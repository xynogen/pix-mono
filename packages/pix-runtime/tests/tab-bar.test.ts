import { afterEach, expect, test } from "bun:test";
import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import { isSubTabKey, nextTab, renderSubTabBar, renderTabBar } from "../src/tab-bar.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => `*${t}*` };

afterEach(() => setKittyProtocolActive(false));

test("renders every tab when it fits", () => {
	expect(renderTabBar(["A", "B"], "B", theme, 80)).toBe("  A  │*  B  *");
});

test("a narrow bar shows the current tab with neighbours and marks hidden sides", () => {
	const names = ["One", "Two", "Three", "Four", "Five"];
	expect(renderTabBar(names, "One", theme, 20)).toBe("*  One  *│  Two  ›");
	expect(renderTabBar(names, "Three", theme, 30)).toBe("‹  Two  │*  Three  *│  Four  ›");
	expect(renderTabBar(names, "Five", theme, 20)).toBe("‹  Four  │*  Five  *");
	// Too narrow for any neighbour: the current tab alone, still marked on both sides.
	expect(renderTabBar(names, "Three", theme, 5)).toBe("‹*  Three  *›");
});

test("sub-tabs are chips, unlike the top bar, and fit the same way", () => {
	expect(renderSubTabBar(["Core", "Packages"], "Core", theme, 80)).toBe("  ● *Core*   ○ Packages");
	expect(renderSubTabBar(["Core", "Packages"], "Core", theme, 80)).not.toContain("│");
	expect(renderSubTabBar(["Appearance", "Footer", "Behaviour"], "Behaviour", theme, 27)).toBe(
		"  ‹○ Footer   ● *Behaviour*",
	);
});

test("nextTab wraps and falls back to the first", () => {
	expect(nextTab(["A", "B", "C"], "C")).toBe("A");
	expect(nextTab(["A", "B"], "A")).toBe("B");
	expect(nextTab(["A", "B"], "gone")).toBe("A");
});

test("backtick is the sub-tab key in legacy and Kitty encodings; ~ and tab are not", () => {
	expect(isSubTabKey("`")).toBe(true);
	expect(isSubTabKey("~")).toBe(false);
	expect(isSubTabKey("\t")).toBe(false);
	setKittyProtocolActive(true);
	expect(isSubTabKey("\x1b[96u")).toBe(true);
	expect(isSubTabKey("\x1b[126u")).toBe(false);
	expect(isSubTabKey("\x1b[96:126;2u")).toBe(false);
});
