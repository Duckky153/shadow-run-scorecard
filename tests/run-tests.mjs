// Plain Node tests for the Shadow Run Scorecard. Run: node tests/run-tests.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
await import(join(root, "data.js"));
await import(join(root, "scorecard.mjs"));
const S = globalThis.ShadowRun;
const DATA = globalThis.SHADOW_RUN_DATA;

function privatePatterns() {
  const file = join(process.env.HOME || "", ".config/leakgate/scorecard-patterns.txt");
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return [/\/Users\//, /@[a-z0-9-]+\.[a-z]/i]; }
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const m = /^\/(.*)\/([a-z]*)$/.exec(l);
    return m ? new RegExp(m[1], m[2]) : new RegExp(l);
  });
}

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}\n      ${String(err.message).split("\n").join("\n      ")}`);
  }
}

const score = (opts) => S.scoreAll(DATA, opts);
const byId = (result) => Object.fromEntries(result.shippers.map((s) => [s.id, s]));
const countTypes = (result) => Object.fromEntries(result.shippers.map((s) => [s.id, s.typeCounts]));

// ------------------------------------------------------------ normalizing (rule 1)

test("dates in ISO and US formats normalize to the same value", () => {
  assert.equal(S.normDate("2026-09-14"), "2026-09-14");
  assert.equal(S.normDate("09/14/2026"), "2026-09-14");
  assert.equal(S.normDate(" 9/4/2026 "), "2026-09-04");
});

test("times normalize across 08:00, 0800 and 8:00 AM", () => {
  assert.equal(S.parseTime("08:00"), 480);
  assert.equal(S.parseTime("0800"), 480);
  assert.equal(S.parseTime("8:00 AM"), 480);
  assert.equal(S.parseTime("2:30 pm"), 870);
  assert.equal(S.parseTime("25:00"), null);
  assert.deepEqual(S.parseAppt("0800-1400"), { start: 480, end: 840 });
});

test("fields match after trimming and ignoring case", () => {
  assert.ok(S.fieldsMatch("reference", "PO-31041", "PO-31041 "));
  assert.ok(S.fieldsMatch("pickup_facility", "Shipper A Plant, Rockford IL", "SHIPPER A PLANT, ROCKFORD IL"));
  assert.ok(S.fieldsMatch("pickup_appt", "08:00-14:00", "0800-1400"));
  assert.ok(S.fieldsMatch("stops", ["Rockford IL", "Omaha NE"], ["ROCKFORD IL", "OMAHA NE"]));
});

test("units are not converted, so a kilogram weight fails", () => {
  assert.equal(S.fieldsMatch("weight_lbs", 18000, 39683), false);
});

test("stop order matters", () => {
  assert.equal(S.fieldsMatch("stops", ["A", "B", "C"], ["A", "C", "B"]), false);
});

// ------------------------------------------------------------ classifying

test("mismatch types are classified by their simple checks", () => {
  assert.equal(S.classify("pickup_appt", "10:00", "0900"), "time_zone");
  assert.equal(S.classify("delivery_appt", "08:00", "0800-1400"), "window_cut_short");
  assert.equal(S.classify("weight_lbs", 18000, 39683), "units");
  assert.equal(S.classify("weight_lbs", 18000, 30000), "wrong_value");
  assert.equal(S.classify("delivery_facility", "Harlow Foods DC 4 Annex, Joliet IL", "HARLOW FOODS DC 4, JOLIET IL"), "facility_alias");
  assert.equal(S.classify("stops", ["A", "C", "B"], ["A", "B", "C"]), "stop_order");
  assert.equal(S.classify("commodity", "Paper towels", "PAPER TWL"), "commodity_wording");
  const subjectLoad = { source: ["Subject: Tender PO 55104", "Body: Please pick up 9/16"] };
  assert.equal(S.classify("reference", "", "PO-55104", subjectLoad), "po_in_subject");
  assert.equal(S.classify("reference", "", "PO-55104", { source: ["Body: no PO here"] }), "missing_reference");
});

test("time zone needs a whole-hour shift of the same shape", () => {
  assert.equal(S.classify("pickup_appt", "10:30", "0900"), "wrong_value");
  assert.equal(S.classify("pickup_appt", "10:00-12:00", "0900-1100"), "time_zone");
  assert.equal(S.classify("pickup_appt", "10:00-12:00", "0900-1200"), "wrong_value");
});

// ------------------------------------------------------------ the synthetic data

test("data has 6 shippers, 72 loads, 12 each, with 10 fields on both records", () => {
  assert.equal(DATA.shippers.length, 6);
  assert.equal(DATA.loads.length, 72);
  const keys = S.FIELDS.map((f) => f.key).sort();
  for (const sh of DATA.shippers) assert.equal(DATA.loads.filter((l) => l.shipper === sh.id).length, 12, sh.id);
  for (const l of DATA.loads) {
    assert.deepEqual(Object.keys(l.agent).sort(), keys, l.load_id);
    assert.deepEqual(Object.keys(l.rep).sort(), keys, l.load_id);
    assert.ok(l.source.length >= 2 && l.source.length <= 4, `${l.load_id} excerpt has ${l.source.length} lines`);
    assert.ok(Array.isArray(l.agent.stops) && Array.isArray(l.rep.stops), l.load_id);
    assert.equal(l.source_format, DATA.shippers.find((s) => s.id === l.shipper).format, l.load_id);
  }
});

test("each shipper has one source format, and the load ids are unique", () => {
  const ids = new Set(DATA.loads.map((l) => l.load_id));
  assert.equal(ids.size, 72);
  const formats = Object.fromEntries(DATA.shippers.map((s) => [s.id, s.format]));
  assert.deepEqual(formats, { A: "Spreadsheet", B: "Email", C: "PDF", D: "PDF", E: "Email", F: "Spreadsheet" });
});

test("the seeded critical-field patterns are exactly the ones in the spec", () => {
  assert.deepEqual(countTypes(score({ threshold: 98 })), {
    A: {},
    B: { po_in_subject: 2 },
    C: { window_cut_short: 1 },
    D: { time_zone: 5, facility_alias: 2 },
    E: { stop_order: 1 },
    F: { units: 4 },
  });
});

test("time zone loads are pickup appointments, facility alias loads are DC 4 deliveries", () => {
  const D = byId(score({}))["D"];
  for (const m of D.mismatches) {
    if (m.type === "time_zone") assert.equal(m.field, "pickup_appt");
    if (m.type === "facility_alias") assert.match(m.agent, /DC 4/);
  }
});

test("disputes: one pickup date each at Shippers A and C, where the agent matches the tender", () => {
  const r = score({});
  assert.deepEqual(r.disputes.map((d) => [d.shipper, d.field]), [["A", "pickup_date"], ["C", "pickup_date"]]);
  for (const d of r.disputes) {
    const [yyyy, mm, dd] = d.agent.split("-");
    assert.ok(d.source.join(" ").includes(`${mm}/${dd}/${yyyy}`), `tender should show the agent's date for ${d.load_id}`);
    assert.ok(!d.source.join(" ").includes(d.rep), `tender should not show the rep's date for ${d.load_id}`);
  }
});

