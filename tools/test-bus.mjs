// Tests the "Bus or drive?" working-out. Run with: node tools/test-bus.mjs
// It cuts the BUS-LOGIC block out of index.html and runs it against the real
// cities/sf/transit.json and cities/sf/past-storms.json. No packages needed.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const page = read("index.html");
const a = page.indexOf("// ==== BUS-LOGIC-START ===="), b = page.indexOf("// ==== BUS-LOGIC-END ====");
assert.ok(a > 0 && b > a, "index.html must hold the BUS-LOGIC-START / BUS-LOGIC-END block");
const code = page.slice(a, b);
const B = new Function(code + "\nreturn BUSLOGIC;")();
const T = JSON.parse(read("cities/sf/transit.json"));
const P = JSON.parse(read("cities/sf/past-storms.json"));

// Mission to SoMa test trip: 20th & Folsom to 10th St near Folsom.
const START = [37.7586, -122.4147], DEST = [37.7737, -122.4132];
const FOLSOM = ["Folsom St, 14th to 18th", "17th & Folsom", "14th St, Folsom to Harrison (Rintaro block)"];
const allText = (r) => r.options.map((o) => o.name + " " + B.sentences(o).join(" ") + " " + B.stopsLine(o)).join(" ") + " " + r.message;
const BANNED = /\bsafe|flood-free|faster|quicker|slower|\bAI\b|moderated/i;

const pageBlock = page.slice(page.indexOf("// ==== BUS-PAGE-START ===="), page.indexOf("// ==== BUS-PAGE-END ===="));
// Castro to Powell: the K, L and M run under Market St; the F streetcar runs on top of it.
const CASTRO = [37.7626, -122.4352], POWELL = [37.7844, -122.4080], CHURCH = "Market St at Church St";

test("the block is pure: no page, map or network inside it", () => {
  assert.doesNotMatch(code.replace(/\/\/.*$/gm, ""), /\bdocument\b|\bwindow\b|\bL\.|\bfetch\b|localStorage|\bmap\./);
});

test("the data has the Folsom past-storm places and a Folsom and a Mission line", () => {
  for (const n of FOLSOM) assert.ok(P.areas.some((x) => x.name === n), n);
  assert.ok(T.routes.some((r) => /Folsom/.test(r.name)));
  assert.ok(T.routes.some((r) => /Mission/.test(r.name)));
  assert.ok(T.routes.length > 80 && T.stops.length > 2000);
});

test("20th & Folsom to 10th St: the Folsom line passes the three Folsom flood places", () => {
  const r = B.plan(START, DEST, T, { areas: P.areas });
  assert.equal(r.message, "");
  assert.ok(r.options.length >= 2 && r.options.length <= 3);
  const folsom = r.options.find((o) => /Folsom/.test(o.name));
  assert.ok(folsom, "the Folsom line is on the card");
  assert.deepEqual([...folsom.busPast].sort(), [...FOLSOM].sort());
  assert.deepEqual(folsom.walkPast, []);
  assert.match(folsom.from.name, /Folsom St & 20th St/);
  assert.ok(folsom.walkToMin <= 2 && folsom.walkFromMin <= 3);
  assert.ok(B.sentences(folsom).some((s) => s.startsWith("The bus passes 3 places that flooded in past storms: ")));
});

test("20th & Folsom to 10th St: a Mission St line passes none, and comes first", () => {
  const r = B.plan(START, DEST, T, { areas: P.areas });
  const first = r.options[0];
  assert.match(first.name, /Mission/);
  assert.equal(first.spots, 0);
  assert.match(first.from.name, /^Mission St/);
  assert.ok(B.sentences(first).includes("Passes none of the places that flooded in past storms."));
  assert.ok(first.walkToMin >= 4 && first.walkToMin <= 6);
  // ranked: fewest flood spots first
  for (let i = 1; i < r.options.length; i++) assert.ok(r.options[i - 1].spots <= r.options[i].spots);
  // one row per line
  const names = r.options.flatMap((o) => o.lines);
  assert.equal(new Set(names).size, names.length);
});

test("the ride goes the right way: the reverse trip uses the other direction", () => {
  const out = B.plan(START, DEST, T, { areas: P.areas }).options.find((o) => /Folsom/.test(o.name));
  const back = B.plan(DEST, START, T, { areas: P.areas }).options.find((o) => /Folsom/.test(o.name));
  assert.ok(back, "the Folsom line also runs back");
  assert.notEqual(out.toward, back.toward);
  assert.ok(out.ride[0][0] < out.ride[out.ride.length - 1][0], "north-bound ride ends further north");
  assert.ok(back.ride[0][0] > back.ride[back.ride.length - 1][0], "south-bound ride ends further south");
});

