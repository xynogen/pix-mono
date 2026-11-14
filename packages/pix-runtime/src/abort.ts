import { setImmediate } from "node:timers/promises";
import { getErrorMessage } from "./errors.ts";

/** Subscribe once, including signals aborted before subscription. Always release on completion. */
export function onAbort(signal: AbortSignal | undefined, cancel: () => void): () => void {
	if (signal?.aborted) cancel();
	else signal?.addEventListener("abort", cancel, { once: true });
	return () => signal?.removeEventListener("abort", cancel);
}

/** Stop waiting even when a provider cannot cancel its underlying operation. */
export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	return await new Promise<T>((resolve, reject) => {
		const cleanup = onAbort(signal, () => reject(signal.reason));
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}

/** Yield to terminal input between CPU/file batches, then reject before more work or writes. */
export async function cancellationCheckpoint(signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	await setImmediate(undefined, { signal });
	signal?.throwIfAborted();
}

/** True when `signal` fired or `error` reads as an abort (hosts reject with plain "aborted" errors). */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	return /aborted/i.test(getErrorMessage(error));
}
