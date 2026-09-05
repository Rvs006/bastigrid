# BastiGrid

Browser-based clearance routing for emergency crews in dense informal settlements. Drop a staging point and an incident on a real Dharavi block, and the engine answers: does a 0.85 m stretcher fit through these alleys, does the 100 m hose reach, and where are the chokepoints.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, TypeScript) |
| 3D | Three.js via React Three Fiber + drei |
| Clearance brain | recast-navigation-js (Recast/Detour in WASM), one navmesh per agent profile |
| Geometry | OpenStreetMap building footprints (ODbL), `public/data/dharavi-osm.json`, projected to local metres at runtime |
| UI | Tailwind v4, Chakra Petch + Chivo Mono |
| Data store | none in the engine; incident log is in-memory for now (Supabase Postgres planned for incidents + field feedback) |

## How to use it

Two screens, switched at the top of the map.

**Dispatch** is the product.

1. Tap the building on fire. BastiGrid places the engine at the nearest road point that has a way in on foot.
2. Read the verdict: "Map says the stretcher crew fits and the hose reaches", or how many metres in it is blocked. Under it, one evidence line says what the verdict rests on (OpenStreetMap walls and their date, how many heights are measured, what is not surveyed) and the fire's DIGIPIN. The chips carry the numbers; the route is drawn through the alleys; the chart shows alley width along it.
3. If the stretcher crew is blocked, press "Try on foot" (or switch the crew at the top of the card) to see the single-firefighter route. Tap another road spot to move the engine, or switch the next tap to move the fire. "Open the action brief" prints the crew page.

**Planning** is for the station officer: "This engine" colours the block by what can reach each pocket from the current stop; "Block plan" shows the fewest engine stops that cover the block, numbered on the map with the streets they stand on.

The ground is a white model by default (real footprints, measured heights); "Satellite" at the top right lays the Esri photo under it and textures the roofs from it.

## How the engine works

1. `src/lib/geo.ts` parses the OSM pull into footprints, streets, and a 2D gap scan (every place two walls come within 0.75 m).
2. `src/lib/nav.ts` extrudes footprints as 1.2 m obstacles over a ground plane and bakes a tiled Recast navmesh with the agent's half-width as `walkableRadius` (7.5 cm voxels). The ground under a footprint has less than the 1.9 m walkable height, so it drops out of the mesh.
3. A click on the street and a click on the incident run `findClosestPoint` + `computePath`. The path is measured against the 100 m hose limit, and corridor width is sampled every 0.5 m by casting perpendicular rays at the footprints.
4. `src/lib/coverage.ts` is the coverage map: H3 resolution-13 hexes (about 7 m across, 44 m2) over the block, each scored with both navmeshes. Green = stretcher fits and the walker path is within the hose limit, amber = walker only or hose short, red = no 0.5 m route. Cells whose centre falls under a roof are skipped. Two modes in the rail: "From E-07" scores every pocket from the staged engine; "Best staging" samples the drivable streets every 25 m, scores every pocket from its nearest reachable street point, then runs a greedy set cover to find the fewest street points that put the green pockets within hose reach (numbered markers on the map, plan in the coverage card).

## Demo links

- `/?demo` opens a solved scene: engine on the living street, fire on a hut at the edge of the densest cluster (34 m stretcher route, 1.11 m tightest gap). Interior huts there are on-foot only; tap one and press "Try on foot".
- `/?demo=coverage` adds the reach map from that engine; `/?demo=ward` opens the block plan.
- `?s=x,y` (engine) and `?i=x,y` (fire) override the pins in local metres (x east, y north of 19.0428 N 72.8573 E).

## Action Brief

"Open the action brief" on a solved verdict switches to a one-page A4 brief (`src/components/Brief.tsx`): fire and engine stop as Plus Codes, verdict, key numbers, a north-up plan of the route with side gaps, the alley-width profile, turn-by-turn legs derived from the string-pulled path (`src/lib/brief.ts`, a new step at every heading change over 22 degrees, narrowest width per leg), hazards, hose note, and provenance. "Print or save as PDF" uses the browser's print dialog with print CSS in `globals.css`; nothing else is needed. `node src/lib/brief.check.mts` tests the leg builder, compass words and Plus Codes.

## Pre-baked meshes, offline, imagery

- `npm run bake` rasterises both navmeshes in Node (about 2 s each) into `public/nav/*.bin` with a manifest. The app loads them in about a second; if the manifest version or the data file size does not match, it bakes live in the browser as before. Re-run after changing the footprints or the Recast config, and bump `NAV_VERSION` in `src/lib/nav.ts` when the geometry rules change.
- `public/sw.js` is a hand-written service worker, registered in production builds only. It precaches the shell, the block data and the meshes, caches app chunks and imagery tiles as they load, and serves the cached shell for any navigation when offline. `public/manifest.json` and the icons make it installable on a phone.
- The ground is Esri World Imagery at zoom 19, stitched in the browser from tiles (`src/lib/satellite.ts`), placed in metres under the block, with each roof textured from its own spot in the photo. Attribution is required and shown in the rail. "Paper" in the rail switches back to the footprint-only view.

## Run

This machine blocks `.cmd` shims, so the npm scripts call node directly:

```bash
npm run dev
```

Self-check for the geometry math:

```bash
node src/lib/geo.check.mts
```

## Data provenance

OSM footprints and streets around 19.041 N 72.857 E (Dharavi, Mumbai). Building heights come from Google Open Buildings 2.5D Temporal v1 (building_height band, 2023 imagery, 0.5 m rasters, CC BY 4.0 / ODbL): `npm run heights` finds the 12.5 km UTM tile that covers the block in the public bucket, reads only the window under the footprints with HTTP range requests (about 3 s, no Earth Engine account), takes the 80th percentile of height pixels under each footprint, and writes `public/data/heights.json`. 178 of 181 buildings get a measured height (median 5 m); the rest fall back to an area-based estimate, and OSM `height` or `building:levels` tags are used when present. Overhead clearance (cables, overhangs) is unsurveyed. Conditions change; verify on approach.
