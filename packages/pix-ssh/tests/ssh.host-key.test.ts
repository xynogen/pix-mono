import { expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@xynogen/pix-runtime/paths";

const exec = await import("@xynogen/pix-runtime/exec");
const runTool = exec.runTool;
let stderr = "";
let publicKey = "";
const calls: string[][] = [];
mock.module("@xynogen/pix-runtime/exec", () => ({
	...exec,
	runTool: async (name: string, args: string[], opts: Parameters<typeof exec.runTool>[2]) => {
		if (name !== "ssh") return runTool(name, args, opts);
		calls.push(args);
		const captured = args.find((arg) => arg.startsWith("UserKnownHostsFile="));
		if (captured)
			writeFileSync(captured.slice("UserKnownHostsFile=".length), `node.invalid ${publicKey}\n`);
		return { code: 255, stdout: "", stderr };
	},
}));
const { HostKeyError, detectHostKeyFailure, hostKeyReset, probeKeyAuth, resetKnownHost } =
	await import("../src/lib.ts");

test("mismatch preserves OpenSSH diagnostic and never becomes password auth", async () => {
	stderr = "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.";
	await expect(probeKeyAuth({ host: "node.invalid" }, "none")).rejects.toBeInstanceOf(HostKeyError);
	await expect(probeKeyAuth({ host: "node.invalid" }, "none")).rejects.toHaveProperty(
		"stderr",
		stderr,
	);
	expect(detectHostKeyFailure("Permission denied (publickey,password).")).toBe(false);
	expect(detectHostKeyFailure("WARNING: REVOKED HOST KEY DETECTED!")).toBe(true);
	expect(hostKeyReset(stderr)).toBeUndefined();
});

test("reset pins verified fingerprint, preserves other hosts and backs up before replacing", async () => {
	const dir = mkdtempSync(join(tempDir(), "pix-ssh-key-test-"));
	try {
		const key = join(dir, "key");
		const generated = await exec.runTool("ssh-keygen", [
			"-q",
			"-t",
			"ed25519",
			"-N",
			"",
			"-f",
			key,
		]);
		expect(generated.code).toBe(0);
		publicKey = readFileSync(`${key}.pub`, "utf8").trim();
		const info = await exec.runTool("ssh-keygen", ["-l", "-E", "sha256", "-f", `${key}.pub`]);
		const fingerprint = info.stdout.trim().split(/\s+/)[1]!;
		const file = join(dir, "known_hosts");
		const original = `# keep comment\nnode.invalid ${publicKey}\nother.invalid ${publicKey}\n`;
		writeFileSync(file, original);
		stderr = `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n${fingerprint}.\n  ssh-keygen -f '${file}' -R 'node.invalid'\nHost key verification failed.`;
		const reset = hostKeyReset(stderr)!;
		expect(reset).toEqual({ file, host: "node.invalid", fingerprint });
		expect(hostKeyReset(stderr.replace(file, "relative/path"))).toBeUndefined();
		expect(hostKeyReset(stderr.replace("-R 'node.invalid'", "-R '-option'"))).toBeUndefined();
		await expect(
			resetKnownHost(
				{ host: "node.invalid" },
				{ ...reset, fingerprint: `SHA256:${"a".repeat(43)}` },
			),
		).rejects.toThrow("could not be verified");
		expect(readFileSync(file, "utf8")).toBe(original);
		await expect(
			resetKnownHost({ host: "node.invalid" }, { ...reset, host: "different.invalid" }),
		).rejects.toThrow("does not match");
		expect(readFileSync(file, "utf8")).toBe(original);
		await resetKnownHost({ host: "node.invalid" }, reset);
		expect(readFileSync(`${file}.old`, "utf8")).toBe(original);
		const updated = readFileSync(file, "utf8");
		expect(updated).toContain("# keep comment");
		expect(updated).toContain(`other.invalid ${publicKey}`);
		expect(updated.match(/node\.invalid/g)).toHaveLength(1);
		const args = calls.at(-1)!;
		for (const option of [
			"ControlPath=none",
			"PreferredAuthentications=none",
			"PubkeyAuthentication=no",
			"PasswordAuthentication=no",
			"KbdInteractiveAuthentication=no",
			"GSSAPIAuthentication=no",
			"HostbasedAuthentication=no",
		])
			expect(args).toContain(option);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
