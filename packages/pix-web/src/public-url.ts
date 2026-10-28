import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { ioTimeoutSignal } from "@xynogen/pix-runtime/io";

function blockedIpv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
		return false;
	const [a, b, c] = parts as [number, number, number, number];
	return (
		a === 0 || // "this" network
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
		(a === 169 && b === 254) || // link-local, cloud metadata
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && c === 0) || // IETF protocol assignments
		(a === 198 && (b === 18 || b === 19)) || // benchmarking
		a >= 224 // multicast, reserved, broadcast
	);
}

function ipv6Groups(address: string): number[] | undefined {
	const value = address.toLowerCase().replace(/^\[|\]$/g, "");
	const halves = value.split("::");
	if (halves.length > 2) return undefined;
	const read = (part: string) =>
		part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [];
	const head = read(halves[0] ?? "");
	const tail = read(halves[1] ?? "");
	if ([...head, ...tail].some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff))
		return undefined;
	const missing = 8 - head.length - tail.length;
	if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
	return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

function blockedIp(address: string): boolean {
	const value = address.toLowerCase().replace(/^\[|\]$/g, "");
	if (isIP(value) === 4) return blockedIpv4(value);
	if (isIP(value) !== 6) return false;
	const groups = ipv6Groups(value);
	if (!groups) return false;
	const first = groups[0] ?? 0;
	if (groups.slice(0, 7).every((group) => group === 0) && (groups[7] ?? 0) <= 1) return true;
	if (first >= 0xfc00 && first <= 0xfdff) return true; // unique local
	if ((first & 0xffc0) === 0xfe80) return true; // link-local
	if (first >= 0xff00) return true; // multicast
	if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
		return blockedIpv4(
			`${(groups[6] ?? 0) >> 8}.${(groups[6] ?? 0) & 255}.${(groups[7] ?? 0) >> 8}.${(groups[7] ?? 0) & 255}`,
		);
	}
	return false;
}

// ponytail: checks the address, then fetch() resolves again, so a DNS-rebinding
// host can still swap to an internal IP between the two. Pin the checked IP with
// a custom-lookup dispatcher if this guards anything more sensitive than reads.
async function assertPublicUrl(url: string): Promise<void> {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
		throw new Error("Fetch URL must use HTTP or HTTPS");
	const host = parsed.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/, "");
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		blockedIp(host)
	)
		throw new Error("Blocked URL: internal host");
	if (isIP(host)) return;
	let addresses: { address: string; family: number }[];
	try {
		addresses = await dns.lookup(host, { all: true, verbatim: true });
	} catch (err) {
		// Fail closed: an unverified host must not be fetched. fetch() would hit
		// the same resolver, so this only blocks what could not be checked.
		const code = (err as NodeJS.ErrnoException).code ?? "lookup failed";
		throw new Error(`Blocked URL: could not resolve ${host} (${code})`);
	}
	if (addresses.some(({ address }) => blockedIp(address)))
		throw new Error("Blocked URL: hostname resolves to an internal host");
}

export async function fetchPublic(
	url: string,
	init: RequestInit,
	maxRedirects = 5,
): Promise<Response> {
	let current = url;
	// One deadline for the whole redirect chain, from the io.timeoutSec setting.
	const signal = ioTimeoutSignal(init.signal ?? undefined);
	for (let hop = 0; ; hop++) {
		await assertPublicUrl(current);
		const response = await fetch(current, { ...init, signal, redirect: "manual" });
		const location =
			response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
		if (!location) return response;
		if (hop >= maxRedirects) throw new Error("Blocked URL: too many redirects");
		current = new URL(location, current).toString();
	}
}
