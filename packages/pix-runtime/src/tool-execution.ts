export interface ToolExecutionContext<U> {
	update(value: U): void;
	onCleanup(cleanup: () => void): void;
}

/** Foreground call scope. The operation must forward signal and await its own process cleanup. */
export async function runToolExecution<R, U, E>(options: {
	signal?: AbortSignal;
	onUpdate?: (value: U) => void;
	execute: (scope: ToolExecutionContext<U>) => Promise<R>;
	onError: (error: unknown, cancelled: boolean) => E;
}): Promise<R | E> {
	const cleanups: Array<() => void> = [];
	let finished = false;
	let result!: R;
	let failure: { error: unknown } | undefined;
	const cleanupErrors: unknown[] = [];
	try {
		options.signal?.throwIfAborted();
		result = await options.execute({
			update(value) {
				if (!finished && !options.signal?.aborted) options.onUpdate?.(value);
			},
			onCleanup(cleanup) {
				if (finished) cleanup();
				else cleanups.push(cleanup);
			},
		});
		options.signal?.throwIfAborted();
	} catch (error) {
		failure = { error };
	} finally {
		finished = true;
		for (const cleanup of cleanups.reverse()) {
			try {
				cleanup();
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
	}
	if (cleanupErrors.length) {
		failure = {
			error: new AggregateError(
				[...(failure ? [failure.error] : []), ...cleanupErrors],
				"Tool execution cleanup failed",
			),
		};
	}
	if (failure) {
		return options.onError(
			failure.error,
			cleanupErrors.length === 0 && options.signal?.aborted === true,
		);
	}
	return result;
}
