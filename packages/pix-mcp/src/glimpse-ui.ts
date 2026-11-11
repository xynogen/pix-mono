import { dirname, join } from "node:path";
import { runToolSync } from "@xynogen/pix-runtime/exec";
import { existsSync } from "@xynogen/pix-runtime/fs";
import { requireFrom } from "@xynogen/pix-runtime/paths";
import { currentPlatform } from "@xynogen/pix-runtime/platform";

let glimpseAvailable: boolean | null = null;
let resolvedBinaryPath: string | null = null;

export function isGlimpseAvailable(): boolean {
	if (glimpseAvailable !== null) return glimpseAvailable;

	if (currentPlatform().os !== "darwin") {
		glimpseAvailable = false;
		return false;
	}

	resolvedBinaryPath = getGlimpseBinaryPath();
	glimpseAvailable = resolvedBinaryPath !== null;
	return glimpseAvailable;
}

function getGlimpseBinaryPath(): string | null {
	if (process.env.GLIMPSE_BINARY && existsSync(process.env.GLIMPSE_BINARY)) {
		return process.env.GLIMPSE_BINARY;
	}

	// Local node_modules
	try {
		const require = requireFrom(import.meta.url);
		const glimpseuiPath = require.resolve("glimpseui");
		const binaryPath = join(dirname(glimpseuiPath), "glimpse");
		if (existsSync(binaryPath)) return binaryPath;
	} catch {}

	// Global npm install
	try {
		const globalRoot = runToolSync("npm", ["root", "-g"], { timeoutMs: 10_000 }).stdout.trim();
		const binaryPath = join(globalRoot, "glimpseui", "src", "glimpse");
		if (existsSync(binaryPath)) return binaryPath;
	} catch {}

	return null;
}

export async function openGlimpseWindow(
	html: string,
	options: {
		title: string;
		width?: number;
		height?: number;
		onClosed: () => void;
	},
) {
	const modulePath = resolvedBinaryPath
		? join(dirname(resolvedBinaryPath), "glimpse.mjs")
		: "glimpseui";
	const glimpse = await import(modulePath);

	let active = true;
	const win = glimpse.open(html, {
		width: options.width ?? 900,
		height: options.height ?? 700,
		title: options.title,
	});

	win.on("closed", () => {
		if (!active) return;
		active = false;
		options.onClosed();
	});

	return {
		close: () => {
			if (!active) return;
			active = false;
			win.close();
		},
	};
}
