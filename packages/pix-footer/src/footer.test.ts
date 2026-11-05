import { describe, expect, test } from "bun:test";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { prettySection } from "@xynogen/pix-runtime/sections";
import {
	compactStatus,
	computeSessionTotals,
	computeTps,
	renderSystem,
	renderThinkingLevel,
	renderTokens,
} from "./footer.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	getThinkingBorderColor: (level: string) => (text: string) => `<${level}>${text}</${level}>`,
};

describe("renderThinkingLevel", () => {
	test("uses the host theme's canonical thinking-level renderer", () => {
		expect(renderThinkingLevel(theme, "high", "high")).toBe("<high>high</high>");
		expect(renderThinkingLevel(theme, "xhigh", "xhigh")).toBe("<xhigh>xhigh</xhigh>");
		expect(renderThinkingLevel(theme, "max", "max")).toBe("<max>max</max>");
	});

	test("renders unknown levels as a secondary model value", () => {
		const calls: string[] = [];
		const recordingTheme = {
			fg: (color: string, text: string) => {
				calls.push(color);
				return text;
			},
			getThinkingBorderColor: theme.getThinkingBorderColor,
		};
		expect(renderThinkingLevel(recordingTheme, "future", "future")).toBe("future");
		expect(calls).toEqual(["dim"]);
	});
});

describe("compactStatus", () => {
	test("compacts current pi-lens active server lists to a count", () => {
		expect(compactStatus("pi-lens-lsp", "LSP Active: json, yaml, typescript", theme)).toBe(
			`${icon("lsp")}  3`,
		);
	});

	test("preserves active and failed counts without listing server names", () => {
		expect(compactStatus("pi-lens-lsp", "LSP Active: json, yaml · LSP Failed: eslint", theme)).toBe(
			`${icon("lsp")}  2 !1`,
		);
	});

	test("keeps compatibility with the older parenthesized count", () => {
		expect(compactStatus("pi-lens-lsp", "LSP Active (4)", theme)).toBe(`${icon("lsp")}  4`);
	});
});

describe("computeTps", () => {
	test("suppresses the sub-second reasoning-lump spike", () => {
		// 800 output tokens landing at 0.1s would read 8000 t/s without the floor.
		expect(computeTps(800, 0.1)).toBeNull();
	});

	test("returns a plausible rate once the window is a real second", () => {
		// Same 800 tokens over 8s = 100 t/s, a normal decode rate.
		expect(computeTps(800, 8)).toBe(100);
	});

	test("null when there is no output", () => {
		expect(computeTps(0, 5)).toBeNull();
	});
});

describe("cost marker", () => {
	const msg = (total: number, totalFromProvider?: boolean) => ({
		type: "message",
		message: {
			role: "assistant",
			usage: { input: 1, output: 1, cacheRead: 0, cost: { total, totalFromProvider } },
		},
	});
	const theme = { fg: (_role: string, text: string) => text } as never;
	const parts = { ...prettySection.defaults.footer, tokens: false, cost: true };
	const cost = (...entries: unknown[]) =>
		renderTokens(computeSessionTotals(entries), theme, false, parts);

	test("billed totals show $; any catalog estimate shows ~$", () => {
		expect(cost(msg(0.1, true), msg(0, false))).toMatch(/^ \$\d+\.\d{3}$/);
		expect(cost(msg(0.1, true), msg(0.2))).toMatch(/^ ~\$\d+\.\d{3}$/);
	});
});

test("system readings use three dotted-separated groups with distinct temperatures", () => {
	const tagged = {
		...theme,
		fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
	};
	expect(renderSystem({ cpu: 12, cpuTemp: 56, gpu: 95, gpuTemp: 80, ram: 93 }, tagged)).toBe(
		`<muted>${icon("sys.cpu")} </muted><dim>12%</dim> <dim>56°C</dim>` +
			`<muted> ⋮ </muted><muted>${icon("sys.gpu")} </muted><error>95%</error> <warning>80°C</warning>` +
			`<muted> ⋮ </muted><muted>${icon("sys.ram")} </muted><error>93%</error>`,
	);
	expect(renderSystem({}, theme)).toBe(
		`${icon("sys.cpu")} — — ⋮ ${icon("sys.gpu")} — — ⋮ ${icon("sys.ram")} —`,
	);
	expect(renderSystem({ cpu: 11, gpuTemp: 49, ram: 24 }, theme)).toBe(
		`${icon("sys.cpu")} 11% — ⋮ ${icon("sys.gpu")} — 49°C ⋮ ${icon("sys.ram")} 24%`,
	);
});
