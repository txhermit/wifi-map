"use strict";

// wifi-map: live offline map of Wi-Fi devices for the Kismet WebUI.
// Polls the generic devices REST endpoint (same family as probe-dashboard),
// plots IEEE80211 devices at their average GPS position, clustered.
// Map tiles come from httpd/tiles/ served by Kismet itself - no internet.

var local_uri_prefix = "";
if (typeof(KISMET_URI_PREFIX) !== 'undefined')
    local_uri_prefix = KISMET_URI_PREFIX;

var PLUGIN_BASE = local_uri_prefix + 'plugin/wifi-map/';

var POLL_MS = 5000;          // live update interval
var PRIME_WINDOW_SEC = 86400; // first activation: pull last 24h of devices
var STALE_SEC = 900;          // drop markers unseen for 15 min
var MAX_ZOOM = 16;            // must match the deepest zoom generated into httpd/tiles/

var FALLBACK_CENTER = [29.4241, -98.4936]; // San Antonio, used when no GPS fix

var map = null;
var cluster = null;
var markers = {};  // device key -> { marker, last_seen }
var pollTimer = -1;
var primed = false;

// Field-simplified device poll. Aliased signal keeps the payload small.
var FIELDS = [
    "kismet.device.base.key",
    "kismet.device.base.macaddr",
    "kismet.device.base.name",
    "kismet.device.base.phyname",
    "kismet.device.base.first_time",
    "kismet.device.base.last_time",
    "kismet.device.base.channel",
    "kismet.device.base.manuf",
    ["kismet.device.base.signal/kismet.common.signal.last_signal", "last_signal"],
    "kismet.device.base.location",
];

// ---- helpers ----

