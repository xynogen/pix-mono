import { defineSection, enumOr, isObj, posNumOr } from "../schema.ts";

export type IconMode = "nerd" | "unicode" | "ascii";
export type LsStyle = "grid" | "tree";
export type RenderSize = number | `${number}%`;

export interface DiffConfig {
	splitMinWidth: number;
	splitMinCodeWidth: number;
}

export interface PrettyConfig {
	icons: IconMode;
	lsStyle: LsStyle;
	maxRenderWidth: RenderSize;
	maxRenderHeight: RenderSize;
	maxPreviewLines: number;
	maxRenderLines: number;
	maxHighlightChars: number;
	cacheLimit: number;
	diff: DiffConfig;
}

const ICON_MODES: readonly IconMode[] = ["nerd", "unicode", "ascii"];
const LS_STYLES: readonly LsStyle[] = ["grid", "tree"];

function renderSizeOr(value: unknown, fallback: RenderSize): RenderSize {
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : fallback;
	if (typeof value !== "string") return fallback;
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (!match) return fallback;
	const percent = Number(match[1]);
	return percent > 0 && percent <= 100 ? (value as `${number}%`) : fallback;
}

const DEFAULTS: Readonly<PrettyConfig> = {
	icons: "nerd",
	lsStyle: "grid",
	maxRenderWidth: "65%",
	maxRenderHeight: "80%",
	maxPreviewLines: 80,
	maxRenderLines: 150,
	maxHighlightChars: 80_000,
	cacheLimit: 128,
	diff: { splitMinWidth: 150, splitMinCodeWidth: 60 },
};

export const prettySection = defineSection<"pretty", PrettyConfig>({
	key: "pretty",
	defaults: DEFAULTS,
	parse(raw) {
		if (!isObj(raw)) return { ...DEFAULTS, diff: { ...DEFAULTS.diff } };
		const rawDiff = isObj(raw.diff) ? raw.diff : {};
		return {
			icons: enumOr(raw.icons, ICON_MODES, DEFAULTS.icons),
			lsStyle: enumOr(raw.lsStyle, LS_STYLES, DEFAULTS.lsStyle),
			maxRenderWidth: renderSizeOr(raw.maxRenderWidth, DEFAULTS.maxRenderWidth),
			maxRenderHeight: renderSizeOr(raw.maxRenderHeight, DEFAULTS.maxRenderHeight),
			maxPreviewLines: posNumOr(raw.maxPreviewLines, DEFAULTS.maxPreviewLines),
			maxRenderLines: posNumOr(raw.maxRenderLines, DEFAULTS.maxRenderLines),
			maxHighlightChars: posNumOr(raw.maxHighlightChars, DEFAULTS.maxHighlightChars),
			cacheLimit: posNumOr(raw.cacheLimit, DEFAULTS.cacheLimit),
			diff: {
				splitMinWidth: posNumOr(rawDiff.splitMinWidth, DEFAULTS.diff.splitMinWidth),
				splitMinCodeWidth: posNumOr(rawDiff.splitMinCodeWidth, DEFAULTS.diff.splitMinCodeWidth),
			},
		};
	},
});
