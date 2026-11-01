/**
 * Pure formatting helpers for download status — kept separate from the tool and
 * daemon so they are unit-testable without spawning aria2 or a TUI.
 */

import { humanSize } from "@xynogen/pix-pretty/utils";
import type { Aria2DownloadStatus } from "maria2";

/** aria2 status shape we actually read (fields are strings — bytes can exceed 2^53). */
export type DlStatus = Pick<
	Aria2DownloadStatus,
	"gid" | "status" | "totalLength" | "completedLength" | "downloadSpeed"
> & {
	files?: { path?: string; uris?: { uri: string }[] }[];
	errorMessage?: string;
};

/** Completion fraction 0..1; 0 when total is unknown/zero. */
export function fraction(s: DlStatus): number {
	const total = Number(s.totalLength);
	const done = Number(s.completedLength);
	if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(done)) return 0;
	return Math.max(0, Math.min(1, done / total));
}

/** Seconds remaining at current speed, or undefined when unknowable. */
export function etaSeconds(s: DlStatus): number | undefined {
	const total = Number(s.totalLength);
	const done = Number(s.completedLength);
	const speed = Number(s.downloadSpeed);
	if (!total || !speed || speed <= 0 || done >= total) return undefined;
	return Math.ceil((total - done) / speed);
}

function humanEta(secs: number | undefined): string {
	if (secs === undefined) return "";
	if (secs < 60) return `${secs}s`;
	if (secs < 3600) return `${Math.floor(secs / 60)}m${secs % 60}s`;
	return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
}

/** Best-effort human name for a download: file basename, else first URI, else gid. */
export function downloadName(s: DlStatus): string {
	const path = s.files?.[0]?.path;
	if (path) {
		const base = path.split(/[\\/]/).pop();
		if (base) return base;
	}
	const uri = s.files?.[0]?.uris?.[0]?.uri;
	if (uri) return uri.split("/").pop() || uri;
	return s.gid;
}

/** Compact statistics shared by tool output and live progress rows. */
export function progressStats(s: DlStatus): string {
	const pct = Math.round(fraction(s) * 100);
	const done = humanSize(Number(s.completedLength) || 0);
	const total = Number(s.totalLength) > 0 ? humanSize(Number(s.totalLength)) : "?";
	const speed = Number(s.downloadSpeed) > 0 ? `${humanSize(Number(s.downloadSpeed))}/s` : "";
	const eta = humanEta(etaSeconds(s));
	const parts = [
		Number(s.totalLength) > 0 ? `${pct}%` : "?",
		`${done}/${total}`,
		speed,
		eta && `eta ${eta}`,
	].filter(Boolean);
	return parts.join(" · ");
}

/** Plain tool output retains the handle for follow-up actions. */
export function progressLine(handle: string, s: DlStatus): string {
	return `${handle} ${downloadName(s)} · ${progressStats(s)}`;
}
