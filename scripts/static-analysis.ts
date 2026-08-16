#!/usr/bin/env bun
/**
 * Static-analysis gate shared by local and CI publishing.
 *
 * This intentionally excludes the full test suite: CI already runs it, while
 * this gate focuses on fast, deterministic static checks that must run in the
 * same process immediately before any registry lookup or publish attempt.
 */

import { spawn } from "bun";

export interface StaticAnalysisCommand {
	name: string;
	argv: string[];
}

export const STATIC_ANALYSIS_COMMANDS: readonly StaticAnalysisCommand[] = [
	{ name: "Biome lint and format check", argv: ["bun", "run", "ci"] },
	{ name: "TypeScript typecheck", argv: ["bun", "run", "typecheck"] },
	{ name: "Dependency hygiene", argv: ["bun", "test", "scripts/deps.test.ts"] },
	{ name: "High-severity dependency audit", argv: ["bun", "audit", "--audit-level=high"] },
];

type CommandRunner = (command: StaticAnalysisCommand) => Promise<number>;

function shellQuote(argument: string): string {
	return /^[A-Za-z0-9_./:=@+-]+$/.test(argument)
		? argument
		: `'${argument.replace(/'/g, `'\\''`)}'`;
}

export class StaticAnalysisError extends Error {
	readonly check: string;
	readonly argv: string[];
	readonly exitCode: number;

	constructor(command: StaticAnalysisCommand, exitCode: number) {
		super(`${command.name} failed (exit ${exitCode})`);
		this.name = "StaticAnalysisError";
		this.check = command.name;
		this.argv = [...command.argv];
		this.exitCode = exitCode;
	}
}

export function formatStaticAnalysisFailure(error: StaticAnalysisError): string {
	const rerun = error.argv.map(shellQuote).join(" ");
	const message = `${error.check} failed (exit ${error.exitCode}). Reproduce: ${rerun}`;
	const payload = JSON.stringify({
		check: error.check,
		command: error.argv,
		exitCode: error.exitCode,
		rerun,
	});
	return `::error title=Pre-publish static analysis failed::${message}\nSTATIC_ANALYSIS_FAILURE=${payload}`;
}

async function runCommand(command: StaticAnalysisCommand): Promise<number> {
	const child = spawn(command.argv, {
		cwd: `${import.meta.dir}/..`,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return child.exited;
}

export async function runStaticAnalysis(runner: CommandRunner = runCommand): Promise<void> {
	console.log("Running pre-publish static analysis...");
	for (const command of STATIC_ANALYSIS_COMMANDS) {
		console.log(`\n▶ ${command.name}`);
		const exitCode = await runner(command);
		if (exitCode !== 0) {
			throw new StaticAnalysisError(command, exitCode);
		}
	}
	console.log("\n✔ Pre-publish static analysis passed.");
}

if (import.meta.main) {
	try {
		await runStaticAnalysis();
	} catch (error) {
		if (error instanceof StaticAnalysisError) {
			console.error(`\n${formatStaticAnalysisFailure(error)}`);
		} else {
			console.error(error instanceof Error ? `\n✖ ${error.message}` : "\n✖ Static analysis failed");
		}
		process.exit(1);
	}
}
