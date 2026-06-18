# Location Timeline Card (Home Assistant)

Fork of ![Location Timeline Card](https://github.com/konewka17/timeline_card)  but just to show the last location.

## Installation (HACS)

1. Open **HACS → Frontend → ⋮ → Custom repositories**.
2. Add this repository URL.
3. Set category to **Dashboard**.
4. Click **Add**.
5. Find **Location Timeline Card** in HACS Frontend and click **Download**.
6. Restart Home Assistant (or reload frontend resources if prompted).

After installation, ensure the card resource is available in Lovelace (HACS normally registers this automatically).

## Manual installation

1. Download `last_known_location_card.js` from the latest GitHub Release.
2. Copy it to your Home Assistant `www` folder, for example `/config/www/last_known_location_card.js`.
3. Add it as a dashboard resource:

```yaml
url: /local/last_known_location_card.js
type: module
```

4. Refresh your browser cache.

## Usage

Add the card in the Lovelace UI editor or with manual YAML.

### Minimal setup

```yaml
type: custom:last-known-location-card
entity: device_tracker.my_phone
```
