// Checks every city folder under cities/. Run with: node tools/validate.mjs
import { readFileSync, readdirSync } from "node:fs";

const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const isStr = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[<>]/.test(v);
const https = (u) => typeof u === "string" && /^https:\/\/[^\s"<>]+$/.test(u);
const pair = (p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "number" && typeof p[1] === "number";

let total = 0;
for (const id of readdirSync(new URL("../cities/", import.meta.url))) {
  const dir = new URL(`../cities/${id}/`, import.meta.url);
  if (!/^[a-z0-9-]+$/.test(id)) { fail(`cities/${id}`, "folder name must be lowercase letters, digits or hyphens"); continue; }

  // ---- city.json: the settings for one city
  let city;
  try { city = JSON.parse(readFileSync(new URL("city.json", dir), "utf8")); }
  catch (e) { fail(`cities/${id}/city.json`, "is missing or not valid JSON: " + e.message); continue; }
  const wc = `cities/${id}/city.json`;
  if (city.id !== id) fail(wc, `"id" must match the folder name "${id}"`);
  if (!isStr(city.name, 60)) fail(wc, "name is required");
  if (!isStr(city.title, 80)) fail(wc, "title is required");
  if (!Array.isArray(city.maintainers) || city.maintainers.length === 0) fail(wc, "list at least one maintainer");
  const bd = city.bounds;
  const boundsOk = Array.isArray(bd) && bd.length === 2 && pair(bd[0]) && pair(bd[1]) && bd[0][0] < bd[1][0] && bd[0][1] < bd[1][1];
  if (!boundsOk) fail(wc, "bounds must be [[south, west], [north, east]]");
  if (!pair(city.weather_point)) fail(wc, "weather_point must be [latitude, longitude]");
  if (!Array.isArray(city.open_data_hosts) || !city.open_data_hosts.every(https)) fail(wc, "open_data_hosts must be https:// addresses");
  for (const l of city.links || []) if (!isStr(l.label, 80) || !https(l.url)) fail(wc, "each link needs a label and an https:// url");
  for (const n of city.rain_notes || []) {
    if (!isStr(n.text, 400)) fail(wc, "each rain note needs text of 400 characters or fewer");
    if (n.url !== undefined && !https(n.url)) fail(wc, "rain note url must be https://");
  }
  // rain_so_far: the amounts (in inches) at which "Rain so far" calls the rain heavy, and a storm to compare with
  const rs = city.rain_so_far;
  if (rs !== undefined) {
    const num = (v) => typeof v === "number" && v > 0 && v < 30;
    for (const k of ["hour_heavy_in", "hour_very_heavy_in", "day_soaking_in", "day_big_in"]) if (rs[k] !== undefined && !num(rs[k])) fail(wc, `rain_so_far.${k} must be a number of inches`);
    if (rs.hour_heavy_in >= rs.hour_very_heavy_in) fail(wc, "rain_so_far.hour_heavy_in must be less than hour_very_heavy_in");
    if (rs.day_soaking_in >= rs.day_big_in) fail(wc, "rain_so_far.day_soaking_in must be less than day_big_in");
    if (rs.compare !== undefined && (!isStr(rs.compare.label, 40) || !num(rs.compare.inches))) fail(wc, "rain_so_far.compare needs a label and inches");
  }
  // flood_water_note: one or two short sentences on what flood water can carry, with where the advice comes from
  const fw = city.flood_water_note;
  if (fw !== undefined) {
    if (fw === null || typeof fw !== "object" || !isStr(fw.text, 200) || !isStr(fw.source, 60) || !https(fw.url)) fail(wc, "flood_water_note needs text (200 characters at most), source and an https:// url");
    else if (fw.short !== undefined && !isStr(fw.short, 60)) fail(wc, "flood_water_note.short must be text of 60 characters at most");
    else if (/\b(safe|clean|contaminated)\b/i.test(fw.text + " " + (fw.short || ""))) fail(wc, "flood_water_note must not use the words safe, clean or contaminated: the map cannot test the water");
  }
  // tide_flood_levels: flood levels for the tide station, in feet above MLLW, with where they come from. null means "not known": that level is not graded.
  const tf = city.tide_flood_levels;
  if (tf !== undefined) {
    const lv = ["action", "minor", "moderate", "major"].map((k) => tf[k]);
    if (!lv.every((v) => v === null || v === undefined || (typeof v === "number" && v > 0 && v < 30))) fail(wc, "tide_flood_levels: action, minor, moderate and major must each be feet above MLLW, or null");
    const known = lv.filter((v) => typeof v === "number");
    if (known.some((v, i) => i && v <= known[i - 1])) fail(wc, "tide_flood_levels must go up: action < minor < moderate < major");
    if (typeof tf.minor !== "number" && (typeof tf.moderate === "number" || typeof tf.major === "number")) fail(wc, "tide_flood_levels needs minor before moderate or major");
    if (!https(tf.source_url) || !isStr(tf.as_of, 20) || (tf.note !== undefined && !isStr(tf.note, 800))) fail(wc, "tide_flood_levels needs source_url (https://), as_of (a date) and an optional note of 800 characters or fewer");
    if (!city.tide_station) fail(wc, "tide_flood_levels needs a tide_station");
  }
  // alerts: Weather Service alerts are asked for a whole state ("area", e.g. "CA") and kept only for this county ("county_fips", 6 digits)
  const al = city.alerts;
  if (al !== undefined && (al === null || !/^[A-Z]{2}$/.test(al.area || "") || !/^\d{6}$/.test(al.county_fips || ""))) fail(wc, "alerts needs area (a two-letter state code) and county_fips (six digits, e.g. 006075)");
  if (city.reports_311 && city.reports_311.report_sewage_url !== undefined && !https(city.reports_311.report_sewage_url)) fail(wc, "reports_311.report_sewage_url must be an https:// url");
  const margin = 0.03;
  const inCity = (p) => pair(p) && boundsOk && p[0] >= bd[0][0] - margin && p[0] <= bd[1][0] + margin && p[1] >= bd[0][1] - margin && p[1] <= bd[1][1] + margin;

  // ---- past-storms.json: places that flooded before
  let data;
  try { data = JSON.parse(readFileSync(new URL("past-storms.json", dir), "utf8")); }
  catch (e) { fail(`cities/${id}/past-storms.json`, "is missing or not valid JSON: " + e.message); continue; }
  if (!Array.isArray(data.areas)) fail(`cities/${id}/past-storms.json`, "needs an \"areas\" list");

  (data.areas || []).forEach((a, i) => {
    total++;
    const w = `cities/${id} areas[${i}] (${a && a.name ? a.name : "no name"})`;
    if (!isStr(a.name, 80)) fail(w, "name must be text, 80 characters or fewer, with no < or >");
    if (!["repeat", "reported"].includes(a.tier)) fail(w, "tier must be \"repeat\" or \"reported\"");
    if (!isStr(a.about, 300)) fail(w, "about must be text, 300 characters or fewer");
    if (!Array.isArray(a.shapes) || a.shapes.length === 0) fail(w, "needs at least one shape");
    (a.shapes || []).forEach((s, j) => {
      const ws = `${w} shapes[${j}]`;
      if (s.type === "circle") {
        if (!inCity(s.center)) fail(ws, "center must be [latitude, longitude] inside the city's bounds");
        if (!(s.radius_m >= 20 && s.radius_m <= 300)) fail(ws, "radius_m must be between 20 and 300");
      } else if (s.type === "line") {
        if (!Array.isArray(s.points) || s.points.length < 2 || s.points.length > 20) fail(ws, "points needs 2 to 20 [latitude, longitude] pairs");
        else if (!s.points.every(inCity)) fail(ws, "every point must be [latitude, longitude] inside the city's bounds");
        if (!(s.width_m >= 15 && s.width_m <= 80)) fail(ws, "width_m must be between 15 and 80");
      } else fail(ws, "type must be \"circle\" or \"line\"");
    });
    if (!Array.isArray(a.events) || a.events.length === 0) fail(w, "needs at least one event with a source link");
    (a.events || []).forEach((e, j) => {
      const we = `${w} events[${j}]`;
      if (!isStr(e.when, 60)) fail(we, "when must be text, e.g. \"Dec 31, 2022\" or \"Date not shown\"");
      if (!isStr(e.text, 400)) fail(we, "text must be 400 characters or fewer, in your own words");
      if (!isStr(e.src, 60)) fail(we, "src must name the source, e.g. \"KQED\"");
      if (!https(e.url)) fail(we, "url must be an https:// link to the report");
    });
  });

  // ---- transit.json (optional): bus lines for "Bus or drive?", written by tools/build-transit.py
  let transit = null;
  try { transit = JSON.parse(readFileSync(new URL("transit.json", dir), "utf8")); }
  catch (e) { if (e.code !== "ENOENT") fail(`cities/${id}/transit.json`, "is not valid JSON: " + e.message); }
  if (transit) {
    const wt = `cities/${id}/transit.json`;
    const src = transit.source || {};
    if (!isStr(transit.notice, 1200) || !transit.notice.startsWith("Reproduced with permission granted by the City and County of San Francisco.")) fail(wt, "needs the notice the data license asks for");
    if (!isStr(transit.no_liability, 600) || !isStr(transit.license, 600)) fail(wt, "needs \"no_liability\" and \"license\" (tools/build-transit.py writes them)");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(src.service_from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(src.service_to || "")) fail(wt, "source needs service_from and service_to dates");
    const stops = Array.isArray(transit.stops) ? transit.stops : [];
    if (!stops.length || !stops.every((s) => Array.isArray(s) && s.length === 3 && isStr(s[0], 120) && inCity([s[1], s[2]]))) fail(wt, "every stop must be [name, latitude, longitude] inside the city's bounds");
    if (!Array.isArray(transit.routes) || !transit.routes.length) fail(wt, "needs a \"routes\" list");
    (transit.routes || []).forEach((r, i) => {
      const wr = `${wt} routes[${i}] (${r && r.name ? r.name : "no name"})`;
      if (!isStr(r.id, 12) || !isStr(r.name, 80)) fail(wr, "needs an id and a name");
      if (!Array.isArray(r.line) || r.line.length < 2 || !r.line.every(pair)) fail(wr, "line must be a list of [latitude, longitude] pairs");
      let last = -1;
      const ok = Array.isArray(r.stops) && r.stops.length >= 2 && r.stops.every((s) => {
        const good = Array.isArray(s) && Number.isInteger(s[0]) && s[0] >= 0 && s[0] < stops.length && Number.isInteger(s[1]) && s[1] >= last && s[1] < (r.line || []).length;
        if (good) last = s[1];
        return good;
      });
      if (!ok) fail(wr, "each stop must be [stop number, place on the line], in the order the bus runs");
      // under (rail only): stretches that run underground, which the page does not check against street flooding
      if (r.under !== undefined) {
        const good = Array.isArray(r.under) && r.under.length > 0 && r.under.every((u) => Array.isArray(u) && u.length === 2 && Number.isInteger(u[0]) && Number.isInteger(u[1]) && u[0] >= 0 && u[1] > u[0] && u[1] < r.line.length);
        if (!good || r.type === 3 || r.type === 5) fail(wr, "under must be [first, last] places on the line, and only on a rail line");
      }
    });
  }
}

if (errors.length) {
  console.error("Problems found:\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log(`OK: ${total} past-storm areas checked.`);
