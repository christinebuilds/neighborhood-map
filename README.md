# My Neighborhood Map

My Neighborhood Map: an engine for neighborhood maps, one folder per city. San Francisco is the first city.

## Start here

<img src="docs/screenshot.png" alt="The map on a phone: weather for today, the Nature & walks and Storms & flooding tabs, and the Plan a walk button" width="300" align="right">

New here? Welcome. You can help with or without code, and AI coding tools (Claude Code, Cursor and others) are welcome. Live map: **https://sfcommunitymap.org/**

**Run it on your computer** (no install, no build step):

```
python3 -m http.server 8931
```

Then open http://localhost:8931/ in your browser. Use your browser's phone view, since most neighbors use the map on a phone.

**Where things live**

| File | What it does |
|---|---|
| `index.html` | The whole map: styles, page and script in one file. All three tabs live here. |
| `cities/sf/city.json` | San Francisco settings: map bounds, data feeds, phone numbers, links, rain notes. |
| `cities/sf/past-storms.json` | Places that flooded in past storms, each with a source link. |
| `flood.html` | Short "About the flood map" page. `today.html` and `walk.html` only redirect. |
| `flood/`, `walks/`, `route/`, `drive/`, `forecast/` | Short addresses to share: `/flood`, `/walks`, `/route` and `/forecast` open the map on the right tab. `/drive` is the older address for `/route` and still works. |
| `CNAME` | The site's web address (`sfcommunitymap.org`) for GitHub Pages. |
| `tools/validate.mjs` | Checks the city files. Run `node tools/validate.mjs` before every pull request. |
| `supabase/migrations/` | Record of the database setup for neighbor reports. Only Christine applies changes. |
| `assets/`, `manifest.webmanifest` | Icons and the link preview picture. |
| `docs/` | Plans and notes. |
| `CLAUDE.md` | Rules for AI coding agents (and a good checklist for people too). |

**Pick a task:** the [features wishlist](https://github.com/christinebuilds/neighborhood-map/issues?q=is%3Aissue+is%3Aopen+label%3Awishlist) has ideas neighbors asked for, each with where to start and how to test. New to this? Try one labeled [good first issue](https://github.com/christinebuilds/neighborhood-map/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22). Comment "I'll take this" to claim it, then read [CONTRIBUTING.md](CONTRIBUTING.md).

**Not an official city service.** This map is made by neighbors. It is not a warning system. In an emergency call 9-1-1. Report flooding to the city at 3-1-1.

<br clear="right">

## What the map does

It is one page with three views of your own block:

- **Nature** (the front door): find your address and the page names your neighborhood. A day strip at the top of every tab shows sunrise, sunset, rain hour by hour, temperature and the best two hours for a walk. The map shows street trees (a density picture when zoomed out, single trees when zoomed in) and wildlife neighbors photographed nearby (iNaturalist). Tap a tree or sighting for a small card and "Walk here" for a walking route, what you will pass, and short detours. A seasonal walk (fall colors, blossom) paints the trees in season.
- **Flooding**: the city's flood zone, places that flooded in past storms (with sources), 311 flooding and drain cases, storm drains with a rule-of-thumb flag for which to check first, and neighbor reports ("water here", "I cleared this drain", "needs clearing", "the water is gone"). Each drain keeps a log of clearings and a way to thank the neighbor. One line under the day strip says where the outlook is heading and links to Forecast.
- **Forecast**: mostly pictures. An arrow and a few words say whether it is getting worse, holding steady or improving, with up to three short reasons; a small live rain radar map of the city and the bay plays the last hour; one chart shows the next 48 hours of rain under the tide line, with the flood level and the times heavy rain lines up with a high tide; Weather Service alerts for the city (tap Show on map to see where); and rain so far. The details and sources are behind "About this forecast". It sums up Weather Service, NOAA, Open-Meteo and radar data. It is not an official warning.

This is not an official city service or a warning system. In an emergency call 9-1-1. Report flooding to the city at 3-1-1.

## Pages and links

- `index.html` is the map. `#flood` opens the Flooding view, `#route` opens it with Plan a route (the older `#drive` does the same), `#nature` opens Nature, `#walk` starts planning a walk, `#forecast` opens Forecast, `#feedback` opens the bug and idea form.
- `flood.html` is a short page titled "SF Flood Map" that says what the flood map is. The link to share for flooding is `sfcommunitymap.org/flood`.
- `today.html` and `walk.html` only redirect to the map, so old links keep working.
- Short addresses to share: `sfcommunitymap.org/flood` opens Flooding, `/walks` opens Nature, `/forecast` opens Forecast, and `/route` opens Plan a route (`/drive` still works and does the same). Each is a tiny page that sends people to the map with `#flood`, `#nature`, `#forecast`, `#route` or `#drive` at the end of the address. `/flood` carries the flood map's own link preview.
- `version.txt` holds the build time. The page shows it in the footer and offers to update when a newer one is published.

## Cities

Everything local lives in `cities/<id>/`: `city.json` (bounds, data sources, phone numbers, notes) and `past-storms.json`. The engine loads `cities/sf/` by default; add `?city=<id>` to the address to load another folder. San Francisco is the only city for now; other cities are on hold.

`cities/sf/transit.json` holds Muni's lines and stops for the Transit choice in Plan a route. It is made by `tools/build-transit.py` from the SFMTA's public schedule feed and is used under the SFMTA Transit Data Feed License Agreement, not this project's MIT license. The notice inside the file must stay with any copy. This project is not affiliated with or endorsed by SFMTA.

`cities/sf/bart.json` holds BART's lines and stations in San Francisco, and the first few stations past it, for direct BART rides in Plan a route. It is made by `tools/build-bart.py` from BART's public GTFS schedule feed and is used under BART's Developer License Agreement (https://www.bart.gov/dla), not this project's MIT license. The notice inside the file must stay with any copy. No BART logo, trademark or system map is used. This project is not affiliated with or endorsed by BART. Tests: `node tools/test-bart.mjs`.

## Help improve it

See [CONTRIBUTING.md](CONTRIBUTING.md). Adding a spot in your neighborhood takes one small edit to `cities/sf/past-storms.json`, or you can fill in an issue form with no coding at all. Not a coder? Tap **💬 Feedback** at the top of the map.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## How it is built

One static engine page (`index.html`) with Leaflet and no build step, plus one settings folder per city under `cities/`, published with GitHub Pages. All links between pages are relative, so the site works under any repository name. Neighbor reports are stored in Supabase; notes and photos are checked automatically before they appear.

## Third-party code

The Forecast tab's tide estimate, flood-level grades, outlook rules and alert filter are adapted from [bay-flood](https://github.com/mcsplat/bay-flood) by Matt Carter, under the MIT License. The ported functions in `index.html` are marked, and the full license notice is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
