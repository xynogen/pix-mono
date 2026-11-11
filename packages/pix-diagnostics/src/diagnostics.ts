/**
 * diagnostics.ts — the single Pix diagnostic widget and runtime wiring.
 *
 * `renderWidget` reads a `DiagnosticStore` and renders a top rule and one compact line:
 *
 *   LSP │ <N error> · <N warning> · <N clean> · <N checked> · <age> · <recent files>
 *
 * The render path does no file I/O — it reads only in-memory store state. The
 * default export wires one store, one lazy LSP manager, the two tools, and the
 * session lifecycle. Successful `write`/`edit` results include a fresh LSP check.
 */

import { basename, resolve } from "node:path";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { fadeLine } from "@xynogen/pix-pretty/text";
import {
	mixColors,
	stripTerminalSequences,
	type Theme,
	visibleWidth,
} from "@xynogen/pix-pretty/tui";
import { dotJoin, rule, widgetTitle } from "@xynogen/pix-pretty/utils";
import { config } from "@xynogen/pix-runtime/config";
import { readFileSync, writeFileSync } from "@xynogen/pix-runtime/fs";
import { type ExtensionAPI, truncateHead } from "@xynogen/pix-runtime/host";
import { editSection } from "@xynogen/pix-runtime/sections";
import { DispositionStore } from "./dispositions.ts";
import { createManager, type LspManager } from "./lsp/manager.ts";
import { DiagnosticStore } from "./store.ts";
import { newSyntaxErrors, rejectionText } from "./syntax-guard.ts";
import { collectFindings, registerDiagnosticsTool, summarize } from "./tools/diagnostics-tool.ts";
import { registerMarkTool } from "./tools/mark-tool.ts";
import { registerNavigationTool } from "./tools/navigation-tool.ts";
import type { PixDiagnostic } from "./types.ts";

type ThemeLike = Pick<Theme, "fg" | "style"> & {
	colors: Pick<Theme["colors"], "dim" | "muted">;
};

const MAX_RECENT = 3;
const WIDGET_KEY = "pi-lens-lsp";
/** Repaint period for the age segment, so it keeps counting with no new check. */
const AGE_TICK_MS = 30_000;
/** Past this age the last check is shown as stale (warning color). */
const STALE_MS = 5 * 60_000;

