import { describe, expect, it } from "bun:test";
import {
	createPixPowerShellOperations,
	isWindowsPowerShell,
	LEGACY_REWRITE_NOTE,
	PLAIN_TEXT_PREAMBLE,
	rewriteChainOperators,
	type ShellOperations,
} from "../src/operations";

const OK = "$__pixOk = $?";
const EXIT_ON_FAIL =
	"if (-not $__pixOk) { exit $(if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }) }";

describe("rewriteChainOperators", () => {
	it("rewrites && and || left-to-right into $? checks", () => {
		expect(rewriteChainOperators("a && b || c")).toBe(
			`a; ${OK}; if ($__pixOk) { b; ${OK} }; if (-not $__pixOk) { c; ${OK} }; ${EXIT_ON_FAIL}`,
		);
	});

	it("rewrites each statement's chain independently and exits only after the last", () => {
		expect(rewriteChainOperators("a && b; c\nd || e")).toBe(
			`a; ${OK}; if ($__pixOk) { b; ${OK} }; c\nd; ${OK}; if (-not $__pixOk) { e; ${OK} }; ${EXIT_ON_FAIL}`,
		);
		expect(rewriteChainOperators("a && b; c")).toBe(`a; ${OK}; if ($__pixOk) { b; ${OK} }; c`);
	});

	it("allows the next pipeline on the following line", () => {
		expect(rewriteChainOperators("a &&\n  b")).toBe(
			`a; ${OK}; if ($__pixOk) { b; ${OK} }; ${EXIT_ON_FAIL}`,
		);
	});

	it("ignores operators inside strings, comments, here-strings, and blocks", () => {
		for (const command of [
			"echo 'a && b'",
			'echo "x || y"',
			"echo 'it''s && fine'",
			"# a && b",
			"<# a && b #>",
			"$s = @'\na && b\n'@",
			"if ($a) { b && c }",
			"$x = (a || b)",
			"echo a`&`&b",
		]) {
			expect(rewriteChainOperators(command)).toBeUndefined();
		}
	});

	it("leaves unparseable scripts unchanged", () => {
		expect(rewriteChainOperators("echo 'open && b")).toBeUndefined();
	});
});

describe("isWindowsPowerShell", () => {
	it("detects Windows PowerShell 5.1, not pwsh", () => {
		expect(
			isWindowsPowerShell("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
		).toBe(true);
		expect(isWindowsPowerShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(false);
	});
});

function recordingInner() {
	const calls: string[] = [];
	const inner: ShellOperations = {
		exec: async (command) => {
			calls.push(command);
			return { exitCode: 0 };
		},
	};
	return { inner, calls };
}

describe("createPixPowerShellOperations", () => {
	it("prefixes plain-text rendering and keeps && under pwsh 7", async () => {
		const { inner, calls } = recordingInner();
		const output: string[] = [];
		const ops = createPixPowerShellOperations(inner, () => "C:\\pwsh\\pwsh.exe");
		await ops.exec("a && b", "C:\\", { onData: (d) => output.push(String(d)) });
		expect(calls).toEqual([`${PLAIN_TEXT_PREAMBLE}a && b`]);
		expect(output).toEqual([]);
	});

	it("rewrites chains under Windows PowerShell 5.1 and reports it", async () => {
		const { inner, calls } = recordingInner();
		const output: string[] = [];
		const ops = createPixPowerShellOperations(inner, () => "C:\\x\\powershell.exe");
		await ops.exec("a && b", "C:\\", { onData: (d) => output.push(String(d)) });
		expect(calls[0]).toStartWith(`${PLAIN_TEXT_PREAMBLE}a; $__pixOk = $?; if ($__pixOk) { b;`);
		expect(output).toEqual([LEGACY_REWRITE_NOTE]);
	});
});
