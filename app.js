"use strict";

/* ------------------------------------------------------------------ *
 * Path of Trading — PoE2 currency trading path optimizer
 * Pure vanilla JS. State persisted to localStorage.
 * ------------------------------------------------------------------ */

const STORAGE_KEY = "path-of-trading.v1";

const EXAMPLE = {
  ratios: [
    { fromAmount: 1, fromCur: "DIV", toAmount: 130, baseTo: 130, toCur: "EX" },
    { fromAmount: 1, fromCur: "DIV", toAmount: 55, baseTo: 55, toCur: "VAAL" },
    { fromAmount: 1, fromCur: "DIV", toAmount: 11, baseTo: 11, toCur: "CH" },
    { fromAmount: 1, fromCur: "CH", toAmount: 5, baseTo: 5, toCur: "VAAL" },
    { fromAmount: 1, fromCur: "CH", toAmount: 10, baseTo: 10, toCur: "EX" },
    { fromAmount: 2.2, fromCur: "EX", toAmount: 1, baseTo: 1, toCur: "VAAL" },
  ],
  start: "DIV",
  goals: ["EX", "VAAL"],
  maxLoops: 0,
  startAmount: 1,
  customPath: [],
};

/** @type {typeof EXAMPLE} */
let state = load() || structuredClone(EXAMPLE);
if (!Array.isArray(state.customPath)) state.customPath = [];

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */
const RATIO_RE = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z][A-Za-z0-9]*)\s*(?:->|→)\s*(\d+(?:\.\d+)?)\s*([A-Za-z][A-Za-z0-9]*)\s*$/;

function parseRatio(text) {
  const m = RATIO_RE.exec(text);
  if (!m) return null;
  const [, fromAmount, fromCur, toAmount, toCur] = m;
  const fa = parseFloat(fromAmount);
  const ta = parseFloat(toAmount);
  if (fa <= 0 || ta <= 0) return null;
  if (fromCur.toUpperCase() === toCur.toUpperCase()) return null;
  return {
    fromAmount: fa,
    fromCur: fromCur.toUpperCase(),
    toAmount: ta,
    baseTo: ta,
    toCur: toCur.toUpperCase(),
    fwd: true,
    rev: true,
  };
}

/* ------------------------------------------------------------------ *
 * Graph model
 * ------------------------------------------------------------------ */
function currencies() {
  const set = new Set();
  for (const r of state.ratios) {
    set.add(r.fromCur);
    set.add(r.toCur);
  }
  return [...set].sort();
}

/** Build adjacency: node -> [{to, rate, label}] */
function buildEdges() {
  /** @type {Record<string, {to:string, rate:number, label:string}[]>} */
  const adj = {};
  const add = (from, to, rate, label) => {
    (adj[from] ||= []).push({ to, rate, label });
  };
  for (const r of state.ratios) {
    const rate = r.toAmount / r.fromAmount; // units of `to` per 1 unit of `from`
    // each ratio is bidirectional by default; either direction can be disabled
    // per-ratio to model exchanges that only accept one-way volume.
    if (r.fwd !== false) {
      add(r.fromCur, r.toCur, rate, `${trim(r.fromAmount)}${r.fromCur}\u2192${trim(r.toAmount)}${r.toCur}`);
    }
    if (r.rev !== false) {
      add(r.toCur, r.fromCur, 1 / rate, `${trim(r.toAmount)}${r.toCur}\u2192${trim(r.fromAmount)}${r.fromCur}`);
    }
  }
  return adj;
}

/* ------------------------------------------------------------------ *
 * Connectivity: treat ratios as undirected links and check every
 * currency belongs to a single connected component. Returns the
 * currencies that fall outside the largest group (if the graph is split).
 * ------------------------------------------------------------------ */
function connectivityIssues() {
  const curs = currencies();
  if (curs.length < 2) return [];

  /** @type {Record<string, Set<string>>} */
  const undirected = {};
  const link = (a, b) => { (undirected[a] ||= new Set()).add(b); };
  for (const r of state.ratios) {
    if (r.fwd === false && r.rev === false) continue; // both directions off = no link
    link(r.fromCur, r.toCur);
    link(r.toCur, r.fromCur);
  }

  // discover all connected components
  const unseen = new Set(curs);
  const components = [];
  while (unseen.size) {
    const root = unseen.values().next().value;
    const comp = [];
    const stack = [root];
    unseen.delete(root);
    while (stack.length) {
      const node = stack.pop();
      comp.push(node);
      for (const next of undirected[node] || []) {
        if (unseen.has(next)) { unseen.delete(next); stack.push(next); }
      }
    }
    components.push(comp);
  }

  if (components.length < 2) return [];
  // keep the largest group as the "main" one; everything else is cut off
  components.sort((a, b) => b.length - a.length);
  return components.slice(1).flat().sort();
}

