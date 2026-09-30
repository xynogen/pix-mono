/**
 * Render profile: time Pix tool renderers inside Pi's real ToolExecutionComponent,
 * plus the chip editor and the user-message Markdown transformer.
 *
 *   PI_PKG=<pi-coding-agent dir> bun run profile:render
 *
 * Runs under Node, not Bun: Pi renders under Node + jiti. Extensions load through
 * Pi's own loadExtensions(), so jiti, aliases and theme are the real ones. Each
 * tool's real execute() runs on a temp project first, so renderers get the same
 * structured `details` as in a session.
 *
 * Per scenario (ms per call):
 *   sync    new card: constructor + first updateDisplay, before any async work
 *   async   extra time until the last async repaint (highlight, diff), 0 if none
 *   build   invalidate(): Pi reruns renderCall + renderResult (new args/result, expand, theme)
 *   frame   render(width) with no change (every TUI frame, up to 60/s)
 *   resize  render at a new width (terminal resize, 80 <-> 120, so a width cache hits)
 *   new-w   render at a width the card never saw (first frame after a resize)
 * Budget: a 60 fps frame has 16.7 ms for the whole screen, not one card.
 * ponytail: CPU time only. Pi's line diff and the terminal write are not timed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");
const piPkg = process.env.PI_PKG;
if (!piPkg) throw new Error("Set PI_PKG to the pi-coding-agent package directory");
const ITER = Number(process.env.ITER ?? 200);
const WIDTH = 160;

const host = await import(pathToFileURL(join(piPkg, "dist/index.js")).href);
const { loadExtensions } = await import(
	pathToFileURL(join(piPkg, "dist/core/extensions/loader.js")).href
);
const { initTheme, ToolExecutionComponent, UserMessageComponent, CustomEditor, getMarkdownTheme } =
	host;
initTheme("dark");

const { extensions, errors } = await loadExtensions(
	[join(root, "packages/pix-core/src/extension.ts")],
	root,
);
if (errors.length) throw new Error(`load failed: ${errors[0].error}`);
type ToolDef = {
	execute: (...a: unknown[]) => Promise<Record<string, unknown>>;
	[k: string]: unknown;
};
const tools = new Map<string, ToolDef>();
const transformers: ((md: string, ctx: { messageType: string }) => string)[] = [];
for (const ext of extensions) {
	for (const [name, t] of ext.tools) tools.set(name, t.definition);
	if (ext.markdownTransformer) transformers.push(ext.markdownTransformer);
}

const ui = { requestRender() {}, terminal: { rows: 50, columns: WIDTH } };
// Async renderers (highlight, diff) repaint by calling renderCtx.invalidate(), which
// Pi routes to component.invalidate(). Count those calls to know when output settles.
const settle = async (c: { invalidate(): void }): Promise<number> => {
	let last = performance.now();
	const orig = c.invalidate.bind(c);
	c.invalidate = () => {
		last = performance.now();
		orig();
	};
	// Quiet for 50 ms after the last repaint means settled.
	while (performance.now() - last < 50) await new Promise((r) => setImmediate(r));
	c.invalidate = orig;
	return last;
};
const time = (fn: () => void, n = ITER): number => {
	for (let i = 0; i < 5; i++) fn();
	const t0 = performance.now();
	for (let i = 0; i < n; i++) fn();
	return (performance.now() - t0) / n;
};

// Temp project for execute().
const work = mkdtempSync(join(tmpdir(), "pix-render-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const code = Array.from(
	{ length: 400 },
	(_, i) => `export function fn${i}(a: number, b: string): string {\n\treturn a + b + "${i}";\n}`,
).join("\n");
mkdirSync(join(work, "src"));
for (let d = 0; d < 30; d++) {
	mkdirSync(join(work, `pkg${d}`, "src"), { recursive: true });
	for (let f = 0; f < 6; f++)
		writeFileSync(
			join(work, `pkg${d}`, "src", `file${f}.ts`),
			`export const needle${d}_${f} = ${f};\n`,
		);
}
writeFileSync(join(work, "src/big.ts"), code);
writeFileSync(join(work, "src/edit.ts"), code);
const bashCmd =
	process.platform === "win32"
		? `for /L %i in (1,1,300) do @echo ok line %i ${"x".repeat(60)}`
		: `for i in $(seq 1 300); do echo "ok line $i ${"x".repeat(60)}"; done`;

const scenarios: Record<string, { tool: string; args: Record<string, unknown> }> = {
	"read 1.2k lines": { tool: "read", args: { path: "src/big.ts" } },
	"edit 25 hunks": {
		tool: "edit",
		args: {
			path: "src/edit.ts",
			edits: Array.from({ length: 25 }, (_, k) => ({
				oldText: `export function fn${k * 16}(`,
				newText: `export function fn${k * 16}Renamed(`,
			})),
		},
	},
	"write 1.2k lines": { tool: "write", args: { path: "src/new.ts", content: code } },
	"bash 300 lines": { tool: "bash", args: { command: bashCmd } },
	"grep 180 hits": { tool: "grep", args: { pattern: "needle" } },
	"ls 30 dirs": { tool: "ls", args: { path: "." } },
	"find 180 paths": { tool: "find", args: { pattern: "**/*.ts" } },
};

