import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	type ProviderPickerOptions,
	type SettingsRow,
	showProviderPicker,
	showSettingsPicker,
} from "@xynogen/pix-pretty/provider-picker";
import { fetchConfig, saveFetchConfig } from "./config.ts";
import { listAllFetchProviders } from "./providers.ts";
import { saveSearchConfig, searchConfig } from "./search-config.ts";
import { listAllSearchProviders } from "./search-providers.ts";

type ProviderRow = { id: string; configured: boolean; env: string[] };
type ProviderConfig = { provider: string; nineRouterModel: string };
type Service = {
	kind: "fetch" | "search";
	section: string;
	config: ProviderConfig;
	save: (config: ProviderConfig) => Promise<void>;
	providers: () => ProviderRow[];
	order: string[];
	noKey: Set<string>;
};

const NINE_ROUTER = "9router";

const SERVICES: Service[] = [
	{
		kind: "search",
		section: "Web search",
		config: searchConfig,
		save: saveSearchConfig,
		providers: listAllSearchProviders,
		order: [
			"searxng",
			"9router",
			"exa",
			"tavily",
			"perplexity",
			"serper",
			"brave-search",
			"youcom",
			"google-pse",
			"searchapi",
			"linkup",
			"xquik",
			"ollama-search",
		],
		noKey: new Set(["searxng"]),
	},
	{
		kind: "fetch",
		section: "Web fetch",
		config: fetchConfig,
		save: saveFetchConfig,
		providers: listAllFetchProviders,
		order: ["curl", "jina-reader", "9router"],
		noKey: new Set(["curl", "jina-reader"]),
	},
];

const LEGACY_ENV: Record<string, string> = {
	NINEROUTER_URL: "ROUTER_API_BASE",
	NINEROUTER_KEY: "ROUTER_API_KEY",
};

function envExample(name: string): string {
	if (name === "SEARXNG_URL") return `export ${name}="https://search.example.com"`;
	if (name === "GOOGLE_PSE_CX") return `export ${name}="your-search-engine-id"`;
	return name.endsWith("_URL")
		? `export ${name}="https://9router.example.com/v1"`
		: `export ${name}="your-api-key"`;
}

function providerRows(service: Service): ProviderRow[] {
	const rank = (id: string) => {
		const index = service.order.indexOf(id);
		return index === -1 ? service.order.length : index;
	};
	const providers = service.providers().sort((a, b) => rank(a.id) - rank(b.id));
	return [{ id: "auto", configured: true, env: [] }, ...providers];
}

/** Provider value plus its status color, the same as the /voice overview. */
function providerValue(service: Service): Pick<SettingsRow, "value" | "tone"> {
	const id = service.config.provider;
	if (id === "auto") return { value: "auto \u00b7 first configured", tone: "success" };
	const row = service.providers().find((provider) => provider.id === id);
	if (!row) return { value: `${id} \u00b7 not registered`, tone: "warning" };
	if (!row.configured) return { value: `${id} \u00b7 set ${row.env.join(", ")}`, tone: "warning" };
	const status = service.noKey.has(id) ? "no API key needed" : "connected";
	return { value: `${id} \u00b7 ${status}`, tone: "success" };
}

function pickerOptions(service: Service): ProviderPickerOptions {
	return {
		title: `${icon("settings")} ${service.section}`,
		subtitle: `Default ${service.kind} provider \u00b7 shell variables \u00b7 provider settings`,
		rows: providerRows(service).map((row) => ({
			...row,
			noKey: service.noKey.has(row.id),
			model: row.id === NINE_ROUTER ? service.config.nineRouterModel : undefined,
		})),
		current: service.config.provider,
		envAliases: LEGACY_ENV,
		envExample,
	};
}

async function editService(ctx: ExtensionContext, service: Service): Promise<void> {
	while (true) {
		const action = await showProviderPicker(ctx.ui, pickerOptions(service));
		if (!action) return;
		if (action.kind === "model") {
			service.config.nineRouterModel = action.value;
			await service.save(service.config);
			continue;
		}
		service.config.provider = action.id;
		await service.save(service.config);
		return;
	}
}

function settingsRows(): SettingsRow[] {
	return SERVICES.flatMap((service) => [
		{
			key: `${service.kind}:provider`,
			section: service.section,
			label: "provider",
			...providerValue(service),
		},
		{
			key: `${service.kind}:model`,
			section: service.section,
			label: "9router model",
			value: service.config.nineRouterModel,
			tone: service.config.provider === NINE_ROUTER ? "success" : "muted",
			editable: true,
		},
	]);
}

export function registerWebCommand(pi: ExtensionAPI): void {
	pi.registerCommand("web", {
		description: "Set the default web search and fetch providers and 9Router models",
		handler: async (_args, ctx) => {
			if (typeof ctx.ui.custom !== "function") {
				for (const service of SERVICES) {
					const provider = await ctx.ui.select(
						`Default ${service.kind} provider`,
						providerRows(service).map(({ id }) => id),
					);
					if (!provider) return;
					service.config.provider = provider;
					await service.save(service.config);
				}
				return;
			}
			let cursor = 0;
			while (true) {
				// The modal stays open for model edits. It closes only to open the provider tree.
				const action = await showSettingsPicker(ctx.ui, {
					title: `${icon("settings")} Web Settings`,
					rows: settingsRows,
					selected: cursor,
					onAction: async ({ key, value }) => {
						const [kind, field] = key.split(":");
						if (field === "provider") return "close";
						const service = SERVICES.find((item) => item.kind === kind);
						if (!service || !value) return undefined;
						service.config.nineRouterModel = value;
						await service.save(service.config);
						return undefined;
					},
				});
				if (!action) return;
				cursor = settingsRows().findIndex((row) => row.key === action.key);
				const service = SERVICES.find((item) => action.key.startsWith(`${item.kind}:`));
				if (service) await editService(ctx, service);
			}
		},
	});
}