/* ------------------------------------------------------------------ *
 * Pathfinding: max-product walk from start to every reachable currency.
 * `maxLoops` = number of node revisits allowed (budget).
 * Records the best (highest output) path arriving at each currency.
 * ------------------------------------------------------------------ */
function bestPaths() {
  const adj = buildEdges();
  /** @type {Record<string, {product:number, nodes:string[], edges:any[]}>} */
  const best = {};

  const visit = {}; // node -> count
  const nodes = [state.start];
  const edges = [];

  function dfs(node, product, loopsUsed) {
    if (node !== state.start) {
      const cur = best[node];
      if (!cur || product > cur.product) {
        best[node] = { product, nodes: [...nodes], edges: [...edges] };
      }
    }
    if (nodes.length > currencies().length + state.maxLoops + 1) return; // safety
    for (const e of adj[node] || []) {
      const willRevisit = (visit[e.to] || 0) > 0;
      const nextLoops = loopsUsed + (willRevisit ? 1 : 0);
      if (nextLoops > state.maxLoops) continue;
      visit[e.to] = (visit[e.to] || 0) + 1;
      nodes.push(e.to);
      edges.push(e);
      dfs(e.to, product * e.rate, nextLoops);
      nodes.pop();
      edges.pop();
      visit[e.to] -= 1;
    }
  }

  visit[state.start] = 1;
  dfs(state.start, 1, 0);
  return best;
}

/** Best single-hop conversion rate from `from` to `to`, or null if no direct ratio exists. */
function directRate(from, to) {
  const adj = buildEdges();
  let best = null;
  for (const e of (adj[from] || [])) {
    if (e.to === to && (best === null || e.rate > best)) best = e.rate;
  }
  return best;
}

/** Value of 1 unit of each currency priced in the start currency.
 *  Uses the direct market rate from the start (the "fair" reference price),
 *  falling back to the best-path rate for currencies with no direct link.
 *  Lets us measure the real profit a single trade adds, not just its raw rate. */
function referenceValues(best) {
  const start = state.start;
  const vals = { [start]: 1 };
  for (const c of currencies()) {
    if (c === start) continue;
    const dr = directRate(start, c);
    if (dr && dr > 0) vals[c] = 1 / dr;
    else if (best[c] && best[c].product > 0) vals[c] = 1 / best[c].product;
    else vals[c] = null; // value unknown — can't price this currency
  }
  return vals;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const SVGNS = "http://www.w3.org/2000/svg";

function trim(n) {
  return Number.isInteger(n) ? String(n) : (Math.round(n * 1000) / 1000).toString();
}
/** Positive starting amount used to simulate trades (defaults to 1). */
function startAmt() {
  return state.startAmount > 0 ? state.startAmount : 1;
}
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function renderRatioList() {
  const ul = $("ratio-list");
  ul.innerHTML = "";
  if (state.ratios.length === 0) {
    ul.innerHTML = `<li class="no-path">No ratios yet. Add one above.</li>`;
    return;
  }
  state.ratios.forEach((r, i) => {
    const rate = r.toAmount / r.fromAmount;
    const li = document.createElement("li");
    li.className = "ratio-item";
    const max = Math.max(r.baseTo * 3, r.toAmount * 1.5, r.baseTo + 1);
    li.innerHTML = `
      <div class="ratio-head">
        <span class="ratio-label">
          <input class="amt-edit" type="number" min="0" step="0.1" data-i="${i}" data-side="from" value="${trim(r.fromAmount)}" aria-label="From amount" /><span class="cur">${r.fromCur}</span>
          &rarr;
          <input class="amt-edit" type="number" min="0" step="0.1" data-i="${i}" data-side="to" value="${trim(r.toAmount)}" aria-label="To amount" /><span class="cur">${r.toCur}</span>
          <span class="rate">(${trim(rate)} per 1${r.fromCur})</span>
        </span>
        <span class="ratio-actions">
          <button class="dir-btn ${r.fwd === false ? "off" : "on"}" data-i="${i}" data-dir="fwd" title="Trade ${r.fromCur} \u2192 ${r.toCur}" aria-label="Toggle ${r.fromCur} to ${r.toCur} direction">&rarr;</button>
          <button class="dir-btn ${r.rev === false ? "off" : "on"}" data-i="${i}" data-dir="rev" title="Trade ${r.toCur} \u2192 ${r.fromCur}" aria-label="Toggle ${r.toCur} to ${r.fromCur} direction">&larr;</button>
          <button class="ratio-del" data-i="${i}" title="Remove" aria-label="Remove ratio">&times;</button>
        </span>
      </div>
      <div class="ratio-slider-row">
        <input type="range" data-i="${i}" min="0" max="${trim(max)}" step="0.1" value="${r.toAmount}" />
        <span class="ratio-amount">${trim(r.toAmount)}${r.toCur}</span>
      </div>`;
    ul.appendChild(li);
  });
}

function renderConfig() {
  const curs = currencies();

  // start select
  const start = $("start-select");
  start.innerHTML = "";
  for (const c of curs) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    if (c === state.start) opt.selected = true;
    start.appendChild(opt);
  }
  if (!curs.includes(state.start) && curs.length) {
    state.start = curs[0];
    start.value = state.start;
  }

  // goals
  const goalList = $("goal-list");
  goalList.innerHTML = "";
  state.goals = state.goals.filter((g) => curs.includes(g));
  for (const c of curs) {
    const active = state.goals.includes(c);
    const chip = document.createElement("label");
    chip.className = "goal-chip" + (active ? " active" : "");
    chip.innerHTML = `<input type="checkbox" value="${c}" ${active ? "checked" : ""}/> ${c}`;
    goalList.appendChild(chip);
  }

  // loops slider bounds
  const loops = $("loops-slider");
  loops.value = state.maxLoops;
  $("loops-value").textContent = state.maxLoops;

  $("start-amount").value = trim(startAmt());
}