// ------------------------------------------------------------ rates and statuses (rules 2 to 5)

test("disputed fields are left out: A compares 95 of 96 critical fields", () => {
  const s = byId(score({}));
  assert.equal(s.A.compared, 95);
  assert.equal(s.A.matched, 95);
  assert.equal(s.C.compared, 95);
  assert.equal(s.C.matched, 94);
});

test("Shipper B is 94 of 96, shown as 97.9%", () => {
  const B = byId(score({})).B;
  assert.equal(B.matched, 94);
  assert.equal(B.compared, 96);
  assert.equal(B.rateTenths, 979);
  assert.equal(B.rateText, "97.9%");
});

test("rates round down, so 95 of 96 shows 98.9%, not 99.0%", () => {
  assert.equal(S.fmtRate(95, 96), "98.9%");
  assert.equal(S.fmtRate(96, 96), "100%");
  assert.equal(S.fmtRate(0, 0), "n/a");
});

test("at 98%: A, C and E ready; D and F need a config rule; B stays in review", () => {
  const s = byId(score({ threshold: 98 }));
  assert.deepEqual(Object.fromEntries(Object.values(s).map((x) => [x.id, x.status])),
    { A: "ready", B: "keep", C: "ready", D: "config", E: "ready", F: "config" });
  assert.match(s.B.reason, /94 of 96 matched \(97\.9%\), under 98%/);
  assert.match(s.B.reason, /PO only in subject line 2 times; it can't be fixed in setup/);
});

test("the result sentence at 98% reads as the spec example", () => {
  assert.equal(score({ threshold: 98 }).sentence,
    "At 98%, 3 of 6 shippers can skip review; Shipper D needs time-zone and facility rules, Shipper F needs a kg-to-lb rule, and Shipper B stays in review.");
});

test("98% is the default bar and commodity is off by default", () => {
  const r = score();
  assert.equal(r.threshold, 98);
  assert.equal(r.countCommodity, false);
  assert.equal(byId(r).A.compared, 95);
});

test("at 99%: Shipper C drops to keep in review (and so does E, one mismatch each)", () => {
  const s = byId(score({ threshold: 99 }));
  assert.equal(s.C.status, "keep");
  assert.match(s.C.reason, /under 99%. Mismatches: window cut short once\./);
  assert.equal(s.E.status, "keep");
  assert.equal(s.A.status, "ready");
});

test("at 95%: B is above the bar but still stays in review because its mismatch repeats", () => {
  const s = byId(score({ threshold: 95 }));
  assert.equal(s.B.meetsBar, true);
  assert.equal(s.B.status, "keep");
  assert.equal(s.F.meetsBar, true);
  assert.equal(s.F.status, "config");
});

test("at 100%: only the clean shipper is ready", () => {
  const ready = score({ threshold: 100 }).shippers.filter((s) => s.status === "ready").map((s) => s.id);
  assert.deepEqual(ready, ["A"]);
});

test("commodity toggle adds one field per load and surfaces wording differences", () => {
  const r = score({ threshold: 98, countCommodity: true });
  const s = byId(r);
  assert.equal(s.B.compared, 108);
  assert.equal(s.A.compared, 107);
  assert.deepEqual(s.E.typeCounts, { stop_order: 1, commodity_wording: 2 });
  assert.equal(s.E.status, "config");
  assert.equal(r.sentence,
    "At 98%, 2 of 6 shippers can skip review; Shipper D needs time-zone and facility rules, Shipper E needs a commodity-wording rule, Shipper F needs a kg-to-lb rule, and Shipper B stays in review.");
});

test("counting commodity adds easy fields, so C clears 99% only with the toggle on", () => {
  assert.equal(byId(score({ threshold: 99 })).C.status, "keep");
  const C = byId(score({ threshold: 99, countCommodity: true })).C;
  assert.equal(`${C.matched}/${C.compared}`, "106/107");
  assert.equal(C.status, "ready");
});

test("a shipper with fewer than 10 loads is not judged ready", () => {
  const nine = DATA.loads.filter((l) => l.shipper === "A").slice(0, 9).map((l) => ({ ...l, shipper: "X" }));
  const r = S.scoreAll({ shippers: [{ id: "X", name: "Shipper X", format: "PDF" }], loads: nine }, { threshold: 98 });
  assert.equal(r.shippers[0].matched, r.shippers[0].compared);
  assert.equal(r.shippers[0].status, "keep");
  assert.match(r.shippers[0].reason, /Only 9 loads seen; the minimum is 10\./);
});

test("a repeated type that can't be fixed in setup beats a fixable one", () => {
  const loads = DATA.loads.filter((l) => l.shipper === "B").map((l) => ({ ...l, shipper: "Y" }));
  loads[0] = { ...loads[0], agent: { ...loads[0].agent, pickup_appt: "09:00" }, rep: { ...loads[0].rep, pickup_appt: "0800" } };
  loads[1] = { ...loads[1], agent: { ...loads[1].agent, pickup_appt: "08:00" }, rep: { ...loads[1].rep, pickup_appt: "0700" } };
  const y = S.scoreAll({ shippers: [{ id: "Y", name: "Shipper Y", format: "Email" }], loads }, { threshold: 98 }).shippers[0];
  assert.deepEqual(y.repeated, ["time_zone", "po_in_subject"]);
  assert.equal(y.status, "keep");
  assert.match(y.reason, /PO only in subject line can't be fixed in setup/);
});

test("an out-of-range threshold falls back to the default", () => {
  assert.equal(score({ threshold: 150 }).threshold, 98);
  assert.equal(score({ threshold: "abc" }).threshold, 98);
});

// ------------------------------------------------------------ feedback for Product

test("feedback has one row per pattern, sorted by loads affected", () => {
  const fb = S.feedbackRows(DATA, { threshold: 98 });
  assert.deepEqual(fb.rows.map((r) => [r.label, r.loadsAffected]), [
    ["Time zone", 5],
    ["Units (kg not converted)", 4],
    ["Facility alias", 2],
    ["PO only in subject line", 2],
    ["Disputed rep record", 2],
    ["Stop order", 1],
    ["Window cut short", 1],
  ]);
});

test("feedback rows name the fixer and whether it blocks go-live at 98%", () => {
  const rows = Object.fromEntries(S.feedbackRows(DATA, { threshold: 98 }).rows.map((r) => [r.key, r]));
  assert.equal(rows.time_zone.fixer, "Deployment config");
  assert.deepEqual(rows.time_zone.blocks, ["D"]);
  assert.deepEqual(rows.units.blocks, ["F"]);
  assert.equal(rows.po_in_subject.fixer, "Product and Engineering");
  assert.deepEqual(rows.po_in_subject.blocks, ["B"]);
  assert.deepEqual(rows.window_cut_short.blocks, []);
  assert.deepEqual(rows.stop_order.blocks, []);
  assert.equal(rows.disputed.fixer, "Customer data");
  assert.deepEqual(rows.disputed.blocks, []);
  assert.deepEqual(rows.disputed.shippers, ["A", "C"]);
});

test("at 99% the cut-short window and the stop order start blocking", () => {
  const rows = Object.fromEntries(S.feedbackRows(DATA, { threshold: 99 }).rows.map((r) => [r.key, r]));
  assert.deepEqual(rows.window_cut_short.blocks, ["C"]);
  assert.deepEqual(rows.stop_order.blocks, ["E"]);
});

test("the PO feedback line matches the spec example", () => {
  const row = S.feedbackRows(DATA, { threshold: 98 }).rows.find((r) => r.key === "po_in_subject");
  assert.equal(S.feedbackLine(row),
    "PO only in subject line, 2 loads, Shipper B: Product and Engineering, read the subject line as a source field; blocks go-live for B.");
});

test("feedback summary sentence and plain text", () => {
  const fb = S.feedbackRows(DATA, { threshold: 98 });
  assert.equal(S.feedbackSentence(fb),
    "At the 98% bar, the shadow run shows 7 patterns across 17 loads; 4 block go-live, and 3 of those can be fixed in deployment config.");
  const text = S.feedbackText(fb);
  assert.match(text, /^Shadow run feedback for Product \(synthetic data\)/);
  assert.equal(text.split("\n").filter((l) => /^\d+\. /.test(l)).length, 7);
  assert.match(text, /Example loads: B-04, B-09\./);
});

test("example loads link to the drill-down, and disputed loads to their Needs a person card", () => {
  const rows = Object.fromEntries(S.feedbackRows(DATA, { threshold: 98 }).rows.map((r) => [r.key, r]));
  assert.equal(S.exampleAnchor("po_in_subject", rows.po_in_subject.examples[0].load_id), "load-B-04");
  assert.deepEqual(rows.disputed.examples.map((e) => S.exampleAnchor("disputed", e.load_id)), ["person-A-07", "person-C-05"]);
  const app = readFileSync(join(root, "app.js"), "utf8");
  assert.match(app, /id: `person-\$\{d\.load_id\}`/);
  assert.match(app, /\(\?:load\|person\)/);
});

// ------------------------------------------------------------ shipped files

const SHIPPED = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(html|css|js|mjs|md)$/.test(name)) SHIPPED.push(p);
  }
})(root);

