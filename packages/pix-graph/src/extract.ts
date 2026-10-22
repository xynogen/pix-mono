import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { runToolSync } from "@xynogen/pix-runtime/exec";
import ts from "typescript";
import type { GraphLink, GraphNode } from "./analyzer.ts";
import { createGraphParseCache, type GraphParseCache } from "./parse-cache.ts";
import { createResolver } from "./resolve.ts";

export { createGraphParseCache, type GraphParseCache };

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
// Generated bundles are one huge file of vendored code; they glue unrelated clusters together.
const GENERATED_GLOBS = ["*.bundle.js", "*.min.js", "*.min.mjs", "*.d.ts"];

/** Slugify a path fragment to the `[a-z0-9_]` node-id alphabet. */
function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

/** File node id: the slugged repo-relative path, so `a/src/index.ts` and `b/src/index.ts` differ. */
function fileNodeId(relPath: string): string {
	return slug(relPath);
}

/** Entity node id: file id plus the entity name. */
function entityNodeId(fileId: string, name: string): string {
	return slug(`${fileId}_${name}`);
}

/**
 * List code files under `root`. ripgrep applies `.gitignore`, `.ignore`, `.rgignore` and
 * `.dockerignore`. Hidden paths are scanned unless an ignore file excludes them, and a
 * `!path` line in `.ignore` re-includes a gitignored path.
 */
