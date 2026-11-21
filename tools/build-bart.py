#!/usr/bin/env python3
"""Build cities/sf/bart.json from BART's public GTFS schedule feed.

Run it by hand whenever BART changes its lines or stations (rarely):

    python3 tools/build-bart.py path/to/google_transit.zip
    python3 tools/build-bart.py https://www.bart.gov/dev/schedules/google_transit.zip

The page never talks to BART. It only reads the small file this script writes:
for each BART line and direction that runs through San Francisco, the usual
weekday daytime path, as a simplified line plus its stations in order, and the
street entrances of each station. No times are kept, so the page cannot say when
a train comes or how long a ride takes.

Kept small on purpose: only the San Francisco stations, plus the stations just
past the city that a direct ride from San Francisco reaches first (Daly City to
Millbrae and SFO down the Peninsula; West Oakland, 12th St, 19th St and Lake
Merritt in downtown Oakland). A line that never enters San Francisco (Orange,
and the Oakland Airport link) is left out. Bus bridges are left out.

Underground: in San Francisco BART runs in a tunnel from the Transbay Tube
under Market St and Mission St to Glen Park, and below the street on to
Balboa Park. The stretches between two stations
in UNDER (either way round) are not checked against street flooding, and the
card says so. Every San Francisco stretch must be in UNDER or in AT_STREET, or
the build stops, so a new station gets looked at by a person.

Standard library only. Nothing here runs on the site. It reuses the line
helpers in tools/build-transit.py (the Muni build).
"""
import csv
import hashlib
import importlib.util
import io
import json
import os
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict

sys.dont_write_bytecode = True   # importing build-transit.py must not leave a __pycache__ folder in tools/
HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("build_transit", os.path.join(HERE, "build-transit.py"))
_bt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bt)
project, simplify = _bt.project, _bt.simplify

OFFICIAL_URL = "https://www.bart.gov/dev/schedules/google_transit.zip"
OUT = os.path.join(HERE, "..", "cities", "sf", "bart.json")

DAY_START, DAY_END = 6 * 3600, 20 * 3600   # a trip counts as "daytime" if it leaves its first station in this window
MIN_SHARE = 0.25      # a second path for the same line and direction is kept when at least this share of trips use it
TOLERANCE_M = 4       # how far the simplified line may stray from the real one
MAX_STOP_OFF_M = 250  # a station further than this from its line means the data is wrong; stop and say so

# Stations kept, by GTFS parent station id, with the plain name the page shows.
# Names follow the station signs. True: inside San Francisco (the city's flood data covers it).
STATIONS = {
    "EMBR": ("Embarcadero", True),
    "MONT": ("Montgomery St", True),
    "POWL": ("Powell St", True),
    "CIVC": ("Civic Center/UN Plaza", True),
    "16TH": ("16th St Mission", True),
    "24TH": ("24th St Mission", True),
    "GLEN": ("Glen Park", True),
    "BALB": ("Balboa Park", True),
    "DALY": ("Daly City", False),
    "COLM": ("Colma", False),
    "SSAN": ("South San Francisco", False),
    "SBRN": ("San Bruno", False),
    "SFIA": ("SFO Airport", False),
    "MLBR": ("Millbrae", False),
    "WOAK": ("West Oakland", False),
    "12TH": ("12th St Oakland City Center", False),
    "19TH": ("19th St Oakland", False),
    "LAKE": ("Lake Merritt", False),
}
# Where each line ends, for "toward" (the name on the platform sign). Includes ends outside the kept stations.
ENDS = {
    "ANTC": "Antioch", "PITT": "Pittsburg/Bay Point", "RICH": "Richmond", "BERY": "Berryessa/North San Jose",
    "DUBL": "Dublin/Pleasanton", "DALY": "Daly City", "SFIA": "SFO Airport", "MLBR": "Millbrae",
}
# Plain line names, by the colour in the feed's route_short_name ("Yellow-S"). No BART logo, map or line colours are copied.
LINES = {
    "Yellow": "BART Yellow line (Antioch–SFO/Millbrae)",
    "Red": "BART Red line (Richmond–SFO/Millbrae)",
    "Green": "BART Green line (Berryessa–Daly City)",
    "Blue": "BART Blue line (Dublin/Pleasanton–Daly City)",
}
# Underground stretches, as station pairs (either way round). Transbay Tube, then the Market St and Mission St subway.
UNDER = [
    {"WOAK", "EMBR"},   # Transbay Tube: under the Bay, then under the Embarcadero. West Oakland itself is up on a viaduct,
                        # but the city's flood data stops at the shore, so nothing in Oakland is checked either way.
    {"EMBR", "MONT"}, {"MONT", "POWL"}, {"POWL", "CIVC"},     # under Market St
    {"CIVC", "16TH"}, {"16TH", "24TH"},                      # under Mission St
    {"24TH", "GLEN"},                                        # under Mission St and San Jose Ave to Glen Park
    {"GLEN", "BALB"},   # in a tunnel out of Glen Park, then in a cut beside I-280 into Balboa Park, below the street either way.
                        # Checked, it picks up the I-280 Monterey Blvd exit place (Glen Park), about 370 m past Glen Park station,
                        # where the track is in the tunnel. To check this stretch instead, move this pair to AT_STREET.
]
# San Francisco stretches that are checked like a street ride: from Balboa Park south the track runs beside I-280.
AT_STREET = [{"BALB", "DALY"}]

