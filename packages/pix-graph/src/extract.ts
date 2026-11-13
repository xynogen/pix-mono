import { basename, extname, join, relative, sep } from "node:path";
import { runToolSync } from "@xynogen/pix-runtime/exec";
import { existsSync, readFileSync, statSync } from "@xynogen/pix-runtime/fs";
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

/** True for files the TypeScript extractor parses. */
export function isTsFile(path: string): boolean {
	return CODE_EXTENSIONS.has(extname(path));
}

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
 * `!path` line in `.ignore` re-includes a gitignored path. `accept` widens the set beyond
 * TS/JS (pix-graph passes the ast-grep language map); generated bundles are always skipped.
 */
export function collectFiles(root: string, accept: (path: string) => boolean = isTsFile): string[] {
	if (!statSync(root).isDirectory()) return accept(root) ? [root] : [];
	// --no-config: RIPGREP_CONFIG_PATH must not change which files the graph sees (pi #11203).
	const args = ["--no-config", "--files", "--hidden", "--no-require-git", "--glob", "!.git"];
	for (const glob of GENERATED_GLOBS) args.push("--glob", `!${glob}`);
	if (existsSync(join(root, ".dockerignore"))) args.push("--ignore-file", ".dockerignore");
	const r = runToolSync("rg", args, { cwd: root, timeoutMs: 30_000 });
	// rg exits 1 when no file matches.
	if (r.code === 1 && !r.stderr.trim()) return [];
	if (r.code !== 0) throw new Error(`rg --files failed in ${root}: ${r.stderr.trim() || r.code}`);
	return r.stdout
		.split("\n")
		.filter((rel) => rel && accept(rel))
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

/** Named methods and properties of a class declaration; none for anything else. */
function classMembers(node: ts.Node): Array<{ name: string; label: string; at: ts.Node }> {
	if (!ts.isClassDeclaration(node)) return [];
	return node.members.flatMap((m) => {
		const isMethod = ts.isMethodDeclaration(m);
		if (!(isMethod || ts.isPropertyDeclaration(m)) || !ts.isIdentifier(m.name)) return [];
		return [{ name: m.name.text, label: `${m.name.text}${isMethod ? "()" : ""}`, at: m }];
	});
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

const MOCK_OWNERS = new Set(["vi", "jest", "mock"]);
const MOCK_METHODS = new Set(["mock", "doMock", "module", "importActual", "requireActual"]);

/** Calls whose first string argument is a module specifier. */
function isModuleCall(expr: ts.Expression): boolean {
	if (expr.kind === ts.SyntaxKind.ImportKeyword) return true;
	if (ts.isIdentifier(expr)) return expr.text === "require";
	return (
		ts.isPropertyAccessExpression(expr) &&
		ts.isIdentifier(expr.expression) &&
		MOCK_OWNERS.has(expr.expression.text) &&
		MOCK_METHODS.has(expr.name.text)
	);
}

/**
 * Extract a deterministic structural graph from TS/JS source files.
 * Produces file + entity nodes, `contains` (ownership), file→file `imports`, and
 * `calls` edges from the enclosing declaration to the imported entity. Imports resolve
 * relative paths, tsconfig `paths`/`baseUrl` aliases, workspace packages (`package.json` name +
 * exports), and module strings in `require`/`import()`/test mocks. Calls resolve
 * only through import bindings (named, default-free, namespace `ns.fn()`), following
 * `export … from` re-exports, so a common name like `it` or `render` never links
 * unrelated packages.
 * Other languages go through `generic.ts` (ast-grep, optional).
 *
 * Accepts either file paths (parsed here) or a pre-parsed list from
 * {@link parseFilesProgress} so a caller can parse incrementally with yields.
 */
export function extract(
	files: string[] | ParsedFile[],
	repoRoot: string,
): Extraction & { unresolved: UnresolvedImport[] } {
	const parsed: ParsedFile[] =
		typeof files[0] === "string" || files.length === 0
			? (files as string[]).map((file) => parseFile(file, repoRoot))
			: (files as ParsedFile[]);
	const g = createGraphState(parsed, repoRoot);
	// Pass 1: file + entity nodes, contains edges, import bindings, export tables.
	for (const file of parsed) indexFile(g, file);
	// Pass 2: calls/references from the enclosing top-level declaration (or the file) to imported
	// or same-file entities. A use that is not a call (type annotation, `extends`, a passed
	// constant) becomes `references`, so impact on an interface or const is not silently empty.
	for (const file of parsed) linkUses(g, file);
	return { nodes: g.nodes, links: g.links, unresolved: g.unresolved };
}

type Binding = { file: string; name: string };
type GraphState = ReturnType<typeof createGraphState>;

/** Shared tables for both passes, plus the edge builders that dedupe into them. */
function createGraphState(parsed: ParsedFile[], repoRoot: string) {
	const nodes: GraphNode[] = [];
	const links: GraphLink[] = [];
	const unresolved: UnresolvedImport[] = [];
	const seen = new Set<string>();
	const resolver = createResolver(
		parsed.map((p) => p.rel),
		repoRoot,
	);
	const fileIdByRel = new Map(parsed.map((p) => [p.rel, p.fileId]));
	const exportsByRel = new Map<string, FileExports>();
	// Per file: local binding -> imported module file + imported name ("*" = namespace).
	const bindingsByRel = new Map<string, Map<string, Binding>>();
	// `rel\0Class.member` → member node id, and `classNodeId\0member` → member node id.
	const membersByRel = new Map<string, string>();
	const memberById = new Map<string, string>();

	const resolveSpec = (rel: string, source: ts.SourceFile, at: ts.Node, spec: string) => {
		const target = resolver.resolve(rel, spec);
		// Relative, alias, and workspace-package specifiers should resolve; npm/node modules need not.
		if (!target && resolver.isInternal(rel, spec)) {
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
	/** Add a node once by id. */
	const addNode = (node: GraphNode) => {
		if (seen.has(node.id)) return;
		seen.add(node.id);
		nodes.push(node);
	};
	return {
		nodes,
		links,
		unresolved,
		resolver,
		exportsByRel,
		bindingsByRel,
		membersByRel,
		memberById,
		resolveSpec,
		addImport,
		resolveExport,
		addNode,
	};
}

/** `import … from` and `export … from`: file import edge plus binding/export table entries.
 * Returns false when `stmt` is neither. */
function indexModuleStatement(
	g: GraphState,
	rel: string,
	source: ts.SourceFile,
	stmt: ts.Statement,
	table: FileExports,
	bindings: Map<string, Binding>,
): boolean {
	if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
		const target = g.resolveSpec(rel, source, stmt, stmt.moduleSpecifier.text);
		if (!target) return true;
		if (!stmt.importClause?.isTypeOnly) g.addImport(rel, source, stmt, target);
		const named = stmt.importClause?.namedBindings;
		if (named && ts.isNamespaceImport(named)) {
			bindings.set(named.name.text, { file: target, name: "*" });
		} else if (named) {
			for (const el of named.elements) {
				bindings.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
			}
		}
		return true;
	}
	if (
		ts.isExportDeclaration(stmt) &&
		stmt.moduleSpecifier &&
		ts.isStringLiteral(stmt.moduleSpecifier)
	) {
		const target = g.resolveSpec(rel, source, stmt, stmt.moduleSpecifier.text);
		if (!target) return true;
		if (!stmt.isTypeOnly) g.addImport(rel, source, stmt, target);
		const clause = stmt.exportClause;
		if (!clause) table.star.push(target);
		else if (ts.isNamedExports(clause)) {
			for (const el of clause.elements) {
				table.named.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
			}
		}
		return true;
	}
	return false;
}

/** Pass 1 for one file. */
function indexFile(g: GraphState, { rel, source, fileId }: ParsedFile): void {
	const pkg = g.resolver.packageOf(rel);
	const withPkg = pkg ? { package: pkg } : {};
	g.addNode({ id: fileId, label: basename(rel), file_type: "code", source_file: rel, ...withPkg });
	const table: FileExports = { declared: new Map(), named: new Map(), star: [] };
	const bindings = new Map<string, Binding>();
	g.exportsByRel.set(rel, table);
	g.bindingsByRel.set(rel, bindings);
	for (const stmt of source.statements) {
		if (indexModuleStatement(g, rel, source, stmt, table, bindings)) continue;
		const decl = declName(stmt);
		if (!decl) continue;
		const id = entityNodeId(fileId, decl.name);
		table.declared.set(decl.name, id);
		const entities = [{ id, label: decl.label, at: stmt as ts.Node, parent: fileId }];
		// Class members become `Class.member` nodes, so impact can target one method.
		for (const m of classMembers(stmt)) {
			const mid = entityNodeId(fileId, `${decl.name}.${m.name}`);
			g.membersByRel.set(`${rel}\0${decl.name}.${m.name}`, mid);
			g.memberById.set(`${id}\0${m.name}`, mid);
			entities.push({ id: mid, label: `${decl.name}.${m.label}`, at: m.at, parent: id });
		}
		for (const e of entities) {
			const location = line(source, e.at);
			g.addNode({
				id: e.id,
				label: e.label,
				file_type: "code",
				source_file: rel,
				source_location: location,
				...withPkg,
			});
			g.links.push({
				source: e.parent,
				target: e.id,
				relation: "contains",
				confidence: "EXTRACTED",
				confidence_score: 1,
				source_file: rel,
				source_location: location,
			});
		}
	}
}

/** Pass 2 for one file. */
function linkUses(g: GraphState, { rel, source, fileId }: ParsedFile): void {
	const bindings = g.bindingsByRel.get(rel) ?? new Map<string, Binding>();
	const local = g.exportsByRel.get(rel)?.declared ?? new Map<string, string>();
	if (bindings.size === 0 && local.size === 0) return;
	const emitted = new Set<string>();
	// ponytail: name-based, no scope analysis. A parameter or local that shadows a top-level
	// name of the same file adds a false edge; upgrade with the TS checker if that shows up.
	const callee = (expr: ts.Node): string | undefined => {
		if (ts.isIdentifier(expr)) {
			const b = bindings.get(expr.text);
			if (b) return b.name !== "*" ? g.resolveExport(b.file, b.name) : undefined;
			return local.get(expr.text);
		}
		const ns =
			ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)
				? [expr.expression.text, expr.name.text]
				: ts.isQualifiedName(expr) && ts.isIdentifier(expr.left)
					? [expr.left.text, expr.right.text]
					: undefined;
		if (!ns) return undefined;
		const [left, right] = ns as [string, string];
		const b = bindings.get(left);
		if (b?.name === "*") return g.resolveExport(b.file, right);
		// `Class.member` of a class declared here or imported by name (static access).
		const owner = b ? g.resolveExport(b.file, b.name) : local.get(left);
		return owner ? g.memberById.get(`${owner}\0${right}`) : undefined;
	};
	for (const stmt of source.statements) {
		if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) continue;
		const decl = declName(stmt);
		const stmtFrom = decl ? entityNodeId(fileId, decl.name) : fileId;
		// Inside a class, attribute uses to the enclosing member; `this.x` resolves to `Class.x`.
		let from = stmtFrom;
		const link = (relation: "calls" | "references", target: string, at: ts.Node) => {
			const key = `${relation}\0${from}\0${target}`;
			if (target === from || emitted.has(key)) return;
			emitted.add(key);
			g.links.push({
				source: from,
				target,
				relation,
				confidence: "EXTRACTED",
				confidence_score: 1,
				source_file: rel,
				source_location: line(source, at),
			});
		};
		const className = decl && ts.isClassDeclaration(stmt) ? decl.name : undefined;
		const member = (name: string) => g.membersByRel.get(`${rel}\0${className}.${name}`);
		const visitNamed = (node: ts.Node & { name: ts.Node }) =>
			ts.forEachChild(node, (c) => {
				if (c !== node.name) visit(c);
			});
		const visit = (node: ts.Node): void => {
			if (
				className &&
				node.parent === stmt &&
				(ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) &&
				ts.isIdentifier(node.name)
			) {
				const prev = from;
				from = member(node.name.text) ?? stmtFrom;
				visitNamed(node);
				from = prev;
				return;
			}
			if (
				className &&
				ts.isPropertyAccessExpression(node) &&
				node.expression.kind === ts.SyntaxKind.ThisKeyword
			) {
				const target = member(node.name.text);
				const isCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
				if (target) link(isCall ? "calls" : "references", target, node);
				return;
			}
			if (ts.isCallExpression(node)) {
				// `import("./x")`, `require("./x")`, and test mocks (`vi.mock`, `jest.mock`,
				// `mock.module`) name a module by string; keep each as a file import.
				const [arg] = node.arguments;
				if (arg && ts.isStringLiteralLike(arg) && isModuleCall(node.expression)) {
					const target = g.resolveSpec(rel, source, node, arg.text);
					if (target) g.addImport(rel, source, node, target);
				}
				const target = callee(node.expression);
				if (target) link("calls", target, node);
				// The callee is handled; walk only the arguments and type arguments.
				for (const child of [...(node.typeArguments ?? []), ...node.arguments]) visit(child);
				if (!target) visit(node.expression);
				return;
			}
			// `ns.X` / `ns.T`: one reference to the member, not a second one to the namespace.
			// Otherwise walk only the left side: `obj.foo` must not match an imported `foo`.
			if (ts.isPropertyAccessExpression(node) || ts.isQualifiedName(node)) {
				const target = callee(node);
				if (target) link("references", target, node);
				else visit(ts.isQualifiedName(node) ? node.left : node.expression);
				return;
			}
			// Object keys and member names are labels, not uses of a same-named import.
			if (isNamedMember(node)) {
				visitNamed(node);
				return;
			}
			if (ts.isIdentifier(node)) {
				const target = callee(node);
				if (target) link("references", target, node);
				return;
			}
			ts.forEachChild(node, visit);
		};
		visit(stmt);
	}
}

function isNamedMember(node: ts.Node): node is ts.Node & { name: ts.Identifier } {
	return (
		(ts.isPropertyAssignment(node) ||
			ts.isPropertySignature(node) ||
			ts.isPropertyDeclaration(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isMethodSignature(node)) &&
		ts.isIdentifier(node.name)
	);
}
