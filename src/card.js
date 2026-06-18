import css from "./card.css";
import leafletCss from "leaflet/dist/leaflet.css";
import {findLastActivityDate, getSegmentedTracks} from "./segmentation.js";
import {
    escapeHtml,
    formatDate,
    formatErrorMessage,
    getTrackColor,
    isToday,
    normalizeEntityEntries,
    normalizeList,
    startOfDay,
} from "./utils.js";
import {LocationLeafletMap} from "./leaflet-map.js";
import {getConfigFormSchema} from "./config-flow.js";
import {localize} from "./localize/localize.js";

const DEFAULT_CONFIG = {
    entity: [],
    stay_radius_m: 75,
    min_stay_minutes: 10,
    max_reasonable_speed_kmh: 300,
    map_appearance: "auto",
    map_height_px: 200,
    distance_unit: "metric",
    colors: [],
    hide_current_location: false,
    debug: false,
    activity_icon_map: {},
    update_interval: 300,
    max_lookback_days: 90,
    min_activity_distance_m: 100,
    last_activity_cache_ttl: 3600,
};

// Persist the resolved last-activity date across frontend reloads so a fresh
// card doesn't have to re-run the history search every time the page loads.
const ACTIVITY_CACHE_STORAGE_KEY = "lklc_last_activity_v1";

