import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { type DevLinkOptions, devLink } from "./dev-link.ts";

let root = "";
let options: DevLinkOptions;
const settingsFile = () => options.settingsFile;
const sources = () =>
	(
		JSON.parse(readFileSync(settingsFile(), "utf8")).packages as Array<string | { source: string }>
	).map((p) => (typeof p === "string" ? p : p.source));
const linkedTo = (name: string, base = join(options.npmDir, "node_modules")) =>
	realpathSync(join(base, "@xynogen", name));

beforeEach(() => {
	root = mkdtempSync(join(tempDir(), "pix-dev-link-"));
	const packages: Array<[string, Record<string, string>, object?]> = [
		["pix-app", { "@xynogen/pix-lib": "^1.0.0", maria2: "^0.4.1" }, { extensions: ["./index.ts"] }],
		["pix-lib", { "@xynogen/pix-leaf": "^1.0.0" }],
		["pix-leaf", {}],
		["pix-member", {}, { extensions: ["./index.ts"] }],
		["pix-core", { "@xynogen/pix-member": "^1.0.0" }, { extensions: ["./index.ts"] }],
	];
	for (const [name, dependencies, pi] of packages) {
		mkdirSync(join(root, "packages", name), { recursive: true });
		writeFileSync(
			join(root, "packages", name, "package.json"),
			JSON.stringify({ name: `@xynogen/${name}`, version: "1.0.0", dependencies, pi }),
		);
	}
	mkdirSync(join(root, "agent"));
	options = {
		root,
		npmDir: join(root, "agent", "npm"),
		settingsFile: join(root, "agent", "settings.json"),
		unlink: false,
		names: [],
	};
	// A legacy npm entry with options: linking must keep the options and swap only the source.
	writeFileSync(
		settingsFile(),
		JSON.stringify({ packages: [{ source: "npm:@xynogen/pix-app", extensions: [] }] }),
	);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("links the selected package closure and registers it by local path", () => {
	devLink({ ...options, names: ["pix-app"] });
	for (const name of ["pix-app", "pix-lib", "pix-leaf"]) {
		const dir = realpathSync(join(root, "packages", name));
		expect(linkedTo(name)).toBe(dir);
		expect(linkedTo(name, join(root, "node_modules"))).toBe(dir);
	}
	expect(existsSync(join(options.npmDir, "node_modules", "@xynogen", "pix-core"))).toBe(false);
	const settings = JSON.parse(readFileSync(settingsFile(), "utf8"));
	expect(settings.packages).toEqual([
		{ source: join(root, "packages", "pix-app").replaceAll("\\", "/"), extensions: [] },
	]);
});

test("skips pix-core members in settings and unlink restores everything", () => {
	writeFileSync(settingsFile(), JSON.stringify({ packages: ["npm:@xynogen/pix-member"] }));
	devLink(options);
	expect(sources()).toEqual(
		["pix-app", "pix-core"].map((n) => join(root, "packages", n).replaceAll("\\", "/")),
	);
	devLink({ ...options, unlink: true });
	expect(sources()).toEqual([]);
	expect(existsSync(join(options.npmDir, "node_modules", "@xynogen", "pix-app"))).toBe(false);
	// Unlinking a junction must never delete the repo package behind it.
	expect(existsSync(join(root, "packages", "pix-app", "package.json"))).toBe(true);
});
