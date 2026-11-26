import { expect, test } from "bun:test";
import { nativeMethodKey, wrapMethod } from "../src/patch.ts";

class Base {
	greet(name: string) {
		return `hi ${name}`;
	}
}
class Child extends Base {}

test("wraps with the original bound to the instance", () => {
	class A {
		n = 2;
		twice(x: number) {
			return x * this.n;
		}
	}
	expect(
		wrapMethod(
			A.prototype,
			"twice",
			(native) =>
				function (this: A, x: number) {
					return native.call(this, x) + 1;
				},
		),
	).toBe(true);
	expect(new A().twice(3)).toBe(7);
});

test("re-wrapping replaces the old wrapper instead of stacking", () => {
	class A {
		v() {
			return "n";
		}
	}
	wrapMethod(
		A.prototype,
		"v",
		(native) =>
			function (this: A) {
				return `[${native.call(this)}]`;
			},
	);
	wrapMethod(
		A.prototype,
		"v",
		(native) =>
			function (this: A) {
				return `(${native.call(this)})`;
			},
	);
	expect(new A().v()).toBe("(n)");
});

test("a missing method is left alone", () => {
	const target = {};
	expect(wrapMethod(target, "nope", (native) => native)).toBe(false);
	expect(Reflect.ownKeys(target)).toEqual([]);
});

test("a parent's saved original is not reused by a subclass", () => {
	wrapMethod(
		Base.prototype,
		"greet",
		(native) =>
			function (this: Base, n: string) {
				return `base:${native.call(this, n)}`;
			},
	);
	wrapMethod(
		Child.prototype,
		"greet",
		(native) =>
			function (this: Child, n: string) {
				return `child:${native.call(this, n)}`;
			},
	);
	expect(new Child().greet("x")).toBe("child:base:hi x");
	expect(Object.hasOwn(Child.prototype, nativeMethodKey("greet"))).toBe(true);
});