/** Compares the best path's output to trading the start currency directly for the goal. */
function directComparisonHtml(goal, product) {
  const direct = directRate(state.start, goal);
  if (direct === null) {
    return `<div class="path-compare none">No direct ${state.start}&rarr;${goal} trade &mdash; only reachable via a path.</div>`;
  }
  const factor = product / direct;
  if (Math.abs(factor - 1) < 1e-6) {
    return `<div class="path-compare">
      <span class="cmp-direct">Direct: 1${state.start} = ${trim(direct)}${goal}</span>
      <span class="cmp-badge same">path = direct</span>
    </div>`;
  }
  const better = factor > 1;
  const pct = (factor - 1) * 100;
  return `<div class="path-compare">
    <span class="cmp-direct">Direct: 1${state.start} = ${trim(direct)}${goal}</span>
    <span class="cmp-badge ${better ? "good" : "bad"}">&times;${trim(factor)} ${better ? "better" : "worse"} via path (${pct >= 0 ? "+" : ""}${trim(pct)}%)</span>
  </div>`;
}

/** Ranks currencies by how much net worth you keep when holding wealth in them.
 *  For each currency we take the best path from the start currency to it and value
 *  the result at the fair market price (in start-currency terms). A currency worth
 *  more than the start (gain > 0) is a profitable store of value via arbitrage. */
function renderHoldRanking(best, refVals) {
  const el = $("hold-ranking");
  el.innerHTML = "";

  const start = state.start;
  const rows = [];
  for (const c of currencies()) {
    let value, nodes;
    if (c === start) {
      value = 1;
      nodes = [start];
    } else if (best[c] && refVals[c] != null && refVals[c] > 0) {
      value = best[c].product * refVals[c]; // units acquired * fair value each
      nodes = best[c].nodes;
    } else {
      continue; // unreachable or unpriceable
    }
    rows.push({ cur: c, value, nodes, isStart: c === start });
  }

  if (rows.length === 0) {
    el.innerHTML = `<p class="no-path">Add ratios to rank currencies by value.</p>`;
    return;
  }

  rows.sort((a, b) => b.value - a.value);
  const top = rows[0].value;

  el.innerHTML =
    `<p class="hold-hint">Where your net worth is worth the most, valued in ` +
    `<span class="cur">${start}</span> at market price.</p>` +
    rows.map((row, i) => {
      const pct = (row.value - 1) * 100;
      const cls = pct > 1e-4 ? "good" : pct < -1e-4 ? "bad" : "flat";
      const sign = pct >= 0 ? "+" : "";
      const isBest = i === 0 && top > 1 + 1e-4;
      const pathTxt = row.nodes.length > 1 ? row.nodes.join(" \u2192 ") : "hold as-is";
      return `
        <div class="hold-row${isBest ? " best" : ""}">
          <span class="hold-rank">${i + 1}</span>
          <span class="hold-cur"><span class="cur">${row.cur}</span>${row.isStart ? ' <span class="hold-tag">start</span>' : ""}${isBest ? ' <span class="hold-tag best">best</span>' : ""}</span>
          <span class="hold-path">${pathTxt}</span>
          <span class="hold-gain ${cls}">${sign}${trim(pct)}%</span>
        </div>`;
    }).join("");
}

