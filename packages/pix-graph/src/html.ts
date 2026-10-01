import type { GraphData } from "./analyzer.ts";

// ponytail: vis-network loads from a CDN, like graphify. The page needs network the first time.
// Vendor the file next to graph.html if you need offline viewing.
const VIS_URL = "https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js";
const VIS_SRI = "sha384-yxKDWWf0wwdUj/gPeuL11czrnKFQROnLgY8ll7En9NYoXibgg3C6NK/UDHNtUgWJ";

/** Compact page payload: arrays by index, so a 4.5k-node graph stays under ~600 KB. */
export interface GraphPageData {
	/** Relation names, indexed by `links[i][2]`. */
	rels: string[];
	/** `[label, community index, file:line]`. */
	nodes: [string, number, string][];
	/** `[source node index, target node index, relation index]`. */
	links: [number, number, number][];
	/** `[name, member count]`, largest first. Index = community index. */
	groups: [string, number][];
}

/** Escape JSON for an inline <script>: `<` stops `</script>` and `<!--` from ending the block. */
function inlineJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/\u2028|\u2029/g, " ");
}

/** Name a community after the folder most of its members live in, e.g. `pix-graph/src`. */
function groupName(files: string[], fallback: string): string {
	const counts = new Map<string, number>();
	for (const f of files) {
		const dir = f.split("/").slice(-3, -1).join("/") || f;
		counts.set(dir, (counts.get(dir) ?? 0) + 1);
	}
	let best = fallback;
	let max = 0;
	for (const [dir, n] of counts) if (n > max) [best, max] = [dir, n];
	return best;
}

/** Reduce a graph to the compact page payload. Drops self-loops and dangling links. */
export function graphPageData(graph: GraphData): GraphPageData {
	const byCommunity = new Map<number, number[]>();
	graph.nodes.forEach((n, i) => {
		const c = n.community ?? -1;
		const list = byCommunity.get(c);
		if (list) list.push(i);
		else byCommunity.set(c, [i]);
	});
	const ordered = [...byCommunity].sort((a, b) => b[1].length - a[1].length);
	const groupOf = new Map<number, number>();
	const groups: [string, number][] = ordered.map(([c, members], gi) => {
		for (const i of members) groupOf.set(i, gi);
		const files = members.map((i) => graph.nodes[i]?.source_file).filter((f): f is string => !!f);
		return [`${groupName(files, `community ${c}`)} #${gi}`, members.length];
	});

	const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
	const nodes = graph.nodes.map((n, i): [string, number, string] => {
		const loc = n.source_file
			? `${n.source_file}${n.source_location ? `:${n.source_location}` : ""}`
			: n.id;
		return [n.label, groupOf.get(i) ?? 0, loc];
	});
	const rels: string[] = [];
	const relIndex = new Map<string, number>();
	const links: [number, number, number][] = [];
	for (const l of graph.links) {
		const s = index.get(l.source);
		const t = index.get(l.target);
		if (s === undefined || t === undefined || s === t) continue;
		let r = relIndex.get(l.relation);
		if (r === undefined) {
			r = rels.push(l.relation) - 1;
			relIndex.set(l.relation, r);
		}
		links.push([s, t, r]);
	}
	return { rels, nodes, links, groups };
}

/**
 * Interactive view of a graph. It opens on one bubble per community, so the first paint lays out
 * a few hundred nodes, not thousands. Double-click a bubble (or pick it in the list) to show its
 * members. Search finds any node and opens its community.
 */
