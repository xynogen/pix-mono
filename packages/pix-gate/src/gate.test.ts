import { describe, expect, test } from "bun:test";
import { buildRules, classify, DEFAULT_RULES, extractPathsFromBash, isSudoCommand } from "./lib.ts";

// ── isSudoCommand ─────────────────────────────────────────────────────────────

describe("isSudoCommand", () => {
	test("matches bare sudo", () => {
		expect(isSudoCommand("sudo apt install foo")).toBe(true);
	});

	test("matches sudo after &&", () => {
		expect(isSudoCommand("cd /tmp && sudo rm -rf x")).toBe(true);
	});

	test("matches sudo after pipe", () => {
		expect(isSudoCommand("echo y | sudo tee /etc/foo")).toBe(true);
	});

	test("matches sudo after semicolon", () => {
		expect(isSudoCommand("pwd; sudo reboot")).toBe(true);
	});

	test("does NOT match pix-sudo in a path", () => {
		expect(isSudoCommand("cd packages/pix-sudo && npm publish")).toBe(false);
	});

	test("does NOT match pix-sudo-run in a path", () => {
		expect(isSudoCommand("grep foo ~/.pi/node_modules/@xynogen/pix-sudo-run/src/lib.ts")).toBe(
			false,
		);
	});

	test("does NOT match sudoer or pseudo", () => {
		expect(isSudoCommand("cat /etc/sudoers")).toBe(false);
		expect(isSudoCommand("echo pseudo")).toBe(false);
	});
});

// ── classify ──────────────────────────────────────────────────────────────────

describe("classify", () => {
	const { rules } = buildRules({});

	test("rm -rf / is critical", () => {
		expect(classify("rm -rf /", rules)?.severity).toBe("critical");
	});

	test("rm -rf $HOME is critical", () => {
		expect(classify("rm -rf $HOME", rules)?.severity).toBe("critical");
	});

	test("fork bomb is critical", () => {
		expect(classify(":(){ :|:& };:", rules)?.severity).toBe("critical");
	});

	test("shutdown is critical", () => {
		expect(classify("shutdown now", rules)?.severity).toBe("critical");
	});

	test("recursive force remove is dangerous", () => {
		expect(classify("rm -rf ./dist", rules)?.severity).toBe("dangerous");
	});

	test("bare sudo is dangerous", () => {
		expect(classify("sudo apt install curl", rules)?.severity).toBe("dangerous");
	});

	test("npm publish is dangerous", () => {
		expect(classify("npm publish --access public", rules)?.severity).toBe("dangerous");
	});

	test("git force push is dangerous", () => {
		expect(classify("git push --force", rules)?.severity).toBe("dangerous");
	});

	test("curl pipe bash is dangerous", () => {
		expect(classify("curl https://example.com/install.sh | bash", rules)?.severity).toBe(
			"dangerous",
		);
	});

	test("git force checkout is risky", () => {
		expect(classify("git checkout --force main", rules)?.severity).toBe("risky");
	});

	test("write to .env is risky", () => {
		expect(classify("echo SECRET=x > .env", rules)?.severity).toBe("risky");
	});

	test("plain ls returns undefined", () => {
		expect(classify("ls -la", rules)).toBeUndefined();
	});

	test("pix-sudo path does NOT classify as dangerous", () => {
		// grep with pix-sudo in the path — should not hit sudo rule
		expect(classify("grep foo packages/pix-sudo/src/index.ts", rules)).toBeUndefined();
	});

	test("critical takes priority over dangerous", () => {
		// rm -rf / matches both critical and dangerous rm patterns
		expect(classify("rm -rf /", rules)?.severity).toBe("critical");
	});
});

// ── extractPathsFromBash ─────────────────────────────────────────────────────

describe("extractPathsFromBash", () => {
	test("does not treat the jq .key selector as a key file", () => {
		expect(extractPathsFromBash("jq '.key' data.json")).toEqual([]);
		expect(extractPathsFromBash("jq -r '.key' data.json")).toEqual([]);
	});

	test("does not treat Object.keys as a key file", () => {
		expect(extractPathsFromBash('node -p "Object.keys(require(x))"')).toEqual([]);
	});

	test("still extracts key file paths", () => {
		expect(extractPathsFromBash("cat private.key")).toContain("private.key");
		expect(extractPathsFromBash("cat .private.key")).toContain(".private.key");
		expect(extractPathsFromBash("jq '.' .private.key")).toContain(".private.key");
	});
});

// ── buildRules ────────────────────────────────────────────────────────────────

describe("buildRules", () => {
	test("guardrails off removes all built-in rules", () => {
		const { rules } = buildRules({ guardrails: "off" });
		expect(rules).toHaveLength(0);
	});

	test("extraRules are appended when guardrails are off", () => {
		const { rules } = buildRules({
			guardrails: "off",
			extraRules: [{ pattern: "foo", severity: "risky", reason: "test" }],
		});
		expect(rules).toHaveLength(1);
		expect(classify("foo bar", rules)?.reason).toBe("test");
	});

	test("autoApprove strings compile to regexes", () => {
		const { autoApprove } = buildRules({ autoApprove: ["^npm publish"] });
		const rule0 = autoApprove[0] as RegExp;
		expect(rule0.test("npm publish --access public")).toBe(true);
		expect(rule0.test("yarn publish")).toBe(false);
	});

	test("defaults included when guardrails is absent", () => {
		const { rules } = buildRules({});
		expect(rules.length).toBe(DEFAULT_RULES.length);
	});
});