export function collectFiles(root: string): string[] {
	if (!statSync(root).isDirectory()) return CODE_EXTENSIONS.has(extname(root)) ? [root] : [];
	// --no-config: RIPGREP_CONFIG_PATH must not change which files the graph sees (pi #11203).
	const args = ["--no-config", "--files", "--hidden", "--no-require-git", "--glob", "!.git"];
	for (const ext of CODE_EXTENSIONS) args.push("--glob", `*${ext}`);
	for (const glob of GENERATED_GLOBS) args.push("--glob", `!${glob}`);
	if (existsSync(join(root, ".dockerignore"))) args.push("--ignore-file", ".dockerignore");
	const r = runToolSync("rg", args, { cwd: root, timeoutMs: 30_000 });
	// rg exits 1 when no file matches.
	if (r.code === 1 && !r.stderr.trim()) return [];
	if (r.code !== 0) throw new Error(`rg --files failed in ${root}: ${r.stderr.trim() || r.code}`);
	return r.stdout
		.split("\n")
		.filter(Boolean)
		.map((rel) => join(root, rel))
		.sort(byText);
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

export interface ParsedFile {
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
	cache?: GraphParseCache,
): Promise<ParsedFile[]> {
	const parsed: ParsedFile[] = [];
	if (cache) {
		cache.parsedFiles = 0;
		cache.reusedFiles = 0;
		for (const file of cache.entries.keys()) if (!files.includes(file)) cache.entries.delete(file);
	}
	for (let i = 0; i < files.length; i += chunkSize) {
		if (signal?.aborted) throw new Error("Operation aborted");
		for (let j = i; j < Math.min(i + chunkSize, files.length); j++) {
			const file = files[j] as string;
			if (!cache) {
				parsed.push(parseFile(file, repoRoot));
				continue;
			}
			const text = readFileSync(file, "utf8");
			const prior = cache.entries.get(file);
			if (prior?.text === text) {
				parsed.push(prior.parsed);
				cache.reusedFiles++;
			} else {
				const rel = relative(repoRoot, file).split(sep).join("/");
				const next = {
					file,
					rel,
					source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
					fileId: fileNodeId(rel),
				};
				parsed.push(next);
				cache.entries.set(file, { text, parsed: next });
				cache.parsedFiles++;
			}
		}
		onProgress?.(Math.min(i + chunkSize, files.length), files.length);
		await yieldToLoop();
	}
	return parsed;
}

/** Where a name exported by a file really lives: a declared entity or a re-export. */
interface FileExports {
	/** Exported/declared name -> entity node id in this file. */
	declared: Map<string, string>;
	/** `export { a as b } from "./x"` -> b -> { file: x, name: a }. */
	named: Map<string, { file: string; name: string }>;
	/** `export * from "./x"` targets. */
	star: string[];
}

/** One import specifier that should resolve inside the repo but does not. */
export interface UnresolvedImport {
	source_file: string;
	source_location: string;
	specifier: string;
}

/**
 * Extract a deterministic structural graph from TS/JS source files.
 * Produces file + entity nodes, `contains` (ownership), file→file `imports`, and
 * `calls` edges from the enclosing declaration to the imported entity. Imports resolve
 * relative paths and workspace packages (`package.json` name + exports). Calls resolve
 * only through import bindings (named, default-free, namespace `ns.fn()`), following
 * `export … from` re-exports, so a common name like `it` or `render` never links
 * unrelated packages.
 * ponytail: TS/JS only. Other languages need a tree-sitter extractor (not built).
 *
 * Accepts either file paths (parsed here) or a pre-parsed list from
 * {@link parseFilesProgress} so a caller can parse incrementally with yields.
 */
export function extract(
	files: string[] | ParsedFile[],
	repoRoot: string,
): Extraction & { unresolved: UnresolvedImport[] } {
	const nodes: GraphNode[] = [];
	const links: GraphLink[] = [];
	const unresolved: UnresolvedImport[] = [];
	const seen = new Set<string>();

	const parsed: ParsedFile[] =
		typeof files[0] === "string" || files.length === 0
			? (files as string[]).map((file) => parseFile(file, repoRoot))
			: (files as ParsedFile[]);
	const resolver = createResolver(
		parsed.map((p) => p.rel),
		repoRoot,
	);
	const fileIdByRel = new Map(parsed.map((p) => [p.rel, p.fileId]));
	const exportsByRel = new Map<string, FileExports>();
	// Per file: local binding -> imported module file + imported name ("*" = namespace).
	const bindingsByRel = new Map<string, Map<string, { file: string; name: string }>>();

	const resolveSpec = (rel: string, source: ts.SourceFile, at: ts.Node, spec: string) => {
		const target = resolver.resolve(rel, spec);
		// Relative and workspace-package specifiers should resolve; npm/node modules need not.
		if (!target && (spec.startsWith(".") || resolver.isWorkspace(spec))) {
			unresolved.push({ source_file: rel, source_location: line(source, at), specifier: spec });
		}
		return target;
	};
	const importEdges = new Set<string>();
	const addImport = (rel: string, source: ts.SourceFile, at: ts.Node, target: string) => {
		const targetId = fileIdByRel.get(target);
		const fromId = fileIdByRel.get(rel);
		if (!targetId || !fromId || targetId === fromId || importEdges.has(`${fromId}\0${targetId}`))
			return;
		importEdges.add(`${fromId}\0${targetId}`);
		links.push({
			source: fromId,
			target: targetId,
			relation: "imports",
			confidence: "EXTRACTED",
			confidence_score: 1,
			source_file: rel,
			source_location: line(source, at),
		});
	};

	// Pass 1: file + entity nodes, contains edges, import bindings, export tables.
	for (const { rel, source, fileId } of parsed) {
		const pkg = resolver.packageOf(rel);
		if (!seen.has(fileId)) {
			seen.add(fileId);
			nodes.push({
				id: fileId,
				label: basename(rel),
				file_type: "code",
				source_file: rel,
				...(pkg ? { package: pkg } : {}),
			});
		}
		const table: FileExports = { declared: new Map(), named: new Map(), star: [] };
		const bindings = new Map<string, { file: string; name: string }>();
		exportsByRel.set(rel, table);
		bindingsByRel.set(rel, bindings);
		for (const stmt of source.statements) {
			if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
				const target = resolveSpec(rel, source, stmt, stmt.moduleSpecifier.text);
				if (!target) continue;
				if (!stmt.importClause?.isTypeOnly) addImport(rel, source, stmt, target);
				const clause = stmt.importClause;
				const named = clause?.namedBindings;
				if (named && ts.isNamespaceImport(named)) {
					bindings.set(named.name.text, { file: target, name: "*" });
				} else if (named) {
					for (const el of named.elements) {
						bindings.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
					}
				}
				continue;
			}
			if (
				ts.isExportDeclaration(stmt) &&
				stmt.moduleSpecifier &&
				ts.isStringLiteral(stmt.moduleSpecifier)
			) {
				const target = resolveSpec(rel, source, stmt, stmt.moduleSpecifier.text);
				if (!target) continue;
				if (!stmt.isTypeOnly) addImport(rel, source, stmt, target);
				const clause = stmt.exportClause;
				if (!clause) table.star.push(target);
				else if (ts.isNamedExports(clause)) {
					for (const el of clause.elements) {
						table.named.set(el.name.text, {
							file: target,
							name: (el.propertyName ?? el.name).text,
						});
					}
				}
				continue;
			}
			const decl = declName(stmt);
			if (!decl) continue;
			const id = entityNodeId(fileId, decl.name);
			table.declared.set(decl.name, id);
			if (!seen.has(id)) {
				seen.add(id);
				nodes.push({
					id,
					label: decl.label,
					file_type: "code",
					source_file: rel,
					source_location: line(source, stmt),
					...(pkg ? { package: pkg } : {}),
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
		}
	}

	/** Entity id for `name` exported by `file`, following re-exports (cycle-safe). */
	const resolveExport = (file: string, name: string, depth = 0): string | undefined => {
		const table = exportsByRel.get(file);
		if (!table || depth > 8) return undefined;
		const own = table.declared.get(name);
		if (own) return own;
		const hop = table.named.get(name);
		if (hop) return resolveExport(hop.file, hop.name, depth + 1);
		for (const star of table.star) {
			const hit = resolveExport(star, name, depth + 1);
			if (hit) return hit;
		}
		return undefined;
	};

	// Pass 2: calls from the enclosing top-level declaration (or the file) to imported entities.
	for (const { rel, source, fileId } of parsed) {
		const bindings = bindingsByRel.get(rel);
		if (!bindings || bindings.size === 0) continue;
		const emitted = new Set<string>();
		const callee = (expr: ts.LeftHandSideExpression): string | undefined => {
			if (ts.isIdentifier(expr)) {
				const b = bindings.get(expr.text);
				return b && b.name !== "*" ? resolveExport(b.file, b.name) : undefined;
			}
			if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
				const b = bindings.get(expr.expression.text);
				return b?.name === "*" ? resolveExport(b.file, expr.name.text) : undefined;
			}
			return undefined;
		};
		for (const stmt of source.statements) {
			if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) continue;
			const decl = declName(stmt);
			const from = decl ? entityNodeId(fileId, decl.name) : fileId;
			const visit = (node: ts.Node): void => {
				if (ts.isCallExpression(node)) {
					// `await import("./x.ts")` is a lazy dependency; keep it as a file import.
					const [arg] = node.arguments;
					if (
						node.expression.kind === ts.SyntaxKind.ImportKeyword &&
						arg &&
						ts.isStringLiteral(arg)
					) {
						const target = resolveSpec(rel, source, node, arg.text);
						if (target) addImport(rel, source, node, target);
					}
					const target = callee(node.expression);
					const key = `${from}\0${target}`;
					if (target && target !== from && !emitted.has(key)) {
						emitted.add(key);
						links.push({
							source: from,
							target,
							relation: "calls",
							confidence: "EXTRACTED",
							confidence_score: 1,
							source_file: rel,
							source_location: line(source, node),
						});
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(stmt);
		}
	}

	return { nodes, links, unresolved };
}
