import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { isPackageLoaded, once } from "../src/once.ts";

function host(bus: EventEmitter) {
	const unsubscribe: (() => void)[] = [];
	return {
		events: {
			emit: (channel: string, data: unknown) => {
				bus.emit(channel, data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				bus.on(channel, handler);
				unsubscribe.push(() => bus.off(channel, handler));
			},
		},
		dispose: () => {
			for (const off of unsubscribe) off();
		},
	};
}

describe("package presence through once", () => {
	it("queries existing registrations across distinct extension APIs without registering again", () => {
		const bus = new EventEmitter();
		const first = host(bus);
		const second = host(bus);
		let calls = 0;
		expect(isPackageLoaded(second, "pix-todo")).toBe(false);
		once(first, "pix-todo", () => calls++);
		once(first, "pix-todo", () => calls++);
		expect(calls).toBe(1);
		expect(isPackageLoaded(first, "pix-todo")).toBe(true);
		expect(isPackageLoaded(second, "pix-todo")).toBe(true);
		expect(isPackageLoaded(second, "pix-missing")).toBe(false);
		expect(isPackageLoaded(host(new EventEmitter()), "pix-todo")).toBe(false);
		first.dispose();
		expect(isPackageLoaded(second, "pix-todo")).toBe(false);
		once(host(bus), "pix-todo", () => calls++);
		expect(isPackageLoaded(second, "pix-todo")).toBe(true);
		expect(calls).toBe(2);
	});

	it("supports hosts without an event bus and tolerates unrelated event payloads", () => {
		const pi = {};
		once(pi, "pix-local", () => {});
		expect(isPackageLoaded(pi, "pix-local")).toBe(true);
		expect(isPackageLoaded({}, "pix-local")).toBe(false);
		const bus = new EventEmitter();
		const api = host(bus);
		once(api, "pix-test", () => {});
		for (const data of [null, 1, {}, { key: 1 }, { key: "pix-test" }]) {
			expect(() => bus.emit("pix:package-loaded", data)).not.toThrow();
		}
		expect(isPackageLoaded(api, "pix-test")).toBe(true);
	});
});
