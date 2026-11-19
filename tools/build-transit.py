#!/usr/bin/env python3
"""Build cities/sf/transit.json from SFMTA's public GTFS schedule feed.

Run it once, by hand, whenever Muni changes its routes (a few times a year):

    python3 tools/build-transit.py path/to/muni_gtfs-current.zip
    python3 tools/build-transit.py https://muni-gtfs.apps.sfmta.com/data/muni_gtfs-current.zip

The page never talks to a transit service. It only reads the small file this
script writes: for each Muni line and direction, the usual weekday daytime
path, as a simplified line plus its stops in order. No times are kept, so the
page cannot say when a bus comes or how long a ride takes.

What is left out, and why:
- Lines that only run at rush hour (no weekday trip starts between 10 am and
  3 pm), such as the 1X and 8AX. The page has no clock for buses, so it would
  offer them at noon as if they were running.
- Owl and school-day paths, which fall outside the daytime window.

Underground rail: Muni Metro runs in tunnels under Market St, Twin Peaks,
Fourth St and Duboce Park. A flood shape drawn on the street above is not on
that ride. Each rail line gets an "under" list: the stretches between two
stops that are both in UNDERGROUND below (plus the Sunset Tunnel). The page
does not check those stretches against street flooding and says so. A stretch
with one end at street level (a tunnel mouth) stays checked, because some of
it is on the street. The F streetcar and the three cable car lines run on the
street the whole way, so they are checked like buses.

Standard library only. Nothing here runs on the site.
"""
import csv
import hashlib
import io
import json
import math
import os
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict

OFFICIAL_URL = "https://muni-gtfs.apps.sfmta.com/data/muni_gtfs-current.zip"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cities", "sf", "transit.json")

DAY_START, DAY_END = 6 * 3600, 20 * 3600   # a trip counts as "daytime" if it leaves its first stop in this window
MIN_SHARE = 0.25      # a second path for the same line and direction is kept when at least this share of trips use it
TOLERANCE_M = 4       # how far the simplified line may stray from the real one (flood shapes are 30 m wide or more)
MIDDAY_START, MIDDAY_END = 10 * 3600, 15 * 3600   # a line with no weekday trip starting in this window only runs at rush hour, and is left out
MAX_STOP_OFF_M = 250  # a stop further than this from its line means the data is wrong; stop and say so (end-of-line stops can sit ~130 m past the drawn line)

RAIL = ("0", "1")   # GTFS route_type: 0 is tram / light rail, 1 is subway. (3 is bus, 5 is cable car.)
# Muni Metro stops that are below the street. Exact stop names from stops.txt.
UNDERGROUND = {
    "Metro Embarcadero Station",
    "Metro Montgomery Station/Outbound", "Metro Montgomery Station/Downtown",
    "Metro Powell Station/Outbound", "Metro Powell Station/Downtown",
    "Metro Civic Center Station/Outbd", "Metro Civic Center Station/Downtn",
    "Van Ness Station Outbound", "Metro Van Ness Station",
    "Metro Church Station/Outbound", "Metro Church Station/Downtown",
    "Metro Castro Station/Outbound", "Metro Castro Station/Downtown",
    "Forest Hill Station Outbound", "Metro Forest Hill Station/Downtown",
    "West Portal Station",                      # at the mouth of the Twin Peaks Tunnel: the track toward downtown is all tunnel
    "Yerba Buena/Moscone Station Northbound", "Yerba Buena/Moscone Station Southbound",
    "Union Square/Market St Station Northbound", "Union Square/Market St Station Southbound",
    "Chinatown - Rose Pak Station",
}
# Rail stops with "Station" in the name that are at street level. Any other "Station" on a rail line stops the build,
# so a renamed or new station gets looked at by a person.
STREET_LEVEL_STATIONS = {"San Jose Ave/Glen Park Station"}
# Tunnels with a street-level stop at each mouth: the stretch between the two stops, either way round.
TUNNEL_BETWEEN = [
    {"Carl St & Cole St", "Duboce St/Noe St/Duboce Park"},   # Sunset Tunnel, N Judah outbound
    {"Carl St & Cole St", "Sunset Tunnel East Portal"},      # Sunset Tunnel, N Judah inbound
]

