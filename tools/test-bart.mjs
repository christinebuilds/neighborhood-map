// Tests direct BART rides in Plan a route, Transit. Run with: node tools/test-bart.mjs
// It cuts the BUS-LOGIC and BART-LOGIC blocks out of index.html and runs them against the real
// cities/sf/transit.json, cities/sf/bart.json and cities/sf/past-storms.json. No packages needed.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const page = read("index.html");
const cut = (name) => {
  const a = page.indexOf("// ==== " + name + "-START ===="), b = page.indexOf("// ==== " + name + "-END ====");
  assert.ok(a > 0 && b > a, "index.html must hold the " + name + "-START / " + name + "-END block");
  return page.slice(a, b);
};
const busCode = cut("BUS-LOGIC"), bartCode = cut("BART-LOGIC");
const [BUS, BART] = new Function(busCode + bartCode + "\nreturn [BUSLOGIC, BARTLOGIC];")();
const T = JSON.parse(read("cities/sf/transit.json"));
const Q = JSON.parse(read("cities/sf/bart.json"));
const P = JSON.parse(read("cities/sf/past-storms.json"));
const flood = { areas: P.areas };
const trip = (s, d, f = flood) => BART.merge(BUS.plan(s, d, T, f), BART.plan(s, d, Q, f));
const BANNED = /\bsafe|flood-free|faster|quicker|slower|\bAI\b|moderated/i;

const MISSION_24TH = [37.7524, -122.4184], CIVIC = [37.7797, -122.4140];
const GLEN_PARK = [37.7337, -122.4337], EMBARCADERO = [37.7936, -122.3955];

test("the BART block is pure: no page, map or network inside it", () => {
  assert.doesNotMatch(bartCode.replace(/\/\/.*$/gm, ""), /\bdocument\b|\bwindow\b|\bL\.|\bfetch\b|localStorage|\bmap\./);
});

test("bart.json: the San Francisco stations are there, each line has stations in order", () => {
  const names = Q.stations.map((s) => s.name);
  for (const n of ["Embarcadero", "Montgomery St", "Powell St", "Civic Center/UN Plaza", "16th St Mission", "24th St Mission", "Glen Park", "Balboa Park"])
    assert.ok(names.includes(n), n);
  assert.ok(Q.stations.filter((s) => s.sf).length === 8);
  assert.equal(Q.data, "BART data, not covered by this repo's MIT license");
  assert.ok(Q.routes.length >= 8 && Q.routes.every((r) => r.type === 1 && r.under && r.under.length));
});

test("24th & Mission to Civic Center: BART or the 14, both sensible", () => {
  const r = trip(MISSION_24TH, CIVIC);
  assert.equal(r.message, "");
  assert.ok(/^(BART|14 )/.test(r.options[0].name), r.options[0].name);
  const b = r.options.find((o) => o.bart);
  assert.ok(b, "BART is on the card");
  assert.equal(BART.take(b), "Take BART from 24th St Mission to Civic Center/UN Plaza.");
  assert.equal(b.stops, 2);
  assert.ok(B_lines(b).length === 4, "all four lines that run there are one row");
  assert.ok(BART.sentences(b).includes(BUS.UNDER));
  assert.ok(BART.sentences(b).includes("At street level, this trip passes none of the places that flooded in past storms."));
  assert.ok(r.options.some((o) => /^14 /.test(o.name)), "the 14 is still offered");
});
function B_lines(o) { return o.lines; }

test("Glen Park to Embarcadero: BART comes first", () => {
  const r = trip(GLEN_PARK, EMBARCADERO);
  const first = r.options[0];
  assert.ok(first.bart, first.name);
  assert.equal(BART.take(first), "Take BART from Glen Park to Embarcadero.");
  assert.equal(first.spots, 0);
  assert.ok(first.walkToM <= 800 && first.walkFromM <= 800);
  assert.equal(BART.stopsLine(first), "Glen Park to Embarcadero, 6 stops. Blue, Green, Red or Yellow line.");
  assert.deepEqual(BART.badge(first), { text: "BART", tram: true, bart: true });
});

test("the ride goes the right way: Embarcadero to Glen Park rides south", () => {
  const b = trip(EMBARCADERO, GLEN_PARK).options.find((o) => o.bart);
  assert.equal(BART.take(b), "Take BART from Embarcadero to Glen Park.");
  assert.ok(b.ride[0][0] > b.ride[b.ride.length - 1][0]);
});

test("walks go to the nearest station entrance, within about 800 m", () => {
  const r = BART.plan(MISSION_24TH, CIVIC, Q, flood).options[0];
  const st = Q.stations.find((s) => s.name === "24th St Mission");
  assert.ok(st.doors.some((d) => d[0] === r.from.ll[0] && d[1] === r.from.ll[1]), "gets on at an entrance");
  assert.ok(Math.abs(BUS.distM(MISSION_24TH, r.from.ll) - r.walkToM) <= 1);
  assert.equal(r.walkToMin, Math.max(1, Math.round(r.walkToM / 80)));
  // 1.2 km from the nearest station: no BART
  assert.deepEqual(BART.plan([37.7600, -122.4500], CIVIC, Q, flood).options, []);
});

