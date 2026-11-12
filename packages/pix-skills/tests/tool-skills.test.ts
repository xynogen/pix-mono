import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanSiblingPackageSkills } from "../src/index.ts";

const packagesDir = join(import.meta.dir, "..", "..");

// A package's own tool skill is named after the package, so read_skills(name="<package>") always finds it.
test("package tool skills are named after their package and found by read_skills", () => {
	const owners = readdirSync(packagesDir).filter((dir) => {
		if (dir === "pix-skills") return false;
		try {
			const manifest = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
			return Array.isArray(manifest.pi?.skills);
		} catch {
			return false;
		}
	});
	expect(owners.length).toBeGreaterThan(0);
	const found = new Set(scanSiblingPackageSkills(packagesDir).map((skill) => skill.name));
	for (const dir of owners) {
		const file = join(packagesDir, dir, "skills", `${dir}.md`);
		expect(readFileSync(file, "utf8")).toMatch(new RegExp(`^---\\nname: ${dir}\\n`));
		expect(found.has(dir)).toBe(true);
	}
});
