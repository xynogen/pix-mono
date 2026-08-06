import type {
	AgentSession,
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { getSessionContextUsage } from "@xynogen/pix-pretty/widget-format";
import { type BtwMessageDetails, registerBtwRenderer } from "./render.ts";
import { runBtw, snapshotMainSettings } from "./session.ts";
import { type BtwWidgetJob, hasVisibleJobs, renderBtwWidget } from "./widget.ts";

const STATUS_KEY = "pix-btw";
const WIDGET_KEY = "pix-btw-live";

interface BtwJob {
	id: number;
	question: string;
	model: string;
	startedAt: number;
	completedAt?: number;
	status: "running" | "completed" | "error" | "stopped";
	text: string;
	activeTools: Set<string>;
	toolUses: number;
	turnCount: number;
	outputTokens: number;
	/** Final context usage, captured before the session is disposed on publish. */
	contextUsage: import("@xynogen/pix-pretty/widget-format").ContextUsageLike | null;
	session?: AgentSession;
	error?: string;
}

/** Project a live job into the widget's render shape. */
function toWidgetJob(job: BtwJob): BtwWidgetJob {
	return {
		id: job.id,
		model: job.model,
		status: job.status,
		startedAt: job.startedAt,
		completedAt: job.completedAt,
		activeTools: [...job.activeTools],
		text: job.text,
		toolUses: job.toolUses,
		turnCount: job.turnCount,
		outputTokens: job.outputTokens,
		contextUsage: getSessionContextUsage(job.session) ?? job.contextUsage,
		error: job.error,
	};
}

export function shortModelName(model: { name?: string; id: string }): string {
	return model.name?.trim() || model.id;
}

export function registerBtw(pi: ExtensionAPI): void {
	registerBtwRenderer(pi);

	const jobs = new Map<number, BtwJob>();
	let nextId = 1;
	let latestUi: ExtensionCommandContext["ui"] | undefined;
	let active = true;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;

	let frame = 0;

	const updateUi = () => {
		if (!active || !latestUi) return;
		const now = Date.now();
		const allJobs = [...jobs.values()];
		if (!hasVisibleJobs(allJobs.map(toWidgetJob), now)) {
			latestUi.setStatus(STATUS_KEY, undefined);
			latestUi.setWidget(WIDGET_KEY, undefined);
			if (refreshTimer) clearInterval(refreshTimer);
			refreshTimer = undefined;
			return;
		}
		const runningCount = allJobs.filter((job) => job.status === "running").length;
		latestUi.setStatus(STATUS_KEY, runningCount > 0 ? `BTW ${runningCount}` : undefined);
		latestUi.setWidget(
			WIDGET_KEY,
			(tui: TUI, theme: Theme) => {
				const text = new Text("", 0, 0);
				return {
					render: (width: number) => {
						const w = width || tui.terminal.columns;
						const widgetJobs = [...jobs.values()].map(toWidgetJob);
						text.setText(renderBtwWidget(widgetJobs, theme, frame, Date.now(), w).join("\n"));
						return text.render(w);
					},
					invalidate: () => text.invalidate(),
				};
			},
			{ placement: "aboveEditor" },
		);
		// 80ms cadence advances the spinner and refreshes elapsed/linger. When only
		// finished jobs remain, they drop once their linger window closes.
		refreshTimer ??= setInterval(() => {
			frame++;
			updateUi();
		}, 80);
	};

	const publish = (job: BtwJob, details: BtwMessageDetails) => {
		job.session?.dispose();
		job.session = undefined;
		// The side session may finish while the main extension runtime is being
		// replaced. Never touch the captured pi/UI after shutdown begins.
		if (!active) return;
		updateUi();
		// A display-only CustomEntry never enters the main agent's LLM context and
		// never steers the running turn, so the card lands the instant the side
		// question finishes — even while the main agent is still streaming. This is
		// the whole point of /btw: an immediate aside, not a deferred bottom-of-log
		// note that only appears once the main turn goes idle.
		pi.appendEntry<BtwMessageDetails>("pix-btw-answer", details);
	};

	pi.registerCommand("btw", {
		description: "Ask an isolated side question without interrupting the main agent",
		handler: async (rawArgs, ctx) => {
			const question = rawArgs.trim();
			latestUi = ctx.ui;
			if (!question) {
				ctx.ui.notify("Usage: /btw <question>", "warning");
				return;
			}

			let snapshot: ReturnType<typeof snapshotMainSettings>;
			try {
				snapshot = snapshotMainSettings(ctx, pi.getThinkingLevel(), pi.getActiveTools());
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const id = nextId++;
			const job: BtwJob = {
				id,
				question,
				model: shortModelName(snapshot.model),
				startedAt: Date.now(),
				status: "running",
				text: "",
				activeTools: new Set(),
				toolUses: 0,
				turnCount: 0,
				outputTokens: 0,
				contextUsage: null,
			};
			jobs.set(id, job);
			updateUi();
			ctx.ui.notify(`BTW #${id} started — the main agent will keep running.`, "info");

			void runBtw({
				question,
				snapshot,
				ctx,
				onSession: (session) => {
					job.session = session;
				},
				onTextDelta: (_delta, fullText) => {
					job.text = fullText;
				},
				onToolStart: (name) => {
					job.activeTools.add(name);
				},
				onToolEnd: (name) => {
					job.activeTools.delete(name);
					job.toolUses++;
				},
				onTurnEnd: (turnCount) => {
					job.turnCount = turnCount;
				},
				onOutputTokens: (output) => {
					job.outputTokens += output;
					job.contextUsage = getSessionContextUsage(job.session) ?? job.contextUsage;
				},
			})
				.then(({ text, thinking, session }) => {
					job.status = "completed";
					job.completedAt = Date.now();
					job.text = text;
					job.session = session;
					job.contextUsage = getSessionContextUsage(session) ?? job.contextUsage;
					publish(job, {
						question,
						answer: text || "No answer returned.",
						thinking,
						model: job.model,
						thinkingLevel: snapshot.thinkingLevel,
						durationMs: Date.now() - job.startedAt,
						toolUses: job.toolUses,
					});
				})
				.catch((error) => {
					job.status = "error";
					job.completedAt = Date.now();
					job.error = error instanceof Error ? error.message : String(error);
					publish(job, {
						question,
						answer: "",
						thinking: "",
						model: job.model,
						thinkingLevel: snapshot.thinkingLevel,
						durationMs: Date.now() - job.startedAt,
						toolUses: job.toolUses,
						error: job.error,
					});
				});
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (!active) return;
		latestUi = ctx.ui;
		updateUi();
	});

	pi.on("session_shutdown", () => {
		// Set this before clearing timers: already-queued callbacks and late BTW
		// completions must become no-ops before Pi invalidates this runtime.
		active = false;
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		latestUi?.setStatus(STATUS_KEY, undefined);
		latestUi?.setWidget(WIDGET_KEY, undefined);
		for (const job of jobs.values()) {
			if (job.status === "running") {
				job.status = "stopped";
				void job.session?.abort();
			}
			job.session?.dispose();
		}
		jobs.clear();
	});
}
