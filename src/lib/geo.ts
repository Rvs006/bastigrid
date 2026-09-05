// Geometry layer: OSM -> local metres, footprint gap scan, corridor width along a path.
// Pt = [x east, y north] in metres from the block origin.

export type Pt = [number, number];
export type BBox = [number, number, number, number]; // minX, minY, maxX, maxY

export interface Building {
  id: number;
  ring: Pt[]; // closed polygon, last point != first
  bbox: BBox;
  area: number; // m2
  height: number; // m
  heightSource: "osm" | "estimate" | "open-buildings";
}

export interface Street {
  id: number;
  kind: string;
  name?: string;
  pts: Pt[];
}

export interface Block {
  origin: { lat: number; lon: number };
  buildings: Building[];
  streets: Street[];
  bbox: BBox;
}

export interface Chokepoint {
  at: Pt;
  width: number;
  a: number; // building ids
  b: number;
}

interface OsmElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}
export interface OsmJson {
  elements: OsmElement[];
}

const M_PER_DEG_LAT = 110574;

export function makeProjector(origin: { lat: number; lon: number }) {
  const mPerDegLon = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  return (lat: number, lon: number): Pt => [
    (lon - origin.lon) * mPerDegLon,
    (lat - origin.lat) * M_PER_DEG_LAT,
  ];
}

