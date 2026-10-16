# Offline map tiles

This directory holds pre-rendered XYZ raster tiles at
`{z}/{x}/{y}.png`. The plugin's Leaflet map loads them from
`/plugin/wifi-map/tiles/...`, served by Kismet itself — no tile
server, no internet.

Tiles are intentionally NOT committed to git (see `../.gitignore`).
A few hundred MB of PNGs makes every clone miserable. Instead:

1. Generate once with **Mobile Atlas Creator** (MOBAC):
   - map source: any OSM raster layer
   - draw a bbox around San Antonio + your wardriving corridors
   - zooms 12–16 for detail, 0–11 for zoom-out context
   - export format: "directory tiles" straight into this folder
2. Or ship a region tarball as a **GitHub release asset**
   (e.g. `wifi-map-tiles-sa16.tar.gz`) and unpack it here:
   `tar xzf wifi-map-tiles-sa16.tar.gz -C httpd/tiles`
3. Restart Kismet after adding tiles (plugins are scanned at startup).

`MAX_ZOOM` in `httpd/js/wifi_map.js` must match the deepest zoom
level you generated.
