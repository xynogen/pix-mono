import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { getIconMode } from "@xynogen/pix-runtime/icon-catalog";
import ts from "typescript";
import { withUiFixture } from "../../../scripts/ui-capture.ts";

// ponytail: execute the exact test cleanup blocks, not a copied helper or a live MCP session.
test("MCP capture teardown rejection restores fixtures and settles fake dependencies", async () => {
	const highlight = await import("@xynogen/pix-pretty/highlight");
	const keys = [
		Symbol.for("@xynogen/pix-runtime"),
		Symbol.for("@earendil-works/pi-coding-agent:theme"),
		Symbol.for("@mariozechner/pi-coding-agent:theme"),
	];
	for (const file of [
		"tool-result-renderer.render.test.ts",
		"approval.render.test.ts",
		"mcp-panel.render.test.ts",
	]) {
		const source = ts.createSourceFile(
			file,
			readFileSync(new URL(file, import.meta.url), "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		const registration = source.statements.find(ts.isExpressionStatement)!;
		const callback = (registration.expression as ts.CallExpression)
			.arguments[1] as ts.ArrowFunction;
		const body = callback.body as ts.Block;
		const cleanup = body.statements.find(ts.isTryStatement)!.finallyBlock!;
		const tail = body.statements.slice(
			body.statements.indexOf(body.statements.find(ts.isTryStatement)!) + 1,
		);
		const javascript = ts.transpile(
			`${cleanup.getText(source).slice(1, -1)}\n${tail.map((node) => node.getText(source)).join("\n")}`,
			{ target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
		);
		const env = { MCP_OAUTH_DIR: process.env.MCP_OAUTH_DIR };
		const prettyEnv = process.env.PRETTY_ICONS;
		const icons = getIconMode();
		const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
		const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		const savedCache = new Map(highlight._cache);
		const fixture = await withUiFixture({ hostTheme: true });
		const teardownError = new Error(`${file}: teardown rejected`);
		const restoreError = new Error(`${file}: runtime shutdown rejected`);
		const originalError = new Error(`${file}: capture failed`);
		const shutdown = fixture.runtime.shutdown.bind(fixture.runtime);
		fixture.runtime.shutdown = async () => {
			await shutdown();
			throw restoreError;
		};
		if (!file.startsWith("mcp-panel")) process.env.MCP_OAUTH_DIR = `${fixture.agentDir}/oauth`;
		if (file.startsWith("tool-")) highlight._cache.set("cleanup-failure", ["fixture"]);
		const tools = new Map([["fixture", {}]]);
		const handlers = new Map([
			[
				"session_shutdown",
				async () => {
					throw teardownError;
				},
			],
		]);
		let resolve!: (value: unknown) => void;
		const dependency = new Promise((done) => {
			resolve = done;
		});
		let settled = false;
		const command = dependency.then(() => {
			settled = true;
			throw teardownError;
		});
		void command.catch(() => {});
		const inputs: string[] = [];
		const overlay = {
			handleInput: (data: string) => {
				inputs.push(data);
				if (data === "\r") resolve(undefined);
			},
		};
		const disposed: number[] = [];
		const panels = [{ dispose: () => disposed.push(1) }, { dispose: () => disposed.push(2) }];
		const customResolvers = new Set([resolve]);
		const variables = {
			fixture,
			highlight,
			savedCache,
			env,
			tools,
			handlers,
			command,
			overlay,
			panels,
			customResolvers,
			pending: { resolve, completed: command },
			rendered: () => {},
			closing: false,
			errors: [originalError] as unknown[],
		};
		const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
		try {
			const error = await new AsyncFunction(...Object.keys(variables), javascript)(
				...Object.values(variables),
			).then(
				() => undefined,
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toEqual([
				originalError,
				teardownError,
				restoreError,
			]);
			expect([...highlight._cache]).toEqual([...savedCache]);
			expect<string | undefined>(process.env.MCP_OAUTH_DIR).toBe(env.MCP_OAUTH_DIR);
			expect(process.env.PRETTY_ICONS).toBe(prettyEnv);
			expect(getIconMode()).toBe(icons);
			expect(keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key))).toEqual(
				descriptors,
			);
			expect(Object.getOwnPropertyDescriptor(process.stdout, "columns")).toEqual(columns);
			expect(existsSync(fixture.agentDir)).toBe(false);
			if (file.startsWith("tool-")) {
				expect([tools.size, handlers.size]).toEqual([0, 0]);
			} else {
				expect(settled).toBe(true);
				expect(disposed).toEqual([1, 2]);
				if (file.startsWith("approval")) {
					expect(inputs).toEqual(["\x1b[A", "\r"]);
					expect(customResolvers.size).toBe(0);
				}
			}
		} finally {
			resolve(undefined);
			await command.catch(() => {});
			highlight._cache.clear();
			for (const [key, value] of savedCache) highlight._cache.set(key, value);
			if (env.MCP_OAUTH_DIR === undefined) delete process.env.MCP_OAUTH_DIR;
			else process.env.MCP_OAUTH_DIR = env.MCP_OAUTH_DIR;
			fixture.runtime.shutdown = shutdown;
			await fixture.restore();
		}
	}
});
