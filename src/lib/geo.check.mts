// Self-check for the geometry math. Run: node src/lib/geo.check.mts
import assert from "node:assert/strict";
import {
  corridorProfile,
  makeProjector,
  makeUnprojector,
  pathLength,
  pointInRing,
  scanChokepoints,
  splitAtLength,
  type Building,
  type Pt,
} from "./geo.ts";

const box = (id: number, x0: number, y0: number, x1: number, y1: number): Building => ({
  id,
  ring: [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ],
  bbox: [x0, y0, x1, y1],
  area: (x1 - x0) * (y1 - y0),
  height: 3,
  heightSource: "estimate",
});

// two walls 1.1 m apart, corridor along x
const walls = [box(1, 0, 1, 20, 5), box(2, 0, -4, 20, -0.1)];
const path: Pt[] = [
  [2, 0.45],
  [18, 0.45],
];
const prof = corridorProfile(path, walls, 1);
assert.ok(
  prof.every((p) => Math.abs(p.w - 1.1) < 1e-6),
  "width should be 1.1, got " + prof.map((p) => p.w.toFixed(2)).join(","),
);
assert.equal(prof[0].s, 0);
assert.ok(Math.abs(prof[prof.length - 1].s - 16) < 1e-9, "last sample sits on the end point");

// gap scan flags a 0.6 m slot, ignores a 3 m street
const flags = scanChokepoints([box(1, 0, 0, 5, 5), box(2, 5.6, 0, 10, 5), box(3, 0, 8, 10, 12)]);
assert.equal(flags.length, 1);
assert.ok(Math.abs(flags[0].width - 0.6) < 1e-9);

// hose split
assert.equal(pathLength([[0, 0], [30, 40]]), 50);
const [head, tail] = splitAtLength(
  [
    [0, 0],
    [60, 0],
    [60, 60],
  ],
  100,
);
assert.deepEqual(head[head.length - 1], [60, 40]);
assert.equal(tail.length, 2);

// projector: 1 km north of the origin, and the inverse round-trips
const origin = { lat: 19.0428, lon: 72.8573 };
const proj = makeProjector(origin);
const unproj = makeUnprojector(origin);
const [x, y] = proj(origin.lat + 1000 / 110574, origin.lon);
assert.ok(Math.abs(x) < 1e-6 && Math.abs(y - 1000) < 1e-6);
const [lat2, lon2] = unproj([75, -48]);
const back = proj(lat2, lon2);
assert.ok(Math.abs(back[0] - 75) < 1e-6 && Math.abs(back[1] + 48) < 1e-6, "unproject round trip");

// point in ring
const sq = box(9, 0, 0, 10, 10).ring;
assert.equal(pointInRing([5, 5], sq), true);
assert.equal(pointInRing([15, 5], sq), false);
assert.equal(pointInRing([5, -0.01], sq), false);

console.log("geo.check: ok");
