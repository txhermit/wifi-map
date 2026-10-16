# wifi-map

A Kismet WebUI plugin that adds a **WiFi Map** tab: a live Leaflet map of
IEEE 802.11 devices at their average GPS position, rendered from
**offline tiles** — no internet required. Built for wardriving.

This is a pure web-UI plugin (JavaScript only, no compiled component),
in the same shape as
[probe-dashboard](https://github.com/txhermit/probe-dashboard).
The map rendering pattern is adapted from Kismet's built-in ADSB Live
tab (`http_data/js/kismet.ui.adsb.js`); the data feed is the generic
Kismet devices REST API instead of the ADSB-specific C++ endpoint.

## What it does

- Polls `devices/last-time/.../devices.json` (field-simplified, same
  endpoint family probe-dashboard uses) and plots Wi-Fi devices at
  `kismet.device.base.location` → `kismet.common.location.avg_loc`.
- Markers are clustered with vendored `leaflet.markercluster` and
  colored by signal strength (green ≥ −50 dBm → red < −80 dBm).
- Click a marker for SSID, MAC, vendor, signal, channel, last-seen.
- Markers unseen for 15 minutes are swept; polling pauses when the tab
  is hidden.
- Tiles load from `httpd/tiles/{z}/{x}/{y}.png`, served by Kismet
  itself under `/plugin/wifi-map/tiles/...`. Zero tile server, zero
  internet, zero CORS.

## Install

Kismet scans plugins **at startup only**, in the system plugin dir and
in `~/.kismet/plugins/` **of the user Kismet runs as**. If you run
Kismet as root, a user-dir install is invisible — install system-wide.

```sh
git clone https://github.com/txhermit/wifi-map.git
cd wifi-map

# Kismet runs as root (normal wardriving case):
sudo make install

# ...or Kismet runs as your user:
make userinstall
```

Then add offline tiles (see `httpd/tiles/README.md`) and restart Kismet.

`make uninstall` / `make useruninstall` remove it. Nothing compiles,
so it survives Kismet upgrades without rebuilding.

## Offline tiles

Tiles are not committed to this repo — see `httpd/tiles/README.md`.
Generate a set with Mobile Atlas Creator, or unpack a region tarball
shipped as a GitHub release asset into `httpd/tiles/`.

## Layout

```
manifest.conf            plugin manifest (js= module, relative path)
Makefile                 install / userinstall / uninstall
httpd/
  js/wifi_map.js         the tab: polling, clustering, popups
  js/leaflet.markercluster.js   vendored (Kismet ships Leaflet itself)
  css/wifi_map.css
  css/MarkerCluster.Default.css  vendored
  tiles/                 offline XYZ tiles (gitignored, see README inside)
```

## License

GPL-2.0-or-later, to stay compatible with the Kismet code this plugin's
map pattern is derived from. Kismet © Mike Kershaw / kismetwireless.
