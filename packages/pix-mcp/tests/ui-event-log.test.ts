import { expect, test } from "bun:test";
import { createEventLog } from "../src/ui-event-log.ts";

const frame = (frameType: "patch" | "checkpoint" | "final", sequence: number) => ({
	structuredContent: {
		"pi-mcp-adapter/stream": {
			streamId: "s1",
			sequence,
			frameType,
			phase: frameType === "final" ? "settled" : "detail",
			status: "ok",
			message: `m${sequence}`,
		},
	},
});

function client() {
	const chunks: string[] = [];
	return { chunks, write: (c: string) => chunks.push(c) > 0, end: () => {} };
}

const ids = (chunks: string[]) => chunks.map((c) => Number(/^id: (\d+)/.exec(c)?.[1]));

test("push fans out to clients and drops a client whose write throws", () => {
	const events = createEventLog({});
	const good = client();
	const bad = {
		write: () => {
			throw new Error("closed");
		},
		end: () => {},
	};
	events.clients.add(good);
	events.clients.add(bad);
	events.push("tool-input", { arguments: {} });
	expect(good.chunks).toEqual(['id: 1\nevent: tool-input\ndata: {"arguments":{}}\n\n']);
	expect(events.clients.has(bad)).toBe(false);
});

test("replay resumes after Last-Event-ID, else starts at the latest checkpoint", () => {
	const events = createEventLog({});
	events.push("tool-result", frame("patch", 1));
	events.push("tool-result", frame("checkpoint", 2));
	events.push("tool-result", frame("patch", 3));
	const resumed = client();
	events.replay(resumed, "1");
	expect(ids(resumed.chunks)).toEqual([2, 3]);
	const fresh = client();
	events.replay(fresh);
	expect(ids(fresh.chunks)).toEqual([2, 3]);
});

test("the log prunes to the latest checkpoint, then to the cap", () => {
	const events = createEventLog({}, 3);
	events.push("tool-result", frame("patch", 1));
	events.push("tool-result", frame("patch", 2));
	events.push("tool-result", frame("checkpoint", 3));
	events.push("tool-result", frame("patch", 4));
	const c = client();
	events.replay(c, "0");
	expect(ids(c.chunks)).toEqual([3, 4]);
});

test("summary tracks stream frames and returns a copy", () => {
	const events = createEventLog({
		"pi-mcp-adapter/stream": { streamId: "s1", mode: "stream-first" },
	});
	expect(events.summary()).toEqual({ streamId: "s1", mode: "stream-first", frames: 0, phases: [] });
	events.push("tool-result", frame("patch", 1));
	events.push("tool-result", frame("final", 2));
	const summary = events.summary();
	expect(summary).toMatchObject({
		frames: 2,
		phases: ["detail", "settled"],
		finalStatus: "ok",
		lastMessage: "m2",
	});
	summary?.phases.push("shell");
	expect(events.summary()?.phases).toEqual(["detail", "settled"]);
});
