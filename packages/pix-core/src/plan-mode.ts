/**
 * pix-core plan mode — `/plan` opens a modal to manage saved plans in
 * `<cwd>/.pi/plans/*.md`. Plan mode turns on when the user starts a new plan or
 * edits one from the modal. Shift+Tab, or ctrl+alt+p, toggles it by hand.
 * Tab in an empty prompt cycles the thinking level (Pi's default Shift+Tab action).
 *
 * While plan mode is on:
 *   - available tools stay unchanged;
 *   - `edit` and `write` may only target this project's `.pi/plans/`;
 *   - no hidden prompt: "+ New plan" pastes PLAN_GUIDE into the prompt bar as a chip (sent as <paste>).
 *
 * Plan file format: YAML-ish frontmatter (`title`, `description`) + markdown
 * body (the plan itself). Executing a plan sends a normal, visible user
 * message — no hidden automation.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { chipTag } from "@xynogen/pix-pretty/chips";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { modalOverlayOptions } from "@xynogen/pix-pretty/modal-frame";
import { projectDir } from "@xynogen/pix-runtime/paths";
import { validateOutputPath } from "@xynogen/pix-runtime/safe-path";
import { PlanModal, type PlanModalResult } from "./plan-modal.ts";

// ponytail: only edit/write paths are guarded here. Other tools are not sandboxed.
// PLAN_GUIDE asks for read-only use. Use pix-gate for command restrictions.
const PLAN_DIR = `${projectDir()}/plans`; // "/" so prompts and hints read the same on Windows
const STATE_ENTRY = "pix-plan-mode";

// Visible guide: /plan → "+ New plan" pastes this into the prompt bar as a chip for the user
// to read, edit, and send. Nothing is injected into the system prompt.
export const PLAN_GUIDE = `[PLAN MODE] Write an implementation plan. Do not change project code.
Use any available tool to explore without changing project files. Never use tools to edit project code, install, commit, or delete.
Save ONE plan with \`write\` to \`.pi/plans/YYYY-MM-DD-<feature-name>.md\`. Use \`edit\` or \`write\` to revise it. Both tools are restricted to this project's \`.pi/plans/\`.

Format:
---
title: <Feature name>
description: <One sentence: what this builds and why>
---
# <Feature Name> Implementation Plan
**Goal:** <one sentence>
**Architecture:** <2-3 sentences>
**Tech Stack:** <key technologies>
---
### Task N: <Component Name>
**Files:** Create/Modify/Test with exact paths
**Step 1: Write the failing test** — exact test code
**Step 2: Run test to verify it fails** — exact command + expected FAIL output
**Step 3: Write minimal implementation** — exact code
**Step 4: Run test to verify it passes** — exact command + expected PASS
**Step 5: Commit** — \`git commit -m "feat: ..."\`

Rules: exact file paths, complete code, exact commands with expected output, bite-sized steps (2-5 min each), TDD first, DRY, YAGNI. Never git-add the plan.
When done, say: "Plan saved to <path>. Use /plan to run it."
The goal follows this guide.`;

export interface Plan {
	updated_at?: number;
	file: string;
	title: string;
	description: string;
	body: string;
}

/** Parse `---\ntitle: …\ndescription: …\n---\nbody`. Missing frontmatter → file name as title. */
export function parsePlan(file: string, text: string): Plan {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	const meta = m?.[1] ?? "";
	const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(meta)?.[1]?.trim() ?? "";
	return {
		file,
		title: field("title") || file.replace(/\.md$/, ""),
		description: field("description"),
		body: m ? (m[2] ?? "") : text,
	};
}

