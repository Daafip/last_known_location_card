import Leaflet from "leaflet";
import {maplibreGL} from "@maplibre/maplibre-gl-leaflet";
import {getTrackColor} from "./utils.js";

const DEFAULT_ZOOM = 13;
const MAP_MIN_ZOOM = 1;
const MAP_MAX_ZOOM = 20;

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const CARTO_ATTRIBUTION = `${OSM_ATTRIBUTION}, &copy; <a href="https://carto.com/attributions">CARTO</a>`;

// Served by Home Assistant 2026.9+; older installs fall back to raster tiles.
const VECTOR_STYLES = {
    light: "/static/map/light.json",
    dark: "/static/map/dark.json",
};

let webGL2Supported;

function supportsWebGL2() {
    if (webGL2Supported === undefined) {
        try {
            const context = document.createElement("canvas").getContext("webgl2");
            webGL2Supported = Boolean(context);
            context?.getExtension("WEBGL_lose_context")?.loseContext();
        } catch {
            webGL2Supported = false;
        }
    }
    return webGL2Supported;
}

async function loadMapStyle(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Map style ${url} unavailable (${response.status})`);
    const style = await response.json();
    if (typeof style.sprite === "string") {
        style.sprite = new URL(style.sprite, location.href).href;
    } else if (Array.isArray(style.sprite)) {
        style.sprite = style.sprite.map((sprite) => ({...sprite, url: new URL(sprite.url, location.href).href}));
    }
    return style;
}

export class LocationLeafletMap {
    constructor(mapElement, homeZoneCenter = null, options = {}) {
        if (!mapElement?.isConnected) {
            throw new Error("Cannot setup Leaflet map on disconnected element");
        }

        this._Leaflet = Leaflet;
        this._mapElement = mapElement;
        this._homeZoneCenter = homeZoneCenter;
        this._leafletMap = Leaflet.map(mapElement, {zoomControl: true, minZoom: MAP_MIN_ZOOM, maxZoom: MAP_MAX_ZOOM});

        this._rasterTileUrl = options.mapTileUrl || "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
        this._rasterAttribution = options.mapAttribution
            || (options.mapTileUrl ? OSM_ATTRIBUTION : CARTO_ATTRIBUTION);
        this._vectorLayer = null;
        this._fetchTilesToken = options.fetchMapTilesToken;
        this._tilesToken = undefined;
        this._tokenInterval = undefined;
        this._destroyed = false;
        this._darkMode = false;
        this._styleRequest = 0;
        this._appliedDarkMode = false;
        this._contextLost = false;
        this._fallbackTimeout = undefined;
        this._handleVisibilityChange = () => {
            if (this._contextLost) this._scheduleRasterFallback();
        };
        // Deferred so the caller's setDarkMode() lands before the style is picked.
        Promise.resolve().then(() => this._setupBaseLayer());

        if (this._homeZoneCenter) this._leafletMap.setView(this._homeZoneCenter, DEFAULT_ZOOM);

        this._mapLayers = [];
        this._fullDayPaths = [];
        this._fullDayPath = [];
        this._currentLocations = [];
        this._highlightedPath = [];
        this._highlightedStay = null;
        this._isTravelHighlightActive = false;

        this.setDarkMode(false);
        requestAnimationFrame(() => this._leafletMap.invalidateSize());
    }

    async _setupBaseLayer() {
        if (this._destroyed) return;
        if (supportsWebGL2() && (await this._createVectorLayer())) return;
        this._createRasterLayer();
    }

    async _refreshTilesToken() {
        if (!this._fetchTilesToken) return;
        try {
            this._tilesToken = await this._fetchTilesToken();
        } catch {
            // Older Home Assistant has no tile proxy.
        }
    }

    // HA's tile proxy rejects requests without the token; the worker needs absolute URLs.
    _transformRequest(url) {
        const parsed = new URL(url, location.href);
        if (this._tilesToken && parsed.pathname.startsWith("/api/map_tiles/")) {
            parsed.searchParams.set("token", this._tilesToken);
        }
        return {url: parsed.href};
    }

    async _createVectorLayer() {
        let layer;
        try {
            const [style] = await Promise.all([
                loadMapStyle(VECTOR_STYLES[this._darkMode ? "dark" : "light"]),
                this._refreshTilesToken(),
            ]);
            if (this._destroyed) return false;
            layer = maplibreGL({
                style,
                localIdeographFontFamily: "sans-serif",
                transformRequest: (url) => this._transformRequest(url),
            });
            // The adapter builds the MapLibre map in `onAdd`, which throws on a refused context.
            layer.addTo(this._leafletMap);
        } catch {
            try {
                layer?.remove();
            } catch {
                // May never have finished being added.
            }
            return false;
        }

        this._vectorLayer = layer;
        this._appliedDarkMode = this._darkMode;
        this._mapElement?.classList.remove("raster-tiles");

        const glMap = layer.getMaplibreMap();
        glMap.on("webglcontextlost", () => {
            this._contextLost = true;
            this._scheduleRasterFallback();
        });
        glMap.on("webglcontextrestored", () => {
            this._contextLost = false;
            clearTimeout(this._fallbackTimeout);
        });
        document.addEventListener("visibilitychange", this._handleVisibilityChange);
        // The token rotates every 30 minutes.
        this._tokenInterval ??= setInterval(() => this._refreshTilesToken(), 20 * 60 * 1000);
        this._leafletMap.on("unload", () => {
            clearTimeout(this._fallbackTimeout);
            clearInterval(this._tokenInterval);
            document.removeEventListener("visibilitychange", this._handleVisibilityChange);
        });
        return true;
    }

    _createRasterLayer() {
        if (this._destroyed) return;
        this._mapElement?.classList.add("raster-tiles");
        Leaflet.tileLayer(this._rasterTileUrl, {
            attribution: this._rasterAttribution,
            subdomains: "abcd",
            minZoom: MAP_MIN_ZOOM,
            maxZoom: MAP_MAX_ZOOM,
            referrerPolicy: "no-referrer-when-downgrade",
        }).addTo(this._leafletMap);
    }

    _scheduleRasterFallback() {
        clearTimeout(this._fallbackTimeout);
        if (!this._vectorLayer || document.hidden) return;
        this._fallbackTimeout = setTimeout(() => this._swapToRaster(), 2000);
    }

    _swapToRaster() {
        const layer = this._vectorLayer;
        this._vectorLayer = null;
        clearInterval(this._tokenInterval);
        document.removeEventListener("visibilitychange", this._handleVisibilityChange);
        try {
            layer.remove();
        } catch {
            // Already detached.
        }
        this._createRasterLayer();
        this._mapElement?.classList.toggle("dark", this._darkMode);
    }

    setDarkMode(isDarkMode) {
        const darkMode = Boolean(isDarkMode);
        this._darkMode = darkMode;
        this._mapElement?.classList.toggle("dark", darkMode);
        if (!this._vectorLayer || darkMode === this._appliedDarkMode) return;

        const request = ++this._styleRequest;
        loadMapStyle(VECTOR_STYLES[darkMode ? "dark" : "light"])
            .then((style) => {
                if (request !== this._styleRequest || !this._vectorLayer) return;
                this._appliedDarkMode = darkMode;
                this._vectorLayer.getMaplibreMap()?.setStyle(style);
            })
            .catch(() => {
                // Keep the current style.
            });
    }

    destroy() {
        this._destroyed = true;
        clearTimeout(this._fallbackTimeout);
        clearInterval(this._tokenInterval);
        document.removeEventListener("visibilitychange", this._handleVisibilityChange);
        this._vectorLayer = null;
        this._leafletMap.remove();
        this._mapLayers = [];
        this._fullDayPath = [];
        this._fullDayPaths = [];
        this._currentLocations = [];
        this._highlightedPath = [];
        this._highlightedStay = null;
    }

    setDaySegments(tracks = [], activeEntityIndex = 0, onTrackClick = null, colors = []) {
        this._fullDayPaths = tracks.map((track, index) => {
            const points = [];
            const segments = Array.isArray(track?.segments) ? track.segments : [];
            segments.forEach((segment) => {
                if (segment?.type === "stay" && segment.center) {
                    points.push({
                        point: [segment.center.lat, segment.center.lon],
                        timestamp: segment.start,
                    });
                }
                if (segment?.type === "move" && Array.isArray(segment.points)) {
                    points.push(...segment.points);
                }
            });

            return {
                entityIndex: index,
                isActive: index === activeEntityIndex,
                points,
                color: getTrackColor(index, colors),
                opacity: index === activeEntityIndex ? 1 : 0.8,
                weight: 4,
                borderWeight: 7,
            };
        });

        this._fullDayPath = this._fullDayPaths[activeEntityIndex] || {points: []};
        this._activeTrackColor = this._fullDayPaths[activeEntityIndex]?.color || "var(--primary-color)";
        this._onTrackClick = typeof onTrackClick === "function" ? onTrackClick : null;

        this._highlightedPath = [];
        this._highlightedStay = null;
        this._isTravelHighlightActive = false;

        const activeSegments = tracks[activeEntityIndex]?.segments || [];
        this._drawMapSegments(activeSegments);
    }

    highlightSegment(segment, segments) {
        this._highlightedPath = [];
        this._highlightedStay = null;
        this._isTravelHighlightActive = false;

        if (segment?.type === "stay") {
            this._highlightedStay = segment;
        } else if (segment?.type === "move") {
            this._highlightedPath = [
                {
                    points: segment.points,
                    color: "var(--accent-color)",
                    weight: 7,
                    opacity: 1,
                    borderWeight: 10,
                },
            ];
            this._isTravelHighlightActive = true;
        }

        this._drawMapSegments(segments);
    }

    clearHighlight(segments) {
        if (!this._highlightedPath.length && !this._highlightedStay && !this._isTravelHighlightActive) {
            return;
        }

        this._highlightedPath = [];
        this._highlightedStay = null;
        this._isTravelHighlightActive = false;

        this._drawMapSegments(segments);
    }

    fitMap(bounds = null) {
        if (bounds === null) {
            bounds = this._fullDayPath?.points?.map((point) => point.point) || [];
            // Always keep the current/last-known marker in view alongside the path.
            if (Array.isArray(this._currentLocations)) {
                bounds = bounds.concat(this._currentLocations.map((location) => location.point));
            }
        }
        if (!bounds.length) {
            if (this._homeZoneCenter) this._leafletMap.setView(this._homeZoneCenter, DEFAULT_ZOOM);
            return;
        }
        const normalizedBounds = bounds
            .map(normalizeLatLng)
            .filter((point) => point && Number.isFinite(point.lat) && Number.isFinite(point.lng));
        if (!normalizedBounds.length) return;
        const paddedBounds = this._Leaflet.latLngBounds(normalizedBounds).pad(0.1);
        this._leafletMap.fitBounds(paddedBounds, {maxZoom: 14});
    }

    _drawMapSegments(segments) {
        this._mapLayers.forEach((layer) => layer.remove());
        this._mapLayers = [];

        this._drawMapLines();
        this._drawMapMarkers(segments);
        this._drawCurrentLocationMarkers();
        this._mapLayers.forEach((layer) => this._leafletMap.addLayer(layer));
    }

    _drawMapMarkers(segments) {
        const stayMarkers = Array.isArray(segments) ? segments.filter((segment) => segment?.type === "stay") : [];

        stayMarkers.forEach((stay) => {
            const iconName = stay.zoneIcon || "mdi:map-marker";
            const icon = createMarkerIcon({
                iconName: iconName,
                markerSize: 18,
                iconSize: 14,
                backgroundColor: this._activeTrackColor,
                borderColor: `color-mix(in srgb, black 30%, ${this._activeTrackColor})`,
                iconPadding: "2px",
                leafletIconSize: [22, 22],
            });

            this._mapLayers.push(this._Leaflet.marker(stay.center, {icon, zIndexOffset: 100}));
        });

        if (!this._highlightedStay) return;

        const iconName = this._highlightedStay.zoneIcon || "mdi:map-marker";
        const icon = createMarkerIcon({
            iconName: iconName,
            markerSize: 22,
            iconSize: 22,
            backgroundColor: "var(--accent-color)",
            borderColor: "color-mix(in srgb, black 30%, var(--accent-color))",
            leafletIconSize: [26, 26],
        });

        this._mapLayers.push(
            this._Leaflet.marker(this._highlightedStay.center, {
                icon,
                zIndexOffset: 1000,
            }),
        );
    }

    _drawMapLines() {
        const inactivePaths = this._fullDayPaths.filter((path) => !path.isActive);
        const activePaths = this._fullDayPaths.filter((path) => path.isActive);
        const paths = [...inactivePaths, ...activePaths, ...this._highlightedPath];

        paths.forEach((path) => {
            if (!Array.isArray(path.points) || path.points.length < 2) return;
            const latLngs = path.points.map((point) => point.point);

            if (path.isActive || path.entityIndex === undefined) {
                this._mapLayers.push(
                    this._Leaflet.polyline(latLngs, {
                        color: `color-mix(in srgb, black 30%, ${path.color})`,
                        opacity: path.opacity ?? 1,
                        weight: path.borderWeight ?? path.weight + 3,
                    }),
                );
            }

            const line = this._Leaflet.polyline(latLngs, {
                color: path.color,
                opacity: path.opacity ?? 1,
                weight: path.weight,
            });
            line.on("click", () => {
                if (!Number.isInteger(path.entityIndex) || !this._onTrackClick) return;
                this._onTrackClick(path.entityIndex);
            });
            this._mapLayers.push(line);
        });
    }

    _drawCurrentLocationMarkers() {
        const markerGroup = Leaflet.layerGroup();
        this._currentLocations.forEach((location) => {
            if (!location?.point) return;
            const icon = createEntityIcon(location, this._hass);
            const zIndexOffset = location.isActive ? 1500 : 1000;
            markerGroup.addLayer(
                this._Leaflet.marker(location.point, {
                    icon,
                    zIndexOffset: zIndexOffset,
                }),
            );
        });
        this._mapLayers.push(markerGroup);
    }
}

function createMarkerIcon(options) {
    const haIcon = document.createElement("ha-icon");
    haIcon.setAttribute("icon", options.iconName);
    haIcon.setAttribute(
        "style",
        `color: white; --mdc-icon-size: ${options.iconSize}px; padding: ${options.iconPadding || 0}`,
    );

    const iconDiv = document.createElement("div");
    iconDiv.appendChild(haIcon);
    iconDiv.setAttribute(
        "style",
        `height: ${options.markerSize}px; width: ${options.markerSize}px; background-color: ${options.backgroundColor}; border-radius: 50%; border: 2px solid ${options.borderColor}; display: flex;`,
    );

    return Leaflet.divIcon({
        html: iconDiv,
        className: "my-leaflet-icon",
        iconSize: options.leafletIconSize,
    });
}

function createEntityIcon(location, hass) {
    const iconStyle =
        "color: white; --mdc-icon-size: 24px; height: 42px; width: 42px; display: flex; align-items: center; justify-content: center;";
    let icon;
    if (location.picture) {
        icon = document.createElement("img");
        icon.src = location.picture;
        icon.alt = location.name;
        icon.setAttribute("style", "height: 42px; width: 42px; border-radius: 50%; object-fit: cover;");
    } else if (hass && location.stateObj) {
        // Render the entity's actual icon the way Home Assistant resolves it
        // (custom icon → entity-registry icon → device_class/domain default).
        icon = document.createElement("ha-state-icon");
        icon.hass = hass;
        icon.stateObj = location.stateObj;
        icon.setAttribute("style", iconStyle);
    } else if (location.icon) {
        icon = document.createElement("ha-icon");
        icon.setAttribute("icon", location.icon);
        icon.setAttribute("style", iconStyle);
    } else {
        const getAbbreviation = (name) => {
            const words = name.split(" ");
            if (words.length === 1) {
                return words[0].charAt(0).toUpperCase() + words[0].charAt(1);
            }
            return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
        };
        icon = document.createElement("div");
        icon.innerHTML = getAbbreviation(location.name);
        icon.setAttribute(
            "style",
            `height: 42px; width: 42px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.5em; font-weight: bold; color: white;`,
        );
    }
    const iconDiv = document.createElement("div");
    iconDiv.appendChild(icon);
    iconDiv.setAttribute(
        "style",
        `height: 42px; width: 42px; border-radius: 50%; border: 3px solid color-mix(in srgb, black 30%, ${location.color}); overflow: hidden; background-color: ${location.color}`,
    );

    return Leaflet.divIcon({
        html: iconDiv,
        className: "my-leaflet-icon",
        iconSize: [48, 48],
    });
}

function normalizeLatLng(point) {
    if (Array.isArray(point) && point.length >= 2) {
        return {lat: Number(point[0]), lng: Number(point[1])};
    }
    if (!point || typeof point !== "object") return null;
    if (Number.isFinite(point.lat) && Number.isFinite(point.lng)) {
        return {lat: Number(point.lat), lng: Number(point.lng)};
    }
    if (Number.isFinite(point.lat) && Number.isFinite(point.lon)) {
        return {lat: Number(point.lat), lng: Number(point.lon)};
    }
    return null;
}
