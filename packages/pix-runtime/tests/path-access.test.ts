import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
	PATH_ACCESS,
	type PathRequest,
	requestPathAccess,
	withPathAccess,
} from "../src/path-access.ts";

function send(port: number, message: unknown): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1", () => socket.end(`${JSON.stringify(message)}\n`));
		let response = "";
		socket.on("data", (chunk) => {
			response += chunk.toString();
		});
		socket.on("error", reject);
		socket.on("close", () => resolve(response));
	});
}

describe("path access channel", () => {
	test("no policy is allowed; registered policy owns the answer", async () => {
		const events = createEventBus();
		const request = { paths: ["/project/a"], op: "read", context: {} } as PathRequest;
		expect((await requestPathAccess(events, request)).approved).toBe(true);
		events.on(PATH_ACCESS, (raw) => {
			(raw as PathRequest).decision = Promise.resolve({ approved: false, reason: "denied" });
		});
		expect(await requestPathAccess(events, request)).toEqual({ approved: false, reason: "denied" });
	});

	test("authenticated requests receive policy decisions", async () => {
		let calls = 0;
		await withPathAccess(
			async (access) => {
				calls++;
				expect(access.paths).toEqual(["/project/.env"]);
				expect(access.op).toBe("read");
				return { approved: false, reason: "secret" };
			},
			async ({ port, token }) => {
				const response = await send(port, { token, paths: ["/project/.env"], op: "read" });
				expect(JSON.parse(response)).toEqual({ approved: false, reason: "secret" });
			},
		);
		expect(calls).toBe(1);
	});

	test("bad tokens and malformed paths never reach policy", async () => {
		let calls = 0;
		await withPathAccess(
			async () => {
				calls++;
				return { approved: true, reason: "ok" };
			},
			async ({ port, token }) => {
				for (const message of [
					null,
					{ token: "wrong", paths: ["/a"], op: "read" },
					{ token, paths: [], op: "read" },
					{ token, paths: ["bad\0path"], op: "read" },
					{ token, paths: ["/a"], op: "execute" },
				]) {
					expect(JSON.parse(await send(port, message)).approved).toBe(false);
				}
			},
		);
		expect(calls).toBe(0);
	});

	test("run failures close the listener; pre-aborted runs do not start", async () => {
		let port = 0;
		await expect(
			withPathAccess(
				async () => ({ approved: true, reason: "ok" }),
				async (endpoint) => {
					port = endpoint.port;
					throw new Error("run failed");
				},
			),
		).rejects.toThrow("run failed");
		await expect(send(port, {})).rejects.toThrow();
		let started = false;
		await expect(
			withPathAccess(
				async () => ({ approved: true, reason: "ok" }),
				async () => {
					started = true;
				},
				AbortSignal.abort(new Error("stop")),
			),
		).rejects.toThrow("stop");
		expect(started).toBe(false);
	});
});
