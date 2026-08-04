// Leaflet + raster tiles + Canvas/SVG markers -- deliberately avoids WebGL (see git history:
// MapLibre GL JS required it and failed outright on at least one real Chrome install with
// GPU disabled). Renders raster tiles as plain img tags and overlays via Canvas2D/SVG, so it
// works everywhere.
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

function popupContent(properties) {
  const wrap = document.createElement("div");

  const title = document.createElement("div");
  title.className = "popup-title";
  title.textContent = properties.full_address || "Address not matched";
  wrap.appendChild(title);

  const rows = [
    ["Status", properties.status === "active" ? "Active (in progress)" : "Cleared (completed)"],
    ["Units created", properties.dwelling_units_created],
    ["Units lost", properties.dwelling_units_lost],
    ["Net new units", properties.net_units_created],
    ["Structure", properties.structure_category],
    ["Structure type (raw)", properties.structure_type],
    ["Street type", properties.road_class],
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
  if (sorted.length === 0) return 0;
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

// Same key used to identify a permit's marker throughout: permit_num alone isn't unique --
// a small number of permits (data quirk, not our pipeline) appear once as 'active' and once
// as 'cleared' with the same permit_num, so status has to be part of the identity or hiding
// one status leaves the other status's copy of the same permit_num still showing.
function featureKey(properties) {
  return properties.permit_num + "|" + properties.status;
}

const MOBILE_BREAKPOINT = "(max-width: 860px)";
function isMobile() {
  return window.matchMedia(MOBILE_BREAKPOINT).matches;
}

// Cluster badges: colour AND size both scale with how many permits are in the cluster,
// using the same sequential ramp as the ward choropleth.
const CLUSTER_THRESHOLDS = [10, 25, 50, 100];
const CLUSTER_SIZES = [30, 36, 42, 48, 56];

function clusterIconCreate(cluster) {
  const count = cluster.getChildCount();
  let idx = 0;
  while (idx < CLUSTER_THRESHOLDS.length && count >= CLUSTER_THRESHOLDS[idx]) idx += 1;
  const color = SEQUENTIAL_RAMP[Math.min(idx + 1, SEQUENTIAL_RAMP.length - 1)];
  const size = CLUSTER_SIZES[idx];
  return L.divIcon({
    html: `<div class="cluster-badge" style="width:${size}px;height:${size}px;font-size:${size >= 42 ? 13 : 11}px;background:${color}">${count}</div>`,
    className: "",
    iconSize: L.point(size, size),
  });
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

// Mobile bottom-sheet: draggable via pointer events (mouse + touch in one API), plus a
// plain tap (no meaningful movement) still toggles collapsed/expanded. No-op on desktop,
// where the panel is a normal full-height sidebar, not a fixed-position sheet.
const panelToggle = document.getElementById("panel-toggle");
const panel = document.getElementById("panel");
const PANEL_COLLAPSED_VH = 0.42;
const PANEL_EXPANDED_VH = 0.82;
const DRAG_MOVE_THRESHOLD = 6; // px -- below this, a pointerup is treated as a tap

function setPanelExpanded(expanded) {
  panel.classList.toggle("expanded", expanded);
  panelToggle.setAttribute("aria-expanded", String(expanded));
}

(function setupPanelDrag() {
  let dragging = false;
  let startY = 0;
  let startHeight = 0;
  let moved = false;
  let lastHeight = 0; // the most recently applied height, used to decide the snap target

  panelToggle.addEventListener("pointerdown", (e) => {
    if (!isMobile()) return;
    dragging = true;
    moved = false;
    startY = e.clientY;
    startHeight = panel.getBoundingClientRect().height;
    lastHeight = startHeight;
    panel.classList.add("dragging");
    panel.style.maxHeight = "none";
    panelToggle.setPointerCapture(e.pointerId);
  });

  panelToggle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const deltaY = startY - e.clientY; // positive while dragging upward
    if (Math.abs(deltaY) > DRAG_MOVE_THRESHOLD) moved = true;
    const vh = window.innerHeight;
    const minHeight = vh * 0.12;
    const maxHeight = vh * 0.92;
    lastHeight = Math.min(maxHeight, Math.max(minHeight, startHeight + deltaY));
    panel.style.height = `${lastHeight}px`;
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove("dragging");
    panel.style.height = "";
    panel.style.maxHeight = "";

    if (!moved) {
      setPanelExpanded(!panel.classList.contains("expanded"));
      return;
    }
    const vh = window.innerHeight;
    const midpoint = vh * ((PANEL_COLLAPSED_VH + PANEL_EXPANDED_VH) / 2);
    setPanelExpanded(lastHeight > midpoint);
  }

  panelToggle.addEventListener("pointerup", endDrag);
  panelToggle.addEventListener("pointercancel", endDrag);
})();

// The map container's size can change (sidebar/bottom-sheet layout switching at the
// responsive breakpoint, orientation change, window resize) -- Leaflet caches its
// container size, so it needs to be told to re-measure.
window.addEventListener("resize", () => map.invalidateSize());

let permitsLayer = null;
let allPermitLayers = []; // every point layer (marker or circleMarker), regardless of add/remove state
let wardsLayer = null;
let wardFeaturesByName = null; // ward_name -> leaflet layer

// Wards must always render behind permit points/clusters, regardless of toggle order --
// otherwise (with the map's default shared canvas renderer) whichever layer was most
// recently re-added ends up drawn last, i.e. on top.
function keepWardsAtBack() {
  if (wardsLayer && map.hasLayer(wardsLayer)) wardsLayer.bringToBack();
}

// Builds one point layer per permit feature directly from coordinates (not via L.geoJSON)
// so the marker TYPE can differ by mode: plain canvas circleMarkers on desktop (unchanged
// look/behaviour), or L.marker+divIcon on mobile -- Leaflet.markercluster clusters
// L.Marker instances, not circleMarker/Path instances, so mobile needs real markers.
function buildPointLayers(permits) {
  const mobile = isMobile();
  return permits.features.map((feature) => {
    const [lng, lat] = feature.geometry.coordinates;
    const latlng = L.latLng(lat, lng);
    const status = feature.properties.status;
    const color = status === "active" ? "#eb6834" : status === "cleared" ? "#2a78d6" : "#898781";
    const units = feature.properties.net_units_created || 1;

    let layer;
    if (mobile) {
      const size = radiusForUnits(units) * 2;
      layer = L.marker(latlng, {
        icon: L.divIcon({
          html: `<div class="point-badge" style="width:${size}px;height:${size}px;background:${color}"></div>`,
          className: "",
          iconSize: L.point(size, size),
        }),
      });
    } else {
      layer = L.circleMarker(latlng, {
        radius: radiusForUnits(units),
        fillColor: color,
        fillOpacity: 0.9,
        color: "#fcfcfb",
        weight: 2,
      });
    }
    layer.feature = feature;
    layer.bindPopup(() => popupContent(feature.properties));
    return layer;
  });
}

function rebuildPermitsLayer() {
  if (permitsLayer) map.removeLayer(permitsLayer);

  allPermitLayers = buildPointLayers(permitsData);
  permitsLayer = isMobile()
    ? L.markerClusterGroup({
        iconCreateFunction: clusterIconCreate,
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: true,
        maxClusterRadius: 60,
        disableClusteringAtZoom: 17,
      })
    : L.featureGroup();
  map.addLayer(permitsLayer);

  if (permitsData) {
    renderPermitVisibility(visibleFeatures());
    keepWardsAtBack();
  }
}

// ---- Filter state -----------------------------------------------------------------

const filterState = {
  layers: { wards: true, active: true, cleared: true },
  roadClass: new Set(["major", "minor", "unknown"]),
  structure: new Set(),
  monthRange: [0, 0], // indices into `months`
};

let months = []; // sorted "YYYY-MM" strings spanning the data
let permitsData = null;

function monthOf(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : null;
}

function buildMonthRange(minDateStr, maxDateStr) {
  const result = [];
  const [y0, m0] = minDateStr.split("-").map(Number);
  const [y1, m1] = maxDateStr.split("-").map(Number);
  let y = y0;
  let m = m0;
  while (y < y1 || (y === y1 && m <= m1)) {
    result.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return result;
}

function passesNonDateFilters(props) {
  if (props.status === "active" && !filterState.layers.active) return false;
  if (props.status === "cleared" && !filterState.layers.cleared) return false;
  if (!filterState.roadClass.has(props.road_class)) return false;
  if (!filterState.structure.has(props.structure_category)) return false;
  return true;
}

function passesDateFilter(props) {
  const idx = months.indexOf(monthOf(props.application_date));
  if (idx === -1) return true; // no application_date -- don't hide it over a missing field
  return idx >= filterState.monthRange[0] && idx <= filterState.monthRange[1];
}

function visibleFeatures() {
  return permitsData.features.filter(
    (f) => passesNonDateFilters(f.properties) && passesDateFilter(f.properties)
  );
}

// ---- Rendering that reacts to filters -----------------------------------------------

function renderStats(features) {
  const statsEl = document.getElementById("stats");
  statsEl.textContent = "";

  let activeCount = 0;
  let clearedCount = 0;
  let totalUnits = 0;
  for (const f of features) {
    if (f.properties.status === "active") activeCount += 1;
    else if (f.properties.status === "cleared") clearedCount += 1;
    totalUnits += f.properties.net_units_created || 0;
  }

  const tiles = [
    { label: "Net new units", value: totalUnits },
    { label: "Permits tracked", value: features.length },
    { label: "Active permits", value: activeCount },
    { label: "Cleared permits", value: clearedCount },
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
}

function renderWardShading(features) {
  const totals = new Map(); // ward name -> net units
  for (const f of features) {
    const ward = f.properties.ward;
    if (!ward) continue;
    totals.set(ward, (totals.get(ward) || 0) + (f.properties.net_units_created || 0));
  }

  const values = [...wardFeaturesByName.keys()].map((name) => totals.get(name) || 0);
  const maxUnits = Math.max(1, ...values);
  const thresholds = computeBins(values);
  renderWardBinsLegend(thresholds, maxUnits);

  for (const [name, layer] of wardFeaturesByName) {
    const value = totals.get(name) || 0;
    layer.setStyle({ fillColor: colorForValue(value, thresholds) });
  }
}

function renderPermitVisibility(features) {
  // Actually add/remove layers rather than toggling opacity: with the canvas renderer
  // (preferCanvas: true) a merely-transparent marker is still hit-tested on click, so an
  // opacity-only "hide" would let a filtered-out permit's popup still open.
  const visibleIds = new Set(features.map((f) => featureKey(f.properties)));
  for (const layer of allPermitLayers) {
    const show = visibleIds.has(featureKey(layer.feature.properties));
    if (show) permitsLayer.addLayer(layer);
    else permitsLayer.removeLayer(layer);
  }
}

function renderHistogramHighlight() {
  const bars = document.querySelectorAll(".histogram-bar");
  bars.forEach((bar, i) => {
    const inRange = i >= filterState.monthRange[0] && i <= filterState.monthRange[1];
    bar.classList.toggle("out-of-range", !inRange);
  });
}

function applyAllFilters() {
  const features = visibleFeatures();
  renderStats(features);
  renderPermitVisibility(features);
  if (filterState.layers.wards) {
    renderWardShading(features);
  }
  renderHistogramHighlight();
  keepWardsAtBack();
}

// ---- Filter chip wiring ---------------------------------------------------------------

function setupChipFilters() {
  const layerChips = {
    "layer-wards": () => {
      filterState.layers.wards = !filterState.layers.wards;
      if (wardsLayer) {
        if (filterState.layers.wards) map.addLayer(wardsLayer);
        else map.removeLayer(wardsLayer);
      }
      document.getElementById("ward-legend-section").style.display = filterState.layers.wards
        ? ""
        : "none";
    },
    "layer-active": () => {
      filterState.layers.active = !filterState.layers.active;
    },
    "layer-cleared": () => {
      filterState.layers.cleared = !filterState.layers.cleared;
    },
  };

  for (const [id, toggle] of Object.entries(layerChips)) {
    const chip = document.getElementById(id);
    chip.addEventListener("click", () => {
      chip.dataset.active = chip.dataset.active === "true" ? "false" : "true";
      toggle();
      applyAllFilters();
    });
  }

  document.querySelectorAll('[data-group="road-class"]').forEach((chip) => {
    chip.addEventListener("click", () => {
      const isActive = chip.dataset.active === "true";
      chip.dataset.active = isActive ? "false" : "true";
      if (isActive) filterState.roadClass.delete(chip.dataset.value);
      else filterState.roadClass.add(chip.dataset.value);
      applyAllFilters();
    });
  });

  document.querySelectorAll('[data-group="structure"]').forEach((chip) => {
    filterState.structure.add(chip.dataset.value);
    chip.addEventListener("click", () => {
      const isActive = chip.dataset.active === "true";
      chip.dataset.active = isActive ? "false" : "true";
      if (isActive) filterState.structure.delete(chip.dataset.value);
      else filterState.structure.add(chip.dataset.value);
      applyAllFilters();
    });
  });
}

// ---- Histogram + dual range slider -----------------------------------------------------

function monthLabel(yearMonth) {
  const [y, m] = yearMonth.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-CA", { month: "short", year: "numeric" });
}

function buildHistogram(features) {
  const counts = new Map(months.map((m) => [m, 0]));
  for (const f of features) {
    const m = monthOf(f.properties.application_date);
    if (counts.has(m)) counts.set(m, counts.get(m) + 1);
  }
  const maxCount = Math.max(1, ...counts.values());

  const container = document.getElementById("histogram");
  container.textContent = "";
  for (const m of months) {
    const bar = document.createElement("div");
    bar.className = "histogram-bar";
    bar.style.height = `${Math.max(2, (counts.get(m) / maxCount) * 44)}px`;
    bar.title = `${monthLabel(m)}: ${counts.get(m)}`;
    container.appendChild(bar);
  }
}

function setupDateSlider() {
  const minInput = document.getElementById("range-min");
  const maxInput = document.getElementById("range-max");
  const fill = document.getElementById("range-fill");
  const labelMin = document.getElementById("range-label-min");
  const labelMax = document.getElementById("range-label-max");

  const lastIndex = months.length - 1;
  [minInput, maxInput].forEach((input) => {
    input.min = "0";
    input.max = String(lastIndex);
    input.step = "1";
  });
  minInput.value = "0";
  maxInput.value = String(lastIndex);
  filterState.monthRange = [0, lastIndex];

  function updateFill() {
    const lo = Number(minInput.value);
    const hi = Number(maxInput.value);
    const pct = (v) => (lastIndex === 0 ? 0 : (v / lastIndex) * 100);
    fill.style.left = `${pct(lo)}%`;
    fill.style.right = `${100 - pct(hi)}%`;
    labelMin.textContent = monthLabel(months[lo]);
    labelMax.textContent = monthLabel(months[hi]);
  }

  function onInput(moved) {
    let lo = Number(minInput.value);
    let hi = Number(maxInput.value);
    if (lo > hi) {
      if (moved === "min") {
        hi = lo;
        maxInput.value = String(hi);
      } else {
        lo = hi;
        minInput.value = String(lo);
      }
    }
    filterState.monthRange = [lo, hi];
    updateFill();
    applyAllFilters();
  }

  minInput.addEventListener("input", () => onInput("min"));
  maxInput.addEventListener("input", () => onInput("max"));
  updateFill();
}

// ---- Init -------------------------------------------------------------------------

async function init() {
  try {
    const [summary, wards, permits] = await Promise.all([
      loadJSON("data/summary.json"),
      loadJSON("data/wards.geojson"),
      loadJSON("data/permits.geojson"),
    ]);

    permitsData = permits;

    const lastUpdated = document.getElementById("last-updated");
    const asOf = new Date(summary.last_updated);
    lastUpdated.textContent = `Data as of ${asOf.toLocaleString("en-CA", {
      dateStyle: "medium",
      timeStyle: "short",
    })}`;

    const appDates = permits.features
      .map((f) => f.properties.application_date)
      .filter(Boolean)
      .sort();
    months =
      appDates.length > 0
        ? buildMonthRange(monthOf(appDates[0]), monthOf(appDates[appDates.length - 1]))
        : [];

    wardsLayer = L.geoJSON(wards, {
      style: () => ({
        fillColor: SEQUENTIAL_RAMP[0],
        fillOpacity: 0.55,
        color: "#c3c2b7",
        weight: 1,
      }),
    }).addTo(map);
    wardFeaturesByName = new Map();
    wardsLayer.eachLayer((layer) => {
      wardFeaturesByName.set(layer.feature.properties.ward_name, layer);
    });

    rebuildPermitsLayer();

    // Clustering only applies on mobile -- if the viewport crosses the responsive
    // breakpoint (window resize, tablet rotation), switch rendering mode to match.
    window.matchMedia(MOBILE_BREAKPOINT).addEventListener("change", rebuildPermitsLayer);

    setupChipFilters();
    buildHistogram(permits.features);
    setupDateSlider();
    applyAllFilters();
  } catch (err) {
    console.error(err);
    showLoadError(
      "Couldn't load permit data. If this is a fresh deploy, the daily pipeline may not have run yet."
    );
  }
}

init();
