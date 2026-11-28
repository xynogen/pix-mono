import type {
	AssistantImages,
	ImageApi,
	ImageModel,
	ImagesContext,
	ImagesOptions,
} from "@xynogen/pix-data/ai";
import { ioTimeoutSignal } from "@xynogen/pix-runtime/io";

/** 9Router's images/generations endpoint is not an OpenRouter chat completion. */
export async function generateImages(
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
): Promise<AssistantImages> {
	const result: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};
	try {
		if (!options?.apiKey) throw new Error("9Router image generation requires an API key");
		if (context.input.some((part) => part.type === "image")) {
			throw new Error("9Router image generation does not support reference images");
		}
		const prompt = context.input
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n")
			.trim();
		if (!prompt) throw new Error("9Router image generation requires a prompt");
		const payload = { model: model.id, prompt, response_format: "b64_json" };
		const body = (await options.onPayload?.(payload, model)) ?? payload;
		const response = await (options.fetch ?? fetch)(`${model.baseUrl}/images/generations`, {
			method: "POST",
			signal: ioTimeoutSignal(options.signal, options.timeoutMs ?? 180_000),
			headers: {
				Authorization: `Bearer ${options.apiKey}`,
				"Content-Type": "application/json",
				...options.headers,
			},
			body: JSON.stringify(body),
		});
		await options.onResponse?.(
			{ status: response.status, headers: Object.fromEntries(response.headers) },
			model,
		);
		if (!response.ok) throw new Error(`9Router image generation: HTTP ${response.status}`);
		const raw: unknown = await response.json();
		if (!raw || typeof raw !== "object" || !("data" in raw) || !Array.isArray(raw.data)) {
			throw new Error("9Router image generation returned invalid data");
		}
		result.output = raw.data.flatMap((entry: unknown) => {
			if (!entry || typeof entry !== "object" || !("b64_json" in entry)) return [];
			const data = entry.b64_json;
			if (typeof data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return [];
			const bytes = Buffer.from(data, "base64");
			const mimeType = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
				? "image/png"
				: bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
					? "image/jpeg"
					: bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
						? "image/webp"
						: undefined;
			return mimeType ? [{ type: "image" as const, data, mimeType }] : [];
		});
		if (result.output.length === 0)
			throw new Error("9Router image generation returned no image data");
	} catch (error) {
		result.stopReason = options?.signal?.aborted ? "aborted" : "error";
		result.errorMessage = error instanceof Error ? error.message : String(error);
	}
	return result;
}
