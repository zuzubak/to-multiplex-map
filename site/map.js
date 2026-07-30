// Leaflet + raster tiles + Canvas/SVG markers -- deliberately avoids WebGL (MapLibre GL JS
// requires it) so the map renders in any browser, including ones with hardware acceleration
// disabled or sandboxed (the exact failure this replaced: MapLibre's WebGL context creation
// throwing on a Chrome install with GPU disabled).
const TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>';
const TORONTO_CENTER = [43.6532, -79.3832];

const SEQUENTIAL_RAMP = ["#cde2fb", "#9ec5f4", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];

let errorShown = false;

function showLoadError(message) {
  if (errorShown) return;
  errorShown = true;
  const el = document.createElement("div");
  el.className = "load-error";
  el.textContent = message;
  document.querySelector("main").appendChild(el);
}

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

function quantile(sorted, q) {
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Discrete quantile bins (not a continuous gradient) so the legend can show exact ranges.
function computeBins(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const thresholds = [0, 0.2, 0.4, 0.6, 0.8].map((q) => quantile(sorted, q));
  for (let i = 1; i < thresholds.length; i++) {
    if (thresholds[i] <= thresholds[i - 1]) thresholds[i] = thresholds[i - 1] + 1;
  }
  return thresholds;
}

function colorForValue(value, thresholds) {
  for (let i = thresholds.length - 1; i >= 0; i--) {
    if (value >= thresholds[i]) return SEQUENTIAL_RAMP[i];
  }
  return SEQUENTIAL_RAMP[0];
}

function renderWardBinsLegend(thresholds, maxValue) {
  const container = document.getElementById("ward-bins");
  container.textContent = "";
  const edges = [...thresholds, maxValue];

  for (let i = 0; i < thresholds.length; i++) {
    const row = document.createElement("div");
    row.className = "ward-bin-row";

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = SEQUENTIAL_RAMP[i];

    const label = document.createElement("span");
    const lo = formatCompact(Math.round(edges[i]));
    const hi = i === thresholds.length - 1 ? formatCompact(Math.round(edges[i + 1])) : formatCompact(Math.round(edges[i + 1] - 1));
    label.textContent = i === thresholds.length - 1 ? `${lo}+` : `${lo}–${hi}`;

    row.append(swatch, label);
    container.appendChild(row);
  }
}

function radiusForUnits(units) {
  const points = [
    [1, 5],
    [4, 9],
    [8, 13],
  ];
  if (units <= points[0][0]) return points[0][1];
  if (units >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let i = 0; i < points.length - 1; i++) {
    const [u0, r0] = points[i];
    const [u1, r1] = points[i + 1];
    if (units >= u0 && units <= u1) {
      const t = (units - u0) / (u1 - u0);
      return r0 + (r1 - r0) * t;
    }
  }
  return points[0][1];
}

const map = L.map("map", {
  center: TORONTO_CENTER,
  zoom: 10.5,
  minZoom: 9,
  maxZoom: 19,
  preferCanvas: true,
  zoomControl: false,
});

L.tileLayer(TILE_URL, {
  subdomains: "abcd",
  maxZoom: 19,
  attribution: TILE_ATTRIBUTION,
}).addTo(map);

L.control.zoom({ position: "topright" }).addTo(map);

let permitsLayer = null;

function setupFilters() {
  const chips = [document.getElementById("filter-active"), document.getElementById("filter-cleared")];
  const statusForChip = { "filter-active": "active", "filter-cleared": "cleared" };

  function applyFilter() {
    if (!permitsLayer) return;
    const activeStatuses = new Set(
      chips.filter((chip) => chip.dataset.active === "true").map((chip) => statusForChip[chip.id])
    );
    permitsLayer.eachLayer((layer) => {
      const show = activeStatuses.has(layer.feature.properties.status);
      const el = layer.getElement ? layer.getElement() : null;
      if (el) {
        el.style.display = show ? "" : "none";
      } else if (show) {
        map.addLayer(layer);
      } else {
        map.removeLayer(layer);
      }
    });
  }

  for (const chip of chips) {
    chip.addEventListener("click", () => {
      chip.dataset.active = chip.dataset.active === "true" ? "false" : "true";
      applyFilter();
    });
  }

  applyFilter();
}

async function init() {
  try {
    const [summary, wards, permits] = await Promise.all([
      loadJSON("data/summary.json"),
      loadJSON("data/wards.geojson"),
      loadJSON("data/permits.geojson"),
    ]);

    renderStats(summary);

    const wardUnitValues = wards.features.map((f) => f.properties.total_dwelling_units_created || 0);
    const maxUnits = Math.max(1, ...wardUnitValues);
    const thresholds = computeBins(wardUnitValues);
    renderWardBinsLegend(thresholds, maxUnits);

    L.geoJSON(wards, {
      style: (feature) => ({
        fillColor: colorForValue(feature.properties.total_dwelling_units_created || 0, thresholds),
        fillOpacity: 0.55,
        color: "#c3c2b7",
        weight: 1,
      }),
    }).addTo(map);

    permitsLayer = L.geoJSON(permits, {
      pointToLayer: (feature, latlng) => {
        const status = feature.properties.status;
        const color = status === "active" ? "#eb6834" : status === "cleared" ? "#2a78d6" : "#898781";
        const units = feature.properties.dwelling_units_created || 1;
        return L.circleMarker(latlng, {
          radius: radiusForUnits(units),
          fillColor: color,
          fillOpacity: 0.9,
          color: "#fcfcfb",
          weight: 2,
        });
      },
      onEachFeature: (feature, layer) => {
        layer.bindPopup(() => popupContent(feature.properties));
      },
    }).addTo(map);

    setupFilters();
  } catch (err) {
    console.error(err);
    showLoadError(
      "Couldn't load permit data. If this is a fresh deploy, the daily pipeline may not have run yet."
    );
  }
}

init();
