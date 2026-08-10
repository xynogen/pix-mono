import type { EventBus } from "@earendil-works/pi-coding-agent";

export type PixAgentState = "working" | "blocked" | "idle";
export type PixAgentStateEvent = {
	state: PixAgentState;
	message?: string;
	activities: number;
	blocks: number;
};

type Entry = { source: string; message?: string };
type Coordinator = {
	activities: Map<symbol, Entry>;
	blocks: Map<symbol, Entry>;
};

function coordinators(): WeakMap<EventBus, Coordinator> {
	const global = globalThis as { __pixAgentState?: WeakMap<EventBus, Coordinator> };
	global.__pixAgentState ??= new WeakMap<EventBus, Coordinator>();
	return global.__pixAgentState;
}

function coordinator(events: EventBus): Coordinator {
	const registry = coordinators();
	let state = registry.get(events);
	if (!state) {
		state = { activities: new Map(), blocks: new Map() };
		registry.set(events, state);
	}
	return state;
}

function snapshot(state: Coordinator): PixAgentStateEvent {
	const blocked = [...state.blocks.values()].at(-1);
	if (blocked) {
		return {
			state: "blocked",
			...(blocked.message ? { message: blocked.message } : {}),
			activities: state.activities.size,
			blocks: state.blocks.size,
		};
	}
	const active = [...state.activities.values()].at(-1);
	if (active) {
		return {
			state: "working",
			...(active.message ? { message: active.message } : {}),
			activities: state.activities.size,
			blocks: 0,
		};
	}
	return { state: "idle", activities: 0, blocks: 0 };
}

function publish(events: EventBus): void {
	events.emit("pix:agent-state", snapshot(coordinator(events)));
}

function begin(
	events: EventBus,
	kind: "activities" | "blocks",
	source: string,
	message?: string,
): () => void {
	const state = coordinator(events);
	const token = Symbol(source);
	state[kind].set(token, { source, message });
	publish(events);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		state[kind].delete(token);
		publish(events);
	};
}

/** Keep external status integrations working while asynchronous Pix work remains. */
export function beginAgentActivity(events: EventBus, source: string, message?: string): () => void {
	return begin(events, "activities", source, message);
}

/** Internal primitive behind {@link withAgentBlock}; exported only for same-package tests. Blocks take priority over activity. */
export function beginAgentBlock(events: EventBus, source: string, message?: string): () => void {
	return begin(events, "blocks", source, message);
}

/** Hold blocked state for one prompt and always release it. */
export async function withAgentBlock<T>(
	events: EventBus,
	source: string,
	message: string | undefined,
	prompt: () => Promise<T>,
): Promise<T> {
	const release = beginAgentBlock(events, source, message);
	try {
		return await prompt();
	} finally {
		release();
	}
}

/** Bind state replay/reset to one Pi session lifecycle. */
export function bindAgentStateEvents(events: EventBus): () => void {
	const off = events.on("pix:agent-state:request", () => publish(events));
	publish(events);
	return off;
}

/** Clear stale leases when a session shuts down or an extension reloads. */
export function resetAgentState(events: EventBus): void {
	const state = coordinator(events);
	state.activities.clear();
	state.blocks.clear();
	publish(events);
}