export function renderGraphHtml(graph: GraphData, title = "pix-graph"): string {
	const safeTitle = title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<script src="${VIS_URL}" integrity="${VIS_SRI}" crossorigin="anonymous" defer></script>
<style>
:root { color-scheme: light dark; --bg: #fafafa; --fg: #222; --dim: #666; --line: #ddd; --panel: #fff; --hi: #2563eb; }
@media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #ddd; --dim: #888; --line: #333; --panel: #181818; --hi: #60a5fa; } }
* { box-sizing: border-box; }
body { margin: 0; display: grid; grid-template-columns: 1fr 340px; height: 100vh; font: 13px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
#graph { position: relative; min-width: 0; }
#loading { position: absolute; inset: 0; display: grid; place-items: center; color: var(--dim); }
aside { display: flex; flex-direction: column; gap: 8px; padding: 12px; overflow: hidden; border-left: 1px solid var(--line); background: var(--panel); }
header { display: flex; gap: 8px; align-items: center; }
h1 { flex: 1; margin: 0; font-size: 15px; }
h2 { margin: 8px 0 4px; font-size: 13px; color: var(--dim); font-weight: 600; }
input, button { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
input { width: 100%; }
button { cursor: pointer; } button:hover, button:focus-visible { border-color: var(--hi); }
button[hidden] { display: none; }
.muted { color: var(--dim); }
code { word-break: break-all; color: var(--hi); }
ul { list-style: none; margin: 0; padding: 0; overflow: auto; }
#groups { flex: 1; min-height: 120px; }
#info ul { max-height: 30vh; }
li button { width: 100%; text-align: left; border: 0; border-radius: 4px; padding: 3px 6px; display: flex; gap: 6px; background: none; }
li button:hover, li button:focus-visible { background: var(--bg); outline: 1px solid var(--hi); }
.dot { width: 10px; height: 10px; border-radius: 50%; flex: none; margin-top: 4px; }
.grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
</head>
<body>
<main id="graph" aria-label="Code graph"><div id="loading">Loading graph…</div></main>
<aside>
<header><h1 id="title">Communities</h1><button id="back" type="button" hidden>← All</button></header>
<label class="muted" for="q">Search any node</label>
<input id="q" type="search" placeholder="name, then Enter" list="hits" autocomplete="off">
<datalist id="hits"></datalist>
<div class="muted" id="stats"></div>
<div id="info" aria-live="polite"></div>
<h2 id="listTitle">Communities</h2>
<ul id="groups"></ul>
</aside>
<script>
const DATA = ${inlineJson(graphPageData(graph))};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => "&#" + c.charCodeAt(0) + ";");
const color = (g) => "hsl(" + ((g * 137.508) % 360) + ",60%,52%)";
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const font = { color: dark ? "#ddd" : "#222", strokeWidth: 3, strokeColor: dark ? "#111" : "#fafafa" };
const members = DATA.groups.map(() => []);
DATA.nodes.forEach((n, i) => members[n[1]].push(i));
const degree = new Uint32Array(DATA.nodes.length);
for (const [s, t] of DATA.links) { degree[s]++; degree[t]++; }
let net, view = -1;

function draw(nodes, edges, options) {
	if (net) net.destroy();
	net = new vis.Network($("graph"), { nodes, edges }, {
		nodes: { shape: "dot", font, scaling: { min: 4, max: 44, label: { enabled: true, min: 11, max: 28, drawThreshold: 8 } } },
		edges: { smooth: false, color: { inherit: "from", opacity: 0.35 }, selectionWidth: 2 },
		physics: { solver: "barnesHut", barnesHut: { gravitationalConstant: -6000, springLength: 140 }, stabilization: { iterations: 120, updateInterval: 40 } },
		interaction: { hover: true, tooltipDelay: 120, hideEdgesOnDrag: true, hideEdgesOnZoom: true },
		layout: { improvedLayout: false },
		...options,
	});
	net.once("stabilizationIterationsDone", () => net.setOptions({ physics: false }));
	$("loading")?.remove();
}

function overview() {
	view = -1;
	const weights = new Map();
	for (const [s, t] of DATA.links) {
		const a = DATA.nodes[s][1], b = DATA.nodes[t][1];
		if (a === b) continue;
		const key = a < b ? a + "," + b : b + "," + a;
		weights.set(key, (weights.get(key) ?? 0) + 1);
	}
	const nodes = DATA.groups.map(([name, size], g) => ({ id: g, label: name.replace(/ #\\d+$/, ""), value: size, color: color(g), title: name + " · " + size + " nodes" }));
	const edges = [...weights].map(([key, w]) => { const [from, to] = key.split(",").map(Number); return { from, to, value: w, title: w + " links" }; });
	draw(nodes, edges, { edges: { smooth: false, color: { inherit: "both", opacity: 0.25 }, scaling: { min: 1, max: 8 } } });
	net.on("doubleClick", (e) => e.nodes.length && openGroup(e.nodes[0]));
	net.on("click", (e) => e.nodes.length && showGroup(e.nodes[0]));
	$("title").textContent = "Communities"; $("back").hidden = true;
	$("stats").textContent = DATA.nodes.length + " nodes · " + DATA.links.length + " links · " + DATA.groups.length + " communities. Double-click a bubble to open it.";
	$("info").innerHTML = "";
	$("listTitle").textContent = "Communities";
	list(DATA.groups.map(([name, size], g) => ({ dot: color(g), text: name, meta: size, act: () => openGroup(g) })));
}

function openGroup(g, focusNode) {
	view = g;
	const set = new Set(members[g]);
	const nodes = members[g].map((i) => ({ id: i, label: DATA.nodes[i][0], value: degree[i], color: color(g), title: DATA.nodes[i][2] }));
	const edges = [];
	for (const [s, t, r] of DATA.links) if (set.has(s) && set.has(t)) edges.push({ from: s, to: t, arrows: "to", title: DATA.rels[r] });
	draw(nodes, edges);
	net.on("click", (e) => e.nodes.length && showNode(e.nodes[0]));
	if (focusNode !== undefined) net.once("stabilizationIterationsDone", () => focusOn(focusNode));
	$("title").textContent = DATA.groups[g][0]; $("back").hidden = false;
	$("stats").textContent = nodes.length + " nodes · " + edges.length + " links in this community";
	$("info").innerHTML = "";
	$("listTitle").textContent = "Members";
	list(members[g].slice().sort((a, b) => degree[b] - degree[a]).map((i) => ({ dot: color(g), text: DATA.nodes[i][0], meta: degree[i], act: () => focusOn(i) })));
}

function list(rows) {
	const ul = $("groups"); ul.innerHTML = "";
	for (const row of rows) {
		const li = document.createElement("li"), b = document.createElement("button");
		b.type = "button";
		b.innerHTML = '<span class="dot" style="background:' + row.dot + '"></span><span class="grow">' + esc(row.text) + '</span><span class="muted">' + esc(row.meta) + "</span>";
		b.addEventListener("click", row.act);
		li.append(b); ul.append(li);
	}
}

function showGroup(g) {
	const [name, size] = DATA.groups[g];
	const top = members[g].slice().sort((a, b) => degree[b] - degree[a]).slice(0, 8);
	$("info").innerHTML = "<p><strong>" + esc(name) + "</strong> · " + size + ' nodes</p><p class="muted">Top: ' + top.map((i) => esc(DATA.nodes[i][0])).join(", ") + '</p><button type="button" id="open">Open community</button>';
	$("open").addEventListener("click", () => openGroup(g));
}

function showNode(i) {
	const [label, g, loc] = DATA.nodes[i];
	const near = new Map();
	for (const [s, t, r] of DATA.links) {
		if (s === i) near.set(t, "→ " + DATA.rels[r]);
		else if (t === i) near.set(s, "← " + DATA.rels[r]);
	}
	$("info").innerHTML = "<p><strong>" + esc(label) + "</strong></p><p><code>" + esc(loc) + '</code></p><p class="muted">degree ' + degree[i] + "</p><h2>Neighbors (" + near.size + ")</h2><ul id=near></ul>";
	const ul = $("near");
	for (const [j, rel] of [...near].slice(0, 200)) {
		const li = document.createElement("li"), b = document.createElement("button");
		b.type = "button";
		b.innerHTML = '<span class="dot" style="background:' + color(DATA.nodes[j][1]) + '"></span><span class="grow">' + esc(DATA.nodes[j][0]) + '</span><span class="muted">' + esc(rel) + "</span>";
		b.addEventListener("click", () => jump(j));
		li.append(b); ul.append(li);
	}
}

function focusOn(i) {
	net.selectNodes([i]);
	net.focus(i, { scale: 1.3, animation: { duration: 400 } });
	showNode(i);
}

function jump(i) {
	if (view === DATA.nodes[i][1]) focusOn(i);
	else openGroup(DATA.nodes[i][1], i);
}

$("back").addEventListener("click", overview);
$("q").addEventListener("input", (e) => {
	const q = e.target.value.trim().toLowerCase();
	const hits = q.length < 2 ? [] : DATA.nodes.map((n, i) => i).filter((i) => DATA.nodes[i][0].toLowerCase().includes(q)).sort((a, b) => degree[b] - degree[a]).slice(0, 20);
	$("hits").innerHTML = hits.map((i) => '<option value="' + esc(DATA.nodes[i][0]) + '">').join("");
});
$("q").addEventListener("keydown", (e) => {
	if (e.key !== "Enter") return;
	const q = e.target.value.trim().toLowerCase();
	if (!q) return;
	// Exact label first, then the most connected partial match.
	let best = -1, bestScore = -1;
	DATA.nodes.forEach((n, i) => {
		const l = n[0].toLowerCase();
		if (!l.includes(q)) return;
		const score = (l === q || l === q + "()" ? 1e9 : 0) + degree[i];
		if (score > bestScore) [best, bestScore] = [i, score];
	});
	if (best >= 0) jump(best);
	else $("stats").textContent = "No node matches “" + e.target.value + "”.";
});
addEventListener("DOMContentLoaded", () => typeof vis === "undefined" ? ($("loading").textContent = "Cannot load vis-network from unpkg.com. Check the network.") : overview());
</script>
</body>
</html>
`;
}
