import { describe, expect, test } from "bun:test";
import { DISTRUST_LABEL, decideProjectTrust, TRUST_LABEL, type TrustDeps } from "../src/trust.ts";

function ctx(choice: string | undefined, hasUI = true) {
	const seen: string[][] = [];
	return {
		seen,
		ctx: {
			cwd: "/p",
			mode: "tui",
			hasUI,
			ui: {
				select: async (_title: string, options: string[]) => {
					seen.push(options);
					return choice;
				},
				confirm: async () => false,
				input: async () => undefined,
				notify() {},
			},
		} as never,
	};
}

const deps = (saved: boolean | null = null, mode = "ask"): TrustDeps => ({
	savedDecision: () => saved,
	defaultProjectTrust: () => mode,
});

const event = { type: "project_trust" as const, cwd: "/p" };

describe("project trust prompt", () => {
	test("offers exactly Trust and Do not trust", async () => {
		const c = ctx(TRUST_LABEL);
		await decideProjectTrust(event, c.ctx, deps());
		expect(c.seen).toEqual([[TRUST_LABEL, DISTRUST_LABEL]]);
	});

	test("choices are remembered", async () => {
		expect(await decideProjectTrust(event, ctx(TRUST_LABEL).ctx, deps())).toEqual({
			trusted: "yes",
			remember: true,
		});
		expect(await decideProjectTrust(event, ctx(DISTRUST_LABEL).ctx, deps())).toEqual({
			trusted: "no",
			remember: true,
		});
	});

	test("cancel is untrusted and not saved", async () => {
		expect(await decideProjectTrust(event, ctx(undefined).ctx, deps())).toEqual({ trusted: "no" });
	});

	test("defers to Pi when saved, non-ask default, or no UI", async () => {
		for (const [c, d] of [
			[ctx(TRUST_LABEL), deps(true)],
			[ctx(TRUST_LABEL), deps(null, "always")],
			[ctx(TRUST_LABEL, false), deps()],
		] as const) {
			expect(await decideProjectTrust(event, c.ctx, d)).toEqual({ trusted: "undecided" });
			expect(c.seen).toEqual([]);
		}
	});
});
