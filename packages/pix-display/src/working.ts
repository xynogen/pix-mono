import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "@xynogen/pix-pretty/widget-format";

export default function workingExtension(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | undefined;

	const stop = (_event: unknown, ctx: ExtensionContext): void => {
		if (timer === undefined) return;
		clearInterval(timer);
		timer = undefined;
		ctx.ui.setWorkingMessage();
	};

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		stop(_event, ctx);
		const startedAt = performance.now();
		const tick = () => {
			const elapsed = Math.floor((performance.now() - startedAt) / 1000) * 1000;
			ctx.ui.setWorkingMessage(
				`Working (${elapsed === 0 ? "0s" : formatDuration(elapsed, "btw")})`,
			);
		};
		tick();
		timer = setInterval(tick, 1000);
		timer.unref();
	});
	pi.on("agent_end", stop);
	pi.on("session_shutdown", stop);
}