/** Compact age of the last check: `now`, `45s ago`, `3m ago`, `2h ago`, `1d ago`. */
export function formatAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 5) return "now";
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86_400)}d ago`;
}

/** Count errors and warnings across every stored snapshot. */
function severityCounts(store: DiagnosticStore): { errors: number; warnings: number } {
	let errors = 0;
	let warnings = 0;
	for (const snap of store.all()) {
		for (const d of snap.diagnostics) {
			if (d.severity === "error") errors++;
			else if (d.severity === "warning") warnings++;
		}
	}
	return { errors, warnings };
}

/** Render the one-line widget, or `[]` when no file has state yet. */
export function renderWidget(
	store: DiagnosticStore,
	width: number,
	theme: ThemeLike,
	now = Date.now(),
): string[] {
	const w = Math.max(0, width);
	if (w === 0) return [];
	const checkedFiles = store.recent().filter((snapshot) => snapshot.state !== "touched");
	if (checkedFiles.length === 0) return [];
	const clean = checkedFiles.filter((snapshot) => snapshot.state === "clean").length;
	const unconfirmed = checkedFiles.filter((snapshot) => snapshot.state === "unconfirmed").length;
	const unavailable = checkedFiles.filter((snapshot) => snapshot.state === "unavailable").length;

	const { errors, warnings } = severityCounts(store);
	const parts: string[] = [];
	if (errors > 0) parts.push(theme.fg("error", `${icon("status.error")} ${errors} error`));
	if (warnings > 0) parts.push(theme.fg("warning", `${icon("status.warn")} ${warnings} warning`));
	if (unconfirmed > 0) parts.push(theme.fg("warning", `${unconfirmed} unconfirmed`));
	if (unavailable > 0) parts.push(theme.fg("warning", `${unavailable} unavailable`));
	if (clean > 0) parts.push(theme.fg("success", `${icon("status.ok")} ${clean} clean`));
	parts.push(theme.fg("muted", `${checkedFiles.length} checked`));
	// Newest check first (store.recent order): its age shows how fresh the counts are.
	const age = now - (checkedFiles[0]?.checkedAt ?? now);
	const ageText =
		age >= STALE_MS
			? theme.fg("warning", `stale · ${formatAge(age)}`)
			: theme.fg("muted", formatAge(age));

	const files = checkedFiles
		.slice(0, MAX_RECENT)
		.map((snap) =>
			stripTerminalSequences(basename(snap.filePath)).replace(/[\x00-\x1f\x7f-\x9f]/g, " "),
		);
	const more = checkedFiles.length > files.length ? ` +${checkedFiles.length - files.length}` : "";
	const paintFade = (text: string, fade: number) =>
		fade === 0
			? theme.fg("dim", text)
			: theme.style(text, { fg: mixColors(theme.colors.dim, theme.colors.muted, fade) });
	const summary =
		widgetTitle(theme, icon("lsp"), "LSP") + dotJoin(parts, (text) => theme.fg("muted", text));
	const fileText = files.join(", ") + more;
	const row = fileText ? summary + theme.fg("muted", " · ") + paintFade(fileText, 0) : summary;
	const line = rule(w, (glyphs) => theme.fg("borderMuted", glyphs));
	// Age sits at the far right. Counts win: if they do not fit beside it, the age is dropped.
	const ageW = visibleWidth(ageText);
	if (visibleWidth(summary) + 1 + ageW > w) return [line, fadeLine(row, w, paintFade)];
	const left = fadeLine(row, w - ageW - 1, paintFade);
	return [line, left + " ".repeat(Math.max(1, w - visibleWidth(left) - ageW)) + ageText];
}

// ─── Extension ────────────────────────────────────────────────────────────────

/** Test seam: inject a manager and cwd. Production uses the real ones. */
export interface DiagnosticsOptions {
	manager?: LspManager;
	cwd?: string;
}

export default function registerDiagnostics(
	pi: ExtensionAPI,
	options: DiagnosticsOptions = {},
): void {
	const cwd = options.cwd ?? process.cwd();
	const store = new DiagnosticStore();
	const dispositions = new DispositionStore();
	const manager = options.manager ?? createManager(cwd);
	let unsubscribeWidget: (() => void) | null = null;
	/** Syntax guard: file bytes and diagnostics before each pending edit, by tool call id. */
	const beforeEdit = new Map<string, { bytes: Uint8Array; diagnostics: PixDiagnostic[] }>();

	registerDiagnosticsTool(pi, { store, manager, cwd });
	registerNavigationTool(pi, { manager, cwd });
	registerMarkTool(pi, { store: dispositions, cwd });

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus?.(WIDGET_KEY, undefined);
		store.clear();
		dispositions.clear();
		unsubscribeWidget?.();
		unsubscribeWidget = store.subscribe(() => updateWidget(ctx, store));
		updateWidget(ctx, store);
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "edit" || !config(editSection).rejectNewSyntaxErrors) return;
		const path = event.input?.path;
		if (typeof path !== "string" || !path.trim()) return;
		const filePath = resolve(cwd, path);
		try {
			const bytes = readFileSync(filePath);
			const snapshots = await manager.check({ paths: [filePath], severity: "all" });
			// Without a confirmed check there is no baseline, so the guard stays out of the way.
			if (snapshots.some((s) => s.state === "unconfirmed" || s.state === "unavailable")) return;
			beforeEdit.set(event.toolCallId, {
				bytes,
				diagnostics: snapshots.flatMap((s) => [...s.diagnostics]),
			});
		} catch {
			// Missing file or no LSP: the edit runs unguarded and reports its own errors.
		}
	});

	pi.on("tool_result", async (event) => {
		const before = beforeEdit.get(event.toolCallId);
		beforeEdit.delete(event.toolCallId);
		if (event.isError || !["write", "edit"].includes(event.toolName)) return;
		const path = event.input?.path;
		if (typeof path !== "string" || !path.trim()) return;
		const filePath = resolve(cwd, path);
		store.set({ filePath, diagnostics: [], checkedAt: Date.now(), state: "touched" });
		let report: string;
		try {
			const snapshots = await manager.check({ paths: [filePath], severity: "all" });
			for (const snapshot of snapshots) store.set(snapshot);
			if (before) {
				const added = newSyntaxErrors(
					before.diagnostics,
					snapshots.flatMap((s) => [...s.diagnostics]),
				);
				if (added.length) {
					writeFileSync(filePath, before.bytes);
					for (const snapshot of await manager.check({ paths: [filePath], severity: "all" }))
						store.set(snapshot);
					return {
						content: [
							{ type: "text" as const, text: await rejectionText(path, added, before.bytes) },
						],
						isError: true,
					};
				}
			}
			// Only errors ride along with edits (OpenCode's default too): warnings are
			// noisy mid-refactor. The rest stay in the store and widget, and are
			// counted so nothing is hidden silently.
			const findings = collectFindings(cwd, snapshots, "error");
			const hidden = collectFindings(cwd, snapshots, "all").length - findings.length;
			report = findings.length ? findings.join("\n") : summarize(snapshots);
			if (hidden) report += `\n${hidden} warning/info/hint not shown (lsp_diagnostics lists them).`;
			if (findings.length) report += "\nCheck these diagnostics before the next change.";
		} catch (error) {
			store.set({ filePath, diagnostics: [], checkedAt: Date.now(), state: "unavailable" });
			report = `Check unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}
		return {
			content: [
				...(event.content ?? []),
				{
					type: "text" as const,
					text: `LSP after ${event.toolName}:\n${truncateHead(report).content}`,
				},
			],
			structuredContent: event.structuredContent,
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus?.(WIDGET_KEY, undefined);
		ctx.ui.setWidget?.(WIDGET_KEY, undefined);
		store.clear();
		dispositions.clear();
		unsubscribeWidget?.();
		unsubscribeWidget = null;
		await manager.shutdown();
	});
}

function updateWidget(
	ctx: {
		ui: {
			setWidget?: (
				key: string,
				content:
					| undefined
					| ((
							tui: unknown,
							theme: Theme,
					  ) => {
							render(width: number): string[];
							invalidate(): void;
							dispose?(): void;
					  }),
				options?: { placement?: "aboveEditor" | "belowEditor" },
			) => void;
		};
	},
	store: DiagnosticStore,
): void {
	if (!store.all().some((snapshot) => snapshot.state !== "touched")) {
		ctx.ui.setWidget?.(WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget?.(
		WIDGET_KEY,
		(tui, theme) => {
			// Repaint so the age keeps counting; cleared when the widget is replaced.
			const tick = setInterval(
				() => (tui as { requestRender?: () => void } | undefined)?.requestRender?.(),
				AGE_TICK_MS,
			);
			tick.unref?.();
			return {
				render: (width) => renderWidget(store, width, theme),
				invalidate() {},
				dispose: () => clearInterval(tick),
			};
		},
		{ placement: "aboveEditor" },
	);
}
