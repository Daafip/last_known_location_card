# Advanced Configuration

This document covers advanced YAML-only configuration options for the Last Known Location Card. These options are not available through the GUI editor — switch to the YAML editor to use them.

## Entity object syntax

Each item in the `entity` list can be a plain string (entity ID) or an object. The object form lets you attach an `activity_entity` directly to a specific tracked entity.

### Object properties

| Property          | Required | Description                                                                                                                                                          |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entity`          | **Yes**  | The `device_tracker` or `person` entity ID.                                                                                                                          |
| `activity_entity` | No       | A `sensor` entity that tracks the current activity (e.g. walking, running, cycling). When set, move segments are tagged with the resolved activity icon.             |
| `color`           | No       | An override color code (like `#ff0000`, `red`, or `var(--orange-color)`) specifically for this entity. Overrides global map display `colors` array.                  |

### Examples

**Simple — all entities as strings (works in GUI and YAML):**

```yaml
type: custom:last-known-location-card
entity:
    - person.alice
    - person.bob
```

**Object form — per-entity activity sensor and color:**

```yaml
type: custom:last-known-location-card
entity:
    - entity: person.alice
      activity_entity: sensor.alice_activity
      color: "#e91e63"
    - entity: person.bob
      activity_entity: sensor.bob_activity
      color: "#2196f3"
```

**Mixed — strings and objects together:**

```yaml
type: custom:last-known-location-card
entity:
    - person.alice
    - entity: person.bob
      activity_entity: sensor.bob_activity
```

## Activity Icons

When an `activity_entity` is provided, the card displays the current activity for "move" segments. You can customize the icons used for these activities using the `activity_icon_map` option.

### `activity_icon_map`

This is an object where keys are activity names (as reported by your activity sensor) and values are MDI icons.

| Property            | Type   | Description                                                                                               |
| ------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `activity_icon_map` | object | A map of activity names to icon strings (e.g., `walking: mdi:walk`). Falls back to zone icons or default. |

**Example:**

```yaml
type: custom:last-known-location-card
entity:
    - entity: person.alice
      activity_entity: sensor.alice_activity
activity_icon_map:
    Walking: mdi:walk
    Running: mdi:run
    Cycling: mdi:bike
    "In car": mdi:car
```

### GUI editor behavior

When entity objects are detected in the configuration, the GUI editor is automatically disabled and the card switches to YAML mode. To return to the GUI editor, convert all entity items back to plain strings.