/** Overview of trades whose rate deviates from the fair market price.
 *  For each currency pair, prices both sides in the start currency and reports
 *  the value gained by trading in the favorable direction (an arbitrage edge). */
function renderMispriced(refVals) {
  const el = $("mispriced");
  el.innerHTML = "";

  const adj = buildEdges();
  /** @type {Map<string, {from:string, to:string, rate:number, gain:number}>} */
  const byPair = new Map();
  for (const from of Object.keys(adj)) {
    for (const e of adj[from]) {
      const vFrom = refVals[from], vTo = refVals[e.to];
      if (vFrom == null || vTo == null || vFrom <= 0 || vTo <= 0) continue;
      const gain = (e.rate * vTo) / vFrom - 1; // value delta of trading from -> to
      const key = [from, e.to].sort().join("|");
      // keep the favorable direction (positive gain) for each pair
      const prev = byPair.get(key);
      if (!prev || gain > prev.gain) byPair.set(key, { from, to: e.to, rate: e.rate, gain });
    }
  }

  const EPS = 1e-4;
  const mispriced = [...byPair.values()].filter((t) => t.gain > EPS).sort((a, b) => b.gain - a.gain);
  const fairCount = byPair.size - mispriced.length;

  if (byPair.size === 0) {
    el.innerHTML = `<p class="no-path">Add at least two connected ratios to compare prices.</p>`;
    return;
  }
  if (mispriced.length === 0) {
    el.innerHTML = `<p class="no-path">All trades are fairly priced \u2014 no arbitrage edge found.</p>`;
    return;
  }

  el.innerHTML =
    `<p class="mispriced-hint">Trades priced away from the market. Buying the ` +
    `<span class="under">underpriced</span> side beats trading directly.</p>` +
    mispriced.map((t) => `
      <div class="mispriced-row">
        <span class="mp-trade">1<span class="cur">${t.from}</span> &rarr; ${trim(t.rate)}<span class="cur">${t.to}</span></span>
        <span class="mp-note"><span class="cur">${t.to}</span> is <span class="under">underpriced</span> vs <span class="cur">${t.from}</span></span>
        <span class="mp-gain good">+${trim(t.gain * 100)}%</span>
      </div>`).join("") +
    (fairCount > 0 ? `<p class="mispriced-foot">${fairCount} other ${fairCount === 1 ? "pair is" : "pairs are"} fairly priced.</p>` : "");
}

function renderResults() {
  const best = bestPaths();
  const refVals = referenceValues(best);
  renderHoldRanking(best, refVals);
  renderMispriced(refVals);
  renderCustomPath(best, refVals);
  const wrap = $("results");
  wrap.innerHTML = "";

  if (state.goals.length === 0) {
    wrap.innerHTML = `<p class="no-path">Select one or more goal currencies.</p>`;
    return [];
  }

  const paths = [];
  for (const goal of state.goals) {
    const res = best[goal];
    const card = document.createElement("div");
    card.className = "path-card" + (res ? "" : " unreachable");

    if (!res) {
      card.innerHTML = `
        <div class="path-card-head">
          <span class="path-goal">&rarr; <span class="cur">${goal}</span></span>
          <span class="path-result bad">no path</span>
        </div>
        <p class="no-path">No path from ${state.start} to ${goal} within ${state.maxLoops} loop(s).</p>`;
      wrap.appendChild(card);
      paths.push({ goal, res: null });
      continue;
    }

    const cls = res.product >= 1 ? "good" : "bad";
    const amt0 = startAmt();
    card.innerHTML = `
      <div class="path-card-head">
        <span class="path-goal">&rarr; <span class="cur">${goal}</span></span>
        <span class="path-result ${cls}">${trim(amt0)}${state.start} = ${trim(res.product * amt0)}${goal}</span>
      </div>
      ${directComparisonHtml(goal, res.product)}`;
    wrap.appendChild(card);
    // Measure the in-DOM card so the diagram fills the panel at 1:1 pixel scale.
    const w = Math.max(320, card.clientWidth - 28);
    card.appendChild(renderPathSvg(res, w, refVals));
    paths.push({ goal, res });
  }
  return paths;
}

