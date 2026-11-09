import { onAbort } from "@xynogen/pix-runtime/abort";

/** Overlay lifetime with exactly-once completion; UI policy and timers stay with each component. */
export function createOverlayLifecycle<T>() {
	const controller = new AbortController();
	let done: ((value: T) => void) | undefined;
	let result: { value: T } | undefined;
	let notified = false;
	const notify = () => {
		if (!done || !result || notified) return;
		notified = true;
		done(result.value);
	};
	const dispose = () => controller.abort();
	return {
		get closed() {
			return controller.signal.aborted;
		},
		onCleanup(cleanup: () => void) {
			onAbort(controller.signal, cleanup);
		},
		bind(callback: (value: T) => void) {
			done = callback;
			notify();
		},
		finish(value: T) {
			if (controller.signal.aborted) return;
			result = { value };
			dispose();
			notify();
		},
		dispose,
	};
}
