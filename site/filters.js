/* The filter layer, shared by both views.
 *
 * The map and the trend chart are two lenses on one slice of the data, so the
 * slice lives here and nowhere else: one vocabulary of chips, one predicate,
 * one URL encoding. Before this existed the chip markup was duplicated across
 * two HTML files -- sixteen byte-identical buttons -- and nothing stopped the
 * two copies from drifting into disagreeing about what a filter meant.
 *
 * The whole filter bar is rendered from GROUPS below, so adding a filter is a
 * one-line change here and both views pick it up.
 *
 * Exposes a single global, `Filters`. No modules: the site is served as plain
 * files with no build step, and <script> ordering in index.html is the only
 * dependency graph there is.
 */
(function (global) {
  "use strict";

  // Every chip in the bar. `on` is the default state -- the source of truth for
  // what a first-time visitor sees, and the baseline the URL hash is diffed
  // against so a default view produces a clean, empty hash.
  const GROUPS = [
    {
      key: "status", label: "Permit status", prop: "status", param: "status",
      options: [
        { value: "active", label: "Active", on: true, swatch: "var(--series-active)" },
        { value: "cleared", label: "Cleared", on: true, swatch: "var(--series-cleared)" },
      ],
    },
    {
      key: "roadClass", label: "Street type", prop: "road_class", param: "road",
      options: [
        { value: "major", label: "Major", on: true },
        { value: "minor", label: "Minor", on: true },
        { value: "unknown", label: "Unknown", on: true },
      ],
    },
    {
      // WHERE a permit's new units come from. Two start off: basement units are
      // the most common permit here and the least visible change, so they swamp
      // everything else; `unclear` is kept reachable rather than silently dropped.
      key: "scope", label: "Construction type", prop: "construction_type", param: "scope",
      options: [
        { value: "new_building", label: "New building", on: true },
        { value: "laneway_garden_suite", label: "Laneway / garden suite", on: true },
        { value: "basement_units", label: "New basement unit(s)", on: false },
        { value: "aboveground_units", label: "New aboveground unit(s)", on: true },
        { value: "unclear", label: "Unclear from description", on: false },
      ],
    },
    {
      key: "structure", label: "Structure type", prop: "structure_category", param: "structure",
      options: [
        { value: "Laneway / garden suite", label: "Laneway / garden suite", on: true },
        { value: "Duplex (2 units)", label: "Duplex", on: true },
        { value: "House + secondary suite", label: "House + secondary suite", on: true },
        { value: "Triplex+ (3-6 units)", label: "Triplex+", on: true },
        { value: "Multi-unit building", label: "Multi-unit building", on: true },
        { value: "Multi-tenant / rooming house", label: "Multi-tenant / rooming house", on: true },
        { value: "Mixed use", label: "Mixed use", on: true },
        { value: "Other", label: "Other", on: true },
      ],
    },
  ];

  const state = {};                 // group key -> Set of active values
  let wards = [];                   // ward names, by descending permit count
  let wardCounts = new Map();
  let months = [];                  // every "YYYY-MM" spanning the data
  let monthRange = [0, 0];
  let listeners = [];
  let suspended = false;            // batches a multi-change update into one notify

  GROUPS.forEach((g) => {
    state[g.key] = new Set(g.options.filter((o) => o.on).map((o) => o.value));
  });
  const selectedWards = new Set();

  // ---- Predicate -----------------------------------------------------------

  const monthOf = (d) => (d ? d.slice(0, 7) : null);

  function passes(p) {
    for (const g of GROUPS) {
      if (!state[g.key].has(p[g.prop])) return false;
    }
    // A permit whose address never matched an address point has no ward. It
    // survives only while every ward is selected, so "all wards" still means
    // everything and narrowing to a ward never silently includes strays.
    if (p.ward == null) {
      if (selectedWards.size !== wards.length) return false;
    } else if (!selectedWards.has(p.ward)) return false;

    const idx = months.indexOf(monthOf(p.application_date));
    if (idx === -1) return true; // don't hide a permit over a missing date
    return idx >= monthRange[0] && idx <= monthRange[1];
  }

  // ---- URL hash ------------------------------------------------------------
  //
  // Only what differs from the defaults is written, so the plain map is a bare
  // URL and a shared link carries exactly the choices its author made.

  function sameAsDefault(group) {
    const def = group.options.filter((o) => o.on).map((o) => o.value);
    return def.length === state[group.key].size && def.every((v) => state[group.key].has(v));
  }

  function encode(extra) {
    const parts = [];
    for (const [k, v] of Object.entries(extra || {})) {
      if (v != null && v !== "") parts.push(`${k}=${encodeURIComponent(v)}`);
    }
    for (const g of GROUPS) {
      if (sameAsDefault(g)) continue;
      const vals = g.options.filter((o) => state[g.key].has(o.value)).map((o) => o.value);
      parts.push(`${g.param}=${vals.map(encodeURIComponent).join(",") || "none"}`);
    }
    // Wards are written whichever way is shorter. Unchecking one of 25 is the
    // common case, and listing the 24 survivors produced a link so long it broke
    // when pasted into an email -- so that case writes `notwards=Davenport`.
    if (selectedWards.size !== wards.length) {
      const inc = wards.filter((w) => selectedWards.has(w));
      const exc = wards.filter((w) => !selectedWards.has(w));
      if (inc.length === 0) parts.push("wards=none");
      else if (inc.length <= exc.length) parts.push(`wards=${inc.map(encodeURIComponent).join(",")}`);
      else parts.push(`notwards=${exc.map(encodeURIComponent).join(",")}`);
    }
    if (monthRange[0] !== 0) parts.push(`from=${months[monthRange[0]]}`);
    if (monthRange[1] !== months.length - 1) parts.push(`to=${months[monthRange[1]]}`);
    return parts.join("&");
  }

  function parseHash() {
    const out = {};
    const raw = global.location.hash.replace(/^#/, "");
    if (!raw) return out;
    for (const pair of raw.split("&")) {
      const i = pair.indexOf("=");
      if (i === -1) continue;
      out[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
    }
    return out;
  }

  /* Apply a parsed hash to the filter sets.
     The hash is the WHOLE state, not a patch: every group resets to its default
     before anything is read back. Skipping absent params instead would strand
     stale filters -- pressing Back to a bare URL left the previous slice applied
     while the address bar claimed defaults.
     Unrecognised values are dropped rather than honoured, so an old link whose
     chip has since been renamed loses that one value. If nothing in a list
     survives, the group falls back to its default instead of to empty: a stale
     link should degrade to showing more than you asked for, never to a blank
     view that looks like the data is gone. */
  function applyHash(params) {
    for (const g of GROUPS) {
      const def = g.options.filter((o) => o.on).map((o) => o.value);
      const raw = params[g.param];
      state[g.key].clear();
      if (raw == null) {
        def.forEach((v) => state[g.key].add(v));
        continue;
      }
      if (raw === "none") continue; // an explicit, deliberate empty
      const valid = new Set(g.options.map((o) => o.value));
      raw.split(",").forEach((v) => { if (valid.has(v)) state[g.key].add(v); });
      if (state[g.key].size === 0) def.forEach((v) => state[g.key].add(v));
    }

    selectedWards.clear();
    if (params.wards === "none") {
      // deliberate: leave empty
    } else if (params.wards != null) {
      const valid = new Set(wards);
      params.wards.split(",").forEach((w) => { if (valid.has(w)) selectedWards.add(w); });
      if (selectedWards.size === 0) wards.forEach((w) => selectedWards.add(w));
    } else if (params.notwards != null) {
      const drop = new Set(params.notwards.split(","));
      wards.forEach((w) => { if (!drop.has(w)) selectedWards.add(w); });
      if (selectedWards.size === 0) wards.forEach((w) => selectedWards.add(w));
    } else {
      wards.forEach((w) => selectedWards.add(w));
    }

    const from = params.from ? months.indexOf(params.from) : -1;
    const to = params.to ? months.indexOf(params.to) : -1;
    monthRange = [from === -1 ? 0 : from, to === -1 ? months.length - 1 : to];
    if (monthRange[0] > monthRange[1]) monthRange = [0, months.length - 1];
  }

  // ---- DOM -----------------------------------------------------------------

  function monthLabel(ym) {
    const [y, m] = ym.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("en-CA", { month: "short", year: "numeric" });
  }

  function renderChips(container) {
    for (const g of GROUPS) {
      const wrap = document.createElement("div");
      wrap.className = "filter-group";

      const label = document.createElement("span");
      label.className = "filter-group-label";
      label.textContent = g.label;
      wrap.appendChild(label);

      for (const opt of g.options) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "filter-chip";
        chip.dataset.group = g.key;
        chip.dataset.value = opt.value;
        chip.dataset.active = String(state[g.key].has(opt.value));
        if (opt.swatch) {
          const sw = document.createElement("span");
          sw.className = "swatch";
          sw.style.background = opt.swatch;
          chip.appendChild(sw);
        }
        chip.appendChild(document.createTextNode(opt.label));
        chip.addEventListener("click", () => {
          const on = chip.dataset.active === "true";
          chip.dataset.active = String(!on);
          if (on) state[g.key].delete(opt.value);
          else state[g.key].add(opt.value);
          notify();
        });
        wrap.appendChild(chip);
      }
      container.appendChild(wrap);
    }
  }

  function renderWards(container) {
    const block = document.createElement("div");
    block.className = "ward-filter";

    const head = document.createElement("div");
    head.className = "ward-filter-head";
    const label = document.createElement("span");
    label.className = "filter-group-label";
    label.textContent = "Wards";
    const actions = document.createElement("span");
    actions.className = "ward-actions";
    head.append(label, actions);

    const list = document.createElement("div");
    list.className = "ward-list";
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", "Wards");

    for (const ward of wards) {
      const row = document.createElement("label");
      row.className = "ward-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = selectedWards.has(ward);
      box.value = ward;
      const name = document.createElement("span");
      name.className = "ward-name";
      name.textContent = ward;
      const count = document.createElement("span");
      count.className = "ward-count";
      count.textContent = (wardCounts.get(ward) || 0).toLocaleString("en-CA");
      box.addEventListener("change", () => {
        if (box.checked) selectedWards.add(ward);
        else selectedWards.delete(ward);
        notify();
      });
      row.append(box, name, count);
      list.appendChild(row);
    }

    for (const [text, on] of [["All", true], ["None", false]]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "link-btn";
      btn.textContent = text;
      btn.addEventListener("click", () => {
        selectedWards.clear();
        if (on) wards.forEach((w) => selectedWards.add(w));
        list.querySelectorAll("input").forEach((b) => { b.checked = on; });
        notify();
      });
      actions.appendChild(btn);
    }

    block.append(head, list);
    container.appendChild(block);
  }

  function renderDateFilter(container, permits) {
    const block = document.createElement("div");
    block.className = "date-filter";
    block.innerHTML =
      '<div class="filter-group-label">Application date</div>' +
      '<div class="histogram" id="histogram"></div>' +
      '<div class="range-slider"><div class="range-track"></div>' +
      '<div class="range-fill" id="range-fill"></div>' +
      '<input type="range" id="range-min" class="range-input" aria-label="Earliest application month">' +
      '<input type="range" id="range-max" class="range-input" aria-label="Latest application month">' +
      '</div><div class="range-labels"><span id="range-label-min"></span>' +
      '<span id="range-label-max"></span></div>';
    container.appendChild(block);

    // The histogram is the map for the slider, so it counts every permit and is
    // deliberately NOT re-shaped by the other filters -- only dimmed outside the
    // selected range. A histogram that redrew itself would move the ground the
    // reader is trying to aim at.
    const counts = new Map(months.map((m) => [m, 0]));
    for (const p of permits) {
      const m = monthOf(p.application_date);
      if (counts.has(m)) counts.set(m, counts.get(m) + 1);
    }
    const max = Math.max(1, ...counts.values());
    const hist = block.querySelector("#histogram");
    for (const m of months) {
      const bar = document.createElement("div");
      bar.className = "histogram-bar";
      bar.style.height = `${Math.max(2, (counts.get(m) / max) * 44)}px`;
      bar.title = `${monthLabel(m)}: ${counts.get(m)}`;
      hist.appendChild(bar);
    }

    const min = block.querySelector("#range-min");
    const maxIn = block.querySelector("#range-max");
    const fill = block.querySelector("#range-fill");
    const lo = block.querySelector("#range-label-min");
    const hi = block.querySelector("#range-label-max");
    const last = months.length - 1;

    [min, maxIn].forEach((i) => { i.min = "0"; i.max = String(last); i.step = "1"; });

    function paint() {
      min.value = String(monthRange[0]);
      maxIn.value = String(monthRange[1]);
      const pct = (v) => (last === 0 ? 0 : (v / last) * 100);
      fill.style.left = `${pct(monthRange[0])}%`;
      fill.style.right = `${100 - pct(monthRange[1])}%`;
      lo.textContent = monthLabel(months[monthRange[0]]);
      hi.textContent = monthLabel(months[monthRange[1]]);
      hist.querySelectorAll(".histogram-bar").forEach((bar, i) => {
        bar.classList.toggle("out-of-range", i < monthRange[0] || i > monthRange[1]);
      });
    }

    function onInput(moved) {
      let a = Number(min.value);
      let b = Number(maxIn.value);
      if (a > b) {
        if (moved === "min") b = a;
        else a = b;
      }
      monthRange = [a, b];
      paint();
      notify();
    }

    min.addEventListener("input", () => onInput("min"));
    maxIn.addEventListener("input", () => onInput("max"));
    paint();
    repaintDates = paint;
  }

  let repaintDates = () => {};

  /* Push the DOM back into agreement with the state. Used after a hash-driven
     change (back button, a pasted link), where the state moved without any
     control having been clicked. */
  function syncControls(root) {
    root.querySelectorAll(".filter-chip[data-group]").forEach((chip) => {
      const set = state[chip.dataset.group];
      if (set) chip.dataset.active = String(set.has(chip.dataset.value));
    });
    root.querySelectorAll(".ward-row input").forEach((box) => {
      box.checked = selectedWards.has(box.value);
    });
    repaintDates();
  }

  // ---- Change plumbing -----------------------------------------------------

  function notify() {
    if (suspended) return;
    listeners.forEach((fn) => fn());
  }

  const Filters = {
    GROUPS,
    get months() { return months; },
    get wards() { return wards; },
    get wardCounts() { return wardCounts; },
    get monthRange() { return monthRange; },
    get selectedWards() { return selectedWards; },
    monthOf,
    monthLabel,
    passes,
    encode,
    parseHash,

    /* Build the whole filter bar into `container` and return once it's live.
       `permits` is the flat property list; `onChange` fires on every change. */
    init(container, permits, onChange) {
      wardCounts = new Map();
      for (const p of permits) {
        if (p.ward) wardCounts.set(p.ward, (wardCounts.get(p.ward) || 0) + 1);
      }
      wards = [...wardCounts.keys()].sort((a, b) => wardCounts.get(b) - wardCounts.get(a));
      wards.forEach((w) => selectedWards.add(w));

      const dates = permits.map((p) => p.application_date).filter(Boolean).sort();
      months = dates.length
        ? buildMonthRange(monthOf(dates[0]), monthOf(dates[dates.length - 1]))
        : [];
      monthRange = [0, Math.max(0, months.length - 1)];

      // Read the incoming link BEFORE the controls render, so they paint in the
      // shared state rather than flashing defaults and correcting themselves.
      applyHash(parseHash());

      suspended = true;
      renderChips(container);
      renderWards(container);
      renderDateFilter(container, permits);
      suspended = false;

      if (onChange) listeners.push(onChange);
    },

    onChange(fn) { listeners.push(fn); },

    /* Re-read the URL and repaint every control. For popstate/hashchange. */
    adoptHash(root) {
      applyHash(parseHash());
      syncControls(root);
    },

    /* A one-line summary of the current slice, for captions. */
    describeWards() {
      if (selectedWards.size === wards.length) return `all ${wards.length} wards`;
      if (selectedWards.size === 0) return "no wards selected";
      if (selectedWards.size === 1) return [...selectedWards][0];
      return `${selectedWards.size} wards`;
    },
  };

  function buildMonthRange(minMonth, maxMonth) {
    const out = [];
    let [y, m] = minMonth.split("-").map(Number);
    const [y1, m1] = maxMonth.split("-").map(Number);
    while (y < y1 || (y === y1 && m <= m1)) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      if (++m > 12) { m = 1; y += 1; }
    }
    return out;
  }

  global.Filters = Filters;
})(window);
