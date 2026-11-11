/** net.ts — network primitives for feature packages (IP checks, DNS, loopback servers). */

import { createServer } from "node:net";

export { lookup as dnsLookup } from "node:dns/promises";
export {
	createServer as createHttpServer,
	type IncomingMessage,
	type Server as HttpServer,
	type ServerResponse,
} from "node:http";
export { isIP } from "node:net";

/** Ask the OS for a free loopback TCP port. Not held: another process can take it before use. */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (addr && typeof addr === "object") {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close(() => reject(new Error("could not resolve a free port")));
			}
		});
	});
}