# SFMTA's license (clause 12) asks that this notice travel with any copy made from its data.
NOTICE = (
    "Reproduced with permission granted by the City and County of San Francisco. The information has been provided "
    "by means of a nonexclusive, limited, and revocable license granted by the City and County of San Francisco. "
    "The City and County of San Francisco does not guarantee the accuracy, adequacy, completeness or usefulness of "
    "any information. The City and County of San Francisco provides this information \"as is,\" without warranty of "
    "any kind, express or implied, including but not limited to warranties of merchantability or fitness for a "
    "particular purpose, and assumes no responsibility for anyone's use of the information."
)
# Clause 4 asks that this disclaimer be shown to the people who use anything made from the data.
NO_LIABILITY = (
    "The SFMTA and its employees, officers, directors and agents shall not be liable for damages of any kind arising "
    "from the use of Data or any application that uses the Data including but not limited to direct, indirect, "
    "incidental, punitive and consequential, and or special damages."
)

M = 111320.0


def rows(z, name):
    with z.open(name) as f:
        for r in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig", newline="")):
            yield {k.strip(): (v or "").strip() for k, v in r.items() if k}


def secs(t):
    p = t.split(":")
    return int(p[0]) * 3600 + int(p[1]) * 60 + int(p[2]) if len(p) == 3 else None


def xy(p, lat0):
    return (p[1] * math.cos(math.radians(lat0)) * M, p[0] * M)


def project(p, a, b):
    """Closest point to p on the segment a-b: (metres away, how far along 0..1, the point)."""
    lat0 = a[0]
    px, py = xy(p, lat0); ax, ay = xy(a, lat0); bx, by = xy(b, lat0)
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    u = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2)) if l2 else 0.0
    return math.hypot(px - ax - u * dx, py - ay - u * dy), u, (a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u)


def simplify(pts, tol):
    """Douglas-Peucker: drop points that sit within tol metres of the line through their neighbors."""
    if len(pts) < 3:
        return list(pts)
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        worst, at = 0.0, None
        for k in range(i + 1, j):
            d = project(pts[k], pts[i], pts[j])[0]
            if d > worst:
                worst, at = d, k
        if at is not None and worst > tol:
            keep[at] = True
            stack += [(i, at), (at, j)]
    return [p for p, k in zip(pts, keep) if k]


def nice(name):
    """ "VAN NESS-MISSION" -> "Van Ness-Mission". """
    small = {"Bart": "BART", "Owl": "Owl", "Sf": "SF", "Ucsf": "UCSF", "Va": "VA"}
    out = []
    for word in name.replace("-", " - ").split():
        w = "'".join(part.capitalize() if len(part) > 1 else part for part in word.split("'")) if word.isupper() or word.islower() else word
        out.append(small.get(w, w))
    return " ".join(out).replace(" - ", "-")