/** Inverse of makeProjector: local metres -> [lat, lng]. */
export function makeUnprojector(origin: { lat: number; lon: number }) {
  const mPerDegLon = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  return (p: Pt): [number, number] => [origin.lat + p[1] / M_PER_DEG_LAT, origin.lon + p[0] / mPerDegLon];
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Ray-casting point-in-polygon; points on the boundary count as outside. */
export function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function ringArea(r: Pt[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i];
    const [x2, y2] = r[(i + 1) % r.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function bboxOf(pts: Pt[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function estimateHeight(tags: Record<string, string>, area: number): [number, Building["heightSource"]] {
  const h = parseFloat(tags["height"] ?? "");
  if (Number.isFinite(h) && h > 0) return [h, "osm"];
  const levels = parseInt(tags["building:levels"] ?? "", 10);
  if (Number.isFinite(levels) && levels > 0) return [levels * 3.1, "osm"];
  // ponytail: area-based guess until Open Buildings 2.5D heights are wired in
  return [area < 45 ? 3.2 : area < 150 ? 6.4 : 9.5, "estimate"];
}

/** Measured heights keyed by OSM way id, from scripts/heights.mts (Open Buildings 2.5D). */
export type HeightTable = Record<string, { h: number; px: number }>;

export function parseOsm(osm: OsmJson, origin: { lat: number; lon: number }, measured?: HeightTable | null): Block {
  const proj = makeProjector(origin);
  const buildings: Building[] = [];
  const streets: Street[] = [];
  for (const el of osm.elements) {
    const tags = el.tags ?? {};
    const g = el.geometry;
    if (!g || g.length < 2) continue;
    if (tags.building) {
      if (parseInt(tags.layer ?? "0", 10) < 0) continue; // underground structures
      const ring = g.map((p) => proj(p.lat, p.lon));
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (ring.length > 3 && first[0] === last[0] && first[1] === last[1]) ring.pop();
      if (ring.length < 3) continue;
      const area = ringArea(ring);
      if (area < 4) continue;
      const ob = measured?.[String(el.id)];
      const [height, heightSource] = ob ? ([ob.h, "open-buildings"] as const) : estimateHeight(tags, area);
      buildings.push({ id: el.id, ring, bbox: bboxOf(ring), area, height, heightSource });
    } else if (tags.highway) {
      streets.push({ id: el.id, kind: tags.highway, name: tags.name, pts: g.map((p) => proj(p.lat, p.lon)) });
    }
  }
  return { origin, buildings, streets, bbox: bboxOf(buildings.flatMap((b) => b.ring)) };
}

function closestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return a;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * dx, a[1] + t * dy];
}

/** Closest pair of boundary points between two rings (vertex-to-edge, both ways). */
function ringGap(P: Pt[], Q: Pt[]): { d: number; p: Pt; q: Pt } {
  let best = { d: Infinity, p: P[0], q: Q[0] };
  const scan = (A: Pt[], B: Pt[], flip: boolean) => {
    for (const v of A) {
      for (let j = 0; j < B.length; j++) {
        const c = closestOnSegment(v, B[j], B[(j + 1) % B.length]);
        const d = dist(v, c);
        if (d < best.d) best = flip ? { d, p: c, q: v } : { d, p: v, q: c };
      }
    }
  };
  scan(P, Q, false);
  scan(Q, P, true);
  return best;
}

function bboxGap(a: BBox, b: BBox): number {
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
  return Math.hypot(dx, dy);
}

/** Footprint gap scan: every place two buildings' walls come within [minWidth, maxWidth) of each other. */
export function scanChokepoints(buildings: Building[], minWidth = 0.3, maxWidth = 0.75): Chokepoint[] {
  const found: Chokepoint[] = [];
  for (let i = 0; i < buildings.length; i++) {
    for (let j = i + 1; j < buildings.length; j++) {
      const A = buildings[i];
      const B = buildings[j];
      if (bboxGap(A.bbox, B.bbox) >= maxWidth) continue;
      const g = ringGap(A.ring, B.ring);
      if (g.d >= minWidth && g.d < maxWidth) {
        found.push({ at: [(g.p[0] + g.q[0]) / 2, (g.p[1] + g.q[1]) / 2], width: g.d, a: A.id, b: B.id });
      }
    }
  }
  // keep the narrowest flag per 2 m cluster
  found.sort((a, b) => a.width - b.width);
  const kept: Chokepoint[] = [];
  for (const c of found) if (!kept.some((k) => dist(k.at, c.at) < 2)) kept.push(c);
  return kept;
}

/** t >= 0 where o + t*d crosses segment ab, or null. */
function raySegment(o: Pt, d: Pt, a: Pt, b: Pt): number | null {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const den = d[0] * ey - d[1] * ex;
  if (Math.abs(den) < 1e-9) return null;
  const ox = a[0] - o[0];
  const oy = a[1] - o[1];
  const t = (ox * ey - oy * ex) / den;
  const u = (ox * d[1] - oy * d[0]) / den;
  return t >= 0 && u >= 0 && u <= 1 ? t : null;
}

export interface ProfileSample {
  s: number; // metres along the path
  w: number; // corridor width (left + right), capped at 2*maxRay
  left: number;
  right: number;
  at: Pt;
}

export function pathLength(path: Pt[]): number {
  let L = 0;
  for (let i = 1; i < path.length; i++) L += dist(path[i - 1], path[i]);
  return L;
}

/** Split a polyline at arc length L: [first L metres, remainder]. */
export function splitAtLength(path: Pt[], L: number): [Pt[], Pt[]] {
  if (path.length < 2 || pathLength(path) <= L) return [path, []];
  const head: Pt[] = [path[0]];
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const seg = dist(path[i - 1], path[i]);
    if (acc + seg >= L) {
      const f = (L - acc) / seg;
      const cut: Pt = [
        path[i - 1][0] + (path[i][0] - path[i - 1][0]) * f,
        path[i - 1][1] + (path[i][1] - path[i - 1][1]) * f,
      ];
      head.push(cut);
      return [head, [cut, ...path.slice(i)]];
    }
    head.push(path[i]);
    acc += seg;
  }
  return [head, []];
}

/** Corridor width sampled perpendicular to the path every `step` metres. */
export function corridorProfile(path: Pt[], buildings: Building[], step = 0.5, maxRay = 6): ProfileSample[] {
  const out: ProfileSample[] = [];
  const nearby = (p: Pt) =>
    buildings.filter(
      (b) =>
        p[0] > b.bbox[0] - maxRay &&
        p[0] < b.bbox[2] + maxRay &&
        p[1] > b.bbox[1] - maxRay &&
        p[1] < b.bbox[3] + maxRay,
    );
  const cast = (o: Pt, d: Pt, cands: Building[]) => {
    let best = maxRay;
    for (const b of cands) {
      const r = b.ring;
      for (let j = 0; j < r.length; j++) {
        const t = raySegment(o, d, r[j], r[(j + 1) % r.length]);
        if (t !== null && t < best) best = t;
      }
    }
    return best;
  };
  const sample = (p: Pt, d: Pt, s: number) => {
    const n: Pt = [-d[1], d[0]];
    const c = nearby(p);
    const left = cast(p, n, c);
    const right = cast(p, [-n[0], -n[1]], c);
    out.push({ s, w: left + right, left, right, at: p });
  };
  let s = 0;
  let lastDir: Pt = [1, 0];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const L = dist(a, b);
    if (L === 0) continue;
    const d: Pt = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    lastDir = d;
    for (let t = 0; t < L; t += step) sample([a[0] + d[0] * t, a[1] + d[1] * t], d, s + t);
    s += L;
  }
  if (path.length > 1) sample(path[path.length - 1], lastDir, s); // exact end point
  return out;
}
