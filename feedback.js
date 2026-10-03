// Feedback for Product: page rendering. The grouping rules live in scorecard.mjs.
(function () {
  "use strict";

  const S = window.ShadowRun;
  const DATA = window.SHADOW_RUN_DATA;
  const $ = (id) => document.getElementById(id);

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  // Settings come from the scorecard link (?t=98&c=0); defaults otherwise.
  const opts = { threshold: S.DEFAULT_THRESHOLD, countCommodity: false };
  try {
    const q = new URLSearchParams(window.location.search);
    const t = Number(q.get("t"));
    if (S.THRESHOLDS.includes(t)) opts.threshold = t;
    opts.countCommodity = q.get("c") === "1";
  } catch (e) { /* defaults */ }
  const query = `?t=${opts.threshold}&c=${opts.countCommodity ? 1 : 0}`;

  const fb = S.feedbackRows(DATA, opts);
  $("fb-sentence").textContent = S.feedbackSentence(fb);
  $("fb-settings").textContent = `Judged at the ${opts.threshold}% bar, with commodity text ${opts.countCommodity ? "counted" : "not counted"}. Change these on the scorecard.`;
  $("back-link").href = `index.html${query}`;

  const rows = fb.rows.map((r) => el("tr", null,
    el("td", { "data-label": "Pattern" }, el("strong", null, r.label)),
    el("td", { "data-label": "Loads", class: "num" }, r.loadsAffected),
    el("td", { "data-label": "Shippers" }, r.shippers.join(", ")),
    el("td", { "data-label": "Example loads" },
      el("span", null, r.examples.map((e, i) => [i ? ", " : "", el("a", { href: `index.html${query}#${S.exampleAnchor(r.key, e.load_id)}` }, e.load_id)]))),
    el("td", { "data-label": "Who fixes it" }, r.fixer),
    el("td", { "data-label": "Blocks go-live" },
      r.blocks.length
        ? el("span", { class: "pill keep" }, `Yes, for ${S.listJoin(r.blocks)}`)
        : el("span", { class: "pill ready" }, "No")),
    el("td", { "data-label": "Next step", class: "reason" }, r.next)));

  $("fb-table").replaceChildren(el("table", { class: "feedback stack" },
    el("thead", null, el("tr", null,
      ["Pattern", "Loads", "Shippers", "Example loads", "Who fixes it", "Blocks go-live", "Next step"].map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", null, rows)));

  // Copy as text: clipboard first, and if that is refused, select the text in the visible box.
  const text = S.feedbackText(fb);
  const box = $("copy-box");
  const status = $("copy-status");
  box.value = text;
  const selectBox = () => {
    box.focus();
    box.select();
    status.textContent = "Copy was blocked here, so the text is selected. Press Ctrl+C or Cmd+C.";
  };
  $("copy-btn").addEventListener("click", () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) { selectBox(); return; }
      navigator.clipboard.writeText(text).then(
        () => { status.textContent = `Copied ${fb.rows.length} items as plain text.`; },
        selectBox);
    } catch (e) {
      selectBox();
    }
  });
})();