function esc(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtTime(epochSec) {
    if (!epochSec) return "";
    try {
        return new Date(epochSec * 1000).toLocaleString();
    } catch (e) {
        return String(epochSec);
    }
}

function signalColor(s) {
    s = Number(s);
    if (!Number.isFinite(s)) return "#888888";
    if (s >= -50) return "#2ecc71";
    if (s >= -65) return "#a3e635";
    if (s >= -80) return "#facc15";
    return "#ef4444";
}

function setStatus(msg) {
    var el = document.getElementById("wifimap-status");
    if (el) el.textContent = msg;
}

// ---- leaflet loading ----
// Kismet ships leaflet.js itself; markercluster is vendored in this plugin.
// Load serially so L.markerClusterGroup exists before we build the map.
function loadScripts(cb) {
    if (typeof(L) === "undefined") {
        $.getScript(local_uri_prefix + "js/leaflet.js").done(function() { loadScripts(cb); });
        return;
    }
    if (typeof(L.markerClusterGroup) === "undefined") {
        $.getScript(PLUGIN_BASE + "js/leaflet.markercluster.js").done(function() { loadScripts(cb); });
        return;
    }
    cb();
}

function initMap() {
    if (map != null)
        return;

    map = L.map("wifi_map", { zoomControl: true });

    // Offline tiles, served by Kismet from this plugin's httpd/tiles/.
    L.tileLayer(PLUGIN_BASE + "tiles/{z}/{x}/{y}.png", {
        minZoom: 0,
        maxZoom: MAX_ZOOM,
        attribution: "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors",
    }).addTo(map);

    cluster = L.markerClusterGroup({
        maxClusterRadius: 60,
        disableClusteringAtZoom: 15,
    });
    map.addLayer(cluster);

    // Center on the live GPS position; fall back to San Antonio.
    $.get(local_uri_prefix + "gps/location.json")
        .done(function(d) {
            try {
                var gp = d["kismet.common.location.geopoint"];
                if (gp && gp[1] && gp[0]) {
                    map.setView([gp[1], gp[0]], 13);
                    return;
                }
            } catch (e) { /* fall through */ }
            map.setView(FALLBACK_CENTER, 11);
        })
        .fail(function() {
            map.setView(FALLBACK_CENTER, 11);
        });
}

// ---- device handling ----

function devicePos(rec) {
    var loc = rec["kismet.device.base.location"];
    if (!loc) return null;
    var avg = loc["kismet.common.location.avg_loc"];
    if (!avg) return null;
    var gp = avg["kismet.common.location.geopoint"];
    if (!gp || !gp[1] || !gp[0]) return null;
    return [gp[1], gp[0]]; // geopoint is [lon, lat]
}

function popupHtml(rec) {
    var sig = rec["last_signal"];
    return "<b>" + esc(rec["kismet.device.base.name"] || "(no SSID)") + "</b><br>" +
        "MAC: " + esc(rec["kismet.device.base.macaddr"] || "") + "<br>" +
        (rec["kismet.device.base.manuf"] ? "Vendor: " + esc(rec["kismet.device.base.manuf"]) + "<br>" : "") +
        "Signal: " + (sig == null ? "n/a" : esc(sig) + " dBm") + "<br>" +
        "Channel: " + esc(rec["kismet.device.base.channel"] || "n/a") + "<br>" +
        "Last seen: " + esc(fmtTime(rec["kismet.device.base.last_time"]));
}

function upsertDevice(rec) {
    if (rec["kismet.device.base.phyname"] !== "IEEE80211")
        return;

    var key = rec["kismet.device.base.key"];
    if (!key) return;

    var pos = devicePos(rec);
    if (!pos) return; // no GPS fix for this device yet

    var lastSeen = rec["kismet.device.base.last_time"] || 0;
    var sig = rec["last_signal"];
    var color = signalColor(sig);

    if (key in markers) {
        var m = markers[key];
        m.marker.setLatLng(pos);
        m.marker.setStyle({ color: color, fillColor: color });
        m.marker.setPopupContent(popupHtml(rec));
        m.last_seen = lastSeen;
        return;
    }

    var marker = L.circleMarker(pos, {
        radius: 7,
        color: color,
        fillColor: color,
        fillOpacity: 0.7,
        weight: 2,
    });
    marker.bindPopup(popupHtml(rec));
    cluster.addLayer(marker);
    markers[key] = { marker: marker, last_seen: lastSeen };
}

function sweepStale() {
    var now = Math.floor(Date.now() / 1000);
    var dropped = 0;
    for (var key in markers) {
        if (now - markers[key].last_seen > STALE_SEC) {
            cluster.removeLayer(markers[key].marker);
            delete markers[key];
            dropped++;
        }
    }
    return dropped;
}

function pollMap() {
    // Only poll while the tab is actually visible, like the ADSB tab does.
    if (typeof(kismet_ui) !== "undefined" && !kismet_ui.window_visible) {
        pollTimer = setTimeout(pollMap, POLL_MS);
        return;
    }
    if ($("#wifi_map").is(":hidden")) {
        pollTimer = setTimeout(pollMap, POLL_MS);
        return;
    }

    var since = primed ? 10 : PRIME_WINDOW_SEC;

    $.post(local_uri_prefix + "devices/last-time/-" + since + "/devices.json", {
        json: JSON.stringify({ fields: FIELDS }),
    })
    .done(function(devs) {
        try {
            var list = (typeof(kismet) !== "undefined" && kismet.sanitizeObject)
                ? kismet.sanitizeObject(devs)
                : devs;
            for (var i = 0; i < list.length; i++)
                upsertDevice(list[i]);
            primed = true;
            sweepStale();
            setStatus(Object.keys(markers).length + " devices on map");
        } catch (e) {
            console.error("wifi-map: poll parse", e);
        }
    })
    .fail(function() {
        setStatus("Poll failed - will retry");
    })
    .always(function() {
        if (pollTimer !== -1)
            clearTimeout(pollTimer);
        pollTimer = setTimeout(pollMap, POLL_MS);
    });
}

// ---- tab ----

$('<link>')
    .attr({ type: "text/css", rel: "stylesheet", href: local_uri_prefix + "css/leaflet.css" })
    .appendTo("head");
$('<link>')
    .attr({ type: "text/css", rel: "stylesheet", href: PLUGIN_BASE + "css/MarkerCluster.Default.css" })
    .appendTo("head");
$('<link>')
    .attr({ type: "text/css", rel: "stylesheet", href: PLUGIN_BASE + "css/wifi_map.css" })
    .appendTo("head");

try {
    if (typeof(kismet_ui_tabpane) !== "undefined") {
        kismet_ui_tabpane.AddTab({
            id: "wifi_map",
            tabTitle: "WiFi Map",
            expandable: false,
            createCallback: function(div) {
                div.html(
                    '<div id="wifimap-holder">' +
                    '<div id="wifi_map"></div>' +
                    '<div id="wifimap-bar"><span id="wifimap-status">Loading map...</span>' +
                    '<span id="wifimap-legend">' +
                    '<i style="background:#2ecc71"></i>&ge;-50 ' +
                    '<i style="background:#a3e635"></i>-65 ' +
                    '<i style="background:#facc15"></i>-80 ' +
                    '<i style="background:#ef4444"></i>weaker (dBm)</span></div>' +
                    "</div>"
                );
                loadScripts(function() {
                    initMap();
                    setStatus("Map ready - waiting for devices");
                });
            },
        }, "center");
    } else {
        console.warn("wifi-map: kismet_ui_tabpane not available");
    }
} catch (e) {
    console.error("wifi-map: init", e);
}

pollTimer = setTimeout(pollMap, 2000);

export const load_complete = 1;