NOTICE = (
    "BART data, from the San Francisco Bay Area Rapid Transit District's GTFS schedule feed, used under BART's "
    "Developer License Agreement (https://www.bart.gov/dla). BART grants non-exclusive, limited and revocable rights "
    "to use, reproduce, and redistribute BART Data. Data is provided on an \"as is\" and \"as available\" basis. "
    "BART makes no representations or warranties of any kind, express or implied. BART disclaims all warranties, "
    "express or implied, including but not limited to implied warranties of merchantability and fitness for a "
    "particular purpose. BART and its employees, officers, directors and agents will not be liable for damages of any "
    "kind arising from the use of Data including but not limited to direct, indirect, incidental, punitive and "
    "consequential damages. BART maintains title, ownership, rights and interest in and to Data. This file is "
    "simplified from the feed and is not from BART."
)


def rows(z, name):
    with z.open(name) as f:
        for r in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig", newline="")):
            yield {k.strip(): (v or "").strip() for k, v in r.items() if k}


def secs(t):
    p = t.split(":")
    return int(p[0]) * 3600 + int(p[1]) * 60 + int(p[2]) if len(p) == 3 else None


def kept_run(stations):
    """The longest run of kept stations in a row that has a San Francisco station in it."""
    best, cur = [], []
    for s in stations + [None]:
        if s in STATIONS:
            cur.append(s)
            continue
        if any(STATIONS[x][1] for x in cur) and len(cur) > len(best):
            best = cur
        cur = []
    return best


