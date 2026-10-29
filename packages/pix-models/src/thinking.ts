import type { Api, Model } from "@earendil-works/pi-ai";
import { CACHE_DIR, DataSource } from "@xynogen/pix-data";

type EffortEntry = { provider: string; id: string; levels: string[] };

export function parseEfforts(raw: unknown): EffortEntry[] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new Error("Invalid models.dev catalog");
	const entries: EffortEntry[] = [];
	for (const [provider, value] of Object.entries(raw)) {
		if (!value || typeof value !== "object" || !("models" in value)) continue;
		const models = value.models;
		if (!models || typeof models !== "object" || Array.isArray(models)) continue;
		for (const [id, model] of Object.entries(models)) {
			if (
				!model ||
				typeof model !== "object" ||
				!("reasoning_options" in model) ||
				!Array.isArray(model.reasoning_options)
			)
				continue;
			const effort = model.reasoning_options.find(
				(option: unknown) =>
					option && typeof option === "object" && "type" in option && option.type === "effort",
			);
			if (
				!effort ||
				!Array.isArray(effort.values) ||
				!effort.values.length ||
				!effort.values.every((level: unknown) => typeof level === "string")
			)
				continue;
			entries.push({ provider, id, levels: [...new Set<string>(effort.values)] });
		}
	}
	return entries;
}

// Fetch only when /models is opened; reuse the shared disk cache and network timeout.
export const reasoningCatalog = new DataSource<EffortEntry[]>({
	label: "models.dev reasoning levels",
	url: "https://models.dev/api.json",
	cachePath: `${CACHE_DIR}/models-dev-reasoning.json`,
	parse: parseEfforts,
	parseCache: parseEfforts,
	empty: [],
});

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const normalize = (id: string) =>
	id
		.slice(id.lastIndexOf("/") + 1)
		.toLowerCase()
		.replace(/[._]/g, "-");

/** Unknown or conflicting gateway aliases keep Pi's own level map; never guess by family. */
export function withReasoningLevels<T extends Model<Api>>(model: T, catalog: EffortEntry[]): T {
	if (!model.reasoning || model.thinkingLevelMap) return model;
	const providerEntries = catalog.filter((entry) => entry.provider === model.provider);
	const candidates = providerEntries.length ? providerEntries : catalog;
	const exact = candidates.filter((entry) => entry.id === model.id);
	const matches = exact.length
		? exact
		: candidates.filter((entry) => normalize(entry.id) === normalize(model.id));
	const first = matches[0];
	const allowed = new Set<string>([...LEVELS, "none", "min"]);
	if (first?.levels.some((level) => !allowed.has(level))) return model;
	if (
		!first ||
		matches.some(
			(entry) =>
				entry.levels.length !== first.levels.length ||
				entry.levels.some((level) => !first.levels.includes(level)),
		)
	)
		return model;
	const thinkingLevelMap = Object.fromEntries(
		LEVELS.map((level) => {
			const wire =
				level === "off"
					? "none"
					: level === "minimal" && first.levels.includes("min")
						? "min"
						: level;
			return [level, first.levels.includes(wire) ? wire : null];
		}),
	);
	if (!Object.values(thinkingLevelMap).some((value) => value !== null)) return model;
	return { ...model, thinkingLevelMap };
}
