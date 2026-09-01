/* App shell: loads the data once, owns the view toggle, and keeps the URL hash
 * in sync with the current slice.
 *
 * The two views share one filter panel, so switching between them keeps whatever
 * you had narrowed down -- which is the whole reason they live on one page. The
 * hash makes that slice shareable: a link carries the view and every non-default
 * filter, so "the chart, Davenport, new buildings only" is a URL rather than a
 * paragraph of instructions.
 *
 * Loaded after filters.js, chart.js and map.js; see index.html.
 */
(function (global) {
  "use strict";

  let currentView = "map";
  let permitProps = [];
  let writingHash = false; // suppresses our own hashchange echo

  function showLoadError(message) {
    const el = document.createElement("div");
    el.className = "load-error";
    el.textContent = message;
    document.querySelector("main").appendChild(el);
  }

  // ---- URL ------------------------------------------------------------------

  function writeHash() {
    const extra = currentView === "trends"
      ? Object.assign({ view: "trends" }, ChartView.params)
      : {};
    const hash = Filters.encode(extra);
    const url = global.location.pathname + global.location.search + (hash ? "#" + hash : "");
    writingHash = true;
    // replaceState, not pushState: a filter chip is not a navigation, and pushing
    // would bury the previous page under dozens of history entries.
    history.replaceState(null, "", url);
    writingHash = false;
  }

  // ---- Views ----------------------------------------------------------------

  function setView(name, { fromHash = false } = {}) {
    currentView = name === "trends" ? "trends" : "map";
    document.querySelectorAll(".view-toggle button").forEach((btn) => {
      const on = btn.dataset.view === currentView;
      btn.dataset.active = String(on);
      btn.setAttribute("aria-selected", String(on));
    });
    document.getElementById("map-view").hidden = currentView !== "map";
    document.getElementById("chart-view").hidden = currentView !== "trends";
    // The ward choropleth legend is map-only; the chart has its own legend.
    document.getElementById("map-legend").hidden = currentView !== "map";

    if (currentView === "map") {
      MapView.show().catch(() => showLoadError(
        "Couldn't load the map library. The trend view still works, and the raw data is at data/permits.geojson."
      ));
    } else {
      // The chart measures its container, which was display:none until this frame.
      requestAnimationFrame(() => ChartView.refresh());
    }
    if (!fromHash) writeHash();
  }

  function refreshAll() {
    renderStats();
    if (currentView === "map") MapView.refresh();
    else ChartView.refresh();
    writeHash();
  }

  // ---- Stats ----------------------------------------------------------------

  function renderStats() {
    const statsEl = document.getElementById("stats");
    statsEl.textContent = "";
    let active = 0;
    let cleared = 0;
    let units = 0;
    let total = 0;
    for (const p of permitProps) {
      if (!Filters.passes(p)) continue;
      total += 1;
      units += p.dwelling_units_created || 0;
      if (p.status === "active") active += 1;
      else if (p.status === "cleared") cleared += 1;
    }
    const fmt = (n) => new Intl.NumberFormat("en-CA", { notation: "compact", maximumFractionDigits: 1 }).format(n);
    for (const [value, label] of [
      [units, "Units created"], [total, "Permits tracked"],
      [active, "Active permits"], [cleared, "Cleared permits"],
    ]) {
      const wrap = document.createElement("div");
      wrap.className = "stat-tile";
      const v = document.createElement("div");
      v.className = "stat-value";
      v.textContent = fmt(value);
      const l = document.createElement("div");
      l.className = "stat-label";
      l.textContent = label;
      wrap.append(v, l);
      statsEl.appendChild(wrap);
    }
  }

  // ---- Mobile bottom sheet --------------------------------------------------
  //
  // Draggable via pointer events (mouse + touch in one API). Three snap states --
  // minimized (just the handle), collapsed (the default peek), expanded (full filter
  // access) -- so dragging down from the default has somewhere smaller to land instead
  // of springing back. No-op on desktop, where the panel is a plain sidebar.
  //
  // Taps use a native "click" listener rather than measuring pointer movement:
  // browsers already suppress click after a real drag, which is a far more reliable
  // tap/drag distinction on touch hardware than a hand-rolled pixel threshold (which
  // misfired on real devices from ordinary touch jitter). The Hide button is wired
  // independently as a guaranteed way back to the view.
  const PANEL_MINIMIZED_PX = 56;
  const PANEL_COLLAPSED_VH = 0.42;
  const PANEL_EXPANDED_VH = 0.82;
  const DRAG_MOVE_THRESHOLD = 6;

  function setupPanel() {
    const panel = document.getElementById("panel");
    const toggle = document.getElementById("panel-toggle");
    const hideBtn = document.getElementById("panel-hide");
    const isMobile = () => global.matchMedia("(max-width: 860px)").matches;

    function targetHeight(state) {
      // window.innerHeight tracks the real visible viewport (unlike CSS vh on mobile),
      // so it's the source of truth for how tall the panel should be.
      const vh = global.innerHeight;
      if (state === "minimized") return PANEL_MINIMIZED_PX;
      if (state === "expanded") return vh * PANEL_EXPANDED_VH;
      return vh * PANEL_COLLAPSED_VH;
    }

    function setState(state) {
      panel.dataset.state = state;
      toggle.setAttribute("aria-expanded", String(state === "expanded"));
      // Desktop's sidebar is full-height CSS, not state-driven -- an inline max-height
      // would clamp it regardless of viewport width (inline styles aren't scoped by
      // media query), so only touch it on mobile.
      if (isMobile() && !panel.classList.contains("dragging")) {
        panel.style.maxHeight = `${targetHeight(state)}px`;
      } else if (!isMobile()) {
        panel.style.maxHeight = "";
      }
      MapView.invalidate();
    }

    setState("collapsed");
    global.addEventListener("resize", () => {
      if (!panel.classList.contains("dragging")) setState(panel.dataset.state);
    });
    hideBtn.addEventListener("click", () => setState("minimized"));

    let dragging = false;
    let startY = 0;
    let startHeight = 0;
    let moved = false;
    let lastHeight = 0;

    toggle.addEventListener("pointerdown", (e) => {
      if (!isMobile()) return;
      dragging = true;
      moved = false;
      startY = e.clientY;
      startHeight = panel.getBoundingClientRect().height;
      lastHeight = startHeight;
      panel.classList.add("dragging");
      panel.style.maxHeight = "none";
      try {
        toggle.setPointerCapture(e.pointerId);
      } catch (err) {
        // Non-fatal: pointer capture keeps tracking if the finger slides off the
        // handle, but the drag math below works without it.
      }
    });

    toggle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const deltaY = startY - e.clientY;
      if (Math.abs(deltaY) > DRAG_MOVE_THRESHOLD) moved = true;
      const vh = global.innerHeight;
      // Capped just above the expanded target so an enthusiastic drag can't overshoot
      // into something that reads as "fullscreen with no escape".
      const maxHeight = vh * PANEL_EXPANDED_VH + 24;
      lastHeight = Math.min(maxHeight, Math.max(PANEL_MINIMIZED_PX, startHeight + deltaY));
      panel.style.height = `${lastHeight}px`;
    });

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove("dragging");
      panel.style.height = "";
      panel.style.maxHeight = "";
      if (!moved) return; // plain tap: the click listener below handles it

      const vh = global.innerHeight;
      const collapsedPx = vh * PANEL_COLLAPSED_VH;
      const expandedPx = vh * PANEL_EXPANDED_VH;
      if (lastHeight < (PANEL_MINIMIZED_PX + collapsedPx) / 2) setState("minimized");
      else if (lastHeight < (collapsedPx + expandedPx) / 2) setState("collapsed");
      else setState("expanded");
    }

    toggle.addEventListener("pointerup", endDrag);
    toggle.addEventListener("pointercancel", endDrag);
    toggle.addEventListener("click", () => {
      if (!isMobile()) return;
      setState(panel.dataset.state === "expanded" ? "collapsed" : "expanded");
    });
  }

  // ---- Init -----------------------------------------------------------------

  async function loadJSON(path) {
    const resp = await fetch(path, { cache: "no-store" });
    if (!resp.ok) throw new Error(`${path}: ${resp.status}`);
    return resp.json();
  }

  async function init() {
    try {
      const [summary, wards, permits] = await Promise.all([
        loadJSON("data/summary.json"),
        loadJSON("data/wards.geojson"),
        loadJSON("data/permits.geojson"),
      ]);

      permitProps = permits.features.map((f) => f.properties);
      const asOf = new Date(summary.last_updated);
      document.getElementById("last-updated").textContent =
        `Data as of ${asOf.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}`;

      Filters.init(document.getElementById("filter-bar"), permitProps, refreshAll);
      ChartView.init(permitProps, asOf, writeHash);
      MapView.init(permits, wards);
      setupPanel();

      const params = Filters.parseHash();
      ChartView.adopt(params);
      document.querySelectorAll(".view-toggle button").forEach((btn) => {
        btn.addEventListener("click", () => setView(btn.dataset.view));
      });

      renderStats();
      setView(params.view === "trends" ? "trends" : "map", { fromHash: true });

      // Back/forward, or someone editing the URL: adopt it rather than ignore it.
      global.addEventListener("hashchange", () => {
        if (writingHash) return;
        const next = Filters.parseHash();
        Filters.adoptHash(document.getElementById("filter-bar"));
        ChartView.adopt(next);
        renderStats();
        setView(next.view === "trends" ? "trends" : "map", { fromHash: true });
        if (currentView === "map") MapView.refresh();
        else ChartView.refresh();
      });
    } catch (err) {
      console.error(err);
      showLoadError(
        "Couldn't load permit data. If this is a fresh deploy, the daily pipeline may not have run yet."
      );
    }
  }

  init();
})(window);