/** Best single edge between two adjacent currencies (highest rate), or null. */
function bestEdge(adj, from, to) {
  let best = null;
  for (const e of (adj[from] || [])) {
    if (e.to === to && (!best || e.rate > best.rate)) best = e;
  }
  return best;
}

/** Interactive builder: assemble a path step by step and compare it to the
 *  optimizer's best path to the same final currency. Steps are stored in
 *  `state.customPath` (currencies after the start). */
function renderCustomPath(best, refVals) {
  const el = $("custom-path");
  el.innerHTML = "";
  const adj = buildEdges();
  const start = state.start;
  const steps = state.customPath || [];
  const nodes = [start, ...steps];

  // walk the chosen nodes, collecting the best edge for each hop
  const edges = [];
  let invalidAt = -1;
  for (let i = 0; i < nodes.length - 1; i++) {
    const e = bestEdge(adj, nodes[i], nodes[i + 1]);
    if (!e) { invalidAt = i; break; }
    edges.push(e);
  }

  // builder controls: start chip + step chips + an "add step" select
  const lastNode = invalidAt === -1 ? nodes[nodes.length - 1] : nodes[invalidAt];
  const neighbors = [...new Set((adj[lastNode] || []).map((e) => e.to))].sort();
  const chips =
    `<span class="cp-chip start"><span class="cur">${start}</span></span>` +
    steps.map((c, i) => {
      const broken = invalidAt !== -1 && i >= invalidAt;
      return `<span class="cp-arrow">&rarr;</span><span class="cp-chip${broken ? " broken" : ""}">` +
        `<span class="cur">${c}</span>` +
        `<button class="cp-del" data-k="${i}" title="Remove from here" aria-label="Remove step">&times;</button></span>`;
    }).join("");
  const addSelect = invalidAt === -1 && neighbors.length
    ? `<span class="cp-arrow">&rarr;</span><select id="cp-add" class="cp-add" aria-label="Add step">` +
      `<option value="">+ step</option>` +
      neighbors.map((c) => `<option value="${c}">${c}</option>`).join("") + `</select>`
    : "";
  const clearBtn = steps.length ? `<button id="cp-clear" class="cp-clear" type="button">Clear</button>` : "";

  const head = `<div class="cp-builder">${chips}${addSelect}${clearBtn}</div>`;
  el.innerHTML = head;

  if (steps.length === 0) {
    el.insertAdjacentHTML("beforeend", `<p class="no-path">Add steps to build a path from <span class="cur">${start}</span> and compare it to the best path.</p>`);
    return;
  }
  if (invalidAt !== -1) {
    el.insertAdjacentHTML("beforeend", `<p class="no-path">No trade from <span class="cur">${nodes[invalidAt]}</span> to <span class="cur">${nodes[invalidAt + 1]}</span> \u2014 remove that step or add a ratio.</p>`);
    return;
  }

  const product = edges.reduce((p, e) => p * e.rate, 1);
  const final = nodes[nodes.length - 1];
  const amt0 = startAmt();
  const cls = product >= 1 ? "good" : "bad";

  // compare to the optimizer's best path to the same final currency
  let cmp = "";
  const bp = best[final];
  if (bp && bp.product > 0) {
    const factor = product / bp.product;
    if (Math.abs(factor - 1) < 1e-6) {
      cmp = `<span class="cmp-badge same">matches the best path</span>`;
    } else {
      const better = factor > 1;
      const pct = (factor - 1) * 100;
      cmp = `<span class="cmp-badge ${better ? "good" : "bad"}">&times;${trim(factor)} ${better ? "better than" : "of"} best (${pct >= 0 ? "+" : ""}${trim(pct)}%)</span>`;
    }
  }

  const card = document.createElement("div");
  card.className = "path-card";
  card.innerHTML = `
    <div class="path-card-head">
      <span class="path-goal">&rarr; <span class="cur">${final}</span></span>
      <span class="path-result ${cls}">${trim(amt0)}${start} = ${trim(product * amt0)}${final}</span>
    </div>
    <div class="path-compare">
      <span class="cmp-direct">Best path: ${trim(amt0)}${start} = ${bp ? trim(bp.product * amt0) : "\u2014"}${final}</span>
      ${cmp}
    </div>`;
  el.appendChild(card);
  const w = Math.max(320, card.clientWidth - 28);
  card.appendChild(renderPathSvg({ product, nodes, edges }, w, refVals));
}

