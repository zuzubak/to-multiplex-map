/* The trend view: the same filtered permits as the map, on a time axis.
 *
 * Hand-drawn SVG rather than a charting library -- the site has no build step
 * and the shapes here are bars, one line and a hover rule. Reads its slice from
 * Filters, so the map and this can never disagree about what is being shown.
 *
 * Exposes `ChartView`. Loaded after filters.js; see index.html.
 */
(function (global) {
  "use strict";

  const MEASURES = {
    permits: { label: "Permit applications", short: "Applications", noun: "permits" },
    units: { label: "Dwelling units", short: "Units", noun: "units" },
  };

  // `window` is how many buckets make a year, so the trailing average always
  // means the same span of real time. Year grain has no window: an average of
  // years over years is just the series again.
  const GRAINS = {
    month: { label: "month", window: 12 },
    quarter: { label: "quarter", window: 4 },
    year: { label: "year", window: 0 },
  };

  const view = { measure: "permits", grain: "month", showAverage: true };

  let permits = [];
  let asOf = null;
  let series = [];
  let hoverIndex = null;
  let onViewChange = () => {};

  const SVG_NS = "http://www.w3.org/2000/svg";
  const PAD = { top: 16, right: 18, bottom: 42, left: 52 };

  function el(name, attrs = {}) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  function bucketOf(ym, grain) {
    const [y, m] = ym.split("-").map(Number);
    if (grain === "year") return { key: String(y), label: String(y), year: y, first: m === 1 };
    if (grain === "quarter") {
      const q = Math.floor((m - 1) / 3) + 1;
      return { key: `${y}-Q${q}`, label: `Q${q} ${y}`, year: y, first: q === 1 };
    }
    return { key: ym, label: Filters.monthLabel(ym), year: y, first: m === 1 };
  }

  /* A bucket is partial only if the extract was pulled inside it. A pull on
     Sep 1 covers all of August, so August is whole -- the gap to the newest
     application is reporting lag, which the footnote covers, not a short month. */
  function isPartial(key, grain) {
    if (!asOf) return false;
    const pulled = `${asOf.getFullYear()}-${String(asOf.getMonth() + 1).padStart(2, "0")}`;
    return bucketOf(pulled, grain).key === key;
  }

  function averageLabel() {
    const g = GRAINS[view.grain];
    return `${g.window}-${g.label}`;
  }

  /* Buckets with no permits are kept at zero rather than dropped: a closed-up
     gap would compress the axis and misstate the shape of the trend. */
  function buildSeries() {
    const months = Filters.months;
    const [lo, hi] = Filters.monthRange;
    const totals = new Map();
    for (const ym of months.slice(lo, hi + 1)) {
      const b = bucketOf(ym, view.grain);
      if (!totals.has(b.key)) totals.set(b.key, { ...b, permits: 0, units: 0 });
    }
    for (const p of permits) {
      if (!Filters.passes(p)) continue;
      const ym = Filters.monthOf(p.application_date);
      if (!ym) continue;
      const row = totals.get(bucketOf(ym, view.grain).key);
      if (!row) continue;
      row.permits += 1;
      row.units += Number(p.dwelling_units_created) || 0;
    }

    const rows = [...totals.values()];
    rows.forEach((r) => {
      r.value = r[view.measure];
      r.partial = isPartial(r.key, view.grain);
    });
    const w = GRAINS[view.grain].window;
    rows.forEach((r, i) => {
      r.avg = w && i >= w - 1
        ? rows.slice(i - w + 1, i + 1).reduce((s, x) => s + x.value, 0) / w
        : null;
    });
    return rows;
  }

  /* Clean tick steps, so the axis reads 0 / 50 / 100 and never 0 / 47 / 94. */
  function niceTicks(max) {
    if (max <= 0) return { top: 1, step: 1 };
    const raw = max / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
    return { top: Math.ceil(max / step) * step, step };
  }

  function draw() {
    const svg = document.getElementById("chart");
    const frame = document.getElementById("chart-frame");
    if (!svg || !frame.offsetParent) return; // hidden view: nothing to measure against
    svg.textContent = "";

    const rows = series;
    const total = rows.reduce((s, r) => s + r.value, 0);
    document.getElementById("chart-empty").hidden = total > 0;

    const width = Math.max(frame.clientWidth || 720, 320);
    const height = Math.round(Math.min(Math.max(width * 0.42, 260), 440));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;
    const { top: yTop, step } = niceTicks(Math.max(...rows.map((r) => r.value), 0));
    const slot = plotW / Math.max(rows.length, 1);
    const x = (i) => PAD.left + slot * (i + 0.5);
    const y = (v) => PAD.top + plotH - (v / yTop) * plotH;
    const barW = Math.max(1, Math.min(slot - 2, 26)); // 2px surface gap, capped thin

    // 45deg hatch marks a part-period bar -- the one texture the palette allows.
    const defs = el("defs");
    const pat = el("pattern", {
      id: "hatch", width: 6, height: 6,
      patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)",
    });
    pat.appendChild(el("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "currentColor", "stroke-width": 3 }));
    defs.appendChild(pat);
    svg.appendChild(defs);

    for (let v = 0; v <= yTop + 1e-9; v += step) {
      svg.appendChild(el("line", {
        class: v === 0 ? "axis-line" : "grid-line",
        x1: PAD.left, x2: width - PAD.right, y1: y(v), y2: y(v),
      }));
      const t = el("text", { class: "axis-text", x: PAD.left - 10, y: y(v) + 4, "text-anchor": "end" });
      t.textContent = v.toLocaleString("en-CA");
      svg.appendChild(t);
    }

    rows.forEach((r, i) => {
      const h = plotH - (y(r.value) - PAD.top);
      if (h <= 0) return;
      svg.appendChild(el("rect", {
        class: `bar${r.partial ? " is-partial" : ""}${i === hoverIndex ? " is-hovered" : ""}`,
        x: x(i) - barW / 2, y: y(r.value), width: barW, height: h, rx: 2,
      }));
    });

    // One label per year unless the series is short enough to label every bucket.
    const showAll = rows.length <= 14;
    const seen = new Set();
    rows.forEach((r, i) => {
      if (!showAll && (!r.first || seen.has(r.year))) return;
      seen.add(r.year);
      const t = el("text", {
        class: `axis-text${showAll ? "" : " year"}`,
        x: x(i), y: height - PAD.bottom + 20, "text-anchor": "middle",
      });
      t.textContent = showAll ? r.label : String(r.year);
      svg.appendChild(t);
    });

    const pts = rows.map((r, i) => (r.avg == null ? null : [x(i), y(r.avg)])).filter(Boolean);
    if (view.showAverage && pts.length > 1) {
      svg.appendChild(el("path", {
        class: "avg-line", d: pts.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(" "),
      }));
      const last = pts[pts.length - 1];
      svg.appendChild(el("circle", { class: "avg-dot", cx: last[0], cy: last[1], r: 4 }));
    }

    if (hoverIndex != null && rows[hoverIndex]) {
      svg.appendChild(el("line", {
        class: "hover-rule", x1: x(hoverIndex), x2: x(hoverIndex), y1: PAD.top, y2: PAD.top + plotH,
      }));
    }
    // Full-height hit bands: the target is the whole column, not the drawn bar,
    // so a one-permit month is as easy to hover as a peak.
    rows.forEach((r, i) => {
      const hit = el("rect", { class: "hit-area", x: PAD.left + slot * i, y: PAD.top, width: slot, height: plotH });
      hit.addEventListener("pointerenter", () => setHover(i, x(i), y(r.value)));
      hit.addEventListener("pointerleave", () => setHover(null));
      svg.appendChild(hit);
    });

    renderLegend();
    renderCaptions(rows, total);
    renderTable(rows);
  }

  function setHover(i, px, py) {
    hoverIndex = i;
    const tip = document.getElementById("chart-tooltip");
    if (i == null || !series[i]) { tip.hidden = true; draw(); return; }

    const r = series[i];
    const svg = document.getElementById("chart");
    const scale = svg.clientWidth / svg.viewBox.baseVal.width || 1;
    tip.textContent = "";

    const head = document.createElement("span");
    head.className = "tt-period";
    head.textContent = r.label;
    tip.appendChild(head);
    tip.appendChild(tipRow("var(--seq-200)", MEASURES[view.measure].short, r.value.toLocaleString("en-CA")));
    if (view.showAverage && r.avg != null) {
      tip.appendChild(tipRow("var(--seq-700)", `${averageLabel()} avg`,
        Math.round(r.avg).toLocaleString("en-CA"), "line"));
    }
    if (r.partial) {
      const note = document.createElement("span");
      note.className = "tt-note";
      note.textContent = "Part-period — still filling in";
      tip.appendChild(note);
    }

    tip.hidden = false;
    const frameW = document.getElementById("chart-frame").clientWidth;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(px * scale, half + 4), frameW - half - 4)}px`;
    tip.style.top = `${Math.max(py * scale - 12, tip.offsetHeight + 4)}px`;
    draw();
  }

  function tipRow(color, key, val, shape) {
    const row = document.createElement("span");
    row.className = "tt-row";
    const sw = document.createElement("span");
    sw.className = "tt-swatch";
    sw.style.background = color;
    if (shape === "line") sw.style.height = "2px";
    const k = document.createElement("span");
    k.className = "tt-key";
    k.textContent = key;
    const v = document.createElement("span");
    v.className = "tt-val";
    v.textContent = val;
    row.append(sw, k, v);
    return row;
  }

  function renderLegend() {
    const legend = document.getElementById("chart-legend");
    legend.textContent = "";
    const items = [[MEASURES[view.measure].label, "var(--seq-200)", "swatch"]];
    if (view.showAverage && GRAINS[view.grain].window) {
      items.push([`${averageLabel()} trailing average`, "var(--seq-700)", "line"]);
    }
    for (const [label, color, kind] of items) {
      const item = document.createElement("span");
      item.className = "legend-item";
      const sw = document.createElement("span");
      sw.className = `legend-swatch${kind === "line" ? " line" : ""}`;
      sw.style.background = color;
      const txt = document.createElement("span");
      txt.textContent = label;
      item.append(sw, txt);
      legend.appendChild(item);
    }
  }

  function renderCaptions(rows, total) {
    const m = MEASURES[view.measure];
    const months = Filters.months;
    const [lo, hi] = Filters.monthRange;
    document.getElementById("chart-title").textContent = `${m.label} by ${GRAINS[view.grain].label}`;
    document.getElementById("chart-scope").textContent =
      `${total.toLocaleString("en-CA")} ${m.noun} · ${Filters.describeWards()} · ` +
      `${Filters.monthLabel(months[lo])} to ${Filters.monthLabel(months[hi])}`;

    const notes = ["Counted by application date."];
    if (rows.some((r) => r.partial)) notes.push("The final bar is a part-period the extract only partly covers.");
    notes.push("Applications take time to reach the City's open data, so the most recent periods are still filling in.");
    document.getElementById("chart-note").textContent = notes.join(" ");

    document.getElementById("chart-desc").textContent =
      `Bar chart of ${m.label.toLowerCase()} by ${GRAINS[view.grain].label}, ` +
      `${Filters.monthLabel(months[lo])} to ${Filters.monthLabel(months[hi])}, covering ` +
      `${Filters.describeWards()}. Total ${total.toLocaleString("en-CA")} ${m.noun}. ` +
      `The numbers behind it are in the table below the chart.`;
  }

  function renderTable(rows) {
    document.getElementById("table-measure-head").textContent = MEASURES[view.measure].short;
    document.getElementById("table-caption").textContent =
      `${MEASURES[view.measure].label} by ${GRAINS[view.grain].label}, matching the current filters.`;
    const body = document.querySelector("#data-table tbody");
    body.textContent = "";
    for (const r of rows) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = r.label + (r.partial ? " (part-period)" : "");
      const td = document.createElement("td");
      td.textContent = r.value.toLocaleString("en-CA");
      tr.append(th, td);
      body.appendChild(tr);
    }
  }

  function syncAverageChip() {
    const chip = document.getElementById("toggle-average");
    const on = Boolean(GRAINS[view.grain].window);
    chip.disabled = !on;
    chip.dataset.active = String(view.showAverage && on);
    chip.textContent = on ? `${averageLabel()} average` : "Average n/a by year";
  }

  function setupToolbar() {
    document.querySelectorAll('.chart-toolbar .filter-chip[data-group]').forEach((chip) => {
      chip.addEventListener("click", () => {
        const group = chip.dataset.group;
        document.querySelectorAll(`.chart-toolbar .filter-chip[data-group="${group}"]`)
          .forEach((c) => { c.dataset.active = String(c === chip); });
        view[group] = chip.dataset.value;
        syncAverageChip();
        onViewChange();
        ChartView.refresh();
      });
    });

    document.getElementById("toggle-average").addEventListener("click", () => {
      view.showAverage = !view.showAverage;
      syncAverageChip();
      onViewChange();
      ChartView.refresh();
    });
    syncAverageChip();
  }

  const ChartView = {
    /* Non-default toolbar choices, for the URL hash. */
    get params() {
      const out = {};
      if (view.measure !== "permits") out.measure = view.measure;
      if (view.grain !== "month") out.grain = view.grain;
      if (!view.showAverage) out.avg = "0";
      return out;
    },

    /* Like Filters.applyHash, the hash is the whole state: an absent param means
       the default, not "keep what was there". Anything else strands a stale
       measure or grain behind a URL that says otherwise. */
    adopt(params) {
      view.measure = MEASURES[params.measure] ? params.measure : "permits";
      view.grain = GRAINS[params.grain] ? params.grain : "month";
      view.showAverage = params.avg !== "0";
      document.querySelectorAll('.chart-toolbar .filter-chip[data-group]').forEach((c) => {
        c.dataset.active = String(view[c.dataset.group] === c.dataset.value);
      });
      syncAverageChip();
    },

    init(permitProps, extractDate, viewChangeHandler) {
      permits = permitProps;
      asOf = extractDate;
      onViewChange = viewChangeHandler || (() => {});
      setupToolbar();
      let frame = null;
      global.addEventListener("resize", () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(draw);
      });
    },

    /* Recompute from the current filter slice and redraw. */
    refresh() {
      series = buildSeries();
      hoverIndex = null;
      const tip = document.getElementById("chart-tooltip");
      if (tip) tip.hidden = true;
      draw();
    },

    redraw: draw,
  };

  global.ChartView = ChartView;
})(window);
