const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const TORONTO_CENTER = [-79.3832, 43.6532];
const LOAD_TIMEOUT_MS = 15000;

const SEQUENTIAL_RAMP = ["#cde2fb", "#9ec5f4", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];

let errorShown = false;
let mapLoaded = false;

function showLoadError(message) {
  if (errorShown) return;
  errorShown = true;
  const el = document.createElement("div");
  el.className = "load-error";
  el.textContent = message;
  document.querySelector("main").appendChild(el);
}

function webglAvailable() {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext("webgl") || canvas.getContext("experimental-webgl"))
    );
  } catch (e) {
    return false;
  }
}

if (!webglAvailable()) {
  showLoadError(
    "This map needs WebGL, which your browser has disabled or doesn't support. " +
      "Try a different browser, or check that hardware acceleration / WebGL isn't blocked by an extension or browser setting."
  );
  throw new Error("WebGL unavailable");
}

const map = new maplibregl.Map({
  container: "map",
  style: BASEMAP_STYLE,
  center: TORONTO_CENTER,
  zoom: 10.5,
  minZoom: 9,
  maxZoom: 18,
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

map.on("error", (e) => {
  console.error("MapLibre error:", e && e.error);
  if (!mapLoaded) {
    showLoadError(
      "The basemap failed to load -- this is usually a network issue or an ad blocker / privacy " +
        "extension blocking the map tile server. Try disabling extensions for this site or a different network."
    );
  }
});

setTimeout(() => {
  if (!mapLoaded) {
    showLoadError(
      "The map is taking much longer than expected to load. This usually means the basemap tiles or " +
        "data files are being blocked (by an ad blocker, privacy extension, or restrictive network) rather " +
        "than just being slow. Try a different browser/network, or check the browser console for details."
    );
  }
}, LOAD_TIMEOUT_MS);

function formatCompact(n) {
  if (n === null || n === undefined) return "–";
  return new Intl.NumberFormat("en-CA", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function renderStats(summary) {
  const statsEl = document.getElementById("stats");
  statsEl.textContent = "";

  const byStatus = Object.fromEntries(summary.totals_by_status.map((t) => [t.status, t]));
  const totalPermits = summary.totals_by_status.reduce((s, t) => s + t.permit_count, 0);
  const totalUnits = summary.totals_by_status.reduce((s, t) => s + (t.dwelling_units_created || 0), 0);

  const tiles = [
    { label: "New units (active + cleared)", value: totalUnits },
    { label: "Permits tracked", value: totalPermits },
    { label: "Active permits", value: byStatus.active ? byStatus.active.permit_count : 0 },
    { label: "Cleared permits", value: byStatus.cleared ? byStatus.cleared.permit_count : 0 },
  ];

  for (const tile of tiles) {
    const wrap = document.createElement("div");
    wrap.className = "stat-tile";

    const value = document.createElement("div");
    value.className = "stat-value";
    value.textContent = formatCompact(tile.value);

    const label = document.createElement("div");
    label.className = "stat-label";
    label.textContent = tile.label;

    wrap.append(value, label);
    statsEl.appendChild(wrap);
  }

  const lastUpdated = document.getElementById("last-updated");
  const asOf = new Date(summary.last_updated);
  lastUpdated.textContent = `Data as of ${asOf.toLocaleString("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

function popupContent(properties) {
  const wrap = document.createElement("div");

  const title = document.createElement("div");
  title.className = "popup-title";
  title.textContent = properties.full_address || "Address not matched";
  wrap.appendChild(title);

  const rows = [
    ["Status", properties.status === "active" ? "Active (in progress)" : "Cleared (completed)"],
    ["Units created", properties.dwelling_units_created],
    ["Structure type", properties.structure_type],
    ["Ward", properties.ward],
    ["Application date", properties.application_date],
    ["Issued date", properties.issued_date],
    ["Completed date", properties.completed_date],
  ];

  for (const [k, v] of rows) {
    if (v === null || v === undefined || v === "") continue;
    const row = document.createElement("div");
    row.className = "popup-row";

    const kEl = document.createElement("span");
    kEl.className = "k";
    kEl.textContent = k;

    const vEl = document.createElement("span");
    vEl.className = "v";
    vEl.textContent = v;

    row.append(kEl, vEl);
    wrap.appendChild(row);
  }

  return wrap;
}

async function loadJSON(path) {
  const resp = await fetch(path, { cache: "no-store" });
  if (!resp.ok) throw new Error(`${path}: ${resp.status}`);
  return resp.json();
}

function setupFilters() {
  const chips = [document.getElementById("filter-active"), document.getElementById("filter-cleared")];
  const statusForChip = { "filter-active": "active", "filter-cleared": "cleared" };

  function applyFilter() {
    const activeStatuses = chips
      .filter((chip) => chip.dataset.active === "true")
      .map((chip) => statusForChip[chip.id]);

    if (map.getLayer("permits-points")) {
      map.setFilter("permits-points", ["in", ["get", "status"], ["literal", activeStatuses]]);
    }
  }

  for (const chip of chips) {
    chip.addEventListener("click", () => {
      chip.dataset.active = chip.dataset.active === "true" ? "false" : "true";
      applyFilter();
    });
  }

  applyFilter();
}

map.on("load", async () => {
  mapLoaded = true;
  try {
    const [summary, wards, permits] = await Promise.all([
      loadJSON("data/summary.json"),
      loadJSON("data/wards.geojson"),
      loadJSON("data/permits.geojson"),
    ]);

    renderStats(summary);

    const wardUnitValues = wards.features
      .map((f) => f.properties.total_dwelling_units_created || 0)
      .sort((a, b) => a - b);
    const maxUnits = Math.max(1, ...wardUnitValues);
    document.getElementById("legend-max").textContent = formatCompact(maxUnits);

    // Quantile breaks (not evenly-spaced fractions of max) so wards spread across the
    // full ramp instead of clustering in its pale end.
    function quantile(sorted, q) {
      const idx = (sorted.length - 1) * q;
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) return sorted[lo];
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    }
    const breaks = [0, 0.2, 0.4, 0.6, 0.8, 1].map((q) => quantile(wardUnitValues, q));
    // MapLibre requires strictly ascending stops -- nudge any ties forward.
    for (let i = 1; i < breaks.length; i++) {
      if (breaks[i] <= breaks[i - 1]) breaks[i] = breaks[i - 1] + 0.01;
    }

    map.addSource("wards", { type: "geojson", data: wards });
    map.addLayer({
      id: "wards-fill",
      type: "fill",
      source: "wards",
      paint: {
        "fill-color": [
          "interpolate",
          ["linear"],
          ["get", "total_dwelling_units_created"],
          breaks[0], SEQUENTIAL_RAMP[0],
          breaks[1], SEQUENTIAL_RAMP[1],
          breaks[2], SEQUENTIAL_RAMP[2],
          breaks[3], SEQUENTIAL_RAMP[3],
          breaks[4], SEQUENTIAL_RAMP[4],
          breaks[5], SEQUENTIAL_RAMP[5],
        ],
        "fill-opacity": 0.55,
      },
    });
    map.addLayer({
      id: "wards-outline",
      type: "line",
      source: "wards",
      paint: {
        "line-color": "#c3c2b7",
        "line-width": 1,
      },
    });

    map.addSource("permits", { type: "geojson", data: permits });
    map.addLayer({
      id: "permits-points",
      type: "circle",
      source: "permits",
      paint: {
        "circle-color": [
          "match",
          ["get", "status"],
          "active", "#eb6834",
          "cleared", "#2a78d6",
          "#898781",
        ],
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "dwelling_units_created"], 1],
          1, 5,
          4, 9,
          8, 13,
        ],
        "circle-stroke-width": 2,
        "circle-stroke-color": "#fcfcfb",
        "circle-opacity": 0.9,
      },
    });

    setupFilters();

    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "260px" });

    map.on("click", "permits-points", (e) => {
      const feature = e.features[0];
      popup
        .setLngLat(feature.geometry.coordinates)
        .setDOMContent(popupContent(feature.properties))
        .addTo(map);
    });
    map.on("mouseenter", "permits-points", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "permits-points", () => {
      map.getCanvas().style.cursor = "";
    });
  } catch (err) {
    console.error(err);
    showLoadError(
      "Couldn't load permit data. If this is a fresh deploy, the daily pipeline may not have run yet."
    );
  }
});
