"use strict";

// wifi-map: live offline map of Wi-Fi devices for the Kismet WebUI.
//
// Plots IEEE 802.11 devices at their average GPS position on locally
// served tiles (httpd/tiles/, no internet). APs, clients and other
// types get their own toggleable layers; the rig's GPS position is
// tracked with an auto-follow toggle.
//
// Data: generic devices REST endpoint (field-simplified, server-side
// phyname regex), same family probe-dashboard uses.

var local_uri_prefix = "";
if (typeof(KISMET_URI_PREFIX) !== 'undefined')
    local_uri_prefix = KISMET_URI_PREFIX;

var PLUGIN_BASE = local_uri_prefix + 'plugin/wifi-map/';

var POLL_MS = 3000;           // device poll interval
var GPS_POLL_MS = 3000;       // GPS poll interval
var PRIME_WINDOW_SEC = 86400; // first poll: pull the whole session
var STALE_SEC = 900;          // drop markers unseen for 15 min
var MAX_ZOOM = 16;            // must match deepest zoom in httpd/tiles/
var PHYNAME = "IEEE802.11";   // Kismet Wi-Fi phy name (with the dot)

var FALLBACK_CENTER = [29.4241, -98.4936]; // San Antonio

var map = null;
var mapReady = false;
var layers = { ap: null, client: null, other: null };
var markers = {};   // device key -> { marker, layer, last_seen }
var gpsMarker = null;
var autoFollow = true;
var pollTimer = -1;
var gpsTimer = -1;
var primed = false;
var useRegex = true; // cleared if the server rejects the regex filter

// Marker styling by Kismet device type
var TYPE_STYLE = {
    "Wi-Fi AP":      { color: "#2ecc71", radius: 7, layer: "ap" },
    "Wi-Fi Client":  { color: "#3498db", radius: 5, layer: "client" },
    "Wi-Fi Bridged": { color: "#9b59b6", radius: 6, layer: "other" },
    "Wi-Fi Ad-Hoc":  { color: "#e67e22", radius: 6, layer: "other" },
};
var DEFAULT_STYLE = { color: "#95a5a6", radius: 5, layer: "other" };