test("stops are within about 600 m of each end, and walking is 80 m a minute", () => {
  const r = B.plan(START, DEST, T, { areas: P.areas });
  for (const o of r.options) {
    assert.ok(o.walkToM <= 600 && o.walkFromM <= 600);
    assert.ok(Math.abs(B.distM(START, o.from.ll) - o.walkToM) <= 1);
    assert.equal(o.walkToMin, Math.max(1, Math.round(o.walkToM / 80)));
  }
});

test("no direct bus: says so, and says transfers aren't covered", () => {
  // Ocean Beach to Hunters Point: no single line does this.
  const r = B.plan([37.7600, -122.5080], [37.7290, -122.3720], T, { areas: P.areas });
  assert.deepEqual(r.options, []);
  assert.equal(r.message, "No direct bus between these two places. Bus trips with a transfer aren't covered yet.");
});

test("two places a short walk apart: no bus offered", () => {
  const r = B.plan(START, [37.7600, -122.4149], T, { areas: P.areas });
  assert.deepEqual(r.options, []);
  assert.match(r.message, /^These two places are about 2 min apart on foot/);
});

test("fresh neighbor water reports are counted for the ride and for the walk", () => {
  const onFolsom = [37.7700, -122.4157];                 // on Folsom near 13th, on the bus line
  const r = B.plan(START, DEST, T, { areas: [], water: [onFolsom, { lat: 37.80, lon: -122.47 }] });
  const folsom = r.options.find((o) => /Folsom/.test(o.name));
  assert.equal(folsom.busWater, 1);
  assert.ok(B.sentences(folsom).includes("The bus passes 1 spot where a neighbor reported water recently."));
  const mission = r.options.find((o) => /Mission/.test(o.name));
  assert.equal(mission.busWater + mission.walkWater, 0);
  assert.ok(r.options.indexOf(mission) < r.options.indexOf(folsom));
});

test("walk legs name the flood places they cross", () => {
  // 17th & Harrison sits inside the 17th & Folsom place, so every walk from there starts in it.
  const r = B.plan([37.7641, -122.4128], DEST, T, { areas: P.areas });
  assert.ok(r.options.length > 0);
  for (const o of r.options) {
    assert.ok(o.walkPast.includes("17th & Folsom"), o.name);
    assert.ok(B.sentences(o).some((s) => s.startsWith("Your walk passes ") && s.includes("17th & Folsom")));
  }
});

