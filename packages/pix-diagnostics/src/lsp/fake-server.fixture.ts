/**
 * fake-server.fixture.ts — a minimal push-only LSP server used by tests.
 *
 * It answers `initialize`, `shutdown`, and `textDocument/definition`, and it
 * publishes one diagnostic per opened/changed document with the document's
 * version. It has NO real language intelligence. Tests write it to a temp path
 * and launch it with the Bun runtime.
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

function publish(uri: string, version: number): void {
	connection.sendNotification("textDocument/publishDiagnostics", {
		uri: process.argv.includes("--encoded-uri")
			? uri.replace(
					/^file:\/\/\/([A-Z]):/i,
					(_all, drive: string) => `file:///${drive.toLowerCase()}%3A`,
				)
			: uri,
		version,
		diagnostics: process.argv.includes("--empty")
			? []
			: [
					{
						range: { start: { line: 0, character: 12 }, end: { line: 0, character: 17 } },
						severity: 1,
						message: "Type mismatch",
						source: "fake",
						code: 1,
					},
				],
	});
}

connection.onRequest("initialize", () => ({
	capabilities: {
		textDocumentSync: 1,
		definitionProvider: true,
		positionEncoding: "utf-16",
	},
}));

connection.onNotification("initialized", () => {});

connection.onNotification(
	"textDocument/didOpen",
	(params: { textDocument: { uri: string; version: number } }) => {
		const { uri, version } = params.textDocument;
		versions.set(uri, version);
		publish(uri, version);
	},
);

connection.onNotification(
	"textDocument/didChange",
	(params: { textDocument: { uri: string; version: number } }) => {
		const { uri, version } = params.textDocument;
		versions.set(uri, version);
		publish(uri, version);
	},
);

connection.onNotification("textDocument/didClose", (params: { textDocument: { uri: string } }) => {
	versions.delete(params.textDocument.uri);
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
