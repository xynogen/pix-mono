/**
 * pix-aria2 — fast, resumable downloads through an auto-managed aria2 daemon.
 *
 * Why aria2: segmented multi-connection speed, control-file resume, and built-in
 * retry live in the aria2c process. We spawn a private loopback RPC daemon on
 * first use (see daemon.ts) and drive it over maria2. The model gets short LFID
 * job handles (`dl-swift-otter-42`) instead of raw 16-hex aria2 GIDs — cheaper
 * tokens, typo-proof for pause/resume/rm.
 *
 * POC scope: add / list / pause / resume / rm, with a live progress widget while
 * any download is active. No torrents-specific surface, no config section, no
 * shared-daemon reuse yet — those are the named next steps.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { reportToolStatus } from "@xynogen/pix-pretty/tool-status";
import {
	formatCollapsedToolRow,
	formatToolCallTitle,
	frameToolResult,
	hideCollapsedToolCall,
	rule,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, collapseDelayMs, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { generateLfid } from "@xynogen/pix-runtime/lfid";
import { aria2 } from "maria2/dist/index.js";
import { Type } from "typebox";
import { Aria2MissingError, type DaemonHandle, startDaemon } from "./daemon.ts";
import { type DlStatus, downloadName, fraction, progressLine } from "./format.ts";

const WIDGET_KEY = "pix-aria2:progress";
const POLL_MS = 1000;

/** Lazy per-session daemon + LFID↔GID map + progress polling. One instance per extension load. */
class DownloadManager {
	private daemon: DaemonHandle | undefined;
	private starting: Promise<DaemonHandle> | undefined;
	private readonly gidByHandle = new Map<string, string>();
	private readonly handleByGid = new Map<string, string>();
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private ui: ExtensionContext["ui"] | undefined;
	private readonly completed = new Map<string, { status: DlStatus; at: number }>();

	/** Keep the session-stable UI context; per-turn contexts expire after the turn. */
	setUI(ui: ExtensionContext["ui"]): void {
		this.ui = ui;
	}

	/** Start (or reuse) the daemon. Serialized so concurrent adds share one process. */
	async connect(ctx: ExtensionContext): Promise<DaemonHandle> {
		this.ui ??= ctx.ui;
		if (this.daemon) return this.daemon;
		if (!this.starting) {
			this.starting = startDaemon({ dir: ctx.cwd, onStatus: reportToolStatus(this.ui) }).then(
				(d) => {
					this.daemon = d;
					return d;
				},
			);
		}
		try {
			return await this.starting;
		} finally {
			this.starting = undefined;
		}
	}

	/** Map a fresh LFID to a GID and remember both directions. */
	track(gid: string): string {
		const handle = generateLfid({ prefix: "dl" });
		this.gidByHandle.set(handle, gid);
		this.handleByGid.set(gid, handle);
		return handle;
	}

	resolveGid(handle: string): string | undefined {
		return this.gidByHandle.get(handle);
	}

	handleFor(gid: string): string {
		return this.handleByGid.get(gid) ?? this.track(gid);
	}

	/** Poll active downloads and paint the widget while anything is running. */
	startPolling(): void {
		if (this.pollTimer) return;
		this.pollTimer = setInterval(() => void this.tick(), POLL_MS);
	}

	private async tick(): Promise<void> {
		if (!this.daemon || !this.ui) return;
		let active: DlStatus[];
		try {
			// SAFETY: maria2 types tellActive as Partial<Aria2DownloadStatus>[]; an *active*
			// download always carries gid + length + speed fields at runtime, which is the
			// subset DlStatus reads. Numeric fields are further guarded via Number() in format.ts.
			active = (await aria2.tellActive(this.daemon.conn)) as unknown as DlStatus[];
		} catch {
			return; // daemon hiccup; try again next tick
		}
		const now = Date.now();
		const running = active.filter((status) => {
			const total = Number(status.totalLength);
			const complete =
				status.status === "complete" || (total > 0 && Number(status.completedLength) >= total);
			if (!complete) {
				this.completed.delete(status.gid);
				return true;
			}
			if (!this.completed.has(status.gid)) this.completed.set(status.gid, { status, at: now });
			return false;
		});
		for (const [gid, completed] of this.completed) {
			if (now - completed.at >= collapseDelayMs()) this.completed.delete(gid);
		}
		const visible = [
			...running,
			...[...this.completed.values()]
				.filter((completed) => now - completed.at < collapseDelayMs())
				.map((completed) => completed.status),
		];
		if (visible.length === 0) {
			this.ui.setWidget(WIDGET_KEY, undefined);
			if (this.pollTimer) {
				clearInterval(this.pollTimer);
				this.pollTimer = undefined;
			}
			return;
		}
		const lines = visible.map((s) => progressLine(this.handleFor(s.gid), s));
		this.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => ({
				render: (width: number) => {
					const heading = `${theme.fg("accent", "○")} ${theme.fg("accent", "Downloads")}`;
					const rows = lines.map((line) =>
						truncateToWidth(
							`  ${theme.fg("accent", icon("update"))} ${theme.fg("dim", line)}`,
							width,
						),
					);
					return [
						rule(width, (glyphs) => theme.fg("borderMuted", glyphs)),
						truncateToWidth(heading, width),
						...rows,
					];
				},
				invalidate() {},
			}),
			{ placement: "aboveEditor" },
		);
	}

	async shutdown(): Promise<void> {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		this.ui?.setWidget(WIDGET_KEY, undefined);
		this.completed.clear();
		await this.daemon?.shutdown();
		this.daemon = undefined;
	}
}