test("flood-zone feet are worked out only when the zone is given", () => {
  const none = B.plan(START, DEST, T, { areas: P.areas }).options[0];
  assert.equal(none.busZoneFt, null);
  // A made-up box over Folsom St from 15th to 17th.
  const zone = [{ b: [-122.4165, 37.7640, -122.4140, 37.7670], rings: [[[-122.4165, 37.7640], [-122.4140, 37.7640], [-122.4140, 37.7670], [-122.4165, 37.7670], [-122.4165, 37.7640]]] }];
  const r = B.plan(START, DEST, T, { areas: P.areas, zone });
  const folsom = r.options.find((o) => /Folsom/.test(o.name)), mission = r.options.find((o) => /Mission/.test(o.name));
  assert.ok(folsom.busZoneFt > 900 && folsom.busZoneFt < 1200, String(folsom.busZoneFt));   // the box is about 330 m (1,090 ft) tall
  assert.equal(mission.busZoneFt, 0);
  assert.ok(B.sentences(folsom).some((s) => /^About [\d,]+ feet of this trip is inside the city's flood zone\.$/.test(s)));
});

test("honest wording: no trip times, no promises", () => {
  const trips = [[START, DEST], [DEST, START], [[37.7641, -122.4128], DEST], [[37.7600, -122.5080], [37.7290, -122.3720]], [[37.7837, -122.4089], [37.7527, -122.4186]]];
  for (const [s, d] of trips) {
    const text = allText(B.plan(s, d, T, { areas: P.areas, water: [[37.7700, -122.4157]] }));
    assert.doesNotMatch(text, BANNED);
    assert.doesNotMatch(text, /\d+ min (ride|trip|total|by bus)|min on the bus|arriv|depart/i);
  }
  assert.equal(B.TIMES, "No bus times here. Check a transit app for times and delays.");
  assert.equal(B.CANT_SEE, "This map can't see water on the road right now.");
  assert.equal(B.driveLine(6.2, 0), "Drive around flood spots: about 6 min.");
  assert.equal(B.driveLine(6.2, 1), "Drive: about 6 min. That route still passes 1 flood spot.");
  assert.doesNotMatch(B.driveLine(6, 0) + B.driveLine(6, 2) + B.TIMES + B.CANT_SEE, BANNED);
});

test("lines that share both stops become one row; the line with the least walking is always shown", () => {
  // Made-up streets. Three clean lines 390 m west, each with its own stops, and one line at the door that crosses a flood place.
  const stops = [["Near A", 37.76, -122.42], ["Near B", 37.78, -122.42]], routes = [];
  ["1", "2", "3", "4"].forEach((id, i) => {
    const lat = 37.7600 + i * 0.0002;
    stops.push([id + " A", lat, -122.4245], [id + " B", lat + 0.02, -122.4245]);
    routes.push({ id, name: id + " Far", toward: "North", type: 3, line: [[lat, -122.4245], [lat + 0.02, -122.4245]], stops: [[stops.length - 2, 0], [stops.length - 1, 1]] });
  });
  routes.push({ id: "4R", name: "4R Far Rapid", toward: "North", type: 3, line: routes[3].line, stops: routes[3].stops });
  routes.push({ id: "9", name: "9 Near", toward: "North", type: 3, line: [[37.76, -122.42], [37.78, -122.42]], stops: [[0, 0], [1, 1]] });
  const area = { name: "Made-up dip", shapes: [{ type: "circle", center: [37.77, -122.42], radius_m: 50 }] };
  const r = B.plan([37.76, -122.4201], [37.78, -122.4201], { stops, routes }, { areas: [area] });
  assert.equal(r.options.length, 3);
  assert.deepEqual(r.options.map((o) => o.name), ["1 Far", "2 Far", "9 Near"]);
  assert.deepEqual(r.options[2].busPast, ["Made-up dip"]);
  const merged = B.plan([37.7606, -122.4201], [37.7806, -122.4201], { stops, routes: routes.slice(3, 5) }, { areas: [area] });
  assert.deepEqual(merged.options.map((o) => o.name), ["4 Far or 4R Far Rapid"]);
  assert.equal(B.stopsLine(merged.options[0]), "4 A to 4 B.");
  assert.equal(B.stopsLine(r.options[2]), "Near A to Near B, 1 stop.");
});

test("underground rail is not checked against street flood shapes; rail on the street is", () => {
  const r = B.plan(CASTRO, POWELL, T, { areas: P.areas });
  const metro = r.options.find((o) => /\bK |\bL |\bM /.test(o.name)), f = r.options.find((o) => o.lines.some((n) => /^F /.test(n)));
  assert.ok(metro, "a Metro line is on the card: " + r.options.map((o) => o.name).join(" | "));
  assert.ok(f, "the F streetcar is on the card");
  assert.equal(metro.under, "all");
  assert.ok(!metro.busPast.includes(CHURCH), "the tunnel under Market St does not pass the Church St flood place");
  assert.equal(f.under, "");
  assert.ok(f.busPast.includes(CHURCH), "the F, on the street, does");
  const text = B.sentences(metro);
  assert.ok(text.includes(B.UNDER));
  assert.equal(B.UNDER, "The underground part of the ride isn't checked.");
  assert.ok(!text.includes("Passes none of the places that flooded in past storms."), "an unchecked ride never reads as plainly clear");
  assert.ok(text.includes("At street level, this trip passes none of the places that flooded in past storms."));
  assert.ok(!B.sentences(f).includes(B.UNDER));
});

test("underground: water reports and the flood zone above a tunnel are not counted either", () => {
  const onMarket = [37.7672, -122.4290];   // Market St at Church St, on top of the tunnel
  const box = [{ b: [-122.4300, 37.7665, -122.4280, 37.7680], rings: [[[-122.4300, 37.7665], [-122.4280, 37.7665], [-122.4280, 37.7680], [-122.4300, 37.7680], [-122.4300, 37.7665]]] }];
  const r = B.plan(CASTRO, POWELL, T, { areas: [], water: [onMarket], zone: box });
  const metro = r.options.find((o) => o.under === "all"), f = r.options.find((o) => o.lines.some((n) => /^F /.test(n)));
  assert.equal(metro.busWater, 0); assert.equal(metro.busZoneFt, 0);
  assert.equal(f.busWater, 1); assert.ok(f.busZoneFt > 100);
});

test("a ride that leaves the tunnel is checked from the tunnel mouth on", () => {
  // J Church, Powell to 24th St: under Market St to Van Ness, then on the street, across Market at Church.
  const r = B.plan(POWELL, [37.7515, -122.4275], T, { areas: P.areas });
  const j = r.options.find((o) => o.lines.some((n) => /^J /.test(n)));
  assert.ok(j, "the J is on the card: " + r.options.map((o) => o.name).join(" | "));
  assert.equal(j.under, "part");
  assert.ok(j.busPast.includes(CHURCH));
  assert.ok(B.sentences(j).includes(B.UNDER));
});

test("the data marks tunnels only on rail lines, and cable cars and the F stay at street level", () => {
  const under = T.routes.filter((r) => r.under);
  assert.deepEqual([...new Set(under.map((r) => r.id))].sort(), ["J", "K", "L", "M", "N", "T"]);
  for (const r of under) {
    assert.equal(r.type, 0);
    for (const [a, b] of r.under) assert.ok(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b > a && b < r.line.length, r.id);
  }
  assert.ok(T.routes.some((r) => r.type === 5 && !r.under), "cable cars are in, with no tunnel");
  assert.ok(T.routes.some((r) => r.id === "F" && !r.under));
  // made-up line: only the marked stretch is skipped
  const line = [[37.76, -122.42], [37.77, -122.42], [37.78, -122.42]];
  const area = { name: "Made-up dip", shapes: [{ type: "circle", center: [37.765, -122.42], radius_m: 40 }] };
  assert.deepEqual(B.passes(line, { areas: [area] }).past, ["Made-up dip"]);
  assert.deepEqual(B.passes(line, { areas: [area] }, [[0, 1]]).past, []);
  assert.deepEqual(B.passes(line, { areas: [area] }, [[1, 2]]).past, ["Made-up dip"]);
});

test("lines that only run at rush hour are left out, and headsigns use a real apostrophe", () => {
  const ids = new Set(T.routes.map((r) => r.id));
  for (const id of ["1X", "8AX", "8BX", "30X"]) assert.ok(!ids.has(id), id);
  for (const id of ["1", "8", "30", "14", "14R", "38R"]) assert.ok(ids.has(id), id);
  assert.ok(!JSON.stringify(T).includes("`"));
  assert.ok(T.routes.some((r) => r.toward === "Fisherman's Wharf"));
});

test("neighbor water: the bus card uses the page's own list and never names a number of hours or days", () => {
  assert.match(pageBlock, /waterNow/);
  assert.doesNotMatch(pageBlock, /36e5|created_at/);
  assert.doesNotMatch(code + pageBlock, /last \d+ (h|hours|days)|last 2 days|48 \* /);
});

test("SFMTA's data notice travels with the data and is on the page", () => {
  const notice = [
    "Reproduced with permission granted by the City and County of San Francisco. The information has been provided by means of a nonexclusive, limited, and revocable license granted by the City and County of San Francisco.",
    "The City and County of San Francisco does not guarantee the accuracy, adequacy, completeness or usefulness of any information. The City and County of San Francisco provides this information \"as is,\" without warranty of any kind, express or implied, including but not limited to warranties of merchantability or fitness for a particular purpose, and assumes no responsibility for anyone's use of the information.",
  ];
  const noLiability = "The SFMTA and its employees, officers, directors and agents shall not be liable for damages of any kind arising from the use of Data or any application that uses the Data including but not limited to direct, indirect, incidental, punitive and consequential, and or special damages.";
  assert.equal(T.notice, notice.join(" "));
  assert.equal(T.no_liability, noLiability);
  assert.match(T.license, /not covered by this project's open-source license/);
  for (const t of [...notice, noLiability]) assert.ok(page.includes("<p>" + t + "</p>"), t.slice(0, 40));
  assert.ok(page.includes('<details id="busNotice"><summary>Data notice</summary>'));
  assert.ok(page.includes("Not affiliated with or endorsed by SFMTA."));
  assert.doesNotMatch(page, /route_color|sfmta\.com\/[^"]*\.(png|svg|jpg)/i);
});
