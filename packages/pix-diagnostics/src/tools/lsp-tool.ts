import { defineActionTool } from "@xynogen/pix-runtime/action-tool";
import type { DispositionStore } from "../dispositions.ts";
import type { LspManager } from "../lsp/manager.ts";
import type { DiagnosticStore } from "../store.ts";
import { diagnosticsTool } from "./diagnostics-tool.ts";
import { markTool } from "./mark-tool.ts";
import { navigationTool } from "./navigation-tool.ts";

export interface LspToolDeps {
	store: DiagnosticStore;
	dispositions: DispositionStore;
	manager: LspManager;
	cwd: string;
}

export function lspTool({ store, dispositions, manager, cwd }: LspToolDeps) {
	return defineActionTool({
		name: "lsp",
		label: "LSP",
		description:
			"Language-server tools: diagnostics (type errors, lint) for files, exact navigation (definition, references, callers, hover, symbols, rename preview), and session-only diagnostic marks.",
		promptSnippet:
			"lsp(action, …) — diagnostics|navigate|mark: LSP checks and exact code navigation",
		promptGuidelines: [
			'lsp: after edits, check with action "diagnostics" (source "lsp", explicit paths). For a known symbol use action "navigate" (definition, references, callHierarchy) instead of grep. Load read_skills(name="pix-diagnostics", full=true) for patterns.',
		],
		actions: {
			diagnostics: {
				tool: diagnosticsTool({ store, manager, cwd }),
				summary: 'source ("session"|"lsp"), paths?, severity? → findings.',
			},
			navigate: {
				tool: navigationTool({ manager, cwd }),
				summary: "operation, path?, line?, character?|symbol?, query? → exact LSP lookup.",
			},
			mark: {
				tool: markTool({ store: dispositions, cwd }),
				summary: "op (set|list|clear), path?, code?, disposition? → session-only marks.",
			},
		},
	});
}