/** Linear left-to-right chain for one goal path.
 *  Element sizes are fixed (px); only the spacing stretches to fill `W`. */
function renderPathSvg(res, W, refVals) {
  const n = res.nodes.length;
  const H = 112;
  const pad = 38;
  const gap = n > 1 ? (W - pad * 2) / (n - 1) : 0;
  const y = 52;
  const r = 18;
  const svg = svgEl("svg", { class: "path-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}` });

  // running amount held at each node (starts at the simulated start amount)
  const amts = [startAmt()];
  for (const e of res.edges) amts.push(amts[amts.length - 1] * e.rate);

  for (let i = 0; i < n - 1; i++) {
    const x1 = pad + gap * i;
    const x2 = pad + gap * (i + 1);
    const e = res.edges[i];
    const mx = (x1 + x2) / 2;
    svg.appendChild(svgEl("line", { class: "edge-line active", x1: x1 + r, y1: y, x2: x2 - r, y2: y, "marker-end": "url(#arrow-active)" }));

    const rateLbl = svgEl("text", { class: "edge-label active", x: mx, y: y - 26 });
    rateLbl.textContent = `\u00d7${trim(e.rate)}`;
    svg.appendChild(rateLbl);

    // Profit this trade actually adds: change in value (priced in the start
    // currency) vs the market rate, so a fair-rate trade reads 0% and only a
    // cross-rate that beats the market shows a real gain.
    const vBefore = refVals[res.nodes[i]];
    const vAfter = refVals[res.nodes[i + 1]];
    if (vBefore != null && vAfter != null && vBefore > 0) {
      let pct = ((amts[i + 1] * vAfter) / (amts[i] * vBefore) - 1) * 100;
      if (Math.abs(pct) < 1e-6) pct = 0; // snap float noise to a clean 0%
      const profit = svgEl("text", { class: "step-profit " + (pct >= 0 ? "good" : "bad"), x: mx, y: y - 12 });
      profit.textContent = `${pct >= 0 ? "+" : ""}${trim(pct)}%`;
      svg.appendChild(profit);
    }
  }

  res.nodes.forEach((node, i) => {
    const x = pad + gap * i;
    const isStart = i === 0;
    const isGoal = i === n - 1;
    svg.appendChild(svgEl("circle", { class: "node-circle" + (isStart ? " start" : isGoal ? " goal" : ""), cx: x, cy: y, r }));
    const t = svgEl("text", { class: "node-label", x, y });
    t.textContent = node;
    svg.appendChild(t);
    const amt = svgEl("text", { class: "step-amount", x, y: y + 38 });
    amt.textContent = `${trim(amts[i])}${node}`;
    svg.appendChild(amt);
  });

  svg.appendChild(arrowDefs());
  return svg;
}

function arrowDefs() {
  const defs = svgEl("defs");
  for (const [id, color] of [["arrow", "var(--border)"], ["arrow-active", "var(--accent)"]]) {
    const marker = svgEl("marker", {
      id, viewBox: "0 0 10 10", refX: "9", refY: "5",
      markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse",
    });
    marker.appendChild(svgEl("path", { d: "M0,0 L10,5 L0,10 z", fill: color }));
    defs.appendChild(marker);
  }
  return defs;
}

/** Profitability chart: how much currency you hold after each trade, one line per goal.
 *  Re-rendered live as ratio sliders move. Fixed element sizes; width fills the panel. */
const SERIES_COLORS = ["#e0bd63", "#6fb3d4", "#5cb874", "#d4634f", "#b08fe0", "#e0905a"];

function renderProfitChart(paths) {
  const svg = $("chart");
  const legend = $("chart-legend");
  svg.innerHTML = "";
  legend.innerHTML = "";

  const W = Math.max(360, ($("chart-wrap").clientWidth || 600) - 16);
  const H = 280;
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const series = (paths || [])
    .filter((p) => p.res)
    .map((p, i) => {
      const amts = [startAmt()];
      for (const e of p.res.edges) amts.push(amts[amts.length - 1] * e.rate);
      return { goal: p.goal, amts, product: p.res.product, color: SERIES_COLORS[i % SERIES_COLORS.length] };
    });

  if (!series.length) {
    const t = svgEl("text", { class: "no-path-svg", x: W / 2, y: H / 2, "text-anchor": "middle" });
    t.textContent = "No reachable paths to chart.";
    svg.appendChild(t);
    return;
  }

  const maxSteps = Math.max(1, ...series.map((s) => s.amts.length - 1));
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const a of s.amts) { lo = Math.min(lo, a); hi = Math.max(hi, a); }
  if (lo === hi) { lo *= 0.9; hi *= 1.1; }
  const log = lo > 0 && hi / lo > 50; // switch to log scale when the range is huge
  const yv = (a) => (log ? Math.log10(Math.max(a, 1e-9)) : a);

  let ymin = yv(lo), ymax = yv(hi);
  const span = ymax - ymin || 1;
  ymin -= span * 0.1;
  ymax += span * 0.14;
  if (!log && ymin < 0) ymin = 0; // amounts can't be negative on a linear axis

  const padL = 56, padR = 20, padT = 14, padB = 36;
  const X = (step) => padL + (W - padL - padR) * (step / maxSteps);
  const Y = (a) => padT + (H - padT - padB) * (1 - (yv(a) - ymin) / (ymax - ymin));

  // horizontal gridlines + y-axis value labels
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const val = log ? Math.pow(10, ymin + ((ymax - ymin) * i) / ticks) : ymin + ((ymax - ymin) * i) / ticks;
    const yy = padT + (H - padT - padB) * (1 - i / ticks);
    svg.appendChild(svgEl("line", { class: "chart-grid", x1: padL, y1: yy, x2: W - padR, y2: yy }));
    const lbl = svgEl("text", { class: "chart-axis-label", x: padL - 8, y: yy, "text-anchor": "end", "dominant-baseline": "central" });
    lbl.textContent = trim(val);
    svg.appendChild(lbl);
  }

  // break-even reference line at the starting amount (no profit, no loss)
  const realMin = log ? Math.pow(10, ymin) : ymin;
  const realMax = log ? Math.pow(10, ymax) : ymax;
  const amt0 = startAmt();
  if (amt0 >= realMin && amt0 <= realMax) {
    const yb = Y(amt0);
    svg.appendChild(svgEl("line", { class: "chart-baseline", x1: padL, y1: yb, x2: W - padR, y2: yb }));
    const lbl = svgEl("text", { class: "chart-axis-label", x: W - padR, y: yb - 4, "text-anchor": "end" });
    lbl.textContent = "break-even";
    svg.appendChild(lbl);
  }

  // vertical gridlines + trade-number labels
  for (let s = 0; s <= maxSteps; s++) {
    const xx = X(s);
    svg.appendChild(svgEl("line", { class: "chart-grid faint", x1: xx, y1: padT, x2: xx, y2: H - padB }));
    const lbl = svgEl("text", { class: "chart-axis-label", x: xx, y: H - padB + 16, "text-anchor": "middle" });
    lbl.textContent = s === 0 ? "start" : `trade ${s}`;
    svg.appendChild(lbl);
  }

  // one line per goal, with a marker + amount label at each trade
  series.forEach((s) => {
    const pts = s.amts.map((a, i) => `${X(i)},${Y(a)}`).join(" ");
    svg.appendChild(svgEl("polyline", { class: "series-line", points: pts, stroke: s.color }));
    s.amts.forEach((a, i) => {
      svg.appendChild(svgEl("circle", { class: "series-dot", cx: X(i), cy: Y(a), r: 3.5, fill: s.color }));
      const al = svgEl("text", { class: "chart-amount", x: X(i), y: Y(a) - 8, "text-anchor": "middle" });
      al.textContent = trim(a);
      svg.appendChild(al);
    });
    const li = s.amts.length - 1;
    const gl = svgEl("text", { class: "series-label", x: X(li), y: Y(s.amts[li]) + 16, "text-anchor": "middle", fill: s.color });
    gl.textContent = `\u2192${s.goal}`;
    svg.appendChild(gl);
  });

  // legend with final conversion for each goal
  series.forEach((s) => {
    const item = document.createElement("span");
    item.className = "legend-item";
    const cls = s.product >= 1 ? "good" : "bad";
    item.innerHTML =
      `<span class="legend-swatch" style="background:${s.color}"></span>` +
      `<span>&rarr;${s.goal}</span> <span class="legend-val ${cls}">${trim(startAmt())}${state.start} = ${trim(s.product * startAmt())}${s.goal}</span>`;
    legend.appendChild(item);
  });
}