/** True when `path` (relative to cwd or absolute) resolves inside `<cwd>/.pi/plans/`. */
export function isPlanPath(cwd: string, path: string): boolean {
	const rel = relative(resolve(cwd, PLAN_DIR), resolve(cwd, path));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function listPlans(cwd: string): Plan[] {
	const dir = resolve(cwd, PLAN_DIR);
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
	return files
		.map((f) => ({
			...parsePlan(f, readFileSync(join(dir, f), "utf-8")),
			updated_at: statSync(join(dir, f)).mtimeMs,
		}))
		.sort((a, b) => b.updated_at - a.updated_at || b.file.localeCompare(a.file));
}

/**
 * Shift+Tab toggles plan mode. Tab cycles the thinking level, but only in an empty
 * prompt with no autocomplete list open. Any text keeps Tab for Pi's completion.
 * The thinking cycle reuses Pi's own `app.thinking.cycle` handler (status line included).
 */
export function attachModeKeys(editor: CustomEditor, toggleMode: () => void): void {
	const handleInput = editor.handleInput.bind(editor);
	editor.handleInput = (data: string) => {
		if (matchesKey(data, "shift+tab")) {
			toggleMode();
			return;
		}
		if (matchesKey(data, "tab") && editor.getText() === "" && !editor.isShowingAutocomplete()) {
			editor.actionHandlers.get("app.thinking.cycle")?.();
			return;
		}
		handleInput(data);
	};
}

/** Footer status: plan mode shows its icon and label, normal mode shows only its icon. */
export function modeStatus(
	on: boolean,
	fg: (role: "warning" | "muted", text: string) => string,
): string {
	return on ? fg("warning", icon("mode.plan")) : fg("muted", icon("mode.normal"));
}

export default function registerPlanMode(pi: ExtensionAPI): void {
	let enabled = false;

	function apply(ctx: ExtensionContext, on: boolean): void {
		if (on && !enabled) {
			mkdirSync(resolve(ctx.cwd, PLAN_DIR), { recursive: true });
		}
		const changed = enabled !== on;
		enabled = on;
		ctx.ui.setStatus(
			"plan",
			modeStatus(on, (r, t) => ctx.ui.theme.fg(r, t)),
		);
		pi.appendEntry(STATE_ENTRY, { enabled });
		if (changed) {
			ctx.ui.notify(
				on
					? "Plan mode on: all tools available. Edit/write only inside this project's .pi/plans/."
					: "Plan mode off: edit/write restrictions removed.",
			);
		}
	}

	async function openModal(ctx: ExtensionContext): Promise<void> {
		let requestRender = () => {};
		const result = await ctx.ui.custom<PlanModalResult | undefined>(
			(tui, theme, kb, done) => {
				requestRender = () => tui.requestRender();
				return new PlanModal(listPlans(ctx.cwd), PLAN_DIR, enabled, tui, theme, kb, done);
			},
			{ overlay: true, overlayOptions: modalOverlayOptions() },
		);
		if (!result) return;
		if (result.kind === "toggle") {
			apply(ctx, !enabled);
			return openModal(ctx);
		}
		if (result.kind === "new") {
			apply(ctx, true);
			// pix-display turns <prompt name="plan"> into a "prompt" chip and sends
			// the tag verbatim, so the model sees the guide and the user sees a chip.
			// pix-display adds the trailing space after the chip.
			ctx.ui.setEditorText("");
			ctx.ui.pasteToEditor(chipTag.prompt("plan", PLAN_GUIDE));
			// pasteToEditor does not repaint; without this the chip waits for the next
			// unrelated render (footer tick, keypress), which felt like a 2 s lag.
			requestRender();
			return;
		}
		const path = join(PLAN_DIR, result.plan.file);
		if (result.kind === "edit") {
			// The model edits the file. The chip holds the instruction + path; the user
			// types only the change after it.
			apply(ctx, true);
			ctx.ui.setEditorText("");
			ctx.ui.pasteToEditor(
				chipTag.prompt(
					"plan-edit",
					`Edit the plan in \`${path}\` with \`write\`. Keep its title/description header. Apply the change the user gives after this tag.`,
				),
			);
			requestRender();
			return;
		}
		if (result.kind === "delete") {
			rmSync(resolve(ctx.cwd, path));
			ctx.ui.notify(`Deleted ${path}`, "info");
			return openModal(ctx);
		}
		apply(ctx, false);
		pi.sendUserMessage(`Execute the plan in \`${path}\`. Follow its tasks in order.`);
	}

	pi.registerCommand("plan", {
		description: "Manage saved plans (.pi/plans): new, execute, edit, delete, toggle plan mode",
		handler: async (_args, ctx) => openModal(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: (ctx) => apply(ctx, !enabled),
	});

	// ponytail: registerShortcut("tab") runs before the editor and would break Pi's
	// Tab autocomplete. Wrap the editor so Tab acts only when the prompt is empty.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			const editor = previous?.(tui, theme, kb) ?? new CustomEditor(tui, theme, kb);
			if (editor instanceof CustomEditor) attachModeKeys(editor, () => apply(ctx, !enabled));
			return editor;
		});
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
		const path = event.input.path;
		if (typeof path !== "string" || !isPlanPath(ctx.cwd, path)) {
			return {
				block: true,
				reason: `Plan mode: ${event.toolName} only inside ${resolve(ctx.cwd, PLAN_DIR)}/. Got: ${path}`,
			};
		}
		const checked = await validateOutputPath(resolve(ctx.cwd, path));
		if (!checked.ok) return { block: true, reason: `Plan mode: ${checked.reason}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		const entry = ctx.sessionManager
			.getEntries()
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === STATE_ENTRY,
			)
			.pop() as { data?: { enabled?: boolean } } | undefined;
		enabled = entry?.data?.enabled === true;
		ctx.ui.setStatus(
			"plan",
			modeStatus(enabled, (r, t) => ctx.ui.theme.fg(r, t)),
		);
	});
}
