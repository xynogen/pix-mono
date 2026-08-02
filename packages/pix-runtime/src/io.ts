import { config } from "./runtime.ts";
import { ioSection } from "./sections/io.ts";

export function ioTimeoutMs(): number {
	return config(ioSection).timeoutSec * 1000;
}

export function ioTimeoutSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(ioTimeoutMs());
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
