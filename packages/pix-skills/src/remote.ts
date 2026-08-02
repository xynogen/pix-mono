import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const SKILLS_SH = "https://skills.sh";
const GITHUB_API = "https://api.github.com";
const RAW_GITHUB = "https://raw.githubusercontent.com";
const MAX_FILES = 100;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
const SLUG = /^[a-z0-9](?:[a-z0-9._-]{0,99})$/i;

export interface RemoteSkillSearchResult {
	name: string;
	slug: string;
	source: string;
	installs: number;
}

export interface RemoteSkillEntry {
	name: string;
	path: string;
	root: string;
	source: string;
	cached: boolean;
}

type FetchLike = typeof fetch;

type RemoteRequestOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
};

async function withRemoteDeadline<T>(
	options: RemoteRequestOptions,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const controller = new AbortController();
	let timedOut = false;
	const cancel = () => controller.abort(options.signal?.reason);

	if (options.signal?.aborted) cancel();
	else options.signal?.addEventListener("abort", cancel, { once: true });

	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	timer.unref?.();

	try {
		if (controller.signal.aborted) throw new Error("Remote request cancelled");
		return await operation(controller.signal);
	} catch (error) {
		if (timedOut) {
			const duration = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} seconds` : `${timeoutMs} ms`;
			throw new Error(`Remote request timed out after ${duration}`);
		}
		if (options.signal?.aborted) throw new Error("Remote request cancelled");
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
	}
}

function validatePart(value: string, label: string): string {
	const trimmed = value.trim();
	if (!SLUG.test(trimmed) || trimmed === "." || trimmed === "..") {
		throw new Error(`Invalid ${label}: ${value}`);
	}
	return trimmed;
}

export function parseGitHubSource(source: string): { owner: string; repo: string } {
	const normalized = source
		.trim()
		.replace(/^https:\/\/github\.com\//i, "")
		.replace(/\.git$/i, "")
		.replace(/\/$/, "");
	const parts = normalized.split("/");
	if (parts.length !== 2) throw new Error("Remote source must be a public GitHub owner/repo");
	return {
		owner: validatePart(parts[0] ?? "", "GitHub owner"),
		repo: validatePart(parts[1] ?? "", "GitHub repository"),
	};
}

export function remoteSkillsCacheRoot(): string {
	const cacheHome = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
	return join(cacheHome, "pi", "skills.sh");
}

export async function searchRemoteSkills(
	query: string,
	fetcher: FetchLike = fetch,
	options: RemoteRequestOptions = {},
): Promise<RemoteSkillSearchResult[]> {
	const trimmed = query.trim();
	if (trimmed.length < 2 || trimmed.length > 200) {
		throw new Error("Skills.sh search query must be between 2 and 200 characters");
	}
	return withRemoteDeadline(options, async (signal) => {
		const url = `${SKILLS_SH}/api/search?${new URLSearchParams({ q: trimmed, limit: "10" })}`;
		const response = await fetcher(url, {
			headers: { Accept: "application/json" },
			signal,
		});
		if (!response.ok) throw new Error(`Skills.sh search failed (${response.status})`);
		const data = (await response.json()) as {
			skills?: Array<{ id?: unknown; name?: unknown; installs?: unknown; source?: unknown }>;
		};
		return (data.skills ?? []).flatMap((skill) => {
			if (
				typeof skill.id !== "string" ||
				typeof skill.name !== "string" ||
				typeof skill.source !== "string"
			)
				return [];
			try {
				parseGitHubSource(skill.source);
				validatePart(skill.name, "skill name");
				return [
					{
						name: skill.name,
						slug: skill.id,
						source: skill.source,
						installs: typeof skill.installs === "number" ? skill.installs : 0,
					},
				];
			} catch {
				return [];
			}
		});
	});
}

function frontmatterName(content: string): string | null {
	const block = content.match(/^---\s*\n([\s\S]*?)\n---/);
	const match = block?.[1]?.match(/^name\s*:\s*["']?(.+?)["']?\s*$/m);
	return match?.[1]?.trim() ?? null;
}

async function fetchBytes(
	fetcher: FetchLike,
	url: string,
	signal: AbortSignal,
	maxBytes = MAX_FILE_BYTES,
): Promise<Buffer> {
	const response = await fetcher(url, {
		headers: { Accept: "application/vnd.github+json" },
		signal,
	});
	if (!response.ok) throw new Error(`Remote request failed (${response.status}): ${url}`);
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (declared > maxBytes) throw new Error(`Remote file exceeds ${maxBytes} byte limit`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.byteLength > maxBytes) throw new Error(`Remote file exceeds ${maxBytes} byte limit`);
	return bytes;
}

async function fetchText(
	fetcher: FetchLike,
	url: string,
	signal: AbortSignal,
	maxBytes = MAX_FILE_BYTES,
): Promise<string> {
	return (await fetchBytes(fetcher, url, signal, maxBytes)).toString("utf-8");
}

function safeDestination(root: string, relativePath: string): string {
	const destination = resolve(root, ...relativePath.split("/"));
	const rel = relative(resolve(root), destination);
	if (!rel || rel.startsWith("..") || rel.includes("\\")) throw new Error("Unsafe remote path");
	return destination;
}

async function fetchRemoteSkillWithSignal(
	source: string,
	name: string,
	options: { refresh?: boolean; fetcher?: FetchLike; cacheRoot?: string },
	signal: AbortSignal,
): Promise<RemoteSkillEntry> {
	const { owner, repo } = parseGitHubSource(source);
	const skillName = validatePart(name, "skill name");
	const cacheRoot = options.cacheRoot ?? remoteSkillsCacheRoot();
	const target = join(cacheRoot, owner.toLowerCase(), repo.toLowerCase(), skillName);
	const cachedSkill = join(target, "SKILL.md");
	if (!options.refresh && existsSync(cachedSkill)) {
		return {
			name: skillName,
			path: cachedSkill,
			root: target,
			source: `${owner}/${repo}`,
			cached: true,
		};
	}

	const fetcher = options.fetcher ?? fetch;
	const treeText = await fetchText(
		fetcher,
		`${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/HEAD?recursive=1`,
		signal,
		MAX_BUNDLE_BYTES,
	);
	let tree: {
		truncated?: boolean;
		tree?: Array<{ path?: unknown; type?: unknown; size?: unknown }>;
	};
	try {
		tree = JSON.parse(treeText) as typeof tree;
	} catch {
		throw new Error("GitHub returned an invalid repository tree");
	}
	if (tree.truncated)
		throw new Error("GitHub repository tree is truncated; refusing incomplete skill");
	const files = (tree.tree ?? []).filter(
		(item): item is { path: string; type: "blob"; size?: number } =>
			item.type === "blob" && typeof item.path === "string",
	);
	const candidates = files.filter(
		(file) => file.path.endsWith("/SKILL.md") || file.path === "SKILL.md",
	);

	let skillPath: string | null = null;
	let skillContent: string | null = null;
	for (const candidate of candidates) {
		if ((candidate.size ?? 0) > MAX_FILE_BYTES) continue;
		const raw = `${RAW_GITHUB}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/HEAD/${candidate.path
			.split("/")
			.map(encodeURIComponent)
			.join("/")}`;
		const content = await fetchText(fetcher, raw, signal);
		if (frontmatterName(content) === skillName) {
			skillPath = candidate.path;
			skillContent = content;
			break;
		}
	}
	if (!skillPath || skillContent === null) {
		throw new Error(`Skill "${skillName}" was not found in ${owner}/${repo}`);
	}

	const bundleRoot = dirname(skillPath) === "." ? "" : dirname(skillPath);
	const prefix = bundleRoot ? `${bundleRoot}/` : "";
	const allowed = files.filter((file) => {
		if (!file.path.startsWith(prefix)) return false;
		const rel = file.path.slice(prefix.length);
		return (
			rel === "SKILL.md" ||
			rel.startsWith("references/") ||
			rel.startsWith("scripts/") ||
			rel.startsWith("assets/")
		);
	});
	if (allowed.length > MAX_FILES) throw new Error(`Remote skill exceeds ${MAX_FILES} file limit`);
	const declaredBytes = allowed.reduce((sum, file) => sum + (file.size ?? 0), 0);
	if (declaredBytes > MAX_BUNDLE_BYTES) {
		throw new Error(`Remote skill exceeds ${MAX_BUNDLE_BYTES} byte bundle limit`);
	}

	const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
	await rm(temporary, { recursive: true, force: true });
	let writtenBytes = 0;
	try {
		for (const file of allowed) {
			signal.throwIfAborted();
			const rel = file.path.slice(prefix.length);
			const destination = safeDestination(temporary, rel);
			await mkdir(dirname(destination), { recursive: true });
			let content: Buffer;
			if (rel === "SKILL.md") content = Buffer.from(skillContent, "utf-8");
			else {
				const raw = `${RAW_GITHUB}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/HEAD/${file.path
					.split("/")
					.map(encodeURIComponent)
					.join("/")}`;
				content = await fetchBytes(fetcher, raw, signal);
			}
			writtenBytes += content.byteLength;
			if (writtenBytes > MAX_BUNDLE_BYTES) {
				throw new Error(`Remote skill exceeds ${MAX_BUNDLE_BYTES} byte bundle limit`);
			}
			await writeFile(destination, content, { mode: 0o600 });
		}
		await mkdir(dirname(target), { recursive: true });
		await rm(target, { recursive: true, force: true });
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { recursive: true, force: true });
		throw error;
	}

	const cached = await readFile(cachedSkill, "utf-8");
	if (frontmatterName(cached) !== skillName) throw new Error("Cached skill failed validation");
	return {
		name: skillName,
		path: cachedSkill,
		root: target,
		source: `${owner}/${repo}`,
		cached: false,
	};
}

export async function fetchRemoteSkill(
	source: string,
	name: string,
	options: {
		refresh?: boolean;
		fetcher?: FetchLike;
		cacheRoot?: string;
		signal?: AbortSignal;
		timeoutMs?: number;
	} = {},
): Promise<RemoteSkillEntry> {
	return withRemoteDeadline(options, (signal) =>
		fetchRemoteSkillWithSignal(source, name, options, signal),
	);
}
