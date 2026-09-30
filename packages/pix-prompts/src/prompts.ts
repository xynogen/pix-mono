/**
 * prompts.ts — unconditional system-prompt injection
 *
 * Injects structured context into every agent turn via `before_agent_start`.
 * Sources (injected in order):
 *   1. Own bundled SOP.md — the pix agent operating spec baseline.
 *   2. Repo CWD directive files the Pi host does NOT auto-load — GEMINI.md,
 *      .cursorrules, .windsurfrules (extend/override the baseline).
 *
 * The host (resource-loader.js) unconditionally loads AGENTS.md / CLAUDE.md
 * as <project_instructions path="...">. Those are intentionally NOT in our
 * scan list — a path-normalization mismatch between the host's resolvePath(cwd)
 * and the extension's process.cwd() broke the string-match dedup and silently
 * double-injected them (~2500 wasted tokens/turn). Host coverage wins; we only
 * add what the host cannot.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { moduleFile } from "@xynogen/pix-runtime/paths";

/**
 * Repo-root filenames scanned for per-project directives.
 * AGENTS.md / CLAUDE.md are intentionally absent — the host resource-loader
 * already injects those. See file header for why the dedup was unreliable.
 */
const REPO_DIRECTIVE_FILES = ["GEMINI.md", ".cursorrules", ".windsurfrules"] as const;

/**
 * Max bytes injected per repo directive file (~4k tokens). These files enter
 * the system prompt on EVERY turn; an oversized one silently burns context.
 * The bundled SOP.md is exempt — we control its size.
 */
const MAX_DIRECTIVE_BYTES = 16 * 1024;

interface PromptSource {
	/** Unique tag name — used for idempotency check. */
	tag: string;
	/** Absolute path to the file. */
	path: string;
	/** Byte cap applied on read (repo files only). */
	maxBytes?: number;
}

/** Absolute path to SOP.md bundled inside this package (src/../SOP.md). */
export function resolveOwnSopMd(): string {
	return moduleFile(import.meta.url, "..", "SOP.md");
}

/** Read a file, returning null on any error. Optionally cap size. */
function safeRead(p: string, maxBytes?: number): string | null {
	try {
		const content = readFileSync(p, "utf-8");
		if (maxBytes !== undefined && Buffer.byteLength(content, "utf-8") > maxBytes) {
			return `${content.slice(0, maxBytes)}\n[pix-prompts: truncated at ${maxBytes} bytes]`;
		}
		return content;
	} catch {
		return null;
	}
}

/** Wrap file content in a labelled XML tag for provenance + idempotency. */
function wrap(tag: string, content: string): string {
	return `<${tag}>\n${content}\n</${tag}>`;
}

export default function registerPrompts(pi: ExtensionAPI): void {
	// Resolve own SOP.md once at load time (path is static).
	const ownSopMdPath = resolveOwnSopMd();

	pi.on("before_agent_start", async (event) => {
		const existing = event.systemPrompt ?? "";
		const cwd = process.cwd();

		const sources: PromptSource[] = [];

		// 1. Own SOP.md
		sources.push({ tag: "pix-agent-sop", path: ownSopMdPath });

		// 2. Repo directive files (root only)
		for (const filename of REPO_DIRECTIVE_FILES) {
			const p = join(cwd, filename);
			if (existsSync(p)) {
				// tag = "pix-prompts-<filename>" with dots/leading-dot stripped
				const tag = `pix-prompts-${filename.replace(/^\./, "").replace(/\./g, "-").toLowerCase()}`;
				sources.push({ tag, path: p, maxBytes: MAX_DIRECTIVE_BYTES });
			}
		}

		// Inject each source the prompt doesn't already carry.
		// Skip when EITHER our own tag is present (retry) OR the host has
		// already injected this file as <project_instructions path="...">.
		// The host uses the absolute file path verbatim (system-prompt.js),
		// so a path match means the content is already present byte-for-byte.
		// ── Patch pi's default identity line ──────────────────────────
		// Pi hardcodes "You are an expert coding assistant…" which triggers
		// safety refusals on some models when asked to run sysadmin/network
		// commands (nmap, tcpdump, etc.). Replace with a generic identity
		// that doesn't pigeonhole the agent. The SOP §1 already covers
		// no-self-censorship and full tool access.
		let prompt = existing.replace(
			"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
			"You are Pix Coding Agent. You help users accomplish any task they request.",
		);

		for (const { tag, path, maxBytes } of sources) {
			if (prompt.includes(`<${tag}>`)) continue;
			if (prompt.includes(`path="${path}"`)) continue; // host already injected it
			const content = safeRead(path, maxBytes);
			if (!content) continue;
			prompt = prompt ? `${prompt}\n\n${wrap(tag, content)}` : wrap(tag, content);
		}

		if (prompt === existing) return; // nothing new to inject
		return { systemPrompt: prompt };
	});
}