function readActivityCacheStore() {
    try {
        const parsed = JSON.parse(localStorage.getItem(ACTIVITY_CACHE_STORAGE_KEY));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function writeActivityCacheStore(store) {
    try {
        localStorage.setItem(ACTIVITY_CACHE_STORAGE_KEY, JSON.stringify(store));
    } catch {
        // ignore storage errors (private mode, quota, etc.)
    }
}

class LastKnownLocationCard extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({mode: "open"});
        this._config = {...DEFAULT_CONFIG};
        this._cache = new Map();
        this._selectedDate = startOfDay(new Date());
        this._hass = null;
        this._rendered = false;
        this._touchStart = null;
        this._activeEntityIndex = 0;
        this._updateIntervalId = null;
        this._dateInitialized = false;
        this._lookbackExhausted = false;
        this._resetMapFitMode();
        this._addEventListeners();
    }

    // noinspection JSUnusedGlobalSymbols
    setConfig(config) {
        this._config = {...DEFAULT_CONFIG, ...config};
        this._checkConfig();

        this._cache.clear();

        this._activeEntityIndex = 0;
        this._dateInitialized = false;
        this._selectedDate = startOfDay(new Date());
        this._resetMapFitMode();
        this._setDarkMode();
        this._renderEntitySelector(true);
        this._applyMapHeight();
        this._setupUpdateInterval();
        if (this._hass && this._entitiesHaveState()) {
            this._dateInitialized = true;
            this._dateInitializing = true;
            this._initializeSelectedDate().finally(() => {
                this._dateInitializing = false;
            });
        } else {
            this._render();
        }
    }

    // noinspection JSUnusedGlobalSymbols
    set hass(hass) {
        this._hass = hass;
        this._setDarkMode();
        this._renderEntitySelector();
        if (!this._config.entity) return;
        this._config.entity = normalizeEntityEntries(this._config);

        if (!this._dateInitialized) {
            // Wait for the entity's state to actually arrive before searching, so
            // a hass push that precedes the states doesn't latch us onto "today".
            if (!this._config.entity.length || !this._entitiesHaveState()) {
                if (!this._rendered) {
                    this._render();
                    this._rendered = true;
                }
                return;
            }
            this._dateInitialized = true;
            this._dateInitializing = true;
            this._initializeSelectedDate().finally(() => {
                this._dateInitializing = false;
            });
            return;
        }
        // Skip intermediate fetches while the initial date search is in flight.
        if (this._dateInitializing) return;

        const dateKey = formatDate(this._selectedDate);
        if (!this._cache.has(dateKey)) {
            this._ensureDay(this._selectedDate);
        }
        if (!this._rendered) {
            this._render();
            this._rendered = true;
        }
    }

    // noinspection JSUnusedGlobalSymbols
    static getConfigForm() {
        return getConfigFormSchema();
    }

    // noinspection JSUnusedGlobalSymbols
    getCardSize() {
        return 10;
    }

    // noinspection JSUnusedGlobalSymbols
    disconnectedCallback() {
        if (this._updateIntervalId) {
            clearInterval(this._updateIntervalId);
            this._updateIntervalId = null;
        }
    }

    _checkConfig() {
        this._config.entity = normalizeEntityEntries(this._config);
        this._config.colors = normalizeList(this._config.colors);
        if (this._config.entity.length === 0) {
            throw new Error("You need to define an entity");
        }
        if (!["metric", "imperial"].includes(this._config.distance_unit)) {
            throw new Error("distance_unit must be either 'metric' or 'imperial'");
        }
        if (!["auto", "light", "dark"].includes(this._config.map_appearance)) {
            throw new Error("map_appearance must be one of 'auto', 'light', or 'dark'");
        }
    }

    _setDarkMode() {
        let darkMode = Boolean(this._hass?.themes?.darkMode);
        if (this._config.map_appearance === "dark") {
            darkMode = true;
        } else if (this._config.map_appearance === "light") {
            darkMode = false;
        }
        this._mapView?.setDarkMode(darkMode);
    }

    _applyMapHeight() {
        const mapElement = this.shadowRoot?.getElementById("overview-map");
        if (!mapElement) return;
        mapElement.style.setProperty("height", `${this._config.map_height_px}px`, "important");
    }

    // Actions
    _initializeSelectedDate() {
        // Render the base layout immediately so the user sees the card while we
        // search history for the last day with real location data.
        this._render();
        this._rendered = true;

        return this._resolveLastActivityDate()
            .then(({date, statesByEntity}) => {
                this._selectedDate = date;
                this._resetMapFitMode();
                return this._ensureDay(this._selectedDate, statesByEntity);
            })
            .then(() => this._render())
            .catch((err) => {
                console.warn("Last known location card: failed to resolve last activity date", err);
                this._render();
            });
    }

    _entitiesHaveState() {
        return this._config.entity.some((entry) => Boolean(this._hass?.states?.[entry.entity]));
    }

    _activityCacheKey() {
        const ids = this._config.entity
            .map((entry) => entry.entity)
            .filter(Boolean)
            .sort()
            .join(",");
        const threshold = Number(this._config.min_activity_distance_m) || 100;
        const lookback = Number(this._config.max_lookback_days) || 90;
        return `${ids}|${threshold}|${lookback}`;
    }

    _readActivityCache() {
        const ttl = Number(this._config.last_activity_cache_ttl);
        if (!(ttl > 0)) return null;
        const entry = readActivityCacheStore()[this._activityCacheKey()];
        if (!entry || !entry.date || !entry.ts) return null;
        if (Date.now() - entry.ts > ttl * 1000) return null;
        const date = startOfDay(new Date(`${entry.date}T00:00:00`));
        return Number.isNaN(date.getTime()) ? null : date;
    }

    _writeActivityCache(date) {
        if (!(Number(this._config.last_activity_cache_ttl) > 0)) return;
        const store = readActivityCacheStore();
        store[this._activityCacheKey()] = {date: formatDate(date), ts: Date.now()};
        writeActivityCacheStore(store);
    }

    // Search recorded history backward for the most recent day the entity
    // actually logged a location. We start the search at the entity's last
    // reported day (so an offline device resolves in a single query) rather
    // than trusting `last_updated`, which keeps churning even with no new fix.
    //
    // The result is persisted to localStorage so a frontend reload reuses it
    // instead of re-running the search. Pass force=true (the periodic refresh)
    // to bypass the cache and re-scan.
    async _resolveLastActivityDate(force = false) {
        const todayStart = startOfDay(new Date());
        const entityIds = this._config.entity.map((entry) => entry.entity).filter(Boolean);
        if (!this._hass || !entityIds.length) return {date: todayStart, statesByEntity: null};

        if (!force) {
            const cached = this._readActivityCache();
            if (cached) {
                this._lookbackExhausted = false;
                if (this._config.debug) {
                    console.log(
                        "%c[Last Known Location] using cached last-activity date:",
                        "color: white; background-color: #03a9f4; font-weight: bold;",
                        formatDate(cached),
                    );
                }
                return {date: cached, statesByEntity: null};
            }
        }

        let startDay = null;
        for (const entityId of entityIds) {
            const state = this._hass.states?.[entityId];
            const raw = state?.last_updated || state?.last_changed;
            if (!raw) continue;
            const day = startOfDay(new Date(raw));
            if (Number.isNaN(day.getTime())) continue;
            if (!startDay || day.getTime() > startDay.getTime()) startDay = day;
        }
        if (!startDay || startDay.getTime() > todayStart.getTime()) startDay = todayStart;

        const maxLookback = Number(this._config.max_lookback_days) || 90;
        const threshold = Number(this._config.min_activity_distance_m) || 100;
        let found = null;
        try {
            found = await findLastActivityDate(this._hass, entityIds, startDay, maxLookback, threshold);
        } catch (err) {
            console.warn("Last known location card: history lookback failed", err);
        }
        const resolved = found ? found.date : startDay;
        this._lookbackExhausted = found === null;
        if (this._lookbackExhausted) {
            console.warn(
                `Last known location card: no movement found for ${entityIds.join(", ")} in the last ` +
                    `${maxLookback} days; showing ${formatDate(resolved)}.`,
            );
        }
        this._writeActivityCache(resolved);
        if (this._config.debug) {
            console.log(
                "%c[Last Known Location] resolved last-activity date:",
                "color: white; background-color: #03a9f4; font-weight: bold;",
                formatDate(resolved),
            );
        }
        return {date: resolved, statesByEntity: found ? found.statesByEntity : null};
    }

    _resetMapFitMode() {
        if (isToday(this._selectedDate) && !this._config.hide_current_location) {
            this._mapFitMode = "current_location";
        } else {
            this._mapFitMode = "selected_entity_path";
        }
    }

    _refreshCurrentDay() {
        const key = formatDate(this._selectedDate);
        this._cache.delete(key);
        this._ensureDay(this._selectedDate).then(() => this._render());
    }

    // Periodic tick while the dashboard is open. Instead of re-running the full
    // backward search, only scan forward from the currently shown day to today
    // for newer movement (one window query); if none, just refresh today's points.
    _refresh() {
        const entityIds = this._config.entity.map((entry) => entry.entity).filter(Boolean);
        if (!this._hass || !entityIds.length) return;

        const todayStart = startOfDay(new Date());
        const daysForward = Math.max(0, Math.round((todayStart.getTime() - this._selectedDate.getTime()) / 86400000));
        const threshold = Number(this._config.min_activity_distance_m) || 100;

        findLastActivityDate(this._hass, entityIds, todayStart, daysForward, threshold)
            .then((found) => {
                if (found && formatDate(found.date) !== formatDate(this._selectedDate)) {
                    this._selectedDate = found.date;
                    this._lookbackExhausted = false;
                    this._resetMapFitMode();
                    this._writeActivityCache(found.date);
                    this._cache.delete(formatDate(found.date));
                    this._ensureDay(this._selectedDate, found.statesByEntity).then(() => this._render());
                } else {
                    this._refreshCurrentDay();
                }
            })
            .catch((err) => {
                console.warn("Last known location card: refresh failed", err);
                this._refreshCurrentDay();
            });
    }

    _logCacheToConsole() {
        console.log("%c[Last Known Location Debug]", "color: white; background-color: #03a9f4; font-weight: bold;");
        console.log(JSON.stringify(this._cache.get(formatDate(this._selectedDate))));
    }

    _setupUpdateInterval() {
        if (this._updateIntervalId) {
            clearInterval(this._updateIntervalId);
            this._updateIntervalId = null;
        }

        const interval = Number(this._config.update_interval);
        if (interval > 0) {
            this._updateIntervalId = setInterval(() => {
                this._refresh();
            }, interval * 1000);
        }
    }

    // Rendering
    _render() {
        if (!this.shadowRoot) return;
        this._ensureBaseLayout();

        const dateKey = formatDate(this._selectedDate);
        const dayData = this._cache.get(dateKey) || {
            loading: false,
            tracks: null,
            error: null,
        };

        this.shadowRoot.getElementById("timeline-date").textContent = formatDate(
            this._selectedDate,
            this._hass?.locale,
        );
        this._applyMapHeight();

        this._updateMapFitButton();

        const status = this.shadowRoot.getElementById("card-status");
        if (status) {
            if (dayData.error) {
                status.innerHTML = `<div class="error">${dayData.error}</div>`;
            } else if (dayData.loading) {
                status.innerHTML = `<div class="loading">${localize("card.timeline.loading")}</div>`;
            } else if (this._lookbackExhausted) {
                status.innerHTML = `<div class="loading">No movement in the last ${this._config.max_lookback_days} days</div>`;
            } else {
                status.innerHTML = "";
            }
        }

        this._attachMapCard();
        this._rendered = true;
        requestAnimationFrame(() => this._drawMapPaths());
    }

    _ensureBaseLayout() {
        if (this._baseLayoutReady) return;
        this._baseLayoutReady = true;

        this.shadowRoot.innerHTML = `
          <style>${css}\n${leafletCss}</style>
          <ha-card>
            <div class="card">
              <div class="map-wrap">
                <div id="overview-map"></div>
                <ha-icon-button id="map-fit-mode" class="map-reset" data-action="update-map-fit-mode"><ha-icon></ha-icon></ha-icon-button>
              </div>
              <div class="selector-row" id="selector-row" hidden>
                <div id="entity-selector" class="entity-selector"></div>
              </div>
              <div class="header my-header">
                <span id="timeline-date" class="date"></span>
                ${this._config.debug ? `<ha-icon-button class="nav-button" data-action="debug" label="${localize("card.labels.debug")}"><ha-icon icon="mdi:bug"></ha-icon></ha-icon-button>` : ""}
              </div>
              <div id="card-status"></div>
            </div>
          </ha-card>
        `;
    }

    _updateMapFitButton() {
        const fitToggleBtn = this.shadowRoot?.getElementById("map-fit-mode");
        if (!fitToggleBtn) return;
        const icon = fitToggleBtn.querySelector("ha-icon");

        if (isToday(this._selectedDate) && !this._config.hide_current_location) {
            fitToggleBtn.toggleAttribute("hidden", false);
            if (this._mapFitMode === "current_location") {
                icon.setAttribute("icon", "mdi:magnify-scan");
                fitToggleBtn.setAttribute("label", "Switch to full path fit");
            } else {
                icon.setAttribute("icon", "mdi:crosshairs-gps");
                fitToggleBtn.setAttribute("label", "Switch to current location fit");
            }
        } else {
            fitToggleBtn.toggleAttribute("hidden", true);
        }
    }

    _attachMapCard() {
        const container = this.shadowRoot.getElementById("overview-map");
        if (!container || this._mapView || this._isLoadingMap) return;
        if (!this.isConnected || !container.isConnected) {
            requestAnimationFrame(() => this._attachMapCard());
            return;
        }

        this._isLoadingMap = true;
        try {
            this._mapView = new LocationLeafletMap(container, this._getHomeZoneCenter());
            this._setDarkMode();
            this._drawMapPaths();
        } catch (err) {
            console.warn("Last known location card: map setup failed", err);
        } finally {
            this._isLoadingMap = false;
        }
    }

    _drawMapPaths() {
        const dayData = this._getCurrentDayData();
        if (!dayData || dayData.loading || dayData.error || !this._mapView) return;

        try {
            const tracks = Array.isArray(dayData.tracks) ? dayData.tracks : [];
            if (!this._config.hide_current_location) {
                this._mapView._currentLocations = this._getCurrentEntityLocations();
            }
            this._mapView.setDaySegments(
                tracks,
                this._activeEntityIndex,
                (entityIndex) => this._setActiveEntityIndex(entityIndex),
                this._config.colors,
            );
            this._touchStart = null;

            this._updateMapFitButton();
            this._fitMapToCurrentMode();
        } catch (err) {
            this._setCurrentDayError(err);
            this._render();
        }
    }

    _renderEntitySelector(force_rerender = false) {
        if (!this._baseLayoutReady) return;
        if (this._entitySelectorRendered && !force_rerender) return;
        this._entitySelectorRendered = true;

        const entities = this._config.entity;
        const selector = this.shadowRoot?.getElementById("entity-selector");
        const selectorRow = this.shadowRoot?.getElementById("selector-row");
        if (!selector || !selectorRow) return;
        if (entities.length < 2) {
            selectorRow.toggleAttribute("hidden", true);
            return;
        }

        selectorRow.toggleAttribute("hidden", false);
        selector.innerHTML = entities
            .map(({entity: entityId}, index) => {
                const state = this._hass?.states?.[entityId];
                const picture = state?.attributes?.entity_picture;
                const name = state?.attributes?.friendly_name || entityId;
                const escapedName = escapeHtml(name);
                const escapedPicture = escapeHtml(picture || "");
                const entityDef = this._config.entity[index];
                const trackColor = getTrackColor(index, this._config?.colors, entityDef?.color);
                return `
              <button type="button" style="--entity-track-color:${trackColor};" class="entity-chip ${index === this._activeEntityIndex ? "active" : ""}" data-action="select-entity" data-entity-index="${index}">
                ${picture ? `<img src="${escapedPicture}" alt="${escapedName}">` : '<ha-icon class="entity-avatar-icon" icon="mdi:account-circle"></ha-icon>'}
                <span>${escapedName}</span>
              </button>
            `;
            })
            .join("");
        selector.toggleAttribute("hidden", this._config.entity.length < 2);
    }

    // Functions
    async _ensureDay(date, prefetchedStatesByEntity = null) {
        const key = formatDate(date);
        const existing = this._cache.get(key);
        if (existing && (existing.tracks || existing.loading)) return;

        this._cache.set(key, {loading: true, tracks: null, error: null});

        try {
            const tracks = await getSegmentedTracks(date, this._config, this._hass, prefetchedStatesByEntity);
            this._cache.set(key, {loading: false, tracks, error: null});
        } catch (err) {
            console.warn("Last known location card: history fetch failed", err);
            this._cache.set(key, {
                loading: false,
                tracks: null,
                error: formatErrorMessage(err),
            });
        }
        this._render();
        requestAnimationFrame(() => this._drawMapPaths());
    }

    _getCurrentDayData() {
        return this._cache.get(formatDate(this._selectedDate));
    }

    _setActiveEntityIndex(index) {
        if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= this._config.entity.length ||
            index === this._activeEntityIndex
        ) {
            return;
        }
        this._activeEntityIndex = index;
        this._renderEntitySelector(true);
        this._render();
    }

    _getHomeZoneCenter() {
        const state = this._hass?.states?.["zone.home"];
        const lat = Number(state?.attributes?.latitude);
        const lng = Number(state?.attributes?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return {lat, lng};
    }

    _fitMapToCurrentMode() {
        let bounds = null;
        if (isToday(this._selectedDate) && this._mapFitMode === "current_location") {
            bounds = this._getCurrentEntityLocations().map((point) => point.point);
        }
        this._mapView.fitMap(bounds);
    }

    _updateMapFitMode() {
        if (this._mapFitMode === "current_location") {
            this._mapFitMode = "selected_entity_path";
        } else {
            this._resetMapFitMode();
        }
        this._updateMapFitButton();
        this._fitMapToCurrentMode();
    }

    // The entity's current (last-known) position from its live state, shown as a
    // marker on top of the historical path regardless of which day is displayed.
    _getCurrentEntityLocations() {
        return this._config.entity
            .map(({entity: entityId}, index) => {
                const state = this._hass?.states?.[entityId];
                const lat = Number(state?.attributes?.latitude);
                const lon = Number(state?.attributes?.longitude);
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

                return {
                    point: [lat, lon],
                    picture: state?.attributes?.entity_picture || null,
                    icon: state?.attributes?.icon || null,
                    name: state?.attributes?.friendly_name || entityId,
                    color: getTrackColor(index, this._config?.colors, this._config.entity[index]?.color),
                    isActive: index === this._activeEntityIndex,
                };
            })
            .filter(Boolean);
    }

    _setCurrentDayError(err) {
        const key = formatDate(this._selectedDate);
        const current = this._cache.get(key) || {
            loading: false,
            segments: null,
            points: null,
            error: null,
        };
        this._cache.set(key, {
            ...current,
            loading: false,
            error: formatErrorMessage(err),
        });
    }

    // Event listeners
    _addEventListeners() {
        this.shadowRoot.addEventListener("click", (event) => {
            const target = event.target.closest("[data-action]");
            if (!target) return;
            const action = target.dataset.action;
            if (action === "update-map-fit-mode") {
                this._updateMapFitMode();
            } else if (action === "debug") {
                this._logCacheToConsole();
            } else if (action === "select-entity") {
                this._setActiveEntityIndex(Number(target.dataset.entityIndex));
            }
        });
    }
}

customElements.define("last-known-location-card", LastKnownLocationCard);

window.customCards = window.customCards || [];
window.customCards.push({
    type: "last-known-location-card",
    name: "Last Known Location Card",
    description: localize("card.description"),
});
