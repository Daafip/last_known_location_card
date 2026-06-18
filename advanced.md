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
