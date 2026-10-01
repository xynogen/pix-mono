import type { GraphData } from "./analyzer.ts";

// ponytail: d3 loads from a CDN, like graphify. The page needs network the first time.
// Vendor the file next to graph.html if you need offline viewing.
const D3_URL = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js";
const D3_SRI = "sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i";

/** Compact page payload: arrays by index, so a 4.5k-node graph stays under ~600 KB. */
export interface GraphPageData {
	/** Relation names, indexed by `links[i][2]`. */
	rels: string[];
	/** `[label, community index, file:line]`. */
	nodes: [string, number, string][];
	/** `[source node index, target node index, relation index, 1 if not EXTRACTED]`. */
	links: ([number, number, number] | [number, number, number, 1])[];
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
	const links: GraphPageData["links"] = [];
	for (const l of graph.links) {
		const s = index.get(l.source);
		const t = index.get(l.target);
		if (s === undefined || t === undefined || s === t) continue;
		let r = relIndex.get(l.relation);
		if (r === undefined) {
			r = rels.push(l.relation) - 1;
			relIndex.set(l.relation, r);
		}
		// ponytail: a missing confidence counts as EXTRACTED, so old graph.json files stay solid.
		links.push(l.confidence && l.confidence !== "EXTRACTED" ? [s, t, r, 1] : [s, t, r]);
	}
	return { rels, nodes, links, groups };
}

/**
 * Interactive view of a graph in the style of the Obsidian graph view: a live force layout,
 * nodes you can drag, hover that lights up the neighbors and dims the rest, and labels that fade
 * in as you zoom. The sidebar has search, node info, and a community legend.
 *
 * ponytail: d3-force runs the physics and the page draws on one canvas by hand. Edges go in about
 * 22 batched strokes and nodes in 10 batched fills (one per color), so a 13k-edge graph stays
 * fast. A draw happens only on a tick, zoom, or hover, and the layout stops when it settles.
 * Extra forces pull each node to its community center, so communities stay as clusters.
 */
