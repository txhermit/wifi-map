# Offline map tiles

This directory holds pre-rendered XYZ raster tiles at
`{z}/{x}/{y}.png`. The plugin's Leaflet map loads them from
`/plugin/wifi-map/tiles/...`, served by Kismet itself — no tile
server, no internet.

Tiles are intentionally NOT committed to git (see `../.gitignore`).
A few hundred MB of PNGs makes every clone miserable. Instead:

## Option A — Mobile Atlas Creator (easiest)

1. Install Java 17+ and grab MOBAC from https://mobac.sourceforge.io/
   (`java -jar Mobile_Atlas_Creator.jar`).
2. Map source: **OpenStreetMap Mapnik** (built in; if your MOBAC
   build gutted the bundled sources, add the custom XML below to
   the `mapsources/` folder and restart MOBAC).
3. **Atlas → New Atlas**, format: **OSMTracker tile storage** —
   this is the one that produces plain `{z}/{x}/{y}.png` folders.
4. Go to San Antonio (29.42, -98.49), drag a selection box around
   the metro + your corridors at the lowest zoom you want, tick
   zooms **12–16** (plus 0–11 for zoom-out context; z0–4 is only
   341 tiles total).
5. **Add Selection → Create Atlas**. ~15k tiles for the metro at
   12–16; MOBAC throttles politely, give it time.
6. Copy the `{z}/` folders from the atlas output
   (`atlases/<name>_<date>/<layer>/`) into this directory.
7. `make install` (or `make userinstall`), restart Kismet.

`MAX_ZOOM` in `httpd/js/wifi_map.js` must be >= the deepest zoom
you generated (default 16).

Custom map source XML (`mapsources/osm.xml`) if needed:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<customMapSource>
  <name>OSM Standard</name>
  <minZoom>0</minZoom>
  <maxZoom>19</maxZoom>
  <tileType>png</tileType>
  <url>https://tile.openstreetmap.org/{$z}/{$x}/{$y}.png</url>
  <tileUpdate>None</tileUpdate>
  <backgroundColor>#000000</backgroundColor>
</customMapSource>
```

Respect the tile server's usage policy: one-time pull, low thread
count (MOBAC defaults are sane — leave them alone).

## Option B — release asset

Ship a region tarball as a GitHub release asset
(e.g. `wifi-map-tiles-sa16.tar.gz`) and unpack it here:

```sh
tar xzf wifi-map-tiles-sa16.tar.gz -C httpd/tiles
```

## Option C — headless script

`tools/fetch_tiles.py` downloads the San Antonio set directly
(2 threads, identifying User-Agent, resume-safe). Note: as of
2026-10-15, tile.openstreetmap.org soft-blocks datacenter IPs —
run it from a residential connection or point it at another
tile source.
