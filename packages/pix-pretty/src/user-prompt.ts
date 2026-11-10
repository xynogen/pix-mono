import type { EventBus } from "@earendil-works/pi-coding-agent";
import { withAgentBlock } from "@xynogen/pix-runtime";
import { modalOverlayOptions } from "./modal-frame.ts";

export interface UserPromptState {
	events: EventBus;
	source: string;
	message?: string;
}

export interface UserPromptOptions {
	overlay?: boolean;
	overlayOptions?: ReturnType<typeof modalOverlayOptions>;
	blocked?: { kind: "permission" | "auth" | "question"; message: string };
}

/** Keep native terminal status and Pix notifications scoped to the same prompt. */
export function withUserPrompt<T>(
	blocked: NonNullable<UserPromptOptions["blocked"]>,
	open: (options: UserPromptOptions) => Promise<T>,
	state?: UserPromptState,
): Promise<T> {
	const prompt = () => open({ overlay: true, overlayOptions: modalOverlayOptions(), blocked });
	return state
		? withAgentBlock(state.events, state.source, state.message ?? blocked.message, prompt)
		: prompt();
}