var FIELDS = [
    "kismet.device.base.key",
    "kismet.device.base.macaddr",
    "kismet.device.base.commonname",
    "kismet.device.base.phyname",
    "kismet.device.base.type",
    "kismet.device.base.channel",
    "kismet.device.base.crypt",
    "kismet.device.base.first_time",
    "kismet.device.base.last_time",
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

function setStatus(msg) {
    var el = document.getElementById("wifimap-status");
    if (el) el.textContent = msg;
}

// ---- map setup ----

function loadLeaflet(cb) {
    if (typeof(L) === "undefined") {
        $.getScript(local_uri_prefix + "js/leaflet.js").done(function() { loadLeaflet(cb); });
        return;
    }
    cb();
}

function setAutoFollow(state) {
    autoFollow = state;
    var btn = document.getElementById("gps-follow-btn");
    if (btn) {
        btn.classList.toggle("active", autoFollow);
        btn.innerHTML = autoFollow ? "GPS Lock: ON" : "GPS Lock: OFF";
    }
    if (autoFollow && gpsMarker && map)
        map.panTo(gpsMarker.getLatLng());
}

function initMap() {
    if (mapReady)
        return;

    // preferCanvas keeps thousands of circleMarkers fast
    map = L.map("wifi_map", { preferCanvas: true });

    L.tileLayer(PLUGIN_BASE + "tiles/{z}/{x}/{y}.png", {
        minZoom: 0,
        maxZoom: MAX_ZOOM,
        attribution: "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors",
    }).addTo(map);

    layers.ap = L.layerGroup().addTo(map);
    layers.client = L.layerGroup().addTo(map);
    layers.other = L.layerGroup().addTo(map);

    L.control.layers(null, {
        "Access Points": layers.ap,
        "Clients": layers.client,
        "Bridged / Ad-Hoc / Other": layers.other,
    }, { collapsed: false }).addTo(map);

    var FollowControl = L.Control.extend({
        options: { position: "topleft" },
        onAdd: function() {
            var btn = L.DomUtil.create("div", "kismet-map-ctrl active");
            btn.id = "gps-follow-btn";
            btn.innerHTML = "GPS Lock: ON";
            L.DomEvent.disableClickPropagation(btn);
            L.DomEvent.on(btn, "click", function() { setAutoFollow(!autoFollow); });
            return btn;
        }
    });
    map.addControl(new FollowControl());

    // Dragging the map disengages follow, like any nav app
    map.on("dragstart", function() {
        if (autoFollow)
            setAutoFollow(false);
    });

    // Center on live GPS, fall back to San Antonio
    $.getJSON(local_uri_prefix + "gps/location.json")
        .done(function(d) {
            var gp = d["kismet.common.location.geopoint"];
            if (gp && gp[1] && gp[0])
                map.setView([gp[1], gp[0]], 13);
            else
                map.setView(FALLBACK_CENTER, 11);
        })
        .fail(function() {
            map.setView(FALLBACK_CENTER, 11);
        });

    mapReady = true;
    pollGps();
    pollDevices();
}

// ---- GPS rig marker ----

function pollGps() {
    if (gpsTimer !== -1)
        clearTimeout(gpsTimer);

    var visible = (typeof(kismet_ui) === "undefined" || kismet_ui.window_visible) &&
                  !$("#wifi_map").is(":hidden");

    if (visible && mapReady) {
        // /gps/location.json returns a full location triplet:
        // geopoint [lon, lat], fix, alt (meters), speed (kph)
        $.getJSON(local_uri_prefix + "gps/location.json")
            .done(function(data) {
                try {
                    var loc = data["kismet.common.location.geopoint"];
                    var fix = data["kismet.common.location.fix"] || 0;
                    if (loc && fix >= 2 && (loc[0] !== 0 || loc[1] !== 0)) {
                        var lat = loc[1], lon = loc[0];
                        var mph = (Number(data["kismet.common.location.speed"]) || 0) * 0.621371;
                        var ft = (Number(data["kismet.common.location.alt"]) || 0) * 3.28084;
                        var html = "<b>Sensor Rig GPS</b><br>" +
                            "Fix: " + esc(fix) + "D<br>" +
                            "Speed: " + esc(mph.toFixed(1)) + " mph<br>" +
                            "Alt: " + esc(ft.toFixed(0)) + " ft";

                        if (!gpsMarker) {
                            gpsMarker = L.circleMarker([lat, lon], {
                                radius: 8,
                                fillColor: "#e74c3c",
                                color: "#ffffff",
                                weight: 3,
                                opacity: 1,
                                fillOpacity: 1,
                            }).addTo(map).bindPopup(html);
                        } else {
                            gpsMarker.setLatLng([lat, lon]);
                            gpsMarker.setPopupContent(html);
                            gpsMarker.bringToFront();
                        }

                        if (autoFollow)
                            map.panTo([lat, lon]);
                    }
                } catch (e) {
                    console.error("wifi-map: gps parse", e);
                }
            });
    }

    gpsTimer = setTimeout(pollGps, GPS_POLL_MS);
}

// ---- Wi-Fi devices ----

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
    var name = rec["kismet.device.base.commonname"] ||
               (rec["kismet.device.base.type"] === "Wi-Fi Client"
                   ? "(unassociated client)" : "(hidden SSID)");
    return "<b>" + esc(name) + "</b><br>" +
        "MAC: <code>" + esc(rec["kismet.device.base.macaddr"] || "") + "</code><br>" +
        "Type: " + esc(rec["kismet.device.base.type"] || "") + "<br>" +
        "Ch: " + esc(rec["kismet.device.base.channel"] || "?") +
        " | Crypt: " + esc(rec["kismet.device.base.crypt"] || "None") + "<br>" +
        "Signal: " + (sig == null ? "n/a" : esc(sig) + " dBm") + "<br>" +
        "Last seen: " + esc(fmtTime(rec["kismet.device.base.last_time"]));
}

