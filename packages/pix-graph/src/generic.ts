import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
	type ConsentFn,
	languageForFile,
	type ParseOutcome,
	parseWithGrammar,
	type SgNode,
} from "@xynogen/pix-runtime/ast";
import type { GraphLink, GraphNode } from "./analyzer.ts";

/** Parser seam; tests swap in a fake grammar. */
export type ParseFn = (lang: string, source: string, consent?: ConsentFn) => Promise<ParseOutcome>;

// TS/JS keep the compiler extractor (import bindings, re-exports). Data/markup files have no symbols.
const NOT_GENERIC = new Set([
	"typescript",
	"tsx",
	"javascript",
	"jsx",
	"json",
	"yaml",
	"css",
	"html",
]);

/** ast-grep language of a non-TS code file, or undefined. */
export function genericLanguage(path: string): string | undefined {
	const lang = languageForFile(path);
	return lang && !NOT_GENERIC.has(lang) ? lang : undefined;
}

// Tree-sitter grammar conventions, not per-language tables: a definition is a named node with a
// `name` (or C-style `declarator`) field plus a `body`/`type`; a call is a `*call*`/`*invocation*`
// node whose `function`/`name`/`method`/`macro` field holds the callee.
const IDENT = /identifier$|^constant$|^name$/;
const NOT_DEF = /param|argument|variable|var_spec|field|import/;
const CALL = /call|invocation/;

function identifierIn(node: SgNode | null, depth = 3): string | undefined {
	if (!node || depth < 0) return undefined;
	if (IDENT.test(node.kind())) return node.text();
	for (const child of node.children()) {
		if (!child.isNamed() || !/declarator|identifier|name/.test(child.kind())) continue;
		const hit = identifierIn(child, depth - 1);
		if (hit) return hit;
	}
	return undefined;
}

function definitionName(node: SgNode): string | undefined {
	if (!node.isNamed() || NOT_DEF.test(node.kind())) return undefined;
	if (!node.field("body") && !node.field("type")) return undefined;
	return identifierIn(node.field("name") ?? node.field("declarator"));
}

function calleeName(node: SgNode): string | undefined {
	if (!node.isNamed() || !CALL.test(node.kind())) return undefined;
	const target =
		node.field("function") ?? node.field("name") ?? node.field("method") ?? node.field("macro");
	return target
		?.text()
		.split(/[^A-Za-z0-9_$]+/)
		.filter(Boolean)
		.at(-1);
}

function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

export interface GenericFile {
	file: string;
	rel: string;
	lang: string;
}

export interface GenericExtraction {
	nodes: GraphNode[];
	links: GraphLink[];
	/** Files parsed per language. */
	languages: Record<string, number>;
	/** One line per language that could not be parsed, with the reason. */
	skipped: string[];
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Extract file + definition nodes, `contains`, and cross-file `calls` for non-TS languages.
 * Without import resolution, a call links only when exactly one scanned file defines that name,
 * so common names (`get`, `new`, `run`) never glue unrelated files. Edges are `INFERRED`.
 * ponytail: no import edges for these languages; add specifier→path suffix matching if
 * clustering proves too weak.
 */
export async function extractGeneric(
	files: GenericFile[],
	consent?: ConsentFn,
	onProgress?: (done: number, total: number) => void,
	signal?: AbortSignal,
	parse: ParseFn = parseWithGrammar,
): Promise<GenericExtraction> {
	const nodes: GraphNode[] = [];
	const links: GraphLink[] = [];
	const languages: Record<string, number> = {};
	const failed = new Map<string, { reason: string; files: number }>();
	const seen = new Set<string>();
	const definedIn = new Map<string, Set<string>>();
	const calls: { from: string; name: string; rel: string; line: number }[] = [];

	for (const [i, { file, rel, lang }] of files.entries()) {
		if (signal?.aborted) throw new Error("Operation aborted");
		if (i % 40 === 0) {
			onProgress?.(i, files.length);
			await yieldToLoop();
		}
		const prior = failed.get(lang);
		if (prior) {
			prior.files++;
			continue;
		}
		const outcome = await parse(lang, readFileSync(file, "utf8"), consent);
		if (outcome.kind !== "ok") {
			const reason =
				"pkg" in outcome
					? `grammar ${outcome.pkg} ${outcome.kind === "declined" ? "declined" : "not installed"}`
					: "message" in outcome
						? outcome.message
						: outcome.kind;
			failed.set(lang, { reason, files: 1 });
			continue;
		}
		languages[lang] = (languages[lang] ?? 0) + 1;
		const fileId = slug(rel);
		if (!seen.has(fileId)) {
			seen.add(fileId);
			nodes.push({ id: fileId, label: basename(rel), file_type: "code", source_file: rel });
		}
		const walk = (node: SgNode, owner: string): void => {
			let next = owner;
			const name = definitionName(node);
			const line = node.range().start.line + 1;
			if (name) {
				const id = slug(`${fileId}_${name}`);
				next = id;
				if (!seen.has(id)) {
					seen.add(id);
					const kind = node.kind();
					const isFn =
						/func|method|def|fn/.test(kind) &&
						!/class|struct|type|interface|enum|module|trait|impl/.test(kind);
					nodes.push({
						id,
						label: isFn ? `${name}()` : name,
						file_type: "code",
						source_file: rel,
						source_location: `L${line}`,
					});
					links.push({
						source: fileId,
						target: id,
						relation: "contains",
						confidence: "EXTRACTED",
						confidence_score: 1,
						source_file: rel,
						source_location: `L${line}`,
					});
					const files = definedIn.get(name) ?? new Set<string>();
					files.add(id);
					definedIn.set(name, files);
				}
			}
			const callee = calleeName(node);
			if (callee) calls.push({ from: owner, name: callee, rel, line });
			for (const child of node.children()) walk(child, next);
		};
		walk(outcome.root, fileId);
	}
	onProgress?.(files.length, files.length);

	const ownerFile = new Map(nodes.map((n) => [n.id, n.source_file]));
	const emitted = new Set<string>();
	for (const call of calls) {
		const targets = definedIn.get(call.name);
		if (targets?.size !== 1) continue;
		const [target] = targets;
		if (!target || ownerFile.get(target) === call.rel) continue;
		const key = `${call.from}\0${target}`;
		if (emitted.has(key)) continue;
		emitted.add(key);
		links.push({
			source: call.from,
			target,
			relation: "calls",
			confidence: "INFERRED",
			confidence_score: 0.6,
			source_file: call.rel,
			source_location: `L${call.line}`,
		});
	}

	const skipped = [...failed].map(
		([lang, f]) => `${lang}: ${f.files} file(s) skipped (${f.reason})`,
	);
	return { nodes, links, languages, skipped };
}