const ActionSchema = Type.Enum(["add", "list", "pause", "resume", "rm"] as const, {
	type: "string",
});

interface DlResultDetails {
	_type: "downloadResult";
	action: string;
	ok: boolean;
	lines: string[];
	error?: string;
}

function textResult(details: DlResultDetails) {
	return {
		content: [{ type: "text" as const, text: details.lines.join("\n") || `${details.action} ok` }],
		details,
		isError: !details.ok,
	};
}

function ok(action: string, ...lines: string[]): DlResultDetails {
	return { _type: "downloadResult", action, ok: true, lines };
}

function fail(action: string, error: string): DlResultDetails {
	return { _type: "downloadResult", action, ok: false, lines: [], error };
}

function errMessage(err: unknown): string {
	if (err instanceof Aria2MissingError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

async function handleAdd(
	mgr: DownloadManager,
	daemon: DaemonHandle,
	p: { url?: string; dir?: string },
): Promise<DlResultDetails> {
	if (!p.url) return fail("add", "add requires a url");
	const opts = p.dir ? { dir: p.dir } : undefined;
	const gid = (await aria2.addUri(daemon.conn, [p.url], opts)) as string;
	const handle = mgr.track(gid);
	mgr.startPolling();
	return ok("add", `${handle} queued — ${p.url}`);
}

async function handleList(mgr: DownloadManager, daemon: DaemonHandle): Promise<DlResultDetails> {
	// SAFETY: see DownloadManager.tick() — active downloads always carry the DlStatus subset at runtime.
	const active = (await aria2.tellActive(daemon.conn)) as unknown as DlStatus[];
	if (active.length === 0) return ok("list", "no active downloads");
	return ok("list", ...active.map((s) => progressLine(mgr.handleFor(s.gid), s)));
}

async function handleGidOp(
	mgr: DownloadManager,
	daemon: DaemonHandle,
	action: "pause" | "resume" | "rm",
	handle: string | undefined,
): Promise<DlResultDetails> {
	if (!handle) return fail(action, `${action} requires a handle`);
	const gid = mgr.resolveGid(handle);
	if (!gid) return fail(action, `unknown handle ${handle}`);
	if (action === "pause") await aria2.pause(daemon.conn, gid);
	else if (action === "resume") {
		await aria2.unpause(daemon.conn, gid);
		mgr.startPolling();
	} else await aria2.remove(daemon.conn, gid);
	return ok(action, `${handle} ${action === "rm" ? "removed" : `${action}d`}`);
}

export default function registerDownload(pi: ExtensionAPI): void {
	const mgr = new DownloadManager();

	pi.on("session_start", (_event, ctx) => {
		mgr.setUI(ctx.ui);
	});

	pi.on("session_shutdown", async () => {
		await mgr.shutdown();
	});

	pi.registerTool({
		name: "download",
		...({ exposure: "deferred" } as const),
		label: "Download",
		renderShell: "self",
		description:
			"Fast, resumable file downloads via an auto-managed aria2 daemon. Actions: add <url> (returns a dl-* handle), list (active downloads + progress), pause/resume/rm <handle>. Multi-connection and resumable by default; a live progress widget shows active transfers.",
		promptSnippet: "Download files fast and resumably via aria2 (add/list/pause/resume/rm)",
		parameters: Type.Object({
			action: ActionSchema,
			url: Type.Optional(
				Type.String({ description: "For add: http(s)/ftp/magnet URL to download." }),
			),
			handle: Type.Optional(
				Type.String({ description: "For pause/resume/rm: the dl-* job handle from add/list." }),
			),
			dir: Type.Optional(
				Type.String({ description: "For add: destination directory. Default cwd." }),
			),
		}),
		renderCall(args, theme, context) {
			if (hideCollapsedToolCall(context.state as CollapseState, context.expanded, () => {}))
				return new Text("", 0, 0);
			const a = args as { action?: string; url?: string; handle?: string };
			const target = a.url ?? a.handle ?? "";
			const text = new Text("", 0, 0);
			text.setText(
				`${formatToolCallTitle(theme, "download", context)} ${theme.fg("dim", a.action ?? "")}${target ? ` ${theme.fg("muted", target)}` : ""}`,
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const details = result.details as DlResultDetails | undefined;
			const fallback = result.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n");
			const body = details
				? details.ok
					? details.lines.join("\n") || `${details.action} ok`
					: (details.error ?? `${details.action} failed`)
				: fallback;
			const text = new Text(body, 0, 0);
			if (options.isPartial) return text;
			const failed = context.isError || details?.ok === false;
			if (
				tickCollapse(
					"download",
					context.state as CollapseState,
					context.invalidate,
					options.expanded,
				)
			)
				return new Text(
					formatCollapsedToolRow(
						theme,
						"download",
						body.replace(/\s+/g, " ").trim(),
						"",
						failed ? "error" : "success",
					),
					0,
					0,
				);
			return frameToolResult(text, theme, failed);
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { action: string; url?: string; handle?: string; dir?: string };
			try {
				const daemon = await mgr.connect(ctx);
				if (p.action === "add") return textResult(await handleAdd(mgr, daemon, p));
				if (p.action === "list") return textResult(await handleList(mgr, daemon));
				if (p.action === "pause" || p.action === "resume" || p.action === "rm") {
					return textResult(await handleGidOp(mgr, daemon, p.action, p.handle));
				}
				return textResult(fail(p.action, `unknown action ${p.action}`));
			} catch (err) {
				return textResult(fail(p.action, errMessage(err)));
			}
		},
	});
}

// Re-export pure helpers for tests.
export { downloadName, fraction, progressLine };
