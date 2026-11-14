import { expect, test } from "bun:test";
import { resourceNameToToolName } from "../src/resource-tools.ts";

test("resourceNameToToolName makes a lower-case identifier that never starts with a digit", () => {
	expect(resourceNameToToolName("  My Docs/README.md ")).toBe("my_docs_readme_md");
	expect(resourceNameToToolName("2024 report")).toBe("resource_2024_report");
	expect(resourceNameToToolName("!!!")).toBe("resource");
});
