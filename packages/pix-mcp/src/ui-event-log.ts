import {
	getVisualizationStreamEnvelope,
	type UiHostContext,
	type UiStreamSummary,
} from "./types.ts";

const MAX_EVENT_LOG = 128;

type Entry = { id: number; name: string; payload: unknown };
/** The slice of an SSE `ServerResponse` the log uses. */
type Client = { write(chunk: string): unknown; end(): unknown };

const envelopeOf = (payload: unknown) =>
	getVisualizationStreamEnvelope(
		(payload as { structuredContent?: unknown } | null | undefined)?.structuredContent,
	);

const serialize = (entry: Entry): string =>
	`id: ${entry.id}\nevent: ${entry.name}\ndata: ${JSON.stringify(entry.payload)}\n\n`;

function initialSummary(hostContext: UiHostContext): UiStreamSummary | undefined {
	const stream = hostContext["pi-mcp-adapter/stream"];
	if (!stream || typeof stream !== "object") return undefined;
	const { streamId, mode } = stream as { streamId?: unknown; mode?: unknown };
	if (typeof streamId !== "string" || (mode !== "eager" && mode !== "stream-first"))
		return undefined;
	return { streamId, mode, frames: 0, phases: [] };
}

/**
 * Server-sent event log for one UI session: numbered events fan out to the connected
 * clients, a reconnecting client replays from its Last-Event-ID (or from the latest
 * checkpoint), and the log is pruned to the latest checkpoint once it grows past the cap.
 */
export function createEventLog(hostContext: UiHostContext, max = MAX_EVENT_LOG) {
	const clients = new Set<Client>();
	const log: Entry[] = [];
	let nextId = 1;
	let summary = initialSummary(hostContext);

	const latestCheckpoint = () => {
		for (let i = log.length - 1; i >= 0; i--) {
			const type = envelopeOf(log[i]?.payload)?.frameType;
			if (type === "checkpoint" || type === "final") return i;
		}
		return -1;
	};

	const track = (payload: unknown) => {
		const envelope = envelopeOf(payload);
		if (!envelope) return;
		summary ??= { streamId: envelope.streamId, mode: "eager", frames: 0, phases: [] };
		summary.frames += 1;
		if (!summary.phases.includes(envelope.phase)) summary.phases.push(envelope.phase);
		summary.finalStatus = envelope.status;
		summary.lastMessage = envelope.message;
	};

	const prune = () => {
		if (log.length <= max) return;
		const checkpoint = latestCheckpoint();
		if (checkpoint > 0) log.splice(0, checkpoint);
		if (log.length > max) log.splice(0, log.length - max);
	};

	return {
		clients,
		push(name: string, payload: unknown): void {
			const entry = { id: nextId++, name, payload };
			log.push(entry);
			track(payload);
			prune();
			const chunk = serialize(entry);
			for (const client of clients) {
				try {
					client.write(chunk);
				} catch {
					clients.delete(client);
				}
			}
		},
		/** Send what a (re)connecting client missed: after its last id, else from the latest checkpoint. */
		replay(res: Client, lastEventId?: string | null): void {
			const after = lastEventId ? Number(lastEventId) : Number.NaN;
			const checkpoint = latestCheckpoint();
			const entries = Number.isFinite(after)
				? log.filter((entry) => entry.id > after)
				: log.slice(Math.max(0, checkpoint));
			for (const entry of entries) {
				try {
					res.write(serialize(entry));
				} catch {
					clients.delete(res);
					return;
				}
			}
		},
		closeAll(): void {
			for (const client of clients) {
				try {
					client.end();
				} catch {
					// The socket is already gone; nothing left to close.
				}
			}
			clients.clear();
		},
		summary: (): UiStreamSummary | undefined =>
			summary ? { ...summary, phases: [...summary.phases] } : undefined,
	};
}
