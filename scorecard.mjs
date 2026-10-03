// Shadow Run Scorecard: scoring logic.
//
// This file has no imports or exports on purpose. The page loads it as a plain
// <script>, which keeps it working when opened straight from disk (file://),
// and Node loads it with `import` for the tests. Either way it sets
// globalThis.ShadowRun. All rate math uses integer counts.
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- fields

  const FIELDS = [
    { key: "reference", label: "Reference / PO", critical: true },
    { key: "pickup_facility", label: "Pickup facility", critical: true },
    { key: "pickup_date", label: "Pickup date", critical: true },
    { key: "pickup_appt", label: "Pickup appointment", critical: true },
    { key: "delivery_facility", label: "Delivery facility", critical: true },
    { key: "delivery_appt", label: "Delivery appointment", critical: true },
    { key: "equipment", label: "Equipment", critical: false },
    { key: "weight_lbs", label: "Weight (lb)", critical: true },
    { key: "stops", label: "Stops", critical: true },
    { key: "commodity", label: "Commodity", critical: false, optional: true },
  ];
  const FIELD_LABELS = Object.fromEntries(FIELDS.map((f) => [f.key, f.label]));
  const CRITICAL_FIELDS = FIELDS.filter((f) => f.critical).map((f) => f.key);

  const THRESHOLDS = [95, 98, 99, 100];
  const DEFAULT_THRESHOLD = 98;
  const MIN_LOADS = 10;

  // ---------------------------------------------------------- mismatch types
  // `fixable` means it can be fixed in setup during deployment.
  // `rule` is the short name used in the result sentence ("needs a kg-to-lb rule").

  const TYPES = {
    time_zone: {
      label: "Time zone", fixable: true, rule: "time-zone",
      fixer: "Deployment config", next: "Convert local tender times to Central time.",
      means: "Same appointment shifted by whole hours, so one side was not converted to Central.",
    },
    facility_alias: {
      label: "Facility alias", fixable: true, rule: "facility",
      fixer: "Deployment config", next: "Map each facility nickname to one facility record.",
      means: "Two different facilities with the same name prefix, so a nickname like \"DC 4\" was mapped to the wrong one.",
    },
    units: {
      label: "Units (kg not converted)", fixable: true, rule: "kg-to-lb",
      fixer: "Deployment config", next: "Convert weights marked KG to pounds.",
      means: "The agent's weight times 2.20462 is within 1% of the rep's, so kilograms went into a pounds field.",
    },
    po_in_subject: {
      label: "PO only in subject line", fixable: false, rule: "",
      fixer: "Product and Engineering", next: "Read the subject line as a source field.",
      means: "The agent left the reference blank and the PO number appears only in the email subject line.",
    },
    missing_reference: {
      label: "Missing reference", fixable: false, rule: "",
      fixer: "Product and Engineering", next: "Find where the reference lives and add that source field.",
      means: "The agent left the reference blank and the rep has one.",
    },
    stop_order: {
      label: "Stop order", fixable: false, rule: "",
      fixer: "Product and Engineering", next: "Keep stops in the order the tender lists them.",
      means: "Same stops in a different order.",
    },
    window_cut_short: {
      label: "Window cut short", fixable: false, rule: "",
      fixer: "Product and Engineering", next: "Keep both ends of an appointment window.",
      means: "The rep has a window and the agent kept only its start time.",
    },
    commodity_wording: {
      label: "Commodity wording", fixable: true, rule: "commodity-wording",
      fixer: "Deployment config", next: "Map the shipper's commodity wording to the TMS commodity list.",
      means: "Commodity text worded differently (only counted when the toggle is on).",
    },
    wrong_value: {
      label: "Wrong value", fixable: false, rule: "",
      fixer: "Product and Engineering", next: "Review the example loads by hand.",
      means: "Any other difference.",
    },
  };
  const TYPE_ORDER = Object.keys(TYPES);

  const DISPUTE = {
    key: "disputed",
    label: "Disputed rep record",
    fixer: "Customer data",
    next: "Have a person confirm with the shipper and fix the rep's record.",
  };

  const STATUS_LABELS = {
    ready: "Ready to skip review",
    config: "Needs a config rule",
    keep: "Keep in review",
  };

  // ---------------------------------------------------------- normalizing

  function normText(value) {
    return String(value == null ? "" : value).trim().toLowerCase();
  }

  // "2026-09-14", "09/14/2026" and "9/14/2026" all become "2026-09-14".
  function normDate(value) {
    const s = normText(value);
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    return s;
  }

  // "08:00", "0800" and "8:00 am" all become 480 (minutes after midnight).
  function parseTime(value) {
    const s = normText(value);
    let m = s.match(/^(\d{1,2}):?(\d{2})\s*(am|pm)?$/);
    if (!m) return null;
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  // A single time or a window "start-end". Returns { start, end } or null.
  function parseAppt(value) {
    const parts = normText(value).split("-").map((p) => p.trim());
    if (parts.length === 1) {
      const t = parseTime(parts[0]);
      return t == null ? null : { start: t, end: null };
    }
    if (parts.length === 2) {
      const a = parseTime(parts[0]);
      const b = parseTime(parts[1]);
      return a == null || b == null ? null : { start: a, end: b };
    }
    return null;
  }

  function fmtMinutes(t) {
    return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  }

  function normAppt(value) {
    const p = parseAppt(value);
    if (!p) return normText(value);
    return p.end == null ? fmtMinutes(p.start) : `${fmtMinutes(p.start)}-${fmtMinutes(p.end)}`;
  }

  function normalize(key, value) {
    if (key === "stops") return (Array.isArray(value) ? value : []).map(normText).join(" > ");
    if (key === "pickup_date") return normDate(value);
    if (key === "pickup_appt" || key === "delivery_appt") return normAppt(value);
    return normText(value); // weights are compared as written: no unit conversion
  }

  function fieldsMatch(key, agentValue, repValue) {
    return normalize(key, agentValue) === normalize(key, repValue);
  }

  // ---------------------------------------------------------- classifying

  function classify(key, agentValue, repValue, load) {
    if (key === "reference") {
      if (normText(agentValue) === "" && normText(repValue) !== "") {
        const digits = normText(repValue).replace(/\D/g, "");
        const subject = ((load && load.source) || []).find((l) => /^subject:/i.test(l));
        if (digits && subject && subject.includes(digits)) return "po_in_subject";
        return "missing_reference";
      }
      return "wrong_value";
    }
    if (key === "weight_lbs") {
      const a = Number(agentValue);
      const r = Number(repValue);
      // a * 2.20462 within 1% of r, kept in integers: |a*220462 - r*100000| <= r*1000
      if (Number.isInteger(a) && Number.isInteger(r) && a > 0 && r > 0 &&
          Math.abs(a * 220462 - r * 100000) <= r * 1000) return "units";
      return "wrong_value";
    }
    if (key === "pickup_appt" || key === "delivery_appt") {
      const a = parseAppt(agentValue);
      const r = parseAppt(repValue);
      if (a && r) {
        if (a.end == null && r.end != null && a.start === r.start) return "window_cut_short";
        const shift = a.start - r.start;
        const sameShape = (a.end == null && r.end == null) ||
          (a.end != null && r.end != null && a.end - r.end === shift);
        if (shift !== 0 && shift % 60 === 0 && Math.abs(shift) <= 180 && sameShape) return "time_zone";
      }
      return "wrong_value";
    }
    if (key === "pickup_facility" || key === "delivery_facility") {
      const firstWord = (v) => normText(v).split(/\s+/)[0] || "";
      if (firstWord(agentValue) !== "" && firstWord(agentValue) === firstWord(repValue)) return "facility_alias";
      return "wrong_value";
    }
    if (key === "stops") {
      const a = (agentValue || []).map(normText);
      const r = (repValue || []).map(normText);
      const sorted = (x) => x.slice().sort().join(" > ");
      if (a.length === r.length && sorted(a) === sorted(r)) return "stop_order";
      return "wrong_value";
    }
    if (key === "commodity") return "commodity_wording";
    return "wrong_value";
  }

  // ---------------------------------------------------------- scoring

  function settings(opts) {
    const o = opts || {};
    const t = Number(o.threshold);
    return {
      threshold: Number.isInteger(t) && t >= 0 && t <= 100 ? t : DEFAULT_THRESHOLD,
      countCommodity: Boolean(o.countCommodity),
    };
  }

  function scoredFields(opts) {
    return settings(opts).countCommodity ? CRITICAL_FIELDS.concat(["commodity"]) : CRITICAL_FIELDS.slice();
  }

  // Compares one load field by field.
  function compareLoad(load, opts) {
    const disputedFields = new Map((load.disputed || []).map((d) => [d.field, d.note || ""]));
    const out = { load_id: load.load_id, shipper: load.shipper, compared: 0, matched: 0, mismatches: [], disputes: [] };
    for (const key of scoredFields(opts)) {
      const agent = load.agent[key];
      const rep = load.rep[key];
      if (disputedFields.has(key)) {
        out.disputes.push({ load_id: load.load_id, shipper: load.shipper, field: key, agent, rep, note: disputedFields.get(key), source: load.source });
        continue;
      }
      out.compared += 1;
      if (fieldsMatch(key, agent, rep)) {
        out.matched += 1;
      } else {
        out.mismatches.push({ load_id: load.load_id, shipper: load.shipper, field: key, agent, rep, type: classify(key, agent, rep, load) });
      }
    }
    return out;
  }

  // Integer tenths of a percent, rounded down so a failing rate never displays as passing.
  function rateTenths(matched, compared) {
    return compared > 0 ? Math.floor((matched * 1000) / compared) : 0;
  }

  function fmtRate(matched, compared) {
    if (compared === 0) return "n/a";
    if (matched === compared) return "100%";
    const t = rateTenths(matched, compared);
    return `${Math.floor(t / 10)}.${t % 10}%`;
  }

  // A type label for the middle of a sentence: "Time zone" -> "time zone", "PO only..." unchanged.
  function midLabel(type) {
    const l = TYPES[type].label;
    return /^[A-Z]{2}/.test(l) ? l : l.charAt(0).toLowerCase() + l.slice(1);
  }

  function times(n) {
    return n === 1 ? "once" : `${n} times`;
  }

  function listJoin(items) {
    if (items.length <= 1) return items.join("");
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
  }

  function scoreShipper(shipper, loads, opts) {
    const s = settings(opts);
    const own = loads.filter((l) => l.shipper === shipper.id);
    const results = own.map((l) => compareLoad(l, s));
    let compared = 0;
    let matched = 0;
    const typeCounts = {};
    const mismatches = [];
    const disputes = [];
    for (const r of results) {
      compared += r.compared;
      matched += r.matched;
      for (const m of r.mismatches) {
        typeCounts[m.type] = (typeCounts[m.type] || 0) + 1;
        mismatches.push(m);
      }
      disputes.push(...r.disputes);
    }
    const meetsBar = compared > 0 && matched * 100 >= s.threshold * compared;
    const enoughLoads = own.length >= MIN_LOADS;
    const repeated = TYPE_ORDER.filter((t) => (typeCounts[t] || 0) >= 2);
    const allRepeatsFixable = repeated.length > 0 && repeated.every((t) => TYPES[t].fixable);

    let status;
    if (meetsBar && enoughLoads && repeated.length === 0) status = "ready";
    else if (allRepeatsFixable) status = "config";
    else status = "keep";

    // Reason, built from the same facts the status used.
    const bar = meetsBar ? `at or above ${s.threshold}%` : `under ${s.threshold}%`;
    const sentences = [`${matched} of ${compared} matched (${fmtRate(matched, compared)}), ${bar}.`];
    if (!enoughLoads) sentences.push(`Only ${own.length} loads seen; the minimum is ${MIN_LOADS}.`);
    if (repeated.length === 0) {
      const seen = TYPE_ORDER.filter((t) => typeCounts[t]);
      if (status === "ready") sentences.push("No mismatch type repeated.");
      else if (seen.length) sentences.push(`Mismatches: ${listJoin(seen.map((t) => `${midLabel(t)} ${times(typeCounts[t])}`))}.`);
    } else {
      const list = listJoin(repeated.map((t) => `${midLabel(t)} ${times(typeCounts[t])}`));
      const blockers = repeated.filter((t) => !TYPES[t].fixable);
      let tail;
      if (blockers.length === 0) tail = repeated.length === 1 ? "it can be fixed in setup" : `${repeated.length === 2 ? "both" : "all"} can be fixed in setup`;
      else if (blockers.length === repeated.length) tail = repeated.length === 1 ? "it can't be fixed in setup" : "none can be fixed in setup";
      else tail = `${listJoin(blockers.map(midLabel))} can't be fixed in setup`;
      sentences.push(`Repeated: ${list}; ${tail}.`);
    }
    const reason = sentences.join(" ");

    return {
      id: shipper.id,
      name: shipper.name,
      format: shipper.format,
      loads: own.length,
      compared,
      matched,
      rateTenths: rateTenths(matched, compared),
      rateText: fmtRate(matched, compared),
      meetsBar,
      typeCounts,
      repeated,
      status,
      statusLabel: STATUS_LABELS[status],
      reason,
      mismatches,
      disputes,
      loadResults: results,
    };
  }

  function resultSentence(shippers, threshold) {
    const ready = shippers.filter((s) => s.status === "ready");
    const total = shippers.length;
    let head;
    if (ready.length === total) return `At ${threshold}%, all ${total} shippers can skip review.`;
    if (ready.length === 0) head = `At ${threshold}%, no shipper can skip review yet`;
    else head = `At ${threshold}%, ${ready.length} of ${total} shippers can skip review`;

    const clauses = [];
    for (const s of shippers.filter((x) => x.status === "config")) {
      const rules = s.repeated.map((t) => TYPES[t].rule);
      clauses.push(rules.length === 1
        ? `${s.name} needs a ${rules[0]} rule`
        : `${s.name} needs ${listJoin(rules)} rules`);
    }
    const keep = shippers.filter((x) => x.status === "keep").map((x) => x.id);
    if (keep.length === 1) clauses.push(`Shipper ${keep[0]} stays in review`);
    if (keep.length > 1) clauses.push(`Shippers ${listJoin(keep)} stay in review`);
    return `${head}; ${listJoin(clauses)}.`;
  }

  function scoreAll(data, opts) {
    const s = settings(opts);
    const shippers = data.shippers.map((sh) => scoreShipper(sh, data.loads, s));
    const disputes = shippers.flatMap((x) => x.disputes);
    return {
      threshold: s.threshold,
      countCommodity: s.countCommodity,
      shippers,
      disputes,
      sentence: resultSentence(shippers, s.threshold),
    };
  }

  // ---------------------------------------------------------- feedback for Product
  // One row per mismatch pattern, plus one for disputed rep records.
  // A pattern blocks go-live for a shipper that is not ready when the pattern
  // repeats there or the shipper is under the bar. Disputes never block,
  // because disputed fields are left out of the rate.

  function feedbackRows(data, opts) {
    const result = scoreAll(data, opts);
    const byId = Object.fromEntries(result.shippers.map((s) => [s.id, s]));
    const groups = new Map();
    const add = (key, item) => {
      if (!groups.has(key)) groups.set(key, { loads: [], shippers: [] });
      const g = groups.get(key);
      if (!g.loads.some((l) => l.load_id === item.load_id)) g.loads.push({ load_id: item.load_id, shipper: item.shipper });
      if (!g.shippers.includes(item.shipper)) g.shippers.push(item.shipper);
    };
    for (const s of result.shippers) {
      for (const m of s.mismatches) add(m.type, m);
      for (const d of s.disputes) add(DISPUTE.key, d);
    }
    const order = TYPE_ORDER.concat([DISPUTE.key]);
    const rows = [];
    for (const [key, g] of groups) {
      const meta = key === DISPUTE.key ? DISPUTE : TYPES[key];
      const blocks = key === DISPUTE.key ? [] : g.shippers.filter((id) => {
        const sh = byId[id];
        return sh.status !== "ready" && (sh.repeated.includes(key) || !sh.meetsBar);
      });
      rows.push({
        key,
        label: meta.label,
        loadsAffected: g.loads.length,
        shippers: g.shippers.slice().sort(),
        examples: g.loads.slice(0, 3),
        fixer: meta.fixer,
        blocks,
        next: meta.next,
      });
    }
    rows.sort((a, b) => b.loadsAffected - a.loadsAffected || order.indexOf(a.key) - order.indexOf(b.key));
    return { result, rows };
  }

  // Where an example load links on the scorecard: a disputed load opens its
  // "Needs a person" card, any other load opens its card in the drill-down.
  function exampleAnchor(rowKey, loadId) {
    return `${rowKey === DISPUTE.key ? "person" : "load"}-${loadId}`;
  }

  function shipperList(ids) {
    return ids.length === 1 ? `Shipper ${ids[0]}` : `Shippers ${listJoin(ids)}`;
  }

  function feedbackLine(row) {
    const loads = `${row.loadsAffected} ${row.loadsAffected === 1 ? "load" : "loads"}`;
    const next = row.next.charAt(0).toLowerCase() + row.next.slice(1).replace(/\.$/, "");
    const blocks = row.blocks.length ? `blocks go-live for ${listJoin(row.blocks)}` : "does not block go-live";
    return `${row.label}, ${loads}, ${shipperList(row.shippers)}: ${row.fixer}, ${next}; ${blocks}.`;
  }

  function feedbackSentence(fb) {
    const { result, rows } = fb;
    // Distinct loads across all rows (a load with two patterns counts once).
    const loadIds = new Set();
    for (const s of result.shippers) {
      for (const m of s.mismatches) loadIds.add(m.load_id);
      for (const d of s.disputes) loadIds.add(d.load_id);
    }
    const blocking = rows.filter((r) => r.blocks.length > 0);
    const config = blocking.filter((r) => r.fixer === "Deployment config").length;
    const head = `At the ${result.threshold}% bar, the shadow run shows ${rows.length} patterns across ${loadIds.size} loads`;
    if (blocking.length === 0) return `${head}, and none of them block go-live.`;
    const what = blocking.length === 1 ? "1 blocks go-live" : `${blocking.length} block go-live`;
    const cfg = config === blocking.length
      ? (blocking.length === 1 ? "and it can be fixed in deployment config" : "and all of them can be fixed in deployment config")
      : `and ${config} of those can be fixed in deployment config`;
    return `${head}; ${what}, ${cfg}.`;
  }

  function feedbackText(fb) {
    const { result, rows } = fb;
    const lines = [
      "Shadow run feedback for Product (synthetic data)",
      `Judged at the ${result.threshold}% bar, commodity text ${result.countCommodity ? "counted" : "not counted"}.`,
      "",
    ];
    rows.forEach((r, i) => {
      const ex = r.examples.map((e) => e.load_id).join(", ");
      lines.push(`${i + 1}. ${feedbackLine(r)} Example loads: ${ex}.`);
    });
    return lines.join("\n");
  }

  root.ShadowRun = {
    FIELDS, FIELD_LABELS, CRITICAL_FIELDS, THRESHOLDS, DEFAULT_THRESHOLD, MIN_LOADS,
    TYPES, TYPE_ORDER, DISPUTE, STATUS_LABELS,
    normText, normDate, parseTime, parseAppt, normalize, fieldsMatch, classify,
    compareLoad, scoreShipper, scoreAll, resultSentence, fmtRate, rateTenths, listJoin,
    feedbackRows, feedbackLine, feedbackSentence, feedbackText, shipperList, exampleAnchor,
  };
})(globalThis);
