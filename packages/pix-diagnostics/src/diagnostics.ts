/**
 * diagnostics.ts — Lightweight session-files widget (pi-lens replacement)
 *
 * Tracks files touched this session via `write`/`edit` tool results and renders
 * a single compact line: the up-to-3 most recently touched file basenames with
 * a `+N more` suffix and a `(/lens-booboo for details)` hint.
 *
 * NOTE: it does NOT currently query live LSP diagnostics — `FileRecord.diagnostics`
 * is always empty. The file list is a placeholder for future LSP integration.
 *
 * Registers widget with id "pi-lens" to override the external pi-lens widget.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Diagnostic {
	severity: "error" | "warning" | "information" | "hint";
	message: string;
	line?: number;
	col?: number;
	source?: string;
	code?: string | number;
	uri?: string;
}

interface FileRecord {
	filePath: string;
	diagnostics: Diagnostic[];
	touchedAt: number;
}

// ─── Module state ─────────────────────────────────────────────────────────────

const files = new Map<string, FileRecord>();
let requestRenderFn: (() => void) | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

function clearDiagnosticState(): void {
	files.clear();
}

function requestRender(): void {
	requestRenderFn?.();
}

// ─── Diagnostic collection ────────────────────────────────────────────────────

/**
 * Track that a file was touched. In this simplified version, we don't query
 * LSP diagnostics directly (that requires a full LSP client). Instead, we
 * register the file and show a placeholder/summary. Future enhancement: hook
 * into pi-lens's diagnostic events or build LSP integration.
 */
function recordFileTouched(filePath: string): void {
	const rec: FileRecord = {
		filePath,
		diagnostics: [], // Empty for now - we'd populate from LSP in full version
		touchedAt: Date.now(),
	};
	files.set(filePath, rec);
	requestRender();
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderWidget(width: number, theme: Theme): string[] {
	const w = Math.max(1, width || 80);

	const cyan = (s: string) => theme.fg("accent", s);
	const muted = (s: string) => theme.fg("muted", s);
	const green = (s: string) => theme.fg("success", s);

	const lines: string[] = [];

	// Show a compact summary. This widget overrides pi-lens's verbose output.
	// For detailed diagnostics, users can run /lens-booboo or /lsp-diagnostics.
	const filesCount = files.size;

	if (filesCount === 0) {
		// No files touched yet this session
		return [];
	}

	const recentFiles = [...files.values()]
		.sort((a, b) => b.touchedAt - a.touchedAt)
		.slice(0, 3)
		.map((f) => f.filePath.split("/").pop() ?? f.filePath);

	const filesList = recentFiles.join(", ");
	const summary =
		filesCount <= 3
			? `${green("✓")} ${filesList}`
			: `${green("✓")} ${filesList} +${filesCount - 3} more`;

	const header = ` ${cyan("pix-lens")}  ${summary}  ${muted("(/lens-booboo for details)")}`;
	lines.push(fitLine(header, w));

	return lines;
}

function fitLine(s: string, maxWidth: number, ellipsis = "…"): string {
	return truncateToWidth(s, Math.max(0, maxWidth), ellipsis);
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		clearDiagnosticState();

		// Register widget
		if (!ctx.ui.setWidget) return;
		ctx.ui.setWidget(
			"pi-lens",
			(tui, theme: Theme) => {
				requestRenderFn = () => tui.requestRender();
				return {
					render: (width: number) => renderWidget(width, theme),
					dispose() {
						requestRenderFn = null;
					},
					invalidate() {},
				};
			},
			{ placement: "belowEditor" },
		);
	});

	// Track files after write/edit
	pi.on("tool_result", async (event, _ctx) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			const filePath = (event.input as { path?: string })?.path;
			if (typeof filePath === "string") {
				recordFileTouched(filePath);
			}
		}
	});

	pi.on("session_shutdown", () => {
		clearDiagnosticState();
		requestRenderFn = null;
	});
}