test("underground: a flood place above the Market St subway is not on the ride", () => {
  // A made-up past-storm place drawn on Market St between Powell and Civic Center, on top of the BART tunnel.
  const fake = { name: "Market St test", shapes: [{ type: "circle", center: [37.7820, -122.4105], radius_m: 30 }] };
  const b = BART.plan(GLEN_PARK, EMBARCADERO, Q, { areas: [fake] }).options[0];
  assert.deepEqual(b.busPast, []);
  assert.equal(b.under, "all");
});

test("the at-grade stretch south of Glen Park is checked", () => {
  // A made-up place drawn on the track between Balboa Park and Daly City, where BART runs beside I-280.
  const route = Q.routes.find((r) => r.toward === "Daly City");
  const ids = route.stops.map((s) => Q.stations[s[0]].id);
  const i = route.stops[ids.indexOf("BALB")][1], j = route.stops[ids.indexOf("DALY")][1];
  const mid = route.line[Math.floor((i + j) / 2)];
  const fake = { name: "Beside I-280 test", shapes: [{ type: "circle", center: mid, radius_m: 20 }] };
  const b = BART.plan(GLEN_PARK, [37.7060, -122.4690], Q, { areas: [fake] }).options[0];
  assert.deepEqual(b.busPast, ["Beside I-280 test"]);
  assert.ok(BART.sentences(b).some((s) => s.startsWith("The ride passes 1 place that flooded in past storms")));
  assert.ok(BART.sentences(b).includes(BART.OUTSIDE), "Daly City is outside San Francisco");
});

test("Balboa Park to Powell: the tunnel out of Glen Park is not checked (real past-storm places)", () => {
  // The I-280 Monterey Blvd exit place sits over the BART tunnel just south of Glen Park station.
  // If Glen Park to Balboa Park moves to AT_STREET in tools/build-bart.py, this ride picks that place up and this test fails.
  const b = BART.plan([37.7215, -122.4475], [37.7846, -122.4073], Q, flood).options[0];
  assert.equal(BART.take(b), "Take BART from Balboa Park to Powell St.");
  assert.deepEqual(b.busPast, []);
  assert.equal(b.under, "all");
  assert.ok(P.areas.some((a) => /Monterey Blvd exit/.test(a.name)), "the I-280 Monterey place is still in past-storms.json");
});

test("a ride to Millbrae says the map only knows San Francisco", () => {
  const b = trip(MISSION_24TH, [37.6000, -122.3868]).options.find((o) => o.bart);
  assert.equal(BART.take(b), "Take BART from 24th St Mission to Millbrae.");
  assert.match(BART.stopsLine(b), /Red line toward Millbrae\.$/);
  assert.ok(BART.sentences(b).includes(BART.OUTSIDE));
});

test("ranking: fewest flood spots first, then least walking", () => {
  const water = [CIVIC];   // a fresh water report at the Civic Center end: every walk into it passes it
  const r = trip(MISSION_24TH, [37.7797, -122.4140], { areas: P.areas, water });
  for (let i = 1; i < r.options.length; i++) {
    const a = r.options[i - 1], b = r.options[i];
    assert.ok(a.spots < b.spots || (a.spots === b.spots && a.walkM <= b.walkM) || i === 2, a.name + " before " + b.name);
  }
});

test("no direct ride: falls back to the Google Maps message", () => {
  const r = trip([37.7600, -122.5080], [37.7290, -122.3720]);   // Ocean Beach to Hunters Point
  assert.deepEqual(r.options, []);
  assert.equal(r.message, BART.NONE);
  assert.match(r.message, /Google Maps/);
});

test("two places a short walk apart: no BART either", () => {
  const r = trip(MISSION_24TH, [37.7540, -122.4184]);
  assert.deepEqual(r.options, []);
  assert.match(r.message, /^These two places are about 2 min apart on foot/);
});

test("Muni rows pass through unchanged", () => {
  const m = trip(MISSION_24TH, CIVIC).options.find((o) => !o.bart);
  assert.deepEqual(BART.sentences(m), BUS.sentences(m));
  assert.equal(BART.stopsLine(m), BUS.stopsLine(m));
});

test("no banned words in any BART row", () => {
  for (const [s, d] of [[MISSION_24TH, CIVIC], [GLEN_PARK, EMBARCADERO], [MISSION_24TH, [37.6000, -122.3868]]]) {
    for (const o of trip(s, d).options.filter((o) => o.bart))
      assert.doesNotMatch([BART.take(o), ...BART.sentences(o), BART.stopsLine(o)].join(" "), BANNED);
  }
});