export function renderGraphHtml(graph: GraphData, title = "pix-graph"): string {
	const safeTitle = title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<script src="${D3_URL}" integrity="${D3_SRI}" crossorigin="anonymous" defer></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0f0f1a; color: #e0e0e0; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; height: 100vh; overflow: hidden; }
/* min-height: 0 and overflow: hidden keep the graph box at the viewport size. The canvas is absolute, so it cannot resize its own box. */
#graph { flex: 1; position: relative; min-width: 0; min-height: 0; overflow: hidden; }
#graph canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
#loading { position: absolute; inset: 0; display: grid; place-items: center; color: #777; }
#sidebar { width: 300px; background: #1a1a2e; border-left: 1px solid #2a2a4e; display: flex; flex-direction: column; overflow: hidden; }
#search-wrap { padding: 12px; border-bottom: 1px solid #2a2a4e; }
#search { width: 100%; background: #0f0f1a; border: 1px solid #3a3a5e; color: #e0e0e0; padding: 7px 10px; border-radius: 6px; font: inherit; outline: none; }
#search:focus { border-color: #a882ff; }
#search-results { max-height: 180px; overflow-y: auto; margin-top: 6px; }
h3 { font-size: 12px; color: #aaa; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
#info-panel { padding: 14px; border-bottom: 1px solid #2a2a4e; min-height: 140px; max-height: 45vh; display: flex; flex-direction: column; }
#info-content { font-size: 13px; color: #ccc; display: flex; flex-direction: column; gap: 4px; min-height: 0; }
#info-content b { color: #fff; word-break: break-all; }
code { color: #8ab4f8; word-break: break-all; font-size: 12px; }
.empty { color: #666; font-style: italic; }
.row { display: block; width: 100%; text-align: left; background: none; border: 0; border-left: 3px solid #333; color: #ddd; font: 12px/1.5 inherit; padding: 2px 6px; margin: 2px 0; border-radius: 3px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row:hover, .row:focus-visible { background: #2a2a4e; outline: none; }
.row small { color: #777; }
#neighbors { overflow-y: auto; min-height: 0; }
#legend-wrap { flex: 1; overflow-y: auto; padding: 12px; }
#legend-controls { margin-bottom: 8px; }
label { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12px; color: #ccc; padding: 3px 0; user-select: none; }
label:hover { color: #fff; }
label.dimmed { opacity: 0.35; }
input[type=checkbox] { accent-color: #a882ff; flex: none; }
.dot { width: 11px; height: 11px; border-radius: 50%; flex: none; }
.grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { color: #666; font-size: 11px; }
#stats { padding: 10px 14px; border-top: 1px solid #2a2a4e; font-size: 11px; color: #666; }
</style>
</head>
<body>
<main id="graph" aria-label="Code graph. Drag to pan, scroll to zoom, drag a node to move it."><div id="loading">Loading graph…</div></main>
<aside id="sidebar">
<div id="search-wrap"><input id="search" type="search" placeholder="Search nodes…" autocomplete="off" aria-label="Search nodes"><div id="search-results"></div></div>
<div id="info-panel"><h3>Node info</h3><div id="info-content" aria-live="polite"><span class="empty">Click a node to inspect it</span></div></div>
<div id="legend-wrap"><h3>Communities</h3><div id="legend-controls"><label><input type="checkbox" id="all" checked>Select all</label></div><div id="legend"></div></div>
<div id="stats"></div>
</aside>
<script>
const DATA = ${inlineJson(graphPageData(graph))};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
// graphify COMMUNITY_COLORS (Tableau 10). HI is the Obsidian accent for the hover highlight.
const PALETTE = ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC"];
const BG = "#0f0f1a", HI = "#a882ff", TAU = Math.PI * 2;
const color = (g) => PALETTE[g % PALETTE.length];
const rgba = (hex, a) => "rgba(" + parseInt(hex.slice(1, 3), 16) + "," + parseInt(hex.slice(3, 5), 16) + "," + parseInt(hex.slice(5, 7), 16) + "," + a + ")";
const N = DATA.nodes.length;
const members = DATA.groups.map(() => []);
DATA.nodes.forEach((n, i) => members[n[1]].push(i));
const degree = new Uint32Array(N);
const adj = Array.from({ length: N }, () => []);
DATA.links.forEach(([s, t], k) => { degree[s]++; degree[t]++; adj[s].push(k); adj[t].push(k); });
let maxDeg = 1;
for (const d of degree) if (d > maxDeg) maxDeg = d;

// Calibration knobs. SPACING/GAP size the community seeds. LABEL_AT is the on-screen node radius
// (px) where a label starts to fade in. It is fully visible at twice that radius.
const SPACING = 16, GAP = 50, LABEL_AT = 5, GOLDEN = Math.PI * (3 - Math.sqrt(5));
const nodes = DATA.nodes.map(([, g], i) => ({ i, g, r: 3 + 9 * Math.sqrt(degree[i] / maxDeg), x: 0, y: 0 }));
const byColor = PALETTE.map(() => []);
for (const n of nodes) byColor[n.g % PALETTE.length].push(n);

// Seed: pack one disc per community outward on a spiral, then put each member on a sunflower
// spiral inside its disc, hubs in the middle. The disc centers are also the cluster targets.
const centers = [];
for (let g = 0, t = 0; g < members.length; g++) {
	const m = members[g].sort((a, b) => degree[b] - degree[a]);
	const r = SPACING * Math.sqrt(m.length) + 12;
	let x = 0, y = 0;
	for (;; t++) {
		const a = Math.sqrt(t) * 2.5, d = a * 25;
		x = d * Math.cos(a); y = d * Math.sin(a);
		if (centers.every((c) => Math.hypot(c.x - x, c.y - y) >= c.r + r + GAP)) break;
	}
	centers.push({ x, y, r });
	m.forEach((i, k) => {
		const rr = SPACING * Math.sqrt(k);
		nodes[i].x = x + rr * Math.cos(k * GOLDEN);
		nodes[i].y = y + rr * Math.sin(k * GOLDEN);
	});
}

// Edge buckets: inside a community, an edge takes the community color. Cross-community edges stay
// faint gray. Inferred edges are fainter than extracted ones. Calibration knob: the alpha values.
const links = DATA.links.map(([s, t, r, guess]) => ({ source: s, target: t, inside: DATA.nodes[s][1] === DATA.nodes[t][1], guess: !!guess }));
const BUCKETS = [{ color: "rgba(150,150,190,0.035)", links: [] }, { color: "rgba(150,150,190,0.09)", links: [] }];
PALETTE.forEach((hex) => BUCKETS.push({ color: rgba(hex, 0.22), links: [] }, { color: rgba(hex, 0.5), links: [] }));
for (const l of links) BUCKETS[(l.inside ? 2 + 2 * (DATA.nodes[l.source][1] % PALETTE.length) : 0) + (l.guess ? 0 : 1)].links.push(l);

const hidden = new Set();
let sim, zoom, canvas, ctx, transform, W = 0, H = 0, dpr = 1, hover = -1, selected = -1, queued = false;
const redraw = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };
const shown = (n) => !hidden.has(n.g);

function neighbors(i) {
	const set = new Set([i]);
	for (const k of adj[i]) { const [s, t] = DATA.links[k]; set.add(s === i ? t : s); }
	return set;
}

function draw() {
	queued = false;
	const k = transform.k;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.fillStyle = BG;
	ctx.fillRect(0, 0, W, H);
	ctx.translate(transform.x, transform.y);
	ctx.scale(k, k);
	const focus = hover >= 0 ? hover : selected;
	const near = focus >= 0 ? neighbors(focus) : null;
	const x0 = -transform.x / k, y0 = -transform.y / k, x1 = x0 + W / k, y1 = y0 + H / k;
	const inView = (n) => n.x + n.r > x0 && n.x - n.r < x1 && n.y + n.r > y0 && n.y - n.r < y1;

	ctx.lineWidth = 1 / k;
	ctx.globalAlpha = near ? 0.2 : 1;
	for (const b of BUCKETS) {
		ctx.strokeStyle = b.color;
		ctx.beginPath();
		for (const l of b.links) {
			if (!shown(l.source) || !shown(l.target)) continue;
			ctx.moveTo(l.source.x, l.source.y);
			ctx.lineTo(l.target.x, l.target.y);
		}
		ctx.stroke();
	}
	if (near) drawFocusEdges(focus, k);

	byColor.forEach((list, c) => {
		ctx.fillStyle = PALETTE[c];
		ctx.globalAlpha = near ? 0.18 : 1;
		ctx.beginPath();
		for (const n of list) {
			if (!shown(n) || (near && near.has(n.i)) || !inView(n)) continue;
			ctx.moveTo(n.x + n.r, n.y);
			ctx.arc(n.x, n.y, n.r, 0, TAU);
		}
		ctx.fill();
	});
	ctx.globalAlpha = 1;
	if (near) for (const i of near) {
		const n = nodes[i];
		if (!shown(n)) continue;
		ctx.fillStyle = color(n.g);
		ctx.beginPath();
		ctx.arc(n.x, n.y, n.r, 0, TAU);
		ctx.fill();
	}
	for (const i of new Set([selected, hover])) {
		if (i < 0) continue;
		ctx.strokeStyle = i === hover ? HI : "#ffffff";
		ctx.lineWidth = 2 / k;
		ctx.beginPath();
		ctx.arc(nodes[i].x, nodes[i].y, nodes[i].r + 2 / k, 0, TAU);
		ctx.stroke();
	}

	// Labels keep one screen size. They fade in by on-screen node radius, so hubs label first.
	// A label that would overlap one already drawn is skipped, like Obsidian. LABEL_ORDER puts the
	// focus node first, then hubs, so the important names win the space.
	ctx.font = 12 / k + "px system-ui, sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "top";
	ctx.lineJoin = "round";
	ctx.lineWidth = 3 / k;
	ctx.strokeStyle = BG;
	const taken = [];
	const order = focus >= 0 ? [focus, ...LABEL_ORDER] : LABEL_ORDER;
	for (const i of order) {
		const n = nodes[i];
		if (!shown(n) || !inView(n) || (i !== focus && near && !near.has(i))) continue;
		const a = i === focus ? 1 : Math.min(1, Math.max(0, (n.r * k - (near ? LABEL_AT / 2 : LABEL_AT)) / LABEL_AT));
		if (a < 0.03) continue;
		const text = DATA.nodes[i][0];
		const w = ctx.measureText(text).width * k, sx = transform.applyX(n.x), sy = transform.applyY(n.y) + n.r * k + 3;
		const box = [sx - w / 2 - 2, sy, sx + w / 2 + 2, sy + 15];
		if (taken.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
		taken.push(box);
		if (taken.length > 400) break;
		ctx.globalAlpha = a;
		const y = n.y + n.r + 3 / k;
		ctx.strokeText(text, n.x, y);
		ctx.fillStyle = i === focus ? "#ffffff" : "#d8d8e8";
		ctx.fillText(text, n.x, y);
	}
	ctx.globalAlpha = 1;
}
const LABEL_ORDER = [...degree.keys()].sort((a, b) => degree[b] - degree[a]);

// The focus node's edges: accent color, arrowheads, inferred edges dashed.
function drawFocusEdges(i, k) {
	ctx.globalAlpha = 0.75;
	ctx.strokeStyle = HI;
	ctx.fillStyle = HI;
	ctx.lineWidth = 1 / k;
	for (const dashed of [false, true]) {
		ctx.setLineDash(dashed ? [4 / k, 3 / k] : []);
		ctx.beginPath();
		for (const e of adj[i]) {
			const l = links[e];
			if (l.guess !== dashed || !shown(l.source) || !shown(l.target)) continue;
			ctx.moveTo(l.source.x, l.source.y);
			ctx.lineTo(l.target.x, l.target.y);
		}
		ctx.stroke();
	}
	ctx.setLineDash([]);
	ctx.beginPath();
	const size = 6 / k;
	for (const e of adj[i]) {
		const { source: s, target: t } = links[e];
		if (!shown(s) || !shown(t)) continue;
		const d = Math.hypot(t.x - s.x, t.y - s.y) || 1, ux = (t.x - s.x) / d, uy = (t.y - s.y) / d;
		const px = t.x - ux * t.r, py = t.y - uy * t.r;
		ctx.moveTo(px, py);
		ctx.lineTo(px - ux * size - uy * size * 0.5, py - uy * size + ux * size * 0.5);
		ctx.lineTo(px - ux * size + uy * size * 0.5, py - uy * size - ux * size * 0.5);
		ctx.closePath();
	}
	ctx.fill();
	ctx.globalAlpha = 1;
}

// Nearest shown node under a world point. The hit radius is at least 6 screen px.
function find(x, y) {
	let best = -1, bestD = Infinity;
	const min = 6 / transform.k;
	for (const n of nodes) {
		if (!shown(n)) continue;
		const d = (n.x - x) ** 2 + (n.y - y) ** 2, r = Math.max(n.r, min);
		if (d < r * r && d < bestD) [best, bestD] = [n.i, d];
	}
	return best;
}

function resize() {
	const box = $("graph");
	dpr = devicePixelRatio || 1;
	W = box.clientWidth; H = box.clientHeight;
	canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
	redraw();
}

function start() {
	canvas = document.createElement("canvas");
	ctx = canvas.getContext("2d");
	$("graph").replaceChildren(canvas);
	new ResizeObserver(resize).observe($("graph"));
	resize();

	sim = d3.forceSimulation(nodes)
		.alpha(0.6).alphaDecay(0.03).velocityDecay(0.45)
		// Calibration knobs: link distance, charge, collide padding, and the cluster pull strength.
		.force("link", d3.forceLink(links).distance((l) => (l.inside ? 30 : 120)).strength((l) => (l.inside ? 0.5 : 0.01) / Math.max(1, Math.min(degree[l.source.i], degree[l.target.i]))))
		.force("charge", d3.forceManyBody().strength(-45).distanceMax(300).theta(0.9))
		// Collide keeps nodes from stacking, so a cluster spreads into a disc, not a hairball.
		.force("collide", d3.forceCollide((n) => n.r + 3).iterations(1))
		.force("x", d3.forceX((n) => centers[n.g].x).strength(0.05))
		.force("y", d3.forceY((n) => centers[n.g].y).strength(0.05))
		.on("tick", redraw);

	const sel = d3.select(canvas);
	sel.call(d3.drag()
		.container(function () { return this; })
		.subject((e) => { const i = find(transform.invertX(e.x), transform.invertY(e.y)); return i < 0 ? null : { i, x: transform.applyX(nodes[i].x), y: transform.applyY(nodes[i].y) }; })
		.on("start", (e) => { if (!e.active) sim.alphaTarget(0.2).restart(); const n = nodes[e.subject.i]; n.fx = n.x; n.fy = n.y; })
		.on("drag", (e) => { const n = nodes[e.subject.i]; n.fx = transform.invertX(e.x); n.fy = transform.invertY(e.y); })
		.on("end", (e) => { if (!e.active) sim.alphaTarget(0); const n = nodes[e.subject.i]; n.fx = null; n.fy = null; }));
	zoom = d3.zoom().scaleExtent([0.02, 8]).on("zoom", (e) => { transform = e.transform; redraw(); });
	sel.call(zoom).on("dblclick.zoom", null);

	// Start fitted to the seed layout.
	let ax = Infinity, ay = Infinity, bx = -Infinity, by = -Infinity;
	for (const n of nodes) { ax = Math.min(ax, n.x); ay = Math.min(ay, n.y); bx = Math.max(bx, n.x); by = Math.max(by, n.y); }
	const k = Math.min(W / (bx - ax || 1), H / (by - ay || 1)) * 0.9;
	transform = d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-(ax + bx) / 2, -(ay + by) / 2);
	sel.call(zoom.transform, transform);

	canvas.addEventListener("pointermove", (e) => {
		const i = find(transform.invertX(e.offsetX), transform.invertY(e.offsetY));
		if (i === hover) return;
		hover = i;
		canvas.style.cursor = i >= 0 ? "pointer" : "grab";
		redraw();
	});
	canvas.addEventListener("pointerleave", () => { hover = -1; redraw(); });
	canvas.addEventListener("click", (e) => {
		const i = find(transform.invertX(e.offsetX), transform.invertY(e.offsetY));
		i >= 0 ? showInfo(i) : clearInfo();
	});
}

function row(label, meta, g, act) {
	const b = document.createElement("button");
	b.type = "button"; b.className = "row"; b.style.borderLeftColor = color(g);
	b.innerHTML = esc(label) + (meta ? " <small>" + esc(meta) + "</small>" : "");
	b.addEventListener("click", act);
	return b;
}

function clearInfo() { selected = -1; redraw(); $("info-content").innerHTML = '<span class="empty">Click a node to inspect it</span>'; }

function showInfo(i) {
	selected = i; redraw();
	const [label, g, loc] = DATA.nodes[i];
	const near = new Map();
	for (const k of adj[i]) {
		const [s, t, r, guess] = DATA.links[k];
		const rel = DATA.rels[r] + (guess ? "?" : "");
		near.set(s === i ? t : s, (s === i ? "→ " : "← ") + rel);
	}
	$("info-content").innerHTML = "<b>" + esc(label) + "</b><code>" + esc(loc) + "</code><div>Community: " + esc(DATA.groups[g][0]) +
		"</div><div>Degree: " + degree[i] + "</div>" + (near.size ? '<h3 style="margin-top:8px">Neighbors (' + near.size + ')</h3><div id="neighbors"></div>' : "");
	const box = $("neighbors");
	for (const [j, rel] of [...near].slice(0, 200)) box?.append(row(DATA.nodes[j][0], rel, DATA.nodes[j][1], () => focusNode(j)));
}

function focusNode(i) {
	const n = nodes[i];
	if (hidden.has(n.g)) setGroup(n.g, true);
	showInfo(i);
	if (!zoom) return;
	const k = Math.max(transform.k, 1.5);
	d3.select(canvas).transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-n.x, -n.y));
}

// Community legend: a checkbox shows or hides every member, like graphify.
function setGroup(g, show) {
	show ? hidden.delete(g) : hidden.add(g);
	const box = $("legend").children[g];
	box.classList.toggle("dimmed", !show);
	box.firstChild.checked = show;
	$("all").checked = hidden.size === 0;
	$("all").indeterminate = hidden.size > 0 && hidden.size < DATA.groups.length;
	redraw();
}
DATA.groups.forEach(([name, n], g) => {
	const item = document.createElement("label");
	item.innerHTML = '<input type="checkbox" checked><span class="dot" style="background:' + color(g) + '"></span><span class="grow">' + esc(name) + '</span><span class="count">' + n + "</span>";
	item.firstChild.addEventListener("change", (e) => setGroup(g, e.target.checked));
	$("legend").append(item);
});
$("all").addEventListener("change", (e) => {
	const show = e.target.checked;
	DATA.groups.forEach((_, g) => { show ? hidden.delete(g) : hidden.add(g); $("legend").children[g].classList.toggle("dimmed", !show); $("legend").children[g].firstChild.checked = show; });
	$("all").indeterminate = false;
	redraw();
});

// Search: the 20 best matches, exact name first, then by degree. Enter opens the first one.
let hits = [];
$("search").addEventListener("input", (e) => {
	const q = e.target.value.trim().toLowerCase(), out = $("search-results");
	out.innerHTML = "";
	if (!q) return;
	const score = (i) => { const l = DATA.nodes[i][0].toLowerCase(); return (l === q || l === q + "()" ? 1e9 : 0) + degree[i]; };
	hits = [];
	for (let i = 0; i < N; i++) if (DATA.nodes[i][0].toLowerCase().includes(q)) hits.push(i);
	hits = hits.sort((a, b) => score(b) - score(a)).slice(0, 20);
	if (!hits.length) out.innerHTML = '<span class="empty">No match</span>';
	for (const i of hits) out.append(row(DATA.nodes[i][0], DATA.nodes[i][2], DATA.nodes[i][1], () => focusNode(i)));
});
$("search").addEventListener("keydown", (e) => { if (e.key === "Enter" && hits.length) focusNode(hits[0]); });

$("stats").textContent = N + " nodes · " + DATA.links.length + " links · " + DATA.groups.length + " communities";
addEventListener("DOMContentLoaded", () => typeof d3 === "undefined" ? ($("loading").textContent = "Cannot load d3 from cdn.jsdelivr.net. Check the network.") : start());
</script>
</body>
</html>
`;
}
