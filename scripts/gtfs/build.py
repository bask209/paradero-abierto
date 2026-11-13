#!/usr/bin/env python3
"""
Builds the compact transit bundle the app reads on the phone, straight from
TransMilenio's open static GTFS. No API key, no server: GitHub Actions runs
this every day and publishes the result on GitHub Pages.

  python3 scripts/gtfs/build.py OUT_DIR [--zip path/to/GTFS.zip]

Output:
  OUT_DIR/transit-v1.json  routes, stops, every stop pattern with its line,
                           the scheduled offset of each stop and the trip
                           start times per service
  OUT_DIR/meta-v1.json     version, feed date, size; the app checks this to
                           know when to download a new bundle
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import math
import os
import sys
import urllib.request
import zipfile
from collections import defaultdict

BUCKET = "https://storage.googleapis.com/gtfs-estaticos"
SCHEMA = 1

SYSTEM_BY_AGENCY = {
    "1": "troncal",
    "2": "alimentador",
    "3": "zonal_urbano",
    "4": "zonal_complementario",
    "5": "zonal_especial",
    "6": "dual",
    "7": "transmicable",
}

M_PER_DEG = 111_320.0


def log(*args: object) -> None:
    print(*args, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- download


def latest_zip(dest: str) -> tuple[str, str]:
    """TransMilenio drops one GTFS_YYYYMMDD.zip a day; take the newest of the last two weeks."""
    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=-5))).date()
    for back in range(15):
        day = (today - dt.timedelta(days=back)).strftime("%Y%m%d")
        url = f"{BUCKET}/GTFS_{day}.zip"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=30) as res:
                if res.status != 200:
                    continue
        except Exception:
            continue
        log("downloading", url)
        with urllib.request.urlopen(url, timeout=600) as res, open(dest, "wb") as out:
            while True:
                chunk = res.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
        return dest, day
    raise SystemExit("no GTFS zip found in the last 15 days")


# ---------------------------------------------------------------- helpers


def rows(z: zipfile.ZipFile, name: str):
    if name not in z.namelist():
        return
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig", newline=""))


def seconds(value: str) -> int | None:
    value = (value or "").strip()
    if not value:
        return None
    h, m, s = value.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    """a, b are (lon, lat)."""
    x = (b[0] - a[0]) * M_PER_DEG * math.cos(math.radians((a[1] + b[1]) / 2))
    y = (b[1] - a[1]) * M_PER_DEG
    return math.hypot(x, y)


def seg_project(p, a, b):
    """Distance from p to segment ab and the fraction along it. Points are (lon, lat)."""
    cos = math.cos(math.radians(p[1]))
    ax, ay = (a[0] - p[0]) * M_PER_DEG * cos, (a[1] - p[1]) * M_PER_DEG
    bx, by = (b[0] - p[0]) * M_PER_DEG * cos, (b[1] - p[1]) * M_PER_DEG
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / l2))
    return math.hypot(ax + t * dx, ay + t * dy), t


def simplify(points: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        worst, far = -1, tolerance
        for i in range(first + 1, last):
            d, _ = seg_project(points[i], points[first], points[last])
            if d > far:
                worst, far = i, d
        if worst > 0:
            keep[worst] = True
            stack.append((first, worst))
            stack.append((worst, last))
    return [p for p, k in zip(points, keep) if k]


def encode_polyline(points: list[tuple[float, float]]) -> str:
    """Google polyline, precision 5, points given as (lon, lat), encoded lat first."""
    out = []
    plat = plon = 0
    for lon, lat in points:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def measure(points):
    along = [0.0]
    for i in range(1, len(points)):
        along.append(along[-1] + metres(points[i - 1], points[i]))
    return along


def stop_distances(line, along, stops):
    """Metres along the line of each stop, walking forward so a loop never sends a stop back to the start."""
    out = []
    seg = 0
    n = len(line)
    for p in stops:
        best = None
        # Prefer the first close match ahead of the previous stop; fall back to the nearest ahead.
        for i in range(seg, n - 1):
            d, t = seg_project(p, line[i], line[i + 1])
            if best is None or d < best[0]:
                best = (d, i, t)
            if best[0] < 25 and d > 250:
                break
        if best is None:
            out.append(int(along[-1]) if along else 0)
            continue
        _, i, t = best
        seg = i
        out.append(int(round(along[i] + t * (along[i + 1] - along[i]))))
    # Never backwards.
    for k in range(1, len(out)):
        if out[k] < out[k - 1]:
            out[k] = out[k - 1]
    return out


# ---------------------------------------------------------------- build


def build(zip_path: str, feed_day: str, out_dir: str) -> None:
    z = zipfile.ZipFile(zip_path)
    log("files:", ", ".join(z.namelist()))

    routes = {r["route_id"]: r for r in rows(z, "routes.txt")}
    stops = {s["stop_id"]: s for s in rows(z, "stops.txt")}
    trips = {}
    for t in rows(z, "trips.txt"):
        trips[t["trip_id"]] = (t["route_id"], t["service_id"], (t.get("shape_id") or "").strip())
    log(f"{len(routes)} routes, {len(stops)} stops, {len(trips)} trips")

    services: dict[str, dict] = {}
    for c in rows(z, "calendar.txt"):
        days = "".join(c[d] for d in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"))
        services[c["service_id"]] = {"days": days, "start": c["start_date"], "end": c["end_date"], "add": [], "remove": []}
    for c in rows(z, "calendar_dates.txt"):
        s = services.setdefault(c["service_id"], {"days": "0000000", "start": c["date"], "end": c["date"], "add": [], "remove": []})
        (s["add"] if c["exception_type"] == "1" else s["remove"]).append(c["date"])
        s["start"] = min(s["start"], c["date"])
        s["end"] = max(s["end"], c["date"])

    freqs: dict[str, list[tuple[int, int, int]]] = defaultdict(list)
    for f in rows(z, "frequencies.txt"):
        a, b = seconds(f["start_time"]), seconds(f["end_time"])
        if a is not None and b is not None:
            freqs[f["trip_id"]].append((a, b, max(60, int(f["headway_secs"]))))

    # stop_times is ~580 MB uncompressed: stream it and keep only compact tuples per trip.
    log("reading stop_times.txt")
    per_trip: dict[str, list[tuple[int, str, int | None]]] = defaultdict(list)
    count = 0
    for st in rows(z, "stop_times.txt"):
        tid = st["trip_id"]
        if tid not in trips:
            continue
        t = seconds(st.get("arrival_time") or "")
        if t is None:
            t = seconds(st.get("departure_time") or "")
        per_trip[tid].append((int(st["stop_sequence"]), st["stop_id"], t))
        count += 1
        if count % 2_000_000 == 0:
            log(f"  {count} stop times")
    log(f"{count} stop times in {len(per_trip)} trips")

    # Group trips into patterns: same route, same line, same stops in the same order.
    patterns: dict[tuple, dict] = {}
    for tid, seq in per_trip.items():
        seq.sort(key=lambda x: x[0])
        times = [x[2] for x in seq]
        known = [i for i, v in enumerate(times) if v is not None]
        if not known:
            continue
        # Fill gaps between timepoints linearly by stop count.
        for a, b in zip(known, known[1:]):
            for i in range(a + 1, b):
                times[i] = times[a] + (times[b] - times[a]) * (i - a) // (b - a)
        for i in range(0, known[0]):
            times[i] = times[known[0]]
        for i in range(known[-1] + 1, len(times)):
            times[i] = times[known[-1]]
        start = times[0]
        route_id, service_id, shape_id = trips[tid]
        key = (route_id, shape_id, tuple(x[1] for x in seq))
        p = patterns.get(key)
        if p is None:
            p = patterns[key] = {"sum": [0] * len(seq), "n": 0, "starts": defaultdict(list)}
        for i, v in enumerate(times):
            p["sum"][i] += v - start  # type: ignore[operator]
        p["n"] += 1
        if tid in freqs:
            for a, b, h in freqs[tid]:
                p["starts"][service_id].extend(range(a, b, h))
        else:
            p["starts"][service_id].append(start)
    del per_trip
    log(f"{len(patterns)} patterns")

    shape_ids = {k[1] for k in patterns if k[1]}
    shapes: dict[str, list[tuple[int, float, float]]] = defaultdict(list)
    for s in rows(z, "shapes.txt"):
        if s["shape_id"] in shape_ids:
            shapes[s["shape_id"]].append((int(s["shape_pt_sequence"]), float(s["shape_pt_lon"]), float(s["shape_pt_lat"])))
    lines = {}
    for sid, pts in shapes.items():
        pts.sort()
        lines[sid] = [(lon, lat) for _, lon, lat in pts]
    del shapes

    service_ids = sorted(services)
    service_index = {s: i for i, s in enumerate(service_ids)}

    def days_per_week(sid: str) -> int:
        s = services.get(sid)
        return s["days"].count("1") if s else 0

    used_stops: dict[str, int] = {}
    stop_list: list[str] = []

    def stop_idx(sid: str) -> int:
        if sid not in used_stops:
            used_stops[sid] = len(stop_list)
            stop_list.append(sid)
        return used_stops[sid]

    used_routes: dict[str, int] = {}
    route_list: list[str] = []
    out_patterns = []
    simplified_cache: dict[str, tuple[list, list]] = {}
    for (route_id, shape_id, stop_ids), p in sorted(patterns.items(), key=lambda kv: (kv[0][0], -kv[1]["n"])):
        if route_id not in routes:
            continue
        coords = [(float(stops[s]["stop_lon"]), float(stops[s]["stop_lat"])) for s in stop_ids if s in stops]
        if len(coords) != len(stop_ids) or len(coords) < 2:
            continue
        line = lines.get(shape_id) if shape_id else None
        if not line or len(line) < 2:
            line = coords
        cache_key = shape_id or "|".join(stop_ids)
        if cache_key not in simplified_cache:
            simple = simplify(line, 4.0)
            simplified_cache[cache_key] = (simple, measure(simple))
        simple, along = simplified_cache[cache_key]
        dists = stop_distances(simple, along, coords)
        offsets = [round(v / p["n"]) for v in p["sum"]]
        for k in range(1, len(offsets)):
            offsets[k] = max(offsets[k], offsets[k - 1])
        starts = {}
        per_week = 0
        for sid, values in p["starts"].items():
            if sid not in service_index:
                continue
            values = sorted(set(values))
            per_week += len(values) * days_per_week(sid)
            mins = sorted(set(v // 60 for v in values))
            delta, prev = [], 0
            for v in mins:
                delta.append(v - prev)
                prev = v
            starts[str(service_index[sid])] = delta
        if not starts:
            continue
        if route_id not in used_routes:
            used_routes[route_id] = len(route_list)
            route_list.append(route_id)
        out_patterns.append(
            {
                "r": used_routes[route_id],
                "s": [stop_idx(s) for s in stop_ids],
                "d": dists,
                "t": offsets,
                "g": encode_polyline(simple),
                "w": per_week,
                "n": starts,
            }
        )

    # Stations that hold used stops come along so a portal shows as one place.
    for sid in list(stop_list):
        parent = (stops[sid].get("parent_station") or "").strip()
        if parent and parent in stops:
            stop_idx(parent)

    out_stops = []
    for sid in stop_list:
        s = stops[sid]
        parent = (s.get("parent_station") or "").strip()
        out_stops.append(
            [
                sid,
                " ".join((s.get("stop_name") or "Paradero").split()),
                round(float(s["stop_lat"]), 6),
                round(float(s["stop_lon"]), 6),
                1 if s.get("wheelchair_boarding") == "1" else 0,
                1 if s.get("location_type") == "1" else 0,
                used_stops.get(parent, -1),
                (s.get("stop_code") or "").strip(),
            ]
        )

    out_routes = []
    for rid in route_list:
        r = routes[rid]
        out_routes.append(
            [
                rid,
                (r.get("route_short_name") or "").strip(),
                " ".join((r.get("route_long_name") or "").replace("||", " || ").split()).replace(" || ", " || "),
                SYSTEM_BY_AGENCY.get(r.get("agency_id", ""), "other"),
                (r.get("route_color") or "").strip(),
            ]
        )

    out_services = [[sid, services[sid]["days"], services[sid]["start"], services[sid]["end"], services[sid]["add"], services[sid]["remove"]] for sid in service_ids]

    bundle = {
        "schema": SCHEMA,
        "feedDate": feed_day,
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": f"{BUCKET}/GTFS_{feed_day}.zip",
        "license": "Datos abiertos de TransMilenio S.A., CC BY-SA 4.0",
        "routes": out_routes,
        "stops": out_stops,
        "services": out_services,
        "patterns": out_patterns,
    }
    text = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.sha256(text.encode()).hexdigest()[:12]
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "transit-v1.json"), "w", encoding="utf-8") as f:
        f.write(text)
    meta = {"schema": SCHEMA, "version": f"{feed_day}-{digest}", "feedDate": feed_day, "bytes": len(text.encode()), "generated": bundle["generated"]}
    with open(os.path.join(out_dir, "meta-v1.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f)
    log(
        f"bundle: {len(out_routes)} routes, {len(out_stops)} stops, {len(out_patterns)} patterns, "
        f"{len(out_services)} services, {len(text.encode()) / 1e6:.1f} MB, version {meta['version']}"
    )
    if len(out_routes) < 100 or len(out_stops) < 1000 or len(out_patterns) < 200:
        raise SystemExit("bundle looks too small; refusing to publish it")


def main() -> None:
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    out_dir = args[0]
    if "--zip" in args:
        path = args[args.index("--zip") + 1]
        day = os.path.basename(path).removeprefix("GTFS_").removesuffix(".zip")
    else:
        path, day = latest_zip(os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "gtfs.zip"))
    build(path, day, out_dir)


if __name__ == "__main__":
    main()
