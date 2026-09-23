# Advanced Configuration

This document covers advanced YAML-only configuration options for the Last Known Location Card. These options are not available through the GUI editor — switch to the YAML editor to use them.

## Entity object syntax

Each item in the `entity` list can be a plain string (entity ID) or an object. The object form lets you set a per-entity `color`.

### Object properties

| Property          | Required | Description                                                                                                                                                          |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entity`          | **Yes**  | The `device_tracker` or `person` entity ID.                                                                                                                          |
| `color`           | No       | An override color code (like `#ff0000`, `red`, or `var(--orange-color)`) specifically for this entity. Overrides global map display `colors` array.                  |

### Examples

**Simple — all entities as strings (works in GUI and YAML):**

```yaml
type: custom:last-known-location-card
entity:
    - person.alice
    - person.bob
```

**Object form — per-entity color:**

```yaml
type: custom:last-known-location-card
entity:
    - entity: person.alice
      color: "#e91e63"
    - entity: person.bob
      color: "#2196f3"
```

**Mixed — strings and objects together:**

```yaml
type: custom:last-known-location-card
entity:
    - person.alice
    - entity: person.bob
      color: "#2196f3"
```

### GUI editor behavior

When entity objects are detected in the configuration, the GUI editor is automatically disabled and the card switches to YAML mode. To return to the GUI editor, convert all entity items back to plain strings.

## Base map

The card draws the base map the same way Home Assistant's own map does since 2026.9: [Shortbread vector tiles](https://vector.openstreetmap.org/) from the OpenStreetMap Foundation, rendered with MapLibre GL. The style, glyphs and sprites are the ones Home Assistant serves at `/static/map/`, and tile requests go through Home Assistant's tile proxy with its rotating access token, so no API key is needed. Dark mode uses a real dark style instead of an inverted light one.

The card falls back to raster tiles when those assets are missing (Home Assistant older than 2026.9) or when the browser has no WebGL2. That fallback is CARTO's raster service, which watermarks tiles requested without an API key. Two ways out on an older Home Assistant:

| Property          | Default | Description                                                                                          |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `map_tile_url`    | `null`  | Raster tile URL template for the fallback base map. Only used when vector tiles are unavailable.     |
| `map_attribution` | `null`  | Attribution shown for a custom `map_tile_url`. Defaults to OpenStreetMap.                            |

```yaml
# Your own free CARTO key (https://carto.com/basemaps/apikey)
map_tile_url: https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=YOUR_KEY
```

```yaml
# Or any other raster tile server
map_tile_url: https://tile.example.org/{z}/{x}/{y}.png
map_attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
```
