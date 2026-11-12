/**
 * Per-host credentials and connection prep. The cache is session-scoped and in
 * memory only: passwords are never persisted, and a process exit clears them.
 */

import { existsSync } from "@xynogen/pix-runtime/fs";
import { closeMaster, type HostSpec, probeKeyAuth, probePasswordAuth, probeSftp } from "./lib.ts";

/** Min gap between key re-checks on a host whose login password is cached.
 * Each failed probe is one auth failure in the server log (fail2ban counts it). */
const KEY_RECHECK_MS = 60_000;

export interface HostCreds {
	loginPassword?: string;
	sudoPassword?: string;
}
/** Key = canonical "user@host:port" (see cacheKey). */
export const credCache = new Map<string, HostCreds>();
/** Per-host epoch ms before which the cached-password key re-check is skipped. */
export const keyRecheckAt = new Map<string, number>();

export function cacheKey(spec: HostSpec): string {
	return `${spec.user ?? ""}@${spec.host}:${spec.port ?? 22}`;
}

export function probeConnection(
	spec: HostSpec,
	controlPath: string,
	sig: AbortSignal | undefined,
	files: boolean,
) {
	return files ? probeSftp(spec, "none", sig) : probeKeyAuth(spec, controlPath, sig);
}

/** Pre-run connection prep: honor `fresh`, re-check the key, and report
 * whether the run will reuse a live master. Checked before the auth probes,
 * which open a master themselves. */
export async function prepareConnection(
	spec: HostSpec,
	controlPath: string,
	key: string,
	creds: HostCreds,
	fresh: boolean | undefined,
	sig?: AbortSignal,
	files = false,
): Promise<{ creds: HostCreds; connection: "new" | "reused" }> {
	if (fresh === true) await closeMaster(spec, controlPath, sig);
	const next = await recheckKey(spec, controlPath, key, creds, fresh === true, sig, files);
	if (files) return { creds: next, connection: "new" };
	return { creds: next, connection: existsSync(controlPath) ? "reused" : "new" };
}

export function authVia(loginPassword: string | undefined, connection: "new" | "reused") {
	return { auth: loginPassword ? "password" : "key", connection } as const;
}

/**
 * A cached login password means the live master is likely password-authed, so a
 * normal probe would ride it and never test the key. Re-check the key with
 * multiplexing off (rate-limited by KEY_RECHECK_MS unless `force`); on success
 * drop the password and its master so this call and later ones use the key.
 */
async function recheckKey(
	spec: HostSpec,
	controlPath: string,
	key: string,
	creds: HostCreds,
	force: boolean,
	sig?: AbortSignal,
	files = false,
): Promise<HostCreds> {
	if (!creds.loginPassword) return creds;
	if (!force && (keyRecheckAt.get(key) ?? 0) > Date.now()) return creds;
	if ((await probeConnection(spec, "none", sig, files)) !== "ok") {
		keyRecheckAt.set(key, Date.now() + KEY_RECHECK_MS);
		return creds;
	}
	const next = creds.sudoPassword ? { sudoPassword: creds.sudoPassword } : {};
	credCache.set(key, next);
	keyRecheckAt.delete(key);
	await closeMaster(spec, controlPath, sig);
	return next;
}

/**
 * Overlay password validator for a prompt stage. The login stage tests the
 * password against the host (wrong one re-prompts up to MAX_PASSWORD_ATTEMPTS);
 * the sudo stage can't be probed before login, so it only rejects a blank entry
 * and surfaces a real failure on the run.
 */
export function validatorFor(
	stage: "login" | "sudo",
	spec: HostSpec,
	controlPath: string,
	sig?: AbortSignal,
	files = false,
): (pw: string, validationSignal?: AbortSignal) => Promise<boolean> {
	if (stage !== "login") return (pw) => Promise.resolve(pw.trim().length > 0);
	if (files)
		return async (pw, validationSignal) =>
			Boolean(pw.trim()) && (await probeSftp(spec, "none", validationSignal ?? sig, pw)) !== "auth";
	return (pw, validationSignal) =>
		pw.trim().length === 0
			? Promise.resolve(false)
			: probePasswordAuth(spec, controlPath, pw, validationSignal ?? sig);
}
