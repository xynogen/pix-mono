/**
 * models.ts — enhanced /model command with benchlm rank + score
 *
 * Takes over Pi's built-in /model name (see patch-builtin.ts). Each row shows:
 *   <name>  <provider> · <ctx> · <cost> · 🏅 #rank score
 *
 * Sorted by benchlm rank when available (best first), then alphabetical.
 */

import { modalOverlayOptions } from "@xynogen/pix-pretty/modal-frame";
import type { ExtensionAPI, ExtensionContext } from "@xynogen/pix-runtime/host";
import { ioTimeoutSignal } from "@xynogen/pix-runtime/io";
import { patchOutBuiltinModelCommand } from "./patch-builtin";
import { nonChatNotice, type PickerSource } from "./picker-rows.ts";
import { MODEL_REFRESH_TIMEOUT_MS, ModelPickerView, type ModelSource } from "./picker-view.ts";
import { registerProjectPrefs } from "./project-prefs";
import { reasoningCatalog, withReasoningLevels } from "./thinking.ts";

type ChatModels = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>;
/** PickerSource whose chat list keeps the registry's full model type for setModel. */
type ModelLists = Omit<PickerSource, "chat"> & { chat: ChatModels };

/**
 * The registry calls the picker needs. The public ExtensionContext type narrows modelRegistry;
 * at runtime it is the full registry with refresh and async availability.
 */
function modelSource(ctx: ExtensionContext) {
	type TypedModel = PickerSource["classifiers"][number];
	// SAFETY: Runtime ModelRegistry includes refresh and async availability missing from public types.
	const registry = ctx.modelRegistry as unknown as {
		refresh?: (options?: {
			force?: boolean;
			signal?: AbortSignal;
		}) => Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }> | undefined;
		getAvailable(): ChatModels | Promise<ChatModels>;
		getAvailableOfType?: (type: "classifier" | "image") => Promise<readonly TypedModel[]>;
	};
	// Classifier and image models are not chat models. Each gets its own tab so
	// they are visible but never picked as the session model.
	const loadOfType = async (type: "classifier" | "image") =>
		(await registry.getAvailableOfType?.(type).catch(() => [])) ?? [];
	const load = async (): Promise<ModelLists> => {
		const chat = await registry.getAvailable();
		const [classifiers, images] = await Promise.all([
			loadOfType("classifier"),
			loadOfType("image"),
		]);
		return { chat, classifiers, images };
	};
	return { registry, load };
}

async function showEnhancedPicker(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	initialSearch = "",
): Promise<void> {
	// Open from the current snapshot so the picker appears immediately, then refresh
	// provider catalogs in the background like Pi's built-in selector. ModelRegistry.refresh()
	// is async in Pi 1.5: getAvailable() reads the snapshot, so it must run after refresh resolves.
	const { registry, load } = modelSource(ctx);
	let lists = await load();
	if (lists.chat.length === 0) {
		await registry.refresh?.({ signal: ioTimeoutSignal(undefined, MODEL_REFRESH_TIMEOUT_MS) });
		lists = await load();
	}
	if (lists.chat.length === 0) {
		ctx.ui.notify("No models with configured auth.", "warning");
		return;
	}

	const catalog = lists.chat.some((model) => model.reasoning) ? await reasoningCatalog.get() : [];
	const source: ModelSource = {
		current: lists,
		async refresh(force, signal, closed) {
			const outcome = await registry.refresh?.({ force, signal });
			if (closed.aborted) return undefined;
			if (outcome?.aborted)
				ctx.ui.notify("Model refresh timed out; showing cached models.", "warning");
			else if (outcome?.errors.size)
				ctx.ui.notify(
					`Model refresh failed for ${[...outcome.errors.keys()].join(", ")}; showing cached models.`,
					"warning",
				);
			const next = await load();
			if (closed.aborted) return undefined;
			if (next.chat.length === 0) {
				ctx.ui.notify("No models with configured auth.", "warning");
				return undefined;
			}
			lists = next;
			return next;
		},
	};

	const result = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) =>
			new ModelPickerView({
				pi,
				ctx,
				tui,
				theme,
				source,
				current: ctx.model ? withReasoningLevels(ctx.model, catalog) : undefined,
				initialSearch,
				done,
			}),
		{ overlay: true, overlayOptions: modalOverlayOptions() },
	);
	if (result) await applySelection(pi, ctx, result, lists.chat, catalog);
}

async function applySelection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	result: string,
	available: ChatModels,
	catalog: Parameters<typeof withReasoningLevels>[1],
): Promise<void> {
	const notice = nonChatNotice(result);
	if (notice) {
		ctx.ui.notify(notice, "info");
		return;
	}

	const [provider, ...rest] = result.split("/");
	const id = rest.join("/");
	const picked = available.find((m) => m.provider === provider && m.id === id);
	if (!picked) {
		ctx.ui.notify(`Model not found: ${result}`, "error");
		return;
	}
	const enriched = withReasoningLevels(picked, catalog);
	if (!(await pi.setModel(enriched))) {
		ctx.ui.notify(`Failed to switch to ${picked.id}`, "error");
		return;
	}
	if (enriched !== picked) {
		ctx.ui.notify(`Thinking options for ${picked.id}: models.dev`, "info");
	}
	// Persistence happens in project-prefs.ts via the model_select event.
}

export default function modelPickerExtension(pi: ExtensionAPI) {
	// Route Pi's built-in /model (autocomplete entry and submit shortcut) to this picker.
	// Self-healing: re-applies on every load, so a Pi upgrade can't restore it.
	patchOutBuiltinModelCommand();

	registerProjectPrefs(pi);
	pi.registerCommand("model", {
		description: "Enhanced model picker — shows benchlm rank + score",
		handler: async (args, ctx) => {
			await showEnhancedPicker(pi, ctx, typeof args === "string" ? args.trim() : "");
		},
	});
}