def build(zip_bytes, source):
    z = zipfile.ZipFile(io.BytesIO(zip_bytes))

    weekday, start, end = set(), "99999999", "00000000"
    for c in rows(z, "calendar.txt"):
        if any(c.get(d) == "1" for d in ("monday", "tuesday", "wednesday", "thursday", "friday")):
            weekday.add(c["service_id"])
            start, end = min(start, c["start_date"]), max(end, c["end_date"])
    if not weekday:
        sys.exit("No weekday service found in calendar.txt.")

    routes = {r["route_id"]: r for r in rows(z, "routes.txt") if r.get("route_type") == "1"}   # 1: subway / metro. Bus bridges are 3.
    stops = {s["stop_id"]: s for s in rows(z, "stops.txt")}
    trips = {t["trip_id"]: t for t in rows(z, "trips.txt") if t["service_id"] in weekday and t["route_id"] in routes}
    for sid in STATIONS:
        if sid not in stops or stops[sid].get("location_type") != "1":
            sys.exit("Station %s is not in the feed's stops.txt as a station. Look at STATIONS." % sid)

    def parent(sid):
        return stops[sid].get("parent_station") or sid

    seqs = defaultdict(list)
    for st in rows(z, "stop_times.txt"):
        if st["trip_id"] in trips:
            seqs[st["trip_id"]].append((int(st["stop_sequence"]), st["stop_id"], st["departure_time"] or st["arrival_time"]))

    groups = defaultdict(Counter)   # (route, direction) -> {(station ids, shape id): trips}
    ends = {}
    for tid, seq in seqs.items():
        seq.sort()
        first = secs(seq[0][2])
        if first is None or not (DAY_START <= first <= DAY_END):
            continue
        stations = []
        for _, sid, _ in seq:
            p = parent(sid)
            if not stations or stations[-1] != p:     # SFO has two platforms that a Millbrae train stops at in a row
                stations.append(p)
        t = trips[tid]
        key = (tuple(stations), t["shape_id"])
        groups[(t["route_id"], t["direction_id"])][key] += 1

    chosen = []
    for (rid, did), pats in groups.items():
        total = sum(pats.values())
        seen = set()
        for i, ((stations, shape_id), n) in enumerate(pats.most_common()):
            run = tuple(kept_run(list(stations)))
            if len(run) < 2 or (i and n / total < MIN_SHARE) or run in seen:
                continue
            seen.add(run)
            chosen.append((rid, did, run, shape_id, stations[-1]))

    shapes = defaultdict(list)
    need = {c[3] for c in chosen}
    for s in rows(z, "shapes.txt"):
        if s["shape_id"] in need:
            shapes[s["shape_id"]].append((int(s["shape_pt_sequence"]), float(s["shape_pt_lat"]), float(s["shape_pt_lon"])))

    used = []          # station ids in the order they are first used
    index = {}

    def ref(sid):
        if sid not in index:
            index[sid] = len(used)
            used.append(sid)
        return index[sid]

    out_routes, under_log, worst_off = [], [], 0.0
    for rid, did, run, shape_id, last in sorted(chosen, key=lambda c: (routes[c[0]]["route_short_name"], c[1], c[2])):
        colour = routes[rid]["route_short_name"].split("-")[0]
        if colour not in LINES:
            sys.exit("BART line %s (%s) is not in LINES. Add a plain name for it." % (rid, routes[rid]["route_short_name"]))
        if last not in ENDS:
            sys.exit("Line %s ends at %s, which is not in ENDS." % (rid, last))
        pts = [(la, lo) for _, la, lo in sorted(shapes[shape_id])]
        # Where each station sits along the line, never going backwards.
        placed, seg_from, u_from = [], 0, 0.0
        for sid in run:
            p = (float(stops[sid]["stop_lat"]), float(stops[sid]["stop_lon"]))
            cands = []
            for i in range(seg_from, len(pts) - 1):
                if i == seg_from and u_from > 0:
                    a = (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u_from, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u_from)
                    d, u, q = project(p, a, pts[i + 1])
                    u = u_from + u * (1 - u_from)
                else:
                    d, u, q = project(p, pts[i], pts[i + 1])
                cands.append((d, i, u, q))
            best = min(c[0] for c in cands)
            d, i, u, q = next(c for c in cands if c[0] <= best + 15)
            worst_off = max(worst_off, d)
            if d > MAX_STOP_OFF_M:
                sys.exit("Station %s is %d m from the line of route %s. The feed looks wrong." % (sid, d, rid))
            placed.append((i, u, q))
            seg_from, u_from = i, u
        # The line from the first kept station to the last, with a point at every station, simplified between stations.
        line, refs = [], []
        cursor = placed[0][0] + 1
        piece = [placed[0][2]]
        for k, ((i, u, q), sid) in enumerate(zip(placed, run)):
            if k:
                while cursor <= i:
                    piece.append(pts[cursor]); cursor += 1
                piece.append(q)
            for pt in simplify(piece, TOLERANCE_M):
                r = [round(pt[0], 5), round(pt[1], 5)]
                if not line or line[-1] != r:
                    line.append(r)
            refs.append([ref(sid), len(line) - 1])
            piece = [q]
        under = []
        for k in range(len(run) - 1):
            a, b = run[k], run[k + 1]
            pair = {a, b}
            if pair in UNDER:
                i0, i1 = refs[k][1], refs[k + 1][1]
                if under and under[-1][1] == i0:
                    under[-1][1] = i1
                elif i1 > i0:
                    under.append([i0, i1])
                under_log.append(" and ".join(sorted((STATIONS[a][0], STATIONS[b][0]))))
            elif pair not in AT_STREET and (STATIONS[a][1] or STATIONS[b][1]):
                sys.exit("The stretch %s to %s is in San Francisco but in neither UNDER nor AT_STREET. Add it to one." % (a, b))
        out_routes.append({
            "id": colour + ("-" + did if did else ""),
            "name": LINES[colour],
            "toward": ENDS[last],
            "dir": int(did or 0),
            "type": 1,
            "line": line,
            "stops": refs,
            **({"under": under} if under else {}),
        })

    doors = defaultdict(list)
    for s in stops.values():
        if s.get("location_type") == "2" and s.get("parent_station") in index:
            doors[s["parent_station"]].append([round(float(s["stop_lat"]), 5), round(float(s["stop_lon"]), 5)])
    stations = []
    for sid in used:
        name, in_sf = STATIONS[sid]
        st = stops[sid]
        stations.append({
            "id": sid, "name": name, "ll": [round(float(st["stop_lat"]), 5), round(float(st["stop_lon"]), 5)],
            "doors": sorted(doors[sid]), "sf": in_sf,
        })

    feed = {}
    try:
        feed = next(rows(z, "feed_info.txt"))
    except (KeyError, StopIteration):
        pass

    return {
        "note": "Made by tools/build-bart.py from BART's GTFS schedule feed. Do not edit by hand. Each route is the usual "
                "weekday daytime path of one BART line in one direction, cut to the stations in San Francisco and the "
                "first few past it. No times are kept. \"stations\": id, name, ll ([latitude, longitude]), doors (street "
                "entrances), sf (inside San Francisco). A route's \"stops\" are [station number, place on the line]. "
                "\"under\" lists the stretches that run underground, as [first, last] positions in \"line\".",
        "data": "BART data, not covered by this repo's MIT license",
        "license": "This file is BART data, used under BART's Developer License Agreement (https://www.bart.gov/dla). "
                   "It is not covered by this project's open-source license. Keep \"notice\" with any copy. "
                   "This project is not affiliated with or endorsed by BART. No BART logo, trademark or system map is used.",
        "credit": "BART data: bart.gov",
        "credit_url": "https://www.bart.gov/schedules/developers",
        "source": {
            "name": "BART GTFS schedule feed",
            "official_url": OFFICIAL_URL,
            "built_from": source,
            "sha256": hashlib.sha256(zip_bytes).hexdigest(),
            "feed_version": feed.get("feed_version", ""),
            "service_from": "%s-%s-%s" % (start[:4], start[4:6], start[6:]),
            "service_to": "%s-%s-%s" % (end[:4], end[4:6], end[6:]),
            "license_url": "https://www.bart.gov/dla",
        },
        "notice": NOTICE,
        "stations": stations,
        "routes": out_routes,
    }, worst_off, under_log


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else OUT
    label = sys.argv[3] if len(sys.argv) > 3 else (src if src.startswith("https://") else os.path.basename(src))
    if src.startswith("https://"):
        with urllib.request.urlopen(src, timeout=120) as r:
            data = r.read()
    else:
        with open(src, "rb") as f:
            data = f.read()
    result, worst, under_log = build(data, label)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    print("Wrote %s: %d lines-and-directions, %d stations, %d KB. Service %s to %s. Furthest station from its line: %d m." % (
        os.path.relpath(out), len(result["routes"]), len(result["stations"]), os.path.getsize(out) // 1024,
        result["source"]["service_from"], result["source"]["service_to"], worst))
    print("Underground stretches (not checked against street flooding):")
    for line in sorted(set(under_log)):
        print("  " + line)


if __name__ == "__main__":
    main()
