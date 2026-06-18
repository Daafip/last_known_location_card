import {localize} from "./localize/localize.js";

export function formatDate(date, locale = null) {
    if (locale) {
        try {
            return new Intl.DateTimeFormat(locale.language, {
                weekday: "short",
                year: "numeric",
                month: "short",
                day: "numeric",
            }).format(date);
        } catch {}
    }
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

export function today() {
    return startOfDay(new Date());
}

export function isToday(date) {
    if (!date) return false;
    return startOfDay(date)?.getTime() === today().getTime();
}

export function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function endOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

export function haversineMeters(a, b) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const r = 6371000;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const sin1 = Math.sin(dLat / 2);
    const sin2 = Math.sin(dLon / 2);
    const c =
        2 *
        Math.atan2(
            Math.sqrt(sin1 * sin1 + Math.cos(lat1) * Math.cos(lat2) * sin2 * sin2),
            Math.sqrt(1 - (sin1 * sin1 + Math.cos(lat1) * Math.cos(lat2) * sin2 * sin2)),
        );
    return r * c;
}

export function toLatLon(point) {
    return {lat: point.point[0], lon: point.point[1]};
}

export function toPoint(state) {
    const attrs = state.a || {};
    let lat = Number(attrs.latitude);
    let lon = Number(attrs.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {point: [lat, lon], timestamp: new Date(state.lu * 1000)};
}

export function getTrackColor(index, colors = [], specificColor = null) {
    if (specificColor) {
        return specificColor;
    }

    if (colors.length) {
        return colors[index % colors.length];
    }

    if (index === 0) {
        return "var(--primary-color)";
    }
    return `var(--color-${((index + 1) % 12) + 1})`;
}

export function escapeHtml(text) {
    if (!text) return "";
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function normalizeList(value) {
    if (!value) return [];
    const list = Array.isArray(value) ? value : [value];
    return list.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

export function normalizeEntityEntries(config) {
    const value = config.entity;
    if (!value) return [];
    const list = Array.isArray(value) ? value : [value];
    return list
        .map((item) => {
            if (typeof item === "string") {
                const trimmed = item.trim();
                return trimmed ? {entity: trimmed} : null;
            }
            if (item && typeof item === "object" && typeof item.entity === "string") {
                const entity = item.entity.trim();
                if (!entity) return null;
                const entry = {entity};
                if (typeof item.activity_entity === "string" && item.activity_entity.trim()) {
                    entry.activity_entity = item.activity_entity.trim();
                }
                if (typeof item.color === "string" && item.color.trim()) {
                    entry.color = item.color.trim();
                }
                return entry;
            }
            return null;
        })
        .filter(Boolean);
}

export function formatErrorMessage(err) {
    const message = err && err.message ? String(err.message) : "";
    if (message.toLowerCase().includes("unknown command")) {
        return localize("utils.errors.history_api_unavailable");
    }
    return message || localize("utils.errors.unable_to_load_history");
}

