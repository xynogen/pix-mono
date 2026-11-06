/**
 * Centralized logging for MCP UI operations.
 * Provides structured, contextual logs with levels.
 */

import { format } from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LogContext {
	server?: string;
	session?: string;
	tool?: string;
	uri?: string;
	[key: string]: unknown;
}

export interface LogEntry {
	level: LogLevel;
	message: string;
	context?: LogContext;
	error?: Error;
	timestamp: Date;
}

type LogHandler = (entry: LogEntry) => void;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
	// "silent" sits above every emittable level, so shouldLog() is always false
	// when it is the minimum — a full off switch (used to mute expected errors).
	silent: 4,
};

const LEVEL_PREFIX: Record<LogLevel, string> = {
	debug: "[MCP-UI:DEBUG]",
	info: "[MCP-UI]",
	warn: "[MCP-UI:WARN]",
	error: "[MCP-UI:ERROR]",
	silent: "",
};

class Logger {
	private minLevel: LogLevel = "info";
	private handlers: LogHandler[] = [];
	private defaultContext: LogContext = {};
	// Raw console output bleeds into the active TUI. index.ts turns it off in UI
	// mode and routes warn/error to the transient slot instead.
	private consoleOutput = true;

	setLevel(level: LogLevel): void {
		this.minLevel = level;
	}

	setConsoleOutput(enabled: boolean): void {
		this.consoleOutput = enabled;
	}

	setDefaultContext(context: LogContext): void {
		this.defaultContext = context;
	}

	addHandler(handler: LogHandler): () => void {
		this.handlers.push(handler);
		return () => {
			this.handlers = this.handlers.filter((current) => current !== handler);
		};
	}

	clearHandlers(): void {
		this.handlers = [];
	}

	private shouldLog(level: LogLevel): boolean {
		return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
	}

	private emit(level: LogLevel, message: string, context?: LogContext, error?: Error): void {
		if (!this.shouldLog(level)) return;

		const entry: LogEntry = {
			level,
			message,
			context: { ...this.defaultContext, ...context },
			error,
			timestamp: new Date(),
		};

		// Default console output
		if (this.consoleOutput) {
			const prefix = LEVEL_PREFIX[level];
			const contextStr = formatContext(entry.context);
			const fullMessage = contextStr
				? `${prefix} ${message} ${contextStr}`
				: `${prefix} ${message}`;

			if (level === "error") {
				console.error(fullMessage, error ?? "");
			} else if (level === "warn") {
				console.warn(fullMessage);
			} else if (level === "debug") {
				console.debug(fullMessage);
			} else {
				console.log(fullMessage);
			}
		}

		// Custom handlers
		for (const handler of this.handlers) {
			try {
				handler(entry);
			} catch {
				// Ignore handler errors
			}
		}
	}

	debug(message: string, context?: LogContext): void {
		this.emit("debug", message, context);
	}

	info(message: string, context?: LogContext): void {
		this.emit("info", message, context);
	}

	warn(message: string, context?: LogContext): void {
		this.emit("warn", message, context);
	}

	error(message: string, error?: Error, context?: LogContext): void {
		this.emit("error", message, context, error);
	}

	/**
	 * Create a child logger with additional default context.
	 */
	child(context: LogContext): ChildLogger {
		return new ChildLogger(this, context);
	}
}

class ChildLogger {
	constructor(
		private parent: Logger,
		private context: LogContext,
	) {}

	debug(message: string, context?: LogContext): void {
		this.parent.debug(message, { ...this.context, ...context });
	}

	info(message: string, context?: LogContext): void {
		this.parent.info(message, { ...this.context, ...context });
	}

	warn(message: string, context?: LogContext): void {
		this.parent.warn(message, { ...this.context, ...context });
	}

	error(message: string, error?: Error, context?: LogContext): void {
		this.parent.error(message, error, { ...this.context, ...context });
	}

	child(context: LogContext): ChildLogger {
		return new ChildLogger(this.parent, { ...this.context, ...context });
	}
}

function formatContext(context?: LogContext): string {
	if (!context || Object.keys(context).length === 0) return "";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(context)) {
		if (value !== undefined && value !== null) {
			parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
		}
	}
	return parts.length > 0 ? `(${parts.join(", ")})` : "";
}

// Singleton instance
export const logger = new Logger();

/** Route SDK diagnostics through the existing logger without capturing other extensions. */
export function routeSdkDiagnostics(): () => void {
	const restore = (["warn", "error"] as const).map((level) => {
		const original = console[level];
		const routed = (...args: unknown[]) => {
			// ponytail: only SDK-prefixed diagnostics; unprefixed third-party logs need a host-level logging hook.
			if (typeof args[0] !== "string" || !args[0].startsWith("[mcp-sdk]")) {
				original.apply(console, args);
				return;
			}
			logger[level](format(...args));
		};
		console[level] = routed;
		return () => {
			if (console[level] === routed) console[level] = original;
		};
	});
	return () => {
		for (const reset of restore) reset();
	};
}

// Enable debug mode via environment variable
if (process.env.MCP_UI_DEBUG === "1" || process.env.MCP_UI_DEBUG === "true") {
	logger.setLevel("debug");
}