const toolCtx = {
	cwd: work,
	hasUI: false,
	ui: {},
	sessionManager: { getSessionId: () => "profile", getSessionFile: () => undefined },
	modelRegistry: {},
};
const results = new Map<string, Record<string, unknown>>();
const origCwd = process.cwd();
process.chdir(work);
for (const [label, s] of Object.entries(scenarios)) {
	const def = tools.get(s.tool);
	if (!def) continue;
	try {
		results.set(label, await def.execute("call-1", s.args, undefined, undefined, toolCtx));
	} catch (error) {
		console.error(`${label}: execute failed: ${(error as Error).message}`);
	}
}

// Tool cards. renderCall resolves relative paths against process.cwd(), as in a real session.
// Keep cwd in the temp project until the cards are done.
const rows: string[][] = [];
for (const [label, s] of Object.entries(scenarios)) {
	const def = tools.get(s.tool);
	const result = results.get(label);
	if (!def || !result) {
		rows.push([label, def ? "(execute failed)" : "(tool not registered)"]);
		continue;
	}
	const type = (result.details as { _type?: string } | undefined)?._type ?? "none";
	for (const expanded of [false, true]) {
		const make = () => {
			const c = new ToolExecutionComponent(
				s.tool,
				`call-${Math.random()}`,
				s.args,
				{},
				def,
				ui,
				work,
			);
			c.markExecutionStarted();
			c.setArgsComplete();
			c.updateResult(result, false);
			c.setExpanded(expanded);
			return c;
		};
		const syncs: number[] = [];
		const asyncs: number[] = [];
		for (let i = 0; i < 7; i++) {
			const t0 = performance.now();
			const fresh = make();
			const t1 = performance.now();
			const lastRepaint = await settle(fresh);
			syncs.push(t1 - t0);
			asyncs.push(Math.max(0, lastRepaint - t1));
		}
		syncs.sort((a, b) => a - b);
		asyncs.sort((a, b) => a - b);
		const c = make();
		await settle(c);
		const build = time(() => c.invalidate(), Math.max(20, ITER / 5));
		const frame = time(() => c.render(WIDTH));
		let w = 80;
		const resize = time(
			() => {
				w = w === 80 ? 120 : 80;
				c.render(w);
			},
			Math.max(20, ITER / 5),
		);
		// A width the card never saw: the real cost of the first frame after a resize.
		let fresh = 40;
		const newWidth = time(
			() => {
				fresh = fresh >= 159 ? 40 : fresh + 1;
				c.render(fresh);
			},
			Math.max(20, ITER / 5),
		);
		rows.push([
			`${label}${expanded ? " +exp" : ""} [${type}]`,
			(syncs[3] ?? 0).toFixed(2),
			(asyncs[3] ?? 0).toFixed(1),
			build.toFixed(3),
			frame.toFixed(3),
			resize.toFixed(3),
			newWidth.toFixed(3),
			String(c.render(WIDTH).length),
		]);
	}
}

process.chdir(origCwd);

// Prompt editor with and without chips.
const editorTheme = { borderColor: (t: string) => t, selectList: {} };
const kb = { matches: () => false };
const plain = new CustomEditor(ui, editorTheme, kb);
const chipped = new CustomEditor(ui, editorTheme, kb);
const { installChips } = await import(
	pathToFileURL(join(root, "packages/pix-pretty/src/chips.ts")).href
);
installChips(chipped);
const prompt = `fix <path>src/a.ts</path> and <skill>tdd</skill> ${"word ".repeat(60)}`;
for (const e of [plain, chipped]) {
	e.insertTextAtCursor(prompt);
	e.handleInput(`\x1b[200~${"y".repeat(500)}\x1b[201~`);
}
const md = `use <path>src/a.ts</path> <skill>acme/x@tdd</skill> <paste>${"z".repeat(3000)}</paste> ${"text ".repeat(80)}`;
const other: [string, number][] = [
	["editor, Pi only", time(() => plain.render(WIDTH))],
	["editor + pix chips", time(() => chipped.render(WIDTH))],
	[
		"history transformers (all)",
		time(() => {
			let out = md;
			for (const tr of transformers) out = tr(out, { messageType: "user" });
		}),
	],
	[
		"user message, build + frame",
		time(
			() => new UserMessageComponent(md, getMarkdownTheme(), 1, transformers).render(WIDTH),
			Math.max(20, ITER / 5),
		),
	],
];

// Report.
console.log(`Tool cards (ms per call, ${ITER} iterations, width ${WIDTH})`);
console.log(
	`${"scenario".padEnd(40)} ${"sync".padStart(8)} ${"async".padStart(8)} ${"build".padStart(8)} ${"frame".padStart(8)} ${"resize".padStart(8)} ${"new-w".padStart(8)} ${"lines".padStart(6)}`,
);
for (const r of rows) {
	console.log(
		r.length === 2
			? `${(r[0] ?? "").padEnd(40)} ${r[1]}`
			: `${(r[0] ?? "").padEnd(40)} ${r
					.slice(1, -1)
					.map((v) => v.padStart(8))
					.join(" ")} ${(r.at(-1) ?? "").padStart(6)}`,
	);
}
console.log("\nEditor + history (ms per call)");
for (const [k, v] of other) console.log(`${k.padEnd(40)} ${v.toFixed(3).padStart(8)}`);
