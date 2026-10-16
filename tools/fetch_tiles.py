#!/usr/bin/env python3
"""Fetch offline XYZ raster tiles into httpd/tiles/{z}/{x}/{y}.png.

Politely: max 2 download threads and an identifying User-Agent, per the
OSMF tile usage policy. One-time regional pull, skips tiles already on
disk (resume-safe), validates PNG magic.

Usage:
    python3 tools/fetch_tiles.py [outdir]
Default outdir: ./httpd/tiles
"""

import math
import os
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

UA = "wifi-map-offline-tiles/0.1 (+https://github.com/txhermit/wifi-map)"
BASE = "https://tile.openstreetmap.org"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# San Antonio metro + margin
MIN_LON, MIN_LAT, MAX_LON, MAX_LAT = -98.8, 29.2, -98.2, 29.65
ZOOMS = range(5, 17)          # detail levels for the bbox
WORLD_ZOOMS = range(0, 5)     # full world, so zoom-out isn't blank


def deg2num(lat_deg, lon_deg, zoom):
    n = 2.0 ** zoom
    xtile = int((lon_deg + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat_deg)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return xtile, ytile


def tile_list():
    jobs = []
    for z in WORLD_ZOOMS:
        n = 2 ** z
        for x in range(n):
            for y in range(n):
                jobs.append((z, x, y))
    for z in ZOOMS:
        x0, y0 = deg2num(MAX_LAT, MIN_LON, z)
        x1, y1 = deg2num(MIN_LAT, MAX_LON, z)
        for x in range(min(x0, x1), max(x0, x1) + 1):
            for y in range(min(y0, y1), max(y0, y1) + 1):
                jobs.append((z, x, y))
    return jobs


def valid_png(path):
    try:
        if os.path.getsize(path) < 100:
            return False
        with open(path, "rb") as f:
            return f.read(8) == PNG_MAGIC
    except OSError:
        return False


def fetch(job, outdir, stats):
    z, x, y = job
    path = os.path.join(outdir, str(z), str(x), "%d.png" % y)
    if valid_png(path):
        stats["cached"] += 1
        return

    url = "%s/%d/%d/%d.png" % (BASE, z, x, y)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            if data[:8] != PNG_MAGIC:
                stats["bad"] += 1
                return
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(data)
            stats["ok"] += 1
            return
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(4 * (attempt + 1))
                continue
            if e.code in (403, 401):
                stats["blocked"] += 1
                return
            stats["failed"] += 1
            return
        except Exception:
            time.sleep(2 * (attempt + 1))
    stats["failed"] += 1


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "httpd", "tiles")
    outdir = os.path.abspath(outdir)

    jobs = tile_list()
    print("tiles to consider: %d -> %s" % (len(jobs), outdir), flush=True)

    stats = {"ok": 0, "cached": 0, "bad": 0, "failed": 0, "blocked": 0}
    done = [0]

    def work(job):
        fetch(job, outdir, stats)
        done[0] += 1
        if done[0] % 500 == 0:
            print("  %d/%d  ok=%d cached=%d failed=%d blocked=%d" % (
                done[0], len(jobs), stats["ok"], stats["cached"],
                stats["failed"], stats["blocked"]), flush=True)
        if stats["blocked"] > 20:
            raise RuntimeError("tile server is blocking us; stopping")

    # OSMF policy: max 2 download threads, identifying User-Agent.
    with ThreadPoolExecutor(max_workers=2) as ex:
        try:
            list(ex.map(work, jobs))
        except RuntimeError as e:
            print("ABORT:", e, flush=True)

    print("done: %s" % stats, flush=True)
    if stats["blocked"] > 20:
        sys.exit(3)


if __name__ == "__main__":
    main()
