/** Bounded, shell-free command execution for directive interpolation. */
import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import { runTool } from "@xynogen/pix-runtime/exec";
import { truncateStringToBytes } from "@xynogen/pix-runtime/utf8";

export interface RunOptions {
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxBytes?: number;
}

export async function runArgv(argv: string[], opts: RunOptions): Promise<string> {
	opts.signal?.throwIfAborted();
	if (!argv.length) return "(empty command)";
	const maxBytes = opts.maxBytes ?? 16_384;
	try {
		const result = await runTool(argv[0]!, argv.slice(1), {
			cwd: opts.cwd,
			signal: opts.signal,
			timeoutMs: opts.timeoutMs ?? 10_000,
			maxBuffer: maxBytes,
		});
		const output = `${result.stdout}${result.stderr}`.trimEnd();
		const truncated = result.truncated || Buffer.byteLength(output) > maxBytes;
		const text = truncateStringToBytes(output, maxBytes);
		return `${text || "(no output)"}${result.timedOut ? "\n[output truncated: timed out]" : truncated ? "\n[output truncated]" : ""}`;
	} catch (error) {
		opts.signal?.throwIfAborted();
		return `[command failed: ${getErrorMessage(error)}]`;
	}
}
