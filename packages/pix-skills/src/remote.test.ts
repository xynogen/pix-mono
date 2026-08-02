import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fetchRemoteSkill,
	parseGitHubSource,
	remoteSkillsCacheRoot,
	searchRemoteSkills,
} from "./remote.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("Skills.sh search", () => {
	it("returns validated public GitHub results", async () => {
		const fetcher = (async () =>
			jsonResponse({
				skills: [
					{
						id: "nutlope/hallmark/hallmark",
						name: "hallmark",
						installs: 24849,
						source: "nutlope/hallmark",
					},
					{ id: "bad", name: "../bad", installs: 1, source: "not-a-repo" },
				],
			})) as unknown as typeof fetch;
		const results = await searchRemoteSkills("hallmark", fetcher);
		expect(results).toEqual([
			{
				name: "hallmark",
				slug: "nutlope/hallmark/hallmark",
				source: "nutlope/hallmark",
				installs: 24849,
			},
		]);
	});

	it("rejects undersized queries", async () => {
		expect(searchRemoteSkills("x")).rejects.toThrow("between 2 and 200");
	});

	it("cancels an in-flight search", async () => {
		const controller = new AbortController();
		const fetcher = ((_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
					{ once: true },
				);
			})) as typeof fetch;

		const pending = searchRemoteSkills("hallmark", fetcher, { signal: controller.signal });
		controller.abort();

		await expect(pending).rejects.toThrow("Remote request cancelled");
	});
});

describe("remote skill fetching", () => {
	it("uses Pi's flat XDG cache directory", () => {
		const previous = process.env.XDG_CACHE_HOME;
		process.env.XDG_CACHE_HOME = "/tmp/pix-xdg-cache";
		try {
			expect(remoteSkillsCacheRoot()).toBe("/tmp/pix-xdg-cache/pi/skills.sh");
		} finally {
			if (previous === undefined) delete process.env.XDG_CACHE_HOME;
			else process.env.XDG_CACHE_HOME = previous;
		}
	});

	it("parses GitHub shorthand and URLs", () => {
		expect(parseGitHubSource("nutlope/hallmark")).toEqual({ owner: "nutlope", repo: "hallmark" });
		expect(parseGitHubSource("https://github.com/nutlope/hallmark.git")).toEqual({
			owner: "nutlope",
			repo: "hallmark",
		});
		expect(() => parseGitHubSource("https://example.com/skill")).toThrow("public GitHub");
	});

	it("fetches a conventional bundle and reuses its cache", async () => {
		const root = await mkdtemp(join(tmpdir(), "pix-remote-skill-"));
		roots.push(root);
		const calls: string[] = [];
		const skill = `---\nname: hallmark\ndescription: Anti-slop design.\n---\n# Hallmark\n`;
		const fetcher = async (input: string | URL | Request) => {
			const url = String(input);
			calls.push(url);
			if (url.includes("/git/trees/HEAD")) {
				return jsonResponse({
					tree: [
						{ path: "skills/hallmark/SKILL.md", type: "blob", size: skill.length },
						{ path: "skills/hallmark/references/rules.md", type: "blob", size: 6 },
						{ path: "README.md", type: "blob", size: 100 },
					],
				});
			}
			if (url.endsWith("skills/hallmark/SKILL.md")) return new Response(skill);
			if (url.endsWith("skills/hallmark/references/rules.md")) return new Response("rules\n");
			return new Response("not found", { status: 404 });
		};

		const first = await fetchRemoteSkill("nutlope/hallmark", "hallmark", {
			cacheRoot: root,
			fetcher: fetcher as typeof fetch,
		});
		expect(first.cached).toBe(false);
		expect(await readFile(first.path, "utf-8")).toBe(skill);
		expect(await readFile(join(first.root, "references", "rules.md"), "utf-8")).toBe("rules\n");
		const callCount = calls.length;

		const second = await fetchRemoteSkill("nutlope/hallmark", "hallmark", {
			cacheRoot: root,
			fetcher: fetcher as typeof fetch,
		});
		expect(second.cached).toBe(true);
		expect(calls).toHaveLength(callCount);
	});

	it("times out a stalled remote fetch", async () => {
		const root = await mkdtemp(join(tmpdir(), "pix-remote-skill-"));
		roots.push(root);
		let aborted = false;
		const fetcher = ((_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						reject(new DOMException("Aborted", "AbortError"));
					},
					{ once: true },
				);
			})) as typeof fetch;

		await expect(
			fetchRemoteSkill("owner/repo", "hallmark", {
				cacheRoot: root,
				fetcher,
				timeoutMs: 10,
			}),
		).rejects.toThrow("Remote request timed out after 10 ms");
		expect(aborted).toBe(true);
	});

	it("requires the selected skill name to match frontmatter", async () => {
		const root = await mkdtemp(join(tmpdir(), "pix-remote-skill-"));
		roots.push(root);
		const fetcher = async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("/git/trees/HEAD")) {
				return jsonResponse({ tree: [{ path: "SKILL.md", type: "blob", size: 50 }] });
			}
			return new Response("---\nname: other\ndescription: no\n---\n");
		};
		expect(
			fetchRemoteSkill("owner/repo", "hallmark", {
				cacheRoot: root,
				fetcher: fetcher as typeof fetch,
			}),
		).rejects.toThrow('Skill "hallmark" was not found');
	});
});
