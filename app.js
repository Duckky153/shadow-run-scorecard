// Shadow Run Scorecard: page rendering. The scoring rules live in scorecard.mjs.
(function () {
  "use strict";

  const S = window.ShadowRun;
  const DATA = window.SHADOW_RUN_DATA;
  const $ = (id) => document.getElementById(id);

  // Small DOM helper: el("td", { class: "x", "data-label": "Y" }, "text", childNode)
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function fmtValue(v) {
    if (Array.isArray(v)) return v.join(" > ");
    const s = String(v == null ? "" : v);
    return s.trim() === "" ? "(blank)" : s;
  }

  const shipperIds = DATA.shippers.map((s) => s.id);

  // ---- state, optionally from the link (?t=98&c=1#load-B-04)
  const state = { threshold: S.DEFAULT_THRESHOLD, countCommodity: false, selected: null };
  try {
    const q = new URLSearchParams(window.location.search);
    const t = Number(q.get("t"));
    if (S.THRESHOLDS.includes(t)) state.threshold = t;
    state.countCommodity = q.get("c") === "1";
  } catch (e) { /* defaults */ }

  let focusLoad = null;
  const hash = (window.location.hash || "").slice(1);
  let m = hash.match(/^(?:load|person)-([A-Z])-\d{2}$/);
  if (m && shipperIds.includes(m[1])) { state.selected = m[1]; focusLoad = hash; }
  m = hash.match(/^shipper-([A-Z])$/);
  if (m && shipperIds.includes(m[1])) state.selected = m[1];

  // ---- controls
  const sel = $("threshold");
  for (const t of S.THRESHOLDS) sel.append(el("option", { value: t, selected: t === state.threshold }, `${t}%`));
  sel.addEventListener("change", () => { state.threshold = Number(sel.value); render(); });
  const box = $("commodity");
  box.checked = state.countCommodity;
  box.addEventListener("change", () => { state.countCommodity = box.checked; render(); });
  $("dd-close").addEventListener("click", () => select(null));

  function select(id) {
    state.selected = state.selected === id ? null : id;
    render();
    if (state.selected) $("drilldown").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---- shipper table
  function renderTable(result) {
    const rows = result.shippers.map((s) => {
      const open = state.selected === s.id;
      return el("tr", { class: open ? "is-selected" : null, onclick: () => select(s.id) },
        el("td", { "data-label": "Shipper" },
          el("button", {
            type: "button", class: "linklike", "aria-expanded": open ? "true" : "false", "aria-controls": "drilldown",
            onclick: (e) => { e.stopPropagation(); select(s.id); },
          }, s.name)),
        el("td", { "data-label": "Format" }, s.format),
        el("td", { "data-label": "Loads", class: "num" }, s.loads),
        el("td", { "data-label": "Match rate", class: "num" },
          el("span", null, el("strong", null, s.rateText), el("span", { class: "sub" }, `${s.matched} of ${s.compared}`))),
        el("td", { "data-label": "Status" }, el("span", { class: `pill ${s.status}` }, s.statusLabel)),
        el("td", { "data-label": "Reason", class: "reason" }, s.reason));
    });
    const table = el("table", { class: "shippers stack" },
      el("thead", null, el("tr", null,
        ["Shipper", "Format", "Loads", "Match rate", "Status", "Reason"].map((h) => el("th", { scope: "col" }, h)))),
      el("tbody", null, rows));
    $("shipper-table").replaceChildren(table);
  }

  function sourceBlock(lines) {
    return el("div", { class: "source" },
      el("div", { class: "source-label" }, "Source excerpt"),
      el("pre", null, lines.join("\n")));
  }

  // ---- drill-down for one shipper: only mismatched fields
  function renderDrilldown(result) {
    const panel = $("drilldown");
    const s = result.shippers.find((x) => x.id === state.selected);
    if (!s) { panel.hidden = true; return; }
    panel.hidden = false;
    $("dd-title").textContent = `${s.name}: ${s.statusLabel}`;

    const withMismatch = s.loadResults.filter((r) => r.mismatches.length);
    const clean = s.loads - withMismatch.length;
    const fieldCount = s.mismatches.length;
    let summary = fieldCount === 0
      ? `All ${s.compared} compared fields matched across ${s.loads} loads.`
      : `${fieldCount} mismatched ${fieldCount === 1 ? "field" : "fields"} in ${withMismatch.length} of ${s.loads} loads; ${clean} ${clean === 1 ? "load matches" : "loads match"} on every compared field.`;
    if (s.disputes.length) summary += ` ${s.disputes.length} disputed ${s.disputes.length === 1 ? "field is" : "fields are"} listed under Needs a person.`;
    $("dd-summary").textContent = summary;

    const loadsById = Object.fromEntries(DATA.loads.map((l) => [l.load_id, l]));
    const cards = withMismatch.map((r) => {
      const load = loadsById[r.load_id];
      return el("article", { class: "load", id: `load-${r.load_id}` },
        el("h3", null, r.load_id, el("span", { class: "muted" }, ` ${load.source_format}`)),
        el("table", { class: "cmp stack" },
          el("thead", null, el("tr", null, ["Field", "Agent", "Rep", "Mismatch type"].map((h) => el("th", { scope: "col" }, h)))),
          el("tbody", null, r.mismatches.map((mm) => el("tr", null,
            el("td", { "data-label": "Field" }, S.FIELD_LABELS[mm.field]),
            el("td", { "data-label": "Agent" }, el("code", null, fmtValue(mm.agent))),
            el("td", { "data-label": "Rep" }, el("code", null, fmtValue(mm.rep))),
            el("td", { "data-label": "Mismatch type" },
              el("span", { class: `chip ${S.TYPES[mm.type].fixable ? "fixable" : ""}` }, S.TYPES[mm.type].label)))))),
        sourceBlock(load.source));
    });
    $("dd-loads").replaceChildren(...cards);
  }

  // ---- needs a person
  function renderNeedsPerson(result) {
    const list = result.disputes.map((d) => el("article", { class: "load person", id: `person-${d.load_id}` },
      el("h3", null, `${d.load_id}`, el("span", { class: "muted" }, ` Shipper ${d.shipper}, ${S.FIELD_LABELS[d.field].toLowerCase()}`)),
      el("p", { class: "flag" }, el("span", { class: "chip dispute" }, "Rep record disputed"), " ", d.note),
      el("dl", { class: "pair" },
        el("div", null, el("dt", null, "Agent"), el("dd", null, el("code", null, fmtValue(d.agent)))),
        el("div", null, el("dt", null, "Rep"), el("dd", null, el("code", null, fmtValue(d.rep))))),
      sourceBlock(d.source)));
    $("needs-person").replaceChildren(...(list.length ? list : [el("p", { class: "hint" }, "Nothing disputed.")]));
  }

  // ---- mismatch type reference table (static)
  function renderTypes() {
    $("types-body").replaceChildren(...S.TYPE_ORDER.map((t) => el("tr", null,
      el("td", null, S.TYPES[t].label),
      el("td", null, S.TYPES[t].means),
      el("td", null, S.TYPES[t].fixable ? "Yes" : "No"))));
  }

  function render() {
    const result = S.scoreAll(DATA, state);
    $("result-sentence").textContent = result.sentence;
    renderTable(result);
    renderDrilldown(result);
    renderNeedsPerson(result);
    $("feedback-link").href = `feedback.html?t=${state.threshold}&c=${state.countCommodity ? 1 : 0}`;
  }

  renderTypes();
  render();

  if (focusLoad) {
    const target = document.getElementById(focusLoad);
    if (target) {
      target.classList.add("flash");
      target.scrollIntoView({ block: "center" });
    }
  } else if (state.selected) {
    $("drilldown").scrollIntoView({ block: "start" });
  }
})();