/** Shows a warning when some currencies are disconnected from the rest of the graph. */
function renderWarning() {
  const el = $("connectivity-warning");
  const isolated = connectivityIssues();
  if (isolated.length === 0) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.innerHTML =
    `\u26a0 ${isolated.length === 1 ? "Currency" : "Currencies"} ` +
    `<strong>${isolated.join(", ")}</strong> ${isolated.length === 1 ? "has" : "have"} no ratio ` +
    `connecting ${isolated.length === 1 ? "it" : "them"} to the rest \u2014 add a ratio to bridge the gap.`;
}

function renderAll() {
  renderRatioList();
  renderConfig();
  renderWarning();
  renderProfitChart(renderResults());
  save();
}

/** Lightweight refresh used while dragging sliders (skips full config rebuild). */
function refreshLive() {
  renderProfitChart(renderResults());
  save();
}

/** Re-layout the width-dependent SVGs when the window/panel size changes. */
let _resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => renderProfitChart(renderResults()), 100);
});

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */
$("ratio-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("ratio-input");
  const err = $("ratio-error");
  const parsed = parseRatio(input.value);
  if (!parsed) {
    err.textContent = "Could not parse. Use e.g. 1A -> 20B";
    return;
  }
  err.textContent = "";
  state.ratios.push(parsed);
  input.value = "";
  renderAll();
});

