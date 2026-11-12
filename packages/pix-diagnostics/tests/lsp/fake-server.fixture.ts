/**
 * fake-server.fixture.ts — a minimal push-only LSP server used by tests.
 *
 * It answers `initialize`, `shutdown`, and `textDocument/definition`, and it
 * publishes one diagnostic per opened/changed document with the document's
 * version. It has NO real language intelligence. Flags mimic real servers:
 * `--incremental` (ranged didChange), `--unversioned` (no publish version, like
 * typescript-language-server), `--delay=<ms>` (late publish), `--echo` (the
 * message is the document text). `pix/text` returns the text the server holds.
 * Tests launch it with the Bun runtime.
 *
 * This file is a fixture, not a production module. It is not exported by the
 * package. It lives beside the transport so tests can point Bun at it.
 */

import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";

const connection = createMessageConnection(
	new StreamMessageReader(process.stdin),
	new StreamMessageWriter(process.stdout),
);

const versions = new Map<string, number>();
const texts = new Map<string, string>();
const has = (flag: string) => process.argv.includes(flag);
const delayMs = Number(process.argv.find((a) => a.startsWith("--delay="))?.slice(8) ?? 0);

interface Position {
	line: number;
	character: number;
}

function offsetAt(text: string, pos: Position): number {
	let offset = 0;
	for (let line = 0; line < pos.line; line++) {
		const nl = text.indexOf("\n", offset);
		if (nl === -1) return text.length;
		offset = nl + 1;
	}
	return offset + pos.character;
}

function publish(uri: string, version: number): void {
	if (delayMs > 0) setTimeout(() => sendPublish(uri, version), delayMs);
	else sendPublish(uri, version);
}

function sendPublish(uri: string, version: number): void {
	connection.sendNotification("textDocument/publishDiagnostics", {
		uri: process.argv.includes("--encoded-uri")
			? uri.replace(
					/^file:\/\/\/([A-Z]):/i,
					(_all, drive: string) => `file:///${drive.toLowerCase()}%3A`,
				)
			: uri,
		version: has("--unversioned") ? undefined : version,
		diagnostics: has("--empty")
			? []
			: [
					{
						range: { start: { line: 0, character: 12 }, end: { line: 0, character: 17 } },
						severity: 1,
						message: has("--echo") ? (texts.get(uri) ?? "") : "Type mismatch",
						source: "fake",
						code: 1,
					},
				],
	});
}

connection.onRequest("initialize", () =>
	// --hang-init: never answer, to exercise the client's handshake deadline.
	has("--hang-init")
		? new Promise(() => {})
		: {
				capabilities: {
					textDocumentSync: has("--incremental") ? 2 : 1,
					definitionProvider: true,
					positionEncoding: "utf-16",
				},
			},
);

// Never answers: exercises the client's per-request deadline and abort.
connection.onRequest("pix/hang", () => new Promise(() => {}));

connection.onNotification("initialized", () => {});

connection.onNotification(
	"textDocument/didOpen",
	(params: { textDocument: { uri: string; version: number; text: string } }) => {
		const { uri, version, text } = params.textDocument;
		versions.set(uri, version);
		texts.set(uri, text);
		publish(uri, version);
	},
);

connection.onNotification(
	"textDocument/didChange",
	(params: {
		textDocument: { uri: string; version: number };
		contentChanges: Array<{ text: string; range?: { start: Position; end: Position } }>;
	}) => {
		const { uri, version } = params.textDocument;
		let text = texts.get(uri) ?? "";
		for (const change of params.contentChanges) {
			if (!change.range) {
				text = change.text;
				continue;
			}
			const start = offsetAt(text, change.range.start);
			text = text.slice(0, start) + change.text + text.slice(offsetAt(text, change.range.end));
		}
		versions.set(uri, version);
		texts.set(uri, text);
		publish(uri, version);
	},
);

connection.onRequest("pix/text", (params: { uri: string }) => texts.get(params.uri) ?? null);

connection.onNotification("textDocument/didClose", (params: { textDocument: { uri: string } }) => {
	versions.delete(params.textDocument.uri);
	texts.delete(params.textDocument.uri);
});

connection.onRequest("textDocument/definition", (params: { textDocument: { uri: string } }) => [
	{
		uri: params.textDocument.uri,
		range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
	},
]);

connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));

connection.listen();