function upsertDevice(rec, nowSec) {
    // Client-side belt-and-braces; the server regex should already filter.
    if (rec["kismet.device.base.phyname"] !== PHYNAME)
        return;

    var key = rec["kismet.device.base.key"];
    if (!key) return;

    var pos = devicePos(rec);
    if (!pos) return; // no GPS fix for this device yet

    var lastSeen = rec["kismet.device.base.last_time"] || 0;
    var st = TYPE_STYLE[rec["kismet.device.base.type"]] || DEFAULT_STYLE;
    var target = layers[st.layer];

    if (key in markers) {
        var m = markers[key];
        // Move between layers if the type changed (client -> AP, etc.)
        if (m.layer !== target) {
            m.layer.removeLayer(m.marker);
            target.addLayer(m.marker);
            m.layer = target;
        }
        m.marker.setLatLng(pos);
        m.marker.setPopupContent(popupHtml(rec));
        m.last_seen = lastSeen;
        return;
    }

    var marker = L.circleMarker(pos, {
        radius: st.radius,
        fillColor: st.color,
        color: "#002b36",
        weight: 1.5,
        opacity: 0.9,
        fillOpacity: 0.85,
    }).bindPopup(popupHtml(rec));

    target.addLayer(marker);
    markers[key] = { marker: marker, layer: target, last_seen: lastSeen };
}

function sweepStale(nowSec) {
    for (var key in markers) {
        if (nowSec - markers[key].last_seen > STALE_SEC) {
            markers[key].layer.removeLayer(markers[key].marker);
            delete markers[key];
        }
    }
}

function pollDevices() {
    if (pollTimer !== -1)
        clearTimeout(pollTimer);

    var visible = (typeof(kismet_ui) === "undefined" || kismet_ui.window_visible) &&
                  !$("#wifi_map").is(":hidden");

    if (visible && mapReady) {
        var since = primed ? 10 : PRIME_WINDOW_SEC;
        var body = { fields: FIELDS };
        if (useRegex)
            body.regex = [["kismet.device.base.phyname", "^IEEE802\\.11$"]];

        $.post(local_uri_prefix + "devices/last-time/-" + since + "/devices.json", {
            json: JSON.stringify(body),
        })
        .done(function(devs) {
            try {
                var list = (typeof(kismet) !== "undefined" && kismet.sanitizeObject)
                    ? kismet.sanitizeObject(devs)
                    : devs;
                var nowSec = Math.floor(Date.now() / 1000);
                for (var i = 0; i < list.length; i++)
                    upsertDevice(list[i], nowSec);
                primed = true;
                sweepStale(nowSec);
                setStatus(Object.keys(markers).length + " devices on map");
            } catch (e) {
                console.error("wifi-map: poll parse", e);
            }
        })
        .fail(function(jqXHR) {
            // No-PCRE builds reject the regex filter; fall back to
            // unfiltered polls (client-side phyname check still applies).
            if (jqXHR && jqXHR.status === 400 && useRegex) {
                useRegex = false;
                pollTimer = setTimeout(pollDevices, 500);
                return;
            }
            setStatus("Poll failed - will retry");
        })
        .always(function() {
            if (pollTimer !== -1)
                clearTimeout(pollTimer);
            pollTimer = setTimeout(pollDevices, POLL_MS);
        });
    } else {
        pollTimer = setTimeout(pollDevices, POLL_MS);
    }
}

// ---- tab ----

$('<link>')
    .attr({ type: "text/css", rel: "stylesheet", href: local_uri_prefix + "css/leaflet.css" })
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
            priority: -100,
            createCallback: function(div) {
                div.html(
                    '<div id="wifimap-holder">' +
                    '<div id="wifi_map"></div>' +
                    '<div id="wifimap-bar"><span id="wifimap-status">Opening map...</span>' +
                    '<span id="wifimap-legend">' +
                    '<i style="background:#2ecc71"></i>AP ' +
                    '<i style="background:#3498db"></i>Client ' +
                    '<i style="background:#9b59b6"></i>Bridged ' +
                    '<i style="background:#e67e22"></i>Ad-Hoc ' +
                    '<i style="background:#95a5a6"></i>Other</span></div>' +
                    "</div>"
                );
            },
            activateCallback: function() {
                // Init on first activation so Leaflet gets a real container
                // size; re-assert size on every activation.
                loadLeaflet(function() {
                    initMap();
                    setTimeout(function() { map.invalidateSize(); }, 200);
                });
            },
        }, "center");
    } else {
        console.warn("wifi-map: kismet_ui_tabpane not available");
    }
} catch (e) {
    console.error("wifi-map: init", e);
}

export const load_complete = 1;
