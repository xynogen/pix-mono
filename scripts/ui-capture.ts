import { Box, CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { getIconMode, setIconMode } from "@xynogen/pix-runtime/icon-catalog";
import { collapseSection, prettySection } from "@xynogen/pix-runtime/sections";
import { createIsolatedRuntime } from "@xynogen/pix-runtime/testing";

const roles = [
	"toolTitle",
	"toolOutput",
	"success",
	"error",
	"dim",
	"muted",
	"warning",
	"accent",
	"text",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"border",
	"borderAccent",
	"borderMuted",
	"selectedBg",
	"highlight",
	"thinkingText",
	"customMessageText",
	"customMessageLabel",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
];
const ansiColors = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const rawColors: Record<string, string> = {
	"100;100;100": "raw.lineNumber",
	"80;80;80": "raw.dim",
	"50;50;50": "raw.rule",
	"100;180;120": "raw.green",
	"200;100;100": "raw.red",
	"220;180;80": "raw.yellow",
	"100;140;220": "raw.blue",
	"139;148;158": "raw.muted",
	// Evidence: pix-display/test/code-blocks.test.ts preserves this raw syntax string color.
	"206;145;120": "raw.string",
	"40;40;40": "diff.stripe",
	"18;42;28": "diff.add",
	"48;22;26": "diff.remove",
	"28;72;44": "diff.addHighlight",
	"82;32;38": "diff.removeHighlight",
};

/** Zero-width fixture colors. Decode them only after the real component renders. */
export function roleTheme() {
	const ansi = (role: string, background = false) => {
		const index = roles.indexOf(role);
		if (index < 0) throw new Error(`Unknown fixture role: ${role}`);
		return `\x1b[${background ? 48 : 38};5;${100 + index}m`;
	};
	return {
		fg: (role: string, text: string) => `${ansi(role)}${text}\x1b[39m`,
		bg: (role: string, text: string) => `${ansi(role, true)}${text}\x1b[49m`,
		getFgAnsi: (role: string) => ansi(role),
		getBgAnsi: (role: string) => ansi(role, true),
		// ponytail: capture the border role, not the host's RGB thinking-level palette.
		getThinkingBorderColor: (_level: string) => (text: string) =>
			`${ansi("accent")}${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
		underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
		strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
	};
}

/** OSC policy: default rejects all. Opt-in accepts only native 0.99.2 BEL-terminated 133 A/B/C. */
export function semanticRow(line: string, options: { osc133?: boolean } | number = {}): string {
	let foreground = "";
	let background = "";
	let bold = false;
	let italic = false;
	let inverse = false;
	let faint = false;
	let underline = false;
	let strikethrough = false;
	const runs: { style: string; text: string }[] = [];
	const append = (text: string) => {
		// Pi Input uses a zero-width APC cursor marker. Preserve its location, reject every other APC.
		text = text.replaceAll(CURSOR_MARKER, "<cursor/>");
		// Array.map passes an index as argument two. Keep existing map(semanticRow) callers valid.
		if (typeof options === "object" && options.osc133)
			text = text.replace(/\x1b\]133;([ABC])\x07/g, "<osc133:$1/>");
		if (/[\x00-\x08\x0a-\x1f\x7f-\x9f]/.test(text))
			throw new Error("Unsupported fixture escape or control");
		if (!text) return;
		const style = [
			foreground,
			background && `bg:${background}`,
			bold && "bold",
			italic && "italic",
			inverse && "inverse",
			faint && "faint",
			underline && "underline",
			strikethrough && "strikethrough",
		]
			.filter(Boolean)
			.join("+");
		const last = runs.at(-1);
		if (last?.style === style) last.text += text;
		else runs.push({ style, text });
	};
	let offset = 0;
	for (const match of line.matchAll(/\x1b\[([\d;]*)m/g)) {
		append(line.slice(offset, match.index));
		const codes = (match[1] || "0").split(";").map(Number);
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i] ?? -1;
			switch (code) {
				case 0:
					foreground = "";
					background = "";
					bold = italic = inverse = faint = underline = strikethrough = false;
					break;
				case 1:
					bold = true;
					break;
				case 2:
					faint = true;
					break;
				case 3:
					italic = true;
					break;
				case 4:
					underline = true;
					break;
				case 7:
					inverse = true;
					break;
				case 9:
					strikethrough = true;
					break;
				case 22:
					bold = faint = false;
					break;
				case 23:
					italic = false;
					break;
				case 24:
					underline = false;
					break;
				case 27:
					inverse = false;
					break;
				case 29:
					strikethrough = false;
					break;
				case 39:
					foreground = "";
					break;
				case 49:
					background = "";
					break;
				default: {
					let color: string | undefined;
					const bg = code === 48 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107);
					if (code === 38 || code === 48) {
						const mode = codes[++i];
						if (mode === 5) {
							const index = codes[++i];
							color = index === undefined ? undefined : roles[index - 100];
						} else if (mode === 2) {
							color = rawColors[codes.slice(i + 1, i + 4).join(";")];
							i += 3;
						}
					} else {
						const base = bg ? (code >= 100 ? 100 : 40) : code >= 90 ? 90 : 30;
						if (code >= base && code <= base + 7)
							color = `ansi.${base >= 90 ? "bright." : ""}${ansiColors[code - base]}`;
					}
					if (!color) throw new Error(`Unsupported fixture SGR: ${match[0]}`);
					if (bg) background = color;
					else foreground = color;
				}
			}
		}
		offset = match.index + match[0].length;
	}
	append(line.slice(offset));
	return runs.map(({ style, text }) => (style ? `<${style}>${text}</${style}>` : text)).join("");
}

export function captureRows(
	component: { render(width: number): string[] },
	options: {
		width: number;
		surface: "component" | "host-self" | "host-box";
		osc133?: boolean;
	},
): string[] {
	const { width, surface } = options;
	if (!Number.isInteger(width) || width < 1)
		throw new Error("Capture width must be a positive integer");
	let rows: string[];
	// ponytail: these adapters cover installed 0.99.2 shell geometry only. Use a public host adapter for full-host coverage.
	if (surface === "host-box") {
		const box = new Box(1, 1);
		box.addChild({ render: (childWidth) => component.render(childWidth), invalidate() {} });
		rows = box.render(width);
		if (rows.length) rows.unshift("");
	} else {
		rows = component.render(width);
		if (surface === "host-self" && rows.length) rows = ["", ...rows];
	}
	if (options.osc133) {
		const boundaries = rows.flatMap((row) => [...row.matchAll(/\x1b\]133;([ABC])\x07/g)]);
		if (
			boundaries.length &&
			(boundaries.map((match) => match[1]).join("") !== "ABC" ||
				!rows[0]?.startsWith("\x1b]133;A\x07") ||
				!rows.at(-1)?.startsWith("\x1b]133;B\x07\x1b]133;C\x07"))
		)
			throw new Error("Invalid native OSC 133 boundaries");
	}
	return rows.map((row) => {
		const semantic = semanticRow(row, options);
		if (visibleWidth(row) > width) throw new Error(`Capture row exceeds ${width} columns`);
		return semantic;
	});
}

/** Call restore in finally. Await every config write before restoration. */
export async function withUiFixture(
	options: { icons?: "unicode" | "ascii"; hostTheme?: boolean } = {},
) {
	// ponytail: checked structural adapter for host 0.99.2 only. Recheck host reads before supporting another version.
	const host = options.hostTheme ? await import("@earendil-works/pi-coding-agent") : undefined;
	if (host && host.VERSION !== "0.99.2")
		throw new Error(`Unsupported capture host version: ${host.VERSION}`);
	const hostThemes = host
		? [
				Symbol.for("@earendil-works/pi-coding-agent:theme"),
				Symbol.for("@mariozechner/pi-coding-agent:theme"),
			].map((key) => ({ key, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) }))
		: [];
	if (hostThemes.some(({ descriptor }) => descriptor && !descriptor.configurable))
		throw new Error("Host fixture theme symbols must be configurable");
	const isolated = createIsolatedRuntime();
	const key = Symbol.for("@xynogen/pix-runtime");
	const globals = globalThis as unknown as Record<symbol, unknown>;
	const previous = globals[key];
	const icons = getIconMode();
	const fixedEnv = {
		PRETTY_ICONS: options.icons ?? "unicode",
		PRETTY_MAX_PREVIEW_LINES: "80",
		PRETTY_MAX_HL_CHARS: "80000",
		PRETTY_MAX_HL_LINE_CHARS: "2000",
		PRETTY_CACHE_LIMIT: "128",
	};
	const env = Object.fromEntries(Object.keys(fixedEnv).map((name) => [name, process.env[name]]));
	const columns = [process.stdout, process.stderr].map((stream) =>
		Object.getOwnPropertyDescriptor(stream, "columns"),
	);
	const setWidth = (width: number) => {
		if (!Number.isInteger(width) || width < 1)
			throw new Error("Fixture width must be a positive integer");
		for (const stream of [process.stdout, process.stderr])
			Object.defineProperty(stream, "columns", { configurable: true, value: width });
		process.stdout.emit("resize");
	};
	let restored = false;
	const restore = async () => {
		if (restored) return;
		restored = true;
		try {
			await isolated.runtime.shutdown();
		} finally {
			try {
				for (const { key, descriptor } of hostThemes) {
					if (descriptor) Object.defineProperty(globalThis, key, descriptor);
					else Reflect.deleteProperty(globalThis, key);
				}
				if (previous === undefined) delete globals[key];
				else globals[key] = previous;
				setIconMode(icons);
				for (const [name, value] of Object.entries(env)) {
					if (value === undefined) delete process.env[name];
					else process.env[name] = value;
				}
				for (const [index, stream] of [process.stdout, process.stderr].entries()) {
					const descriptor = columns[index];
					if (descriptor) Object.defineProperty(stream, "columns", descriptor);
					else Reflect.deleteProperty(stream, "columns");
				}
				process.stdout.emit("resize");
			} finally {
				isolated.cleanup();
			}
		}
	};
	try {
		if (host) {
			const fixtureTheme = roleTheme();
			for (const { key } of hostThemes)
				Object.defineProperty(globalThis, key, {
					configurable: true,
					writable: true,
					value: fixtureTheme,
				});
			if (host.getMarkdownTheme().heading("x") !== fixtureTheme.fg("mdHeading", "x"))
				throw new Error("Host Markdown does not read the fixture theme");
		}
		globals[key] = isolated.runtime;
		Object.assign(process.env, fixedEnv);
		await isolated.runtime.init();
		await isolated.runtime.update(prettySection, {
			icons: options.icons ?? "unicode",
			maxPreviewLines: 80,
			maxHighlightChars: 80_000,
		});
		await isolated.runtime.update(collapseSection, (current) => ({
			...current,
			enabled: false,
			tools: {},
		}));
		setIconMode(options.icons ?? "unicode");
		setWidth(80);
		return { runtime: isolated.runtime, agentDir: isolated.agentDir, setWidth, restore };
	} catch (error) {
		try {
			await restore();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "UI fixture startup and cleanup failed");
		}
		throw error;
	}
}