test("shipped files carry no private details, and only the footer names a person", () => {
  // Private patterns live outside the repository (one regex per line, optional /i flag).
  const banned = privatePatterns();
  const bad = [];
  for (const p of SHIPPED.filter((f) => f !== fileURLToPath(import.meta.url))) {
    const src = readFileSync(p, "utf8");
    for (const re of banned) if (re.test(src)) bad.push(`${p.slice(root.length + 1)} matches ${re}`);
    const names = src.match(/Dakshit Raj/g) || [];
    if (/\.html$/.test(p) && names.length !== 1) bad.push(`${p.slice(root.length + 1)} should credit the builder once in the footer`);
    if (!/\.html$/.test(p) && names.length) bad.push(`${p.slice(root.length + 1)} names a person`);
  }
  assert.deepEqual(bad, []);
});

test("both pages say synthetic data and credit the builder in the footer", () => {
  for (const name of ["index.html", "feedback.html"]) {
    const src = readFileSync(join(root, name), "utf8");
    assert.match(src, /<span class="badge">Synthetic data<\/span>/, name);
    assert.match(src, /<footer[\s\S]*Built by Dakshit Raj[\s\S]*<\/footer>/, name);
  }
  assert.match(readFileSync(join(root, "index.html"), "utf8"), /Questions I'd want answered[\s\S]*Which fixes happen in configuration during deployment, and which go back to Engineering\?/);
  assert.match(readFileSync(join(root, "feedback.html"), "utf8"), /How does feedback from deployments reach Product today\?/);
});

test("no em or en dashes in any shipped file", () => {
  const DASHES = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");
  const bad = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(html|css|js|mjs|md)$/.test(name) && DASHES.test(readFileSync(p, "utf8"))) bad.push(name);
    }
  };
  walk(root);
  assert.deepEqual(bad, []);
});

test("pages make no network calls and load no remote files", () => {
  for (const name of ["index.html", "feedback.html", "app.js", "feedback.js", "scorecard.mjs", "style.css"]) {
    const src = readFileSync(join(root, name), "utf8");
    assert.doesNotMatch(src, /\b(fetch|XMLHttpRequest|WebSocket)\s*\(/, name);
    assert.doesNotMatch(src, /(src|href)=["']https?:/, name);
    assert.doesNotMatch(src, /@import|url\(\s*["']?https?:/, name);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
