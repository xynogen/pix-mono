import { randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onAbort } from "./abort.ts";
import { ioTimeoutMs } from "./io.ts";

export interface PathAccess {
	paths: string[];
	op: "read" | "write";
	signal?: AbortSignal;
}

export interface PathDecision {
	approved: boolean;
	reason: string;
}

export interface PathRequest extends PathAccess {
	context: ExtensionContext;
	decision?: Promise<PathDecision>;
}

export const PATH_ACCESS = "pix:path-access";

/** The policy owner answers synchronously with a promise; no installed gate means no policy. */
export async function requestPathAccess(
	events: EventBus,
	request: PathRequest,
): Promise<PathDecision> {
	events.emit(PATH_ACCESS, request);
	return (await request.decision) ?? { approved: true, reason: "No path gate installed" };
}

/** Private loopback channel for a child that must wait before accessing a path. */
export async function withPathAccess<T>(
	decide: (access: PathAccess) => Promise<PathDecision>,
	run: (endpoint: { port: number; token: string }) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	const token = randomBytes(32).toString("hex");
	const lifetime = new AbortController();
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.setEncoding("utf8");
		socket.setTimeout(ioTimeoutMs(), () => socket.destroy());
		socket.on("error", () => socket.destroy());
		socket.on("close", () => sockets.delete(socket));
		let pending = "";
		let busy = false;
		socket.on("data", (chunk) => {
			pending += chunk;
			if (busy || Buffer.byteLength(pending) > 65_536) return socket.destroy();
			if (!pending.endsWith("\n")) return;
			busy = true;
			void (async () => {
				try {
					const message = JSON.parse(pending);
					pending = "";
					if (
						message.token !== token ||
						!["read", "write"].includes(message.op) ||
						!Array.isArray(message.paths) ||
						message.paths.length === 0 ||
						message.paths.length > 8 ||
						!message.paths.every(
							(p: unknown) => typeof p === "string" && p.length > 0 && !p.includes("\0"),
						)
					)
						throw new Error("Invalid path request");
					socket.setTimeout(0);
					const decision = await decide({
						paths: message.paths,
						op: message.op,
						signal: lifetime.signal,
					});
					if (!socket.destroyed) socket.end(`${JSON.stringify(decision)}\n`);
				} catch {
					if (!socket.destroyed)
						socket.end(`${JSON.stringify({ approved: false, reason: "Path gate failed" })}\n`);
				}
			})();
		});
	});
	const close = () => {
		lifetime.abort(new Error("Path gate closed"));
		for (const socket of sockets) socket.destroy();
		server.close();
	};
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const detach = onAbort(signal, close);
		try {
			signal?.throwIfAborted();
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Path gate did not start");
			return await run({ port: address.port, token });
		} finally {
			detach();
		}
	} finally {
		close();
	}
}
