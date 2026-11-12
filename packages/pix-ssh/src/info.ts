/** The read-only `info` action: SSH config report, no connection, no approval. */

import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import {
	type HostAlias,
	type HostInfo,
	type HostSpec,
	hostTarget,
	parseHost,
	readSshConfigAliases,
	resolveHostInfo,
} from "./lib.ts";

function formatHostInfo(host: string, info: HostInfo): string {
	const rows = [
		["HostName", info.hostname],
		["User", info.user],
		["Port", info.port],
		["ProxyJump", info.proxyJump && info.proxyJump !== "none" ? info.proxyJump : undefined],
		["IdentityFile", info.identityFile],
	].filter((r): r is [string, string] => Boolean(r[1]));
	if (rows.length === 0) return `No SSH config found for ${host}.`;
	return [`Effective SSH config for ${host}:`, ...rows.map(([k, v]) => `${k} ${v}`)].join("\n");
}

function formatAliasList(aliases: HostAlias[]): string {
	if (aliases.length === 0) {
		return "No SSH host aliases found in ~/.ssh/config.";
	}
	// De-dupe by alias, first block wins (OpenSSH semantics).
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const a of aliases) {
		if (seen.has(a.alias)) continue;
		seen.add(a.alias);
		let target = "";
		if (a.hostname) {
			const userPart = a.user ? `${a.user}@` : "";
			const portPart = a.port ? `:${a.port}` : "";
			target = `${userPart}${a.hostname}${portPart}`;
		}
		const via = a.proxyJump && a.proxyJump !== "none" ? ` via ${a.proxyJump}` : "";
		lines.push(`${a.alias}${target ? ` → ${target}` : ""}${via}`);
	}
	return [`SSH host aliases (${lines.length}):`, ...lines].join("\n");
}

/** Build the info-action result: per-host effective config when `host` is
 * given, otherwise the alias inventory from ~/.ssh/config. Read-only.
 * Details carry `_type: "sshInfo"` + `host` for the collapsed row. */
export async function infoResult(host: string | undefined, sig?: AbortSignal) {
	const details = { _type: "sshInfo" as const, host: host?.trim() || "aliases" };
	if (host?.trim()) {
		let spec: HostSpec;
		try {
			spec = parseHost(host);
		} catch (err) {
			const msg = getErrorMessage(err);
			return {
				content: [{ type: "text" as const, text: `ssh_run failed: ${msg}` }],
				details,
				isError: true,
			};
		}
		const info = await resolveHostInfo(spec, sig);
		const text = formatHostInfo(hostTarget(spec), info);
		return { content: [{ type: "text" as const, text }], details: { ...details, info } };
	}
	const aliases = readSshConfigAliases();
	return {
		content: [{ type: "text" as const, text: formatAliasList(aliases) }],
		details: { ...details, aliases },
	};
}
