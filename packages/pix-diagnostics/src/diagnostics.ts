/**
 * diagnostics.ts — the single Pix diagnostic widget and runtime wiring.
 *
 * `renderWidget` reads a `DiagnosticStore` and renders a top rule and one compact line:
 *
 *   <LSP icon> LSP  <N error>  <N warning>  <recent files>
 *
 * The render path does no file I/O — it reads only in-memory store state. The
 * default export wires one store, one lazy LSP manager, the two tools, and the
 * session lifecycle. Successful `write`/`edit` results include a fresh LSP check.
 */

import { basename, resolve } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { rule } from "@xynogen/pix-pretty/utils";
import { DispositionStore } from "./dispositions.ts";
import { createManager, type LspManager } from "./lsp/manager.ts";
import { DiagnosticStore } from "./store.ts";
import { collectFindings, registerDiagnosticsTool, summarize } from "./tools/diagnostics-tool.ts";
import { registerMarkTool } from "./tools/mark-tool.ts";
import { registerNavigationTool } from "./tools/navigation-tool.ts";

type ThemeLike = Pick<Theme, "fg">;

const MAX_RECENT = 3;
const WIDGET_KEY = "pi-lens-lsp";

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
export function renderWidget(store: DiagnosticStore, width: number, theme: ThemeLike): string[] {
	const w = Math.max(1, width || 80);
	const checkedFiles = store.recent().filter((snapshot) => snapshot.state !== "touched");
	if (checkedFiles.length === 0) return [];
	const notable = checkedFiles.filter(
		(snapshot) =>
			snapshot.diagnostics.length > 0 || ["unconfirmed", "unavailable"].includes(snapshot.state),
	);
	const clean = checkedFiles.filter((snapshot) => snapshot.state === "clean").length;
	const unconfirmed = checkedFiles.filter((snapshot) => snapshot.state === "unconfirmed").length;
	const unavailable = checkedFiles.filter((snapshot) => snapshot.state === "unavailable").length;

	const { errors, warnings } = severityCounts(store);
	const parts: string[] = [theme.fg("toolTitle", `${icon("lsp")} LSP`)];
	parts.push(theme.fg("muted", `${checkedFiles.length} checked`));
	if (errors > 0) parts.push(theme.fg("error", `${icon("status.error")} ${errors} error`));
	if (warnings > 0) parts.push(theme.fg("warning", `${icon("status.warn")} ${warnings} warning`));
	if (clean > 0) parts.push(theme.fg("success", `${icon("status.ok")} ${clean} clean`));
	if (unconfirmed > 0) parts.push(theme.fg("warning", `${unconfirmed} unconfirmed`));
	if (unavailable > 0) parts.push(theme.fg("warning", `${unavailable} unavailable`));

	const files = notable.slice(0, MAX_RECENT).map((snap) => basename(snap.filePath));
	const more = notable.length > files.length ? ` +${notable.length - files.length}` : "";
	const fileList = files.length > 0 ? theme.fg("dim", files.join(", ") + more) : "";
	if (fileList) parts.push(fileList);

	return [
		rule(w, (glyphs) => theme.fg("borderMuted", glyphs)),
		truncateToWidth(` ${parts.join("  ")}`, w, "…"),
	];
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

	pi.on("tool_result", async (event) => {
		if (event.isError || !["write", "edit"].includes(event.toolName)) return;
		const path = event.input?.path;
		if (typeof path !== "string" || !path.trim()) return;
		const filePath = resolve(cwd, path);
		store.set({ filePath, diagnostics: [], checkedAt: Date.now(), state: "touched" });
		let report: string;
		try {
			const snapshots = await manager.check({ paths: [filePath], severity: "all" });
			for (const snapshot of snapshots) store.set(snapshot);
			const findings = collectFindings(cwd, snapshots, "all");
			report = findings.length ? findings.join("\n") : summarize(snapshots);
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
		(_tui, theme) => ({
			render: (width) => renderWidget(store, width, theme),
			invalidate() {},
		}),
		{ placement: "aboveEditor" },
	);
}
