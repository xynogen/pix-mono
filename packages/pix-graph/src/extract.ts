import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import ts from "typescript";
import type { GraphLink, GraphNode } from "./analyzer.js";

/** Extraction output — node/link lists ready for {@link buildGraph}. */
export interface Extraction {
	nodes: GraphNode[];
	links: GraphLink[];
}

/** Deterministic string comparator (no locale surprises). */
function byText(a: string, b: string): number {
	if (a < b) return -1;
	return a > b ? 1 : 0;
}

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "graphify-out"]);

/** Slugify a path fragment to the `[a-z0-9_]` node-id alphabet. */
function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

/** File node id: `{parent_dir}_{stem}`; top-level files collapse to the bare stem. */
function fileNodeId(relPath: string): string {
	const parts = relPath.split("/");
	const stem = basename(parts.at(-1) ?? relPath, extname(relPath));
	const parent = parts.length >= 2 ? parts.at(-2) : undefined;
	return slug(parent ? `${parent}_${stem}` : stem);
}

/** Entity node id: file id plus the entity name. */
function entityNodeId(fileId: string, name: string): string {
	return slug(`${fileId}_${name}`);
}

/** Walk a directory tree, yielding code files (respects SKIP_DIRS). */
export function collectFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") && entry.name !== ".") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) walk(full);
			} else if (CODE_EXTENSIONS.has(extname(entry.name))) {
				out.push(full);
			}
		}
	};
	const stat = statSync(root);
	if (stat.isDirectory()) walk(root);
	else if (CODE_EXTENSIONS.has(extname(root))) out.push(root);
	return out.sort(byText);
}

function line(source: ts.SourceFile, node: ts.Node): string {
	return `L${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
}

/** Name of a top-level declaration, if it has one. */
function declName(node: ts.Node): { name: string; label: string } | undefined {
	if (ts.isFunctionDeclaration(node) && node.name)
		return { name: node.name.text, label: `${node.name.text}()` };
	if (ts.isClassDeclaration(node) && node.name)
		return { name: node.name.text, label: node.name.text };
	if (ts.isInterfaceDeclaration(node)) return { name: node.name.text, label: node.name.text };
	if (ts.isTypeAliasDeclaration(node)) return { name: node.name.text, label: node.name.text };
	if (ts.isEnumDeclaration(node)) return { name: node.name.text, label: node.name.text };
	if (ts.isVariableStatement(node)) {
		const decl = node.declarationList.declarations[0];
		if (decl && ts.isIdentifier(decl.name)) {
			const initialized = decl.initializer;
			const isFn =
				initialized && (ts.isArrowFunction(initialized) || ts.isFunctionExpression(initialized));
			return { name: decl.name.text, label: isFn ? `${decl.name.text}()` : decl.name.text };
		}
	}
	return undefined;
}

/** Called identifier/member name for a call expression. */
function callName(expr: ts.LeftHandSideExpression): string | undefined {
	if (ts.isIdentifier(expr)) return expr.text;
	if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
	return undefined;
}

interface ParsedFile {
	file: string;
	rel: string;
	source: ts.SourceFile;
	fileId: string;
}

/** Read + parse one file into the shape the extractor consumes. */
function parseFile(file: string, repoRoot: string): ParsedFile {
	const rel = relative(repoRoot, file).split(sep).join("/");
	const text = readFileSync(file, "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	return { file, rel, source, fileId: fileNodeId(rel) };
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Parse files in chunks, yielding to the event loop and reporting progress so a
 * live widget stays responsive during the parse (the slow half of extraction).
 */
export async function parseFilesProgress(
	files: string[],
	repoRoot: string,
	onProgress?: (done: number, total: number) => void,
	signal?: AbortSignal,
	chunkSize = 40,
): Promise<ParsedFile[]> {
	const parsed: ParsedFile[] = [];
	for (let i = 0; i < files.length; i += chunkSize) {
		if (signal?.aborted) throw new Error("Operation aborted");
		for (let j = i; j < Math.min(i + chunkSize, files.length); j++) {
			parsed.push(parseFile(files[j] as string, repoRoot));
		}
		onProgress?.(Math.min(i + chunkSize, files.length), files.length);
		await yieldToLoop();
	}
	return parsed;
}

/**
 * Extract a deterministic structural graph from TS/JS source files.
 * Produces file + entity nodes, `contains`/`imports` (EXTRACTED) and
 * cross-file `calls` (INFERRED) edges. Call edges are intentionally loose —
 * the analyzer validates them against real bindings and drops the false ones.
 * ponytail: TS/JS only. Other languages need a tree-sitter extractor (not built).
 *
 * Accepts either file paths (parsed here) or a pre-parsed list from
 * {@link parseFilesProgress} so a caller can parse incrementally with yields.
 */
export function extract(files: string[] | ParsedFile[], repoRoot: string): Extraction {
	const nodes: GraphNode[] = [];
	const links: GraphLink[] = [];
	// name -> node ids that declare it (for cross-file call inference)
	const declByName = new Map<string, string[]>();
	const seen = new Set<string>();

	const parsed: ParsedFile[] =
		typeof files[0] === "string" || files.length === 0
			? (files as string[]).map((file) => parseFile(file, repoRoot))
			: (files as ParsedFile[]);

	// Pass 1: file + entity nodes, contains + imports edges.
	for (const { rel, source, fileId } of parsed) {
		if (!seen.has(fileId)) {
			seen.add(fileId);
			nodes.push({ id: fileId, label: basename(rel), file_type: "code", source_file: rel });
		}
		for (const stmt of source.statements) {
			if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
				links.push({
					source: fileId,
					target: stmt.moduleSpecifier.text,
					relation: "imports",
					confidence: "EXTRACTED",
					confidence_score: 1,
					source_file: rel,
					source_location: line(source, stmt),
				});
				continue;
			}
			const decl = declName(stmt);
			if (!decl) continue;
			const id = entityNodeId(fileId, decl.name);
			if (!seen.has(id)) {
				seen.add(id);
				nodes.push({
					id,
					label: decl.label,
					file_type: "code",
					source_file: rel,
					source_location: line(source, stmt),
				});
			}
			links.push({
				source: fileId,
				target: id,
				relation: "contains",
				confidence: "EXTRACTED",
				confidence_score: 1,
				source_file: rel,
				source_location: line(source, stmt),
			});
			const bare = decl.label.replace(/\(\)$/, "");
			declByName.set(bare, [...(declByName.get(bare) ?? []), id]);
		}
	}

	// Pass 2: cross-file call edges (INFERRED — validated later by the analyzer).
	const nodeById = new Map(nodes.map((n) => [n.id, n]));
	for (const { rel, source, fileId } of parsed) {
		const localNames = new Set<string>();
		for (const n of nodes) {
			if (n.source_file === rel) localNames.add(n.label.replace(/\(\)$/, ""));
		}
		const emitted = new Set<string>();
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const name = callName(node.expression);
				const targets = name ? declByName.get(name) : undefined;
				if (name && targets) {
					for (const target of targets) {
						const targetNode = nodeById.get(target);
						// Only cross-file, and skip names also declared locally (ambiguous).
						if (
							targetNode &&
							targetNode.source_file !== rel &&
							!localNames.has(name) &&
							!emitted.has(`${target}:${line(source, node)}`)
						) {
							emitted.add(`${target}:${line(source, node)}`);
							links.push({
								source: fileId,
								target,
								relation: "calls",
								confidence: "INFERRED",
								confidence_score: 0.75,
								source_file: rel,
								source_location: line(source, node),
							});
						}
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}

	return { nodes, links };
}
