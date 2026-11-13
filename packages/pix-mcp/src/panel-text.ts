/** panel-text.ts — terminal-safe text for the MCP panels: strip control codes, read typed keys. */

import { decodeKittyPrintable } from "@xynogen/pix-pretty/tui";

const OSC = /(?:\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x9d[\s\S]*?(?:\x07|\x1b\\|\x9c))/;
const CSI = /(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_])/;

/** One line of untrusted text (server names, errors, paths): no escapes, no controls. */
export function sanitizeDisplayText(text: string | null | undefined): string {
	return (text ?? "")
		.replace(new RegExp(OSC.source, "g"), "")
		.replace(new RegExp(CSI.source, "g"), "")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * A panel row we styled ourselves: keep our SGR/CSI styling, drop OSC (links, titles), and
 * collapse other control characters to one space. Newlines stay: tool rows embed them as
 * hang-indent wrap points that frameModal splits on.
 */
export function sanitizeRowContent(content: string): string {
	const osc = new RegExp(`^${OSC.source}`);
	const csi = new RegExp(`^${CSI.source}`);
	let result = "";
	let pendingSpace = false;
	for (let i = 0; i < content.length; i++) {
		const rest = content.slice(i);
		const oscMatch = rest.match(osc);
		if (oscMatch) {
			i += oscMatch[0].length - 1;
			continue;
		}
		const csiMatch = rest.match(csi);
		if (csiMatch) {
			result += csiMatch[0];
			i += csiMatch[0].length - 1;
			continue;
		}
		const code = content.charCodeAt(i);
		if (code === 0x0a) {
			result += "\n";
			pendingSpace = false;
			continue;
		}
		if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			pendingSpace = true;
			continue;
		}
		if (pendingSpace && result && !result.endsWith(" ")) result += " ";
		pendingSpace = false;
		result += content[i];
	}
	return result;
}

function isPrintableCharacter(value: string): boolean {
	const characters = [...value];
	if (characters.length !== 1) return false;
	const codePoint = characters[0]?.codePointAt(0);
	return (
		codePoint !== undefined &&
		codePoint >= 32 &&
		codePoint !== 127 &&
		!(codePoint >= 128 && codePoint <= 159)
	);
}

/**
 * The typed character for a key event, or undefined for a non-printable key. Kitty CSI-u
 * keys decode first (`decodeKittyPrintable`); the length check is the legacy-terminal path.
 */
export function printableChar(data: string): string | undefined {
	const decoded = decodeKittyPrintable(data);
	if (decoded !== undefined && isPrintableCharacter(decoded)) return decoded;
	if (isPrintableCharacter(data)) return data;
	return undefined;
}