def build(zip_bytes, source):
    z = zipfile.ZipFile(io.BytesIO(zip_bytes))

    weekday, start, end = set(), "99999999", "00000000"
    for c in rows(z, "calendar.txt"):
        if any(c.get(d) == "1" for d in ("monday", "tuesday", "wednesday", "thursday", "friday")):
            weekday.add(c["service_id"])
            start, end = min(start, c["start_date"]), max(end, c["end_date"])
    if not weekday:
        sys.exit("No weekday service found in calendar.txt.")

    routes = {r["route_id"]: r for r in rows(z, "routes.txt")}
    stops = {s["stop_id"]: s for s in rows(z, "stops.txt")}
    trips = {t["trip_id"]: t for t in rows(z, "trips.txt") if t["service_id"] in weekday}

    seqs = defaultdict(list)
    for st in rows(z, "stop_times.txt"):
        if st["trip_id"] in trips:
            seqs[st["trip_id"]].append((int(st["stop_sequence"]), st["stop_id"], st["departure_time"] or st["arrival_time"]))

    # The usual daytime path(s) of each line and direction.
    groups = defaultdict(Counter)   # (route, direction) -> {(stop ids, shape id): trips}
    signs = {}
    midday = set()                  # lines with a weekday trip starting in the middle of the day
    for tid, seq in seqs.items():
        seq.sort()
        first = secs(seq[0][2])
        if first is not None and MIDDAY_START <= first <= MIDDAY_END:
            midday.add(trips[tid]["route_id"])
        if first is None or not (DAY_START <= first <= DAY_END):
            continue
        t = trips[tid]
        key = (tuple(s[1] for s in seq), t["shape_id"])
        groups[(t["route_id"], t["direction_id"])][key] += 1
        signs.setdefault(key, t.get("trip_headsign", "").replace("`", "'"))   # the feed writes Fisherman`s Wharf

    rush_only = sorted({routes[rid]["route_short_name"] or rid for rid, _ in groups if rid not in midday})

    need_shapes = set()
    chosen = []
    for (rid, did), pats in groups.items():
        if rid not in midday:
            continue
        total = sum(pats.values())
        ranked = pats.most_common()
        seen = set()
        for i, ((stop_ids, shape_id), n) in enumerate(ranked):
            if i and (n / total < MIN_SHARE or stop_ids in seen):
                continue
            seen.add(stop_ids)
            chosen.append((rid, did, stop_ids, shape_id, signs[(stop_ids, shape_id)]))
            need_shapes.add(shape_id)

    shapes = defaultdict(list)
    for s in rows(z, "shapes.txt"):
        if s["shape_id"] in need_shapes:
            shapes[s["shape_id"]].append((int(s["shape_pt_sequence"]), float(s["shape_pt_lat"]), float(s["shape_pt_lon"])))

    stop_table, stop_index, out_routes, under_log = [], {}, [], []
    worst_off = 0.0

    def stop_ref(sid):
        if sid not in stop_index:
            s = stops[sid]
            stop_index[sid] = len(stop_table)
            stop_table.append([s["stop_name"], round(float(s["stop_lat"]), 5), round(float(s["stop_lon"]), 5)])
        return stop_index[sid]

    def sort_key(c):
        short = routes[c[0]]["route_short_name"] or c[0]
        digits = "".join(ch for ch in short if ch.isdigit())
        return (0 if digits else 1, int(digits or 0), short, c[1], c[4])

    for rid, did, stop_ids, shape_id, sign in sorted(chosen, key=sort_key):
        pts = [(la, lo) for _, la, lo in sorted(shapes[shape_id])]
        if len(pts) < 2 or len(stop_ids) < 2:
            continue
        # Where each stop sits along the line, never going backwards (some lines loop over their own path).
        placed, seg_from, u_from = [], 0, 0.0
        for sid in stop_ids:
            p = (float(stops[sid]["stop_lat"]), float(stops[sid]["stop_lon"]))
            cands = []
            for i in range(seg_from, len(pts) - 1):
                if i == seg_from and u_from > 0:      # only the part of this piece after the previous stop
                    a = (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u_from, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u_from)
                    d, u, q = project(p, a, pts[i + 1])
                    u = u_from + u * (1 - u_from)
                else:
                    d, u, q = project(p, pts[i], pts[i + 1])
                cands.append((d, i, u, q))
            if not cands:
                cands = [(project(p, pts[-2], pts[-1])[0], len(pts) - 2, 1.0, pts[-1])]
            best = min(c[0] for c in cands)
            d, i, u, q = next(c for c in cands if c[0] <= best + 15)   # the first good match, not a later pass of a loop
            worst_off = max(worst_off, d)
            if d > MAX_STOP_OFF_M:
                sys.exit("Stop %s (%s) is %d m from the line of route %s. The feed looks wrong." % (sid, stops[sid]["stop_name"], d, rid))
            placed.append((i, u, q))
            seg_from, u_from = i, u

        # The line, with a point added at every stop, simplified between stops.
        line, stop_refs = [], []
        piece, cursor = [pts[0]], 1   # cursor: the next original point not yet used
        for (i, u, q), sid in zip(placed, stop_ids):
            while cursor <= i:
                piece.append(pts[cursor]); cursor += 1
            piece.append(q)
            for p in simplify(piece, TOLERANCE_M):
                r = [round(p[0], 5), round(p[1], 5)]
                if not line or line[-1] != r:
                    line.append(r)
            stop_refs.append([stop_ref(sid), len(line) - 1])
            piece = [q]
        while cursor < len(pts):
            piece.append(pts[cursor]); cursor += 1
        for p in simplify(piece, TOLERANCE_M):
            r = [round(p[0], 5), round(p[1], 5)]
            if line[-1] != r:
                line.append(r)

        r = routes[rid]
        short = r["route_short_name"] or rid
        # Underground stretches, as [first, last] positions in "line".
        under = []
        if r.get("route_type") in RAIL:
            names = [stops[sid]["stop_name"] for sid in stop_ids]
            for n in names:
                if "Station" in n and "BART" not in n.upper() and "Caltrain" not in n and n not in UNDERGROUND and n not in STREET_LEVEL_STATIONS:
                    sys.exit("Rail stop \"%s\" on the %s is not in UNDERGROUND or STREET_LEVEL_STATIONS. Add it to one of them." % (n, short))
            for k in range(len(names) - 1):
                a, b = names[k], names[k + 1]
                if (a in UNDERGROUND and b in UNDERGROUND) or {a, b} in TUNNEL_BETWEEN:
                    i0, i1 = stop_refs[k][1], stop_refs[k + 1][1]
                    if under and under[-1][1] == i0:
                        under[-1][1] = i1
                    elif i1 > i0:
                        under.append([i0, i1])
                    under_log.append("%s toward %s: %s to %s" % (short, sign, a, b))
        out_routes.append({
            "id": short,
            "name": (short + " " + nice(r["route_long_name"])).strip(),
            "toward": sign,
            "dir": int(did or 0),
            "type": int(r.get("route_type") or 3),
            "line": line,
            "stops": stop_refs,
            **({"under": under} if under else {}),
        })

    return {
        "note": "Made by tools/build-transit.py from SFMTA's GTFS schedule feed. Do not edit by hand. "
                "Each entry is the usual weekday daytime path of one Muni line in one direction. No times are kept. "
                "Lines that only run at rush hour are left out. \"under\" lists the stretches of a rail line that run "
                "underground, as [first, last] positions in \"line\"; route type 5 is a cable car, which runs on the street.",
        "license": "This file is SFMTA data, used under the SFMTA Transit Data Feed License Agreement. It is not covered by "
                   "this project's open-source license. Keep \"notice\" and \"no_liability\" with any copy. "
                   "This project is not affiliated with or endorsed by SFMTA.",
        "source": {
            "name": "SFMTA GTFS schedule feed",
            "official_url": OFFICIAL_URL,
            "built_from": source,
            "sha256": hashlib.sha256(zip_bytes).hexdigest(),
            "service_from": "%s-%s-%s" % (start[:4], start[4:6], start[6:]),
            "service_to": "%s-%s-%s" % (end[:4], end[4:6], end[6:]),
            "license_url": "https://www.sfmta.com/reports/gtfs-transit-data",
            "license_file": "SFMTA_Transit_Data_License_Agreement.txt, inside the feed's zip file",
        },
        "notice": NOTICE,
        "no_liability": NO_LIABILITY,
        "stops": stop_table,
        "routes": out_routes,
    }, worst_off, rush_only, under_log


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
    result, worst, rush_only, under_log = build(data, label)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    print("Wrote %s: %d lines-and-directions, %d stops, %d KB. Service %s to %s. Furthest stop from its line: %d m." % (
        os.path.relpath(out), len(result["routes"]), len(result["stops"]), os.path.getsize(out) // 1024,
        result["source"]["service_from"], result["source"]["service_to"], worst))
    print("Left out, rush hours only: %s." % (", ".join(rush_only) or "none"))
    print("Underground stretches (not checked against street flooding):")
    seen = set()
    for line in under_log:
        if line not in seen:
            seen.add(line)
            print("  " + line)


if __name__ == "__main__":
    main()
