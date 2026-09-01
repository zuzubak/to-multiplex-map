/* The map view.
 *
 * Leaflet + raster tiles + Canvas/SVG markers -- deliberately avoids WebGL (see git
 * history: MapLibre GL JS required it and failed outright on at least one real Chrome
 * install with GPU disabled). Renders raster tiles as plain img tags and overlays via
 * Canvas2D/SVG, so it works everywhere.
 *
 * Leaflet is loaded LAZILY, on first show. It and markercluster are ~150KB from unpkg,
 * and someone who lands on the trend view (or arrives on a shared chart link) should
 * not pay for a map they never open. Everything here that touches `L` therefore runs
 * inside ensureLeaflet()'s promise, never at module scope.
 *
 * The filter slice comes from Filters; this file owns only how that slice is drawn.
 * Exposes `MapView`. Loaded after filters.js; see index.html.
 */
(function (global) {
  "use strict";

  const LEAFLET_CSS = [
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
    "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css",
  ];
  const LEAFLET_JS = [
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js",
  ];

  // CARTO gates its basemaps behind an API key. The key lives in config.js, which is
  // gitignored and written by CI from the CARTO_API_KEY secret -- it still ships to the
  // browser (any client-side basemap key does), so restrict it by domain in the CARTO
  // dashboard rather than treating it as a secret. Falls back to the legacy keyless
  // endpoint so a missing config.js degrades to a working map instead of a blank one.
  const TILE_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
    '&copy; <a href="https://carto.com/attributions">CARTO</a>';
  const TORONTO_CENTER = [43.6532, -79.3832];
  const SEQUENTIAL_RAMP = ["#cde2fb", "#9ec5f4", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];
  const MOBILE_BREAKPOINT = "(max-width: 860px)";

  const SCOPE_LABELS = {
    new_building: "New building",
    laneway_garden_suite: "Laneway / garden suite",
    basement_units: "Addition of new basement unit(s)",
    aboveground_units: "Addition of new aboveground unit(s)",
    unclear: "Unclear from description",
  };

  let permitsData = null;
  let wardsData = null;
  let map = null;
  let permitsLayer = null;
  let allPermitLayers = [];
  let wardsLayer = null;
  let wardFeaturesByName = null;
  let showWards = true;
  let leafletPromise = null;

  function isMobile() {
    return global.matchMedia(MOBILE_BREAKPOINT).matches;
  }

  function formatCompact(n) {
    if (n === null || n === undefined) return "–";
    return new Intl.NumberFormat("en-CA", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  }

  // ---- Lazy Leaflet --------------------------------------------------------

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  function ensureLeaflet() {
    if (leafletPromise) return leafletPromise;
    for (const href of LEAFLET_CSS) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
    }
    // Sequential, not parallel: markercluster registers itself onto the L global
    // and throws if Leaflet core hasn't defined it yet.
    leafletPromise = LEAFLET_JS.reduce(
      (chain, src) => chain.then(() => loadScript(src)),
      Promise.resolve()
    );
    return leafletPromise;
  }

  // ---- Popups & symbology --------------------------------------------------

  function popupContent(properties) {
    const wrap = document.createElement("div");
    const title = document.createElement("div");
    title.className = "popup-title";
    title.textContent = properties.full_address || "Address not matched";
    wrap.appendChild(title);

    const rows = [
      ["Status", properties.status === "active" ? "Active (in progress)" : "Cleared (completed)"],
      ["Units created", properties.dwelling_units_created],
      ["Construction type", SCOPE_LABELS[properties.construction_type] || properties.construction_type],
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
    if (properties.description) {
      const desc = document.createElement("div");
      desc.className = "popup-description";
      desc.textContent = `“${properties.description}”`;
      wrap.appendChild(desc);
    }
    return wrap;
  }

  function quantile(sorted, q) {
    if (sorted.length === 0) return 0;
    const idx = (sorted.length - 1) * q;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  // Discrete quantile bins (not a continuous gradient) so the legend shows exact ranges.
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
      const hi = i === thresholds.length - 1
        ? formatCompact(Math.round(edges[i + 1]))
        : formatCompact(Math.round(edges[i + 1] - 1));
      label.textContent = i === thresholds.length - 1 ? `${lo}+` : `${lo}–${hi}`;
      row.append(swatch, label);
      container.appendChild(row);
    }
  }

  function radiusForUnits(units) {
    const points = [[1, 5], [4, 9], [8, 13]];
    if (units <= points[0][0]) return points[0][1];
    if (units >= points[points.length - 1][0]) return points[points.length - 1][1];
    for (let i = 0; i < points.length - 1; i++) {
      const [u0, r0] = points[i];
      const [u1, r1] = points[i + 1];
      if (units >= u0 && units <= u1) return r0 + (r1 - r0) * ((units - u0) / (u1 - u0));
    }
    return points[0][1];
  }

  // permit_num alone isn't unique -- a few permits (data quirk, not our pipeline) appear
  // once as 'active' and once as 'cleared' under the same number, so status has to be
  // part of the identity or hiding one status leaves the other's copy still showing.
  function featureKey(properties) {
    return properties.permit_num + "|" + properties.status;
  }

  // ---- Clustering ----------------------------------------------------------
  //
  // Badge colour AND size scale with cluster size, on the ward choropleth's ramp.
  // Thresholds are recomputed from the clusters actually visible at the current
  // zoom, not fixed: cluster sizes vary hugely by zoom, and fixed thresholds made
  // every cluster at a city-wide zoom saturate the top bucket and look uniform.
  const CLUSTER_SIZES = [30, 36, 42, 48, 56];
  let clusterColorThresholds = [2, 4, 8, 16];

  function clusterIconCreate(cluster) {
    const count = cluster.getChildCount();
    let idx = 0;
    while (idx < clusterColorThresholds.length && count >= clusterColorThresholds[idx]) idx += 1;
    const color = SEQUENTIAL_RAMP[Math.min(idx + 1, SEQUENTIAL_RAMP.length - 1)];
    // Clamp like the colour above: computeBins returns five thresholds, so idx runs
    // 0..5 -- one past the last CLUSTER_SIZES entry. Unclamped, the biggest cluster in
    // view got `width:undefinedpx`, the browser dropped the declaration, and the badge
    // sized itself to its own text -- a wide, short oval on exactly three-digit counts.
    const size = CLUSTER_SIZES[Math.min(idx, CLUSTER_SIZES.length - 1)];
    return L.divIcon({
      html: `<div class="cluster-badge" style="width:${size}px;height:${size}px;font-size:${size >= 42 ? 13 : 11}px;background:${color}">${count}</div>`,
      className: "",
      iconSize: L.point(size, size),
    });
  }

  // markercluster has no public API to enumerate on-screen clusters, so this reaches
  // into the (internal, but stable across 1.x) _featureGroup holding the visible icons.
  function refreshClusterColors() {
    if (!map || !(permitsLayer instanceof L.MarkerClusterGroup)) return;
    const counts = [];
    permitsLayer._featureGroup.eachLayer((layer) => {
      if (layer instanceof L.MarkerCluster) counts.push(layer.getChildCount());
    });
    if (counts.length === 0) return;
    clusterColorThresholds = computeBins(counts);
    permitsLayer.refreshClusters();
  }

  // ---- Layers --------------------------------------------------------------

  // Wards must always render behind permit points, regardless of toggle order --
  // otherwise (with the shared canvas renderer) whichever layer was re-added most
  // recently ends up drawn last, i.e. on top.
  function keepWardsAtBack() {
    if (wardsLayer && map.hasLayer(wardsLayer)) wardsLayer.bringToBack();
  }

  // Built per feature rather than via L.geoJSON so the marker TYPE can differ by mode:
  // canvas circleMarkers on desktop, L.marker+divIcon on mobile -- markercluster
  // clusters L.Marker instances, not circleMarker/Path instances.
  function buildPointLayers() {
    const mobile = isMobile();
    return permitsData.features.map((feature) => {
      const [lng, lat] = feature.geometry.coordinates;
      const latlng = L.latLng(lat, lng);
      const status = feature.properties.status;
      const color = status === "active" ? "#eb6834" : status === "cleared" ? "#2a78d6" : "#898781";
      const units = feature.properties.dwelling_units_created || 1;

      let layer;
      if (mobile) {
        // The dot stays small (it still encodes unit count), but the tap target is
        // padded to a comfortable minimum -- small dots were hard to hit on touch.
        const dotSize = radiusForUnits(units) * 2;
        const touchSize = Math.max(dotSize, 36);
        layer = L.marker(latlng, {
          icon: L.divIcon({
            html:
              `<div style="width:${touchSize}px;height:${touchSize}px;display:flex;align-items:center;justify-content:center;">` +
              `<div class="point-badge" style="width:${dotSize}px;height:${dotSize}px;background:${color}"></div></div>`,
            className: "",
            iconSize: L.point(touchSize, touchSize),
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
    if (!map) return;
    if (permitsLayer) map.removeLayer(permitsLayer);

    allPermitLayers = buildPointLayers();
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

    renderPermitVisibility(visibleFeatures());
    keepWardsAtBack();
    // markercluster doesn't finish building its cluster icons within the same
    // synchronous call stack as addLayer (confirmed: _featureGroup is still empty
    // immediately after) -- defer a frame so refreshClusterColors finds clusters.
    requestAnimationFrame(refreshClusterColors);
  }

  function visibleFeatures() {
    return permitsData.features.filter((f) => Filters.passes(f.properties));
  }

  function renderWardShading(features) {
    const totals = new Map();
    for (const f of features) {
      const ward = f.properties.ward;
      if (!ward) continue;
      totals.set(ward, (totals.get(ward) || 0) + (f.properties.dwelling_units_created || 0));
    }
    const values = [...wardFeaturesByName.keys()].map((name) => totals.get(name) || 0);
    const maxUnits = Math.max(1, ...values);
    const thresholds = computeBins(values);
    renderWardBinsLegend(thresholds, maxUnits);
    for (const [name, layer] of wardFeaturesByName) {
      layer.setStyle({ fillColor: colorForValue(totals.get(name) || 0, thresholds) });
    }
  }

  function renderPermitVisibility(features) {
    // Add/remove layers rather than toggling opacity: with the canvas renderer a merely
    // transparent marker is still hit-tested, so an opacity-only "hide" would let a
    // filtered-out permit's popup still open.
    const visibleIds = new Set(features.map((f) => featureKey(f.properties)));
    for (const layer of allPermitLayers) {
      if (visibleIds.has(featureKey(layer.feature.properties))) permitsLayer.addLayer(layer);
      else permitsLayer.removeLayer(layer);
    }
  }

  function createMap() {
    const key = (global.CARTO_API_KEY || "").trim();
    const tileUrl = key
      ? "https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png?key=" + encodeURIComponent(key)
      : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

    map = L.map("map", {
      center: TORONTO_CENTER,
      zoom: 10.5,
      minZoom: 9,
      maxZoom: 19,
      preferCanvas: true,
      zoomControl: false,
    });
    L.tileLayer(tileUrl, { subdomains: "abcd", maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
    L.control.zoom({ position: "topright" }).addTo(map);
    map.on("zoomend moveend", () => requestAnimationFrame(refreshClusterColors));

    wardsLayer = L.geoJSON(wardsData, {
      style: () => ({ fillColor: SEQUENTIAL_RAMP[0], fillOpacity: 0.55, color: "#c3c2b7", weight: 1 }),
    });
    wardFeaturesByName = new Map();
    wardsLayer.eachLayer((layer) => wardFeaturesByName.set(layer.feature.properties.ward_name, layer));
    if (showWards) wardsLayer.addTo(map);

    // Clustering only applies on mobile -- if the viewport crosses the responsive
    // breakpoint (resize, tablet rotation), switch rendering mode to match.
    global.matchMedia(MOBILE_BREAKPOINT).addEventListener("change", rebuildPermitsLayer);
    global.addEventListener("resize", () => map.invalidateSize());

    rebuildPermitsLayer();
  }

  const MapView = {
    init(permits, wards) {
      permitsData = permits;
      wardsData = wards;

      const chip = document.getElementById("layer-wards");
      chip.addEventListener("click", () => {
        showWards = chip.dataset.active !== "true";
        chip.dataset.active = String(showWards);
        if (wardsLayer) {
          if (showWards) map.addLayer(wardsLayer);
          else map.removeLayer(wardsLayer);
        }
        document.getElementById("ward-legend-section").style.display = showWards ? "" : "none";
        if (showWards) MapView.refresh();
        keepWardsAtBack();
      });
    },

    /* Bring the map up, creating it (and fetching Leaflet) the first time. */
    async show() {
      await ensureLeaflet();
      if (!map) createMap();
      // The container was display:none until now, so Leaflet's cached size is stale.
      map.invalidateSize();
      MapView.refresh();
    },

    refresh() {
      if (!map) return;
      const features = visibleFeatures();
      renderPermitVisibility(features);
      if (showWards) renderWardShading(features);
      keepWardsAtBack();
    },

    invalidate() {
      if (map) map.invalidateSize();
    },
  };

  global.MapView = MapView;
})(window);