$("ratio-list").addEventListener("input", (e) => {
  const el = e.target;
  const i = +el.dataset.i;
  if (Number.isNaN(i)) return;
  const item = el.closest(".ratio-item");
  const r = state.ratios[i];

  if (el.type === "range") {
    r.toAmount = +el.value;
    item.querySelector('.amt-edit[data-side="to"]').value = trim(r.toAmount);
  } else if (el.classList.contains("amt-edit")) {
    const v = parseFloat(el.value);
    if (!(v > 0)) return; // ignore empty / non-positive while typing
    if (el.dataset.side === "from") {
      r.fromAmount = v;
    } else {
      r.toAmount = v;
      item.querySelector('input[type="range"]').value = r.toAmount;
    }
  } else {
    return;
  }

  // refresh inline labels without a full re-render to preserve focus/caret
  item.querySelector(".ratio-amount").textContent = `${trim(r.toAmount)}${r.toCur}`;
  item.querySelector(".rate").textContent = `(${trim(r.toAmount / r.fromAmount)} per 1${r.fromCur})`;
  refreshLive();
});

// After editing a number field (blur/enter), rebuild so the slider range re-normalizes.
$("ratio-list").addEventListener("change", (e) => {
  if (e.target.classList.contains("amt-edit")) renderAll();
});

$("ratio-list").addEventListener("click", (e) => {
  const dir = e.target.closest(".dir-btn");
  if (dir) {
    const r = state.ratios[+dir.dataset.i];
    const key = dir.dataset.dir; // "fwd" | "rev"
    const other = key === "fwd" ? "rev" : "fwd";
    const enabled = r[key] !== false;
    if (enabled && r[other] === false) return; // keep at least one direction open
    r[key] = !enabled;
    renderAll();
    return;
  }
  const btn = e.target.closest(".ratio-del");
  if (!btn) return;
  state.ratios.splice(+btn.dataset.i, 1);
  renderAll();
});

$("start-select").addEventListener("change", (e) => {
  state.start = e.target.value;
  state.customPath = []; // first hop may no longer be valid from a new start
  renderAll();
});

$("custom-path").addEventListener("change", (e) => {
  if (e.target.id !== "cp-add") return;
  if (e.target.value) {
    state.customPath = [...(state.customPath || []), e.target.value];
    renderAll();
  }
});

$("custom-path").addEventListener("click", (e) => {
  if (e.target.id === "cp-clear") {
    state.customPath = [];
    renderAll();
    return;
  }
  const del = e.target.closest(".cp-del");
  if (del) {
    state.customPath = (state.customPath || []).slice(0, +del.dataset.k);
    renderAll();
  }
});

$("goal-list").addEventListener("change", (e) => {
  const cb = e.target;
  if (cb.type !== "checkbox") return;
  if (cb.checked) {
    if (!state.goals.includes(cb.value)) state.goals.push(cb.value);
  } else {
    state.goals = state.goals.filter((g) => g !== cb.value);
  }
  renderAll();
});

$("start-amount").addEventListener("input", (e) => {
  const v = parseFloat(e.target.value);
  state.startAmount = v > 0 ? v : 1;
  refreshLive();
});

$("loops-slider").addEventListener("input", (e) => {
  state.maxLoops = +e.target.value;
  $("loops-value").textContent = state.maxLoops;
  refreshLive();
});

$("reset-btn").addEventListener("click", () => {
  state = structuredClone(EXAMPLE);
  renderAll();
});

/* ------------------------------------------------------------------ *
 * Init
 * ------------------------------------------------------------------ */
renderAll();
