import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = require("jiti");

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { tempDir } = await jiti.import("@xynogen/pix-runtime/paths");
const cwd = await mkdtemp(join(tempDir(), "hashline-node-"));
const file = join(cwd, "sample.ts");
await writeFile(file, "const retries = 2;\nawait connect();\n");
const tools = new Map();
const pi = { registerTool: (tool) => tools.set(tool.name, tool) };
const readExtension = await jiti.import("../../pix-read/src/extension.ts", { default: true });
const editExtension = await jiti.import("./extension.ts", { default: true });
await readExtension(pi);
await editExtension(pi);
const state = globalThis.__pixHashline;
assert.equal(typeof state.h32, "function");
const read = tools.get("read");
const edit = tools.get("edit");
const result = await read.execute("read", { path: file }, undefined, undefined, { cwd });
assert.equal(result.isError, undefined);
const pos = result.content[0].text.split("|")[0];
assert.match(pos, /^1#[0-9A-F]{3}$/);
assert.equal(result.details.content, "const retries = 2;\nawait connect();");
const changed = await edit.execute("edit", {
	path: file,
	edits: [{ op: "replace", pos, lines: ["const retries = 5;"] }],
}, undefined, undefined, { cwd });
assert.equal(changed.isError, undefined);
assert.equal(await readFile(file, "utf8"), "const retries = 5;\nawait connect();\n");
assert.equal(changed.details.editLine, 1);
const theme = { fg: (_role, text) => text, bold: (text) => text };
let notify;
const rendered = new Promise((resolve) => { notify = resolve; });
const context = { state: {}, expanded: true, isError: false, invalidate: () => notify() };
const component = edit.renderResult(changed, { isPartial: false }, theme, context);
await rendered;
edit.renderResult(changed, { isPartial: false }, theme, { ...context, lastComponent: component });
const text = component.render(120).join("\n");
assert.match(text, /retries/);
assert.match(text, /- -/);
assert.equal(globalThis.__pixHashline, state);
console.log("Node Pi extension smoke passed: anchored read, edit, expanded diff, shared WASM.");
