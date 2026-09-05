// Coverage map: one H3 hex per ~7 m of open ground, coloured by what can reach it.
// Green = stretcher fits and hose reaches, amber = walker only or hose short,
// red = no 0.5 m route at all. Cells whose centre is under a roof are skipped.
//
// Two modes: from the staged engine (computeCoverage), or ward-scale, where every
// pocket is scored from its nearest drivable street point (computeWardCoverage).
import { cellToBoundary, cellToLatLng, polygonToCells } from "h3-js";
import { dist, makeProjector, makeUnprojector, pathLength, pointInRing, type Block, type Pt } from "./geo.ts";
import { HOSE_LIMIT_M, inArea, type BakeArea, type Solver } from "./nav.ts";

export type CellStatus = "green" | "amber" | "red";

export interface CoverageCell {
  h3: string;
  center: Pt;
  ring: Pt[];
  status: CellStatus;
  walkerLen: number | null;
  stretcherLen: number | null;
  reason: string;
}

export interface Coverage {
  res: number;
  cells: CoverageCell[];
  structures: number;
  counts: Record<CellStatus, number>;
}

export interface StagingCandidate {
  at: Pt;
  street: string;
  served: number; // pockets whose nearest reachable street point is this one
  rank: number | null; // 1 = serves the most pockets
}

export interface PlanStep {
  candidate: number; // index into candidates
  covered: number; // green pockets newly covered by this point
  cumulativeShare: number; // share of all green pockets covered after this step
}

export interface WardCoverage extends Coverage {
  candidates: StagingCandidate[];
  bestFor: number[]; // per cell: candidate index, -1 when unreachable
  plan: PlanStep[]; // greedy staging plan: fewest street points covering the green pockets
}

export const PLAN_TARGET = 0.95; // stop the plan once this share of green pockets is covered
export const PLAN_MAX_POINTS = 6;

export const H3_RES = 13; // average cell area 44 m2
export const H3_CELL_M = 7; // flat-to-flat width of a res-13 cell, rounded, for labels
export const CANDIDATE_SPACING_M = 25;

const DRIVABLE = new Set(["primary", "secondary", "tertiary", "residential", "living_street", "unclassified", "service"]);

interface GridCell {
  h3: string;
  center: Pt;
  ring: Pt[];
}

/** H3 cells over the bake area whose centre is on open ground. */
function cellGrid(block: Block, area: BakeArea, res: number): { grid: GridCell[]; structures: number } {
  const toLatLng = makeUnprojector(block.origin);
  const toXY = makeProjector(block.origin);
  const corners: Pt[] = [
    [area.cx - area.half, area.cy - area.half],
    [area.cx + area.half, area.cy - area.half],
    [area.cx + area.half, area.cy + area.half],
    [area.cx - area.half, area.cy + area.half],
  ];
  const buildings = block.buildings.filter((b) => inArea(b, area));
  const grid: GridCell[] = [];
  let structures = 0;
  for (const h3 of polygonToCells(corners.map(toLatLng), res)) {
    const [lat, lng] = cellToLatLng(h3);
    const center = toXY(lat, lng);
    const underRoof = buildings.some(
      (b) =>
        center[0] >= b.bbox[0] && center[0] <= b.bbox[2] && center[1] >= b.bbox[1] && center[1] <= b.bbox[3] && pointInRing(center, b.ring),
    );
    if (underRoof) {
      structures++;
      continue;
    }
    grid.push({ h3, center, ring: cellToBoundary(h3).map(([la, ln]) => toXY(la, ln)) });
  }
  return { grid, structures };
}

/** Classify one pocket given the walker path length from its staging point. */
function score(g: GridCell, from: Pt, walkerLen: number, stretcher: Solver): CoverageCell {
  const s = stretcher.solve(from, g.center, { endSnap: 3 });
  const stretcherLen = s.ok ? pathLength(s.path) : null;
  if (!s.ok) return { ...g, status: "amber", walkerLen, stretcherLen, reason: "walker only, stretcher blocked" };
  if (walkerLen > HOSE_LIMIT_M) {
    return { ...g, status: "amber", walkerLen, stretcherLen, reason: `hose short by ${(walkerLen - HOSE_LIMIT_M).toFixed(0)} m` };
  }
  return { ...g, status: "green", walkerLen, stretcherLen, reason: "stretcher fits, hose reaches" };
}

export function computeCoverage(
  block: Block,
  area: BakeArea,
  staging: Pt,
  walker: Solver,
  stretcher: Solver,
  res = H3_RES,
): Coverage {
  const { grid, structures } = cellGrid(block, area, res);
  const cells: CoverageCell[] = [];
  const counts: Record<CellStatus, number> = { green: 0, amber: 0, red: 0 };
  for (const g of grid) {
    // tight snap: a pocket must be reachable within its own footprint, not via a neighbour 12 m away
    const w = walker.solve(staging, g.center, { endSnap: 3 });
    const cell: CoverageCell = w.ok
      ? score(g, staging, pathLength(w.path), stretcher)
      : { ...g, status: "red", walkerLen: null, stretcherLen: null, reason: "no 0.5 m route" };
    counts[cell.status]++;
    cells.push(cell);
  }
  return { res, cells, structures, counts };
}

/** Points every `spacing` metres along the drivable streets inside the bake area. */
export function streetCandidates(block: Block, area: BakeArea, spacing = CANDIDATE_SPACING_M): { at: Pt; street: string }[] {
  const inside = (p: Pt) => Math.abs(p[0] - area.cx) < area.half - 2 && Math.abs(p[1] - area.cy) < area.half - 2;
  const out: { at: Pt; street: string }[] = [];
  for (const s of block.streets) {
    if (!DRIVABLE.has(s.kind)) continue;
    let next = spacing / 2;
    for (let i = 0; i < s.pts.length - 1; i++) {
      const a = s.pts[i];
      const b = s.pts[i + 1];
      const L = dist(a, b);
      if (L === 0) continue;
      while (next <= L) {
        const p: Pt = [a[0] + ((b[0] - a[0]) * next) / L, a[1] + ((b[1] - a[1]) * next) / L];
        if (inside(p) && !out.some((o) => dist(o.at, p) < spacing / 2)) out.push({ at: p, street: s.name ?? s.kind.replace("_", " ") });
        next += spacing;
      }
      next -= L;
    }
  }
  return out;
}

/** Ward-scale: every pocket scored from its nearest reachable street point. */
export function computeWardCoverage(block: Block, area: BakeArea, walker: Solver, stretcher: Solver, res = H3_RES): WardCoverage {
  const candidates: StagingCandidate[] = streetCandidates(block, area).map((c) => ({ ...c, served: 0, rank: null }));
  const { grid, structures } = cellGrid(block, area, res);
  const cells: CoverageCell[] = [];
  const bestFor: number[] = [];
  const counts: Record<CellStatus, number> = { green: 0, amber: 0, red: 0 };
  for (const g of grid) {
    // straight-line distance lower-bounds the path, so stop once no closer candidate can beat the best path
    const order = candidates.map((c, i) => ({ i, d: dist(c.at, g.center) })).sort((a, b) => a.d - b.d);
    let best = -1;
    let bestLen = Infinity;
    for (const { i, d } of order) {
      if (d >= bestLen) break;
      const w = walker.solve(candidates[i].at, g.center, { endSnap: 3 });
      if (!w.ok) continue;
      const len = pathLength(w.path);
      if (len < bestLen) {
        bestLen = len;
        best = i;
      }
    }
    let cell: CoverageCell;
    if (best < 0) {
      cell = { ...g, status: "red", walkerLen: null, stretcherLen: null, reason: "no 0.5 m route from any street" };
    } else {
      cell = score(g, candidates[best].at, bestLen, stretcher);
      candidates[best].served++;
    }
    counts[cell.status]++;
    cells.push(cell);
    bestFor.push(best);
  }
  // Staging plan: which green pockets each street point can serve within the hose limit
  // (walker path <= 100 m; stretcher fit is taken from the pocket's own score, the stretcher
  // mesh being one connected surface across the block), then greedy set cover.
  const greenIdx = cells.map((c, k) => (c.status === "green" ? k : -1)).filter((k) => k >= 0);
  const reach: Set<number>[] = candidates.map(() => new Set<number>());
  for (const k of greenIdx) {
    const g = cells[k];
    candidates.forEach((c, i) => {
      if (dist(c.at, g.center) > HOSE_LIMIT_M) return; // straight line already too long
      if (i === bestFor[k]) {
        reach[i].add(k);
        return;
      }
      const w = walker.solve(c.at, g.center, { endSnap: 3 });
      if (w.ok && pathLength(w.path) <= HOSE_LIMIT_M) reach[i].add(k);
    });
  }
  const plan: PlanStep[] = [];
  const uncovered = new Set(greenIdx);
  let coveredSoFar = 0;
  while (uncovered.size > 0 && plan.length < PLAN_MAX_POINTS) {
    let bestI = -1;
    let bestGain = 0;
    reach.forEach((set, i) => {
      let gain = 0;
      for (const k of set) if (uncovered.has(k)) gain++;
      if (gain > bestGain) {
        bestGain = gain;
        bestI = i;
      }
    });
    if (bestI < 0) break;
    for (const k of reach[bestI]) uncovered.delete(k);
    coveredSoFar += bestGain;
    plan.push({ candidate: bestI, covered: bestGain, cumulativeShare: greenIdx.length ? coveredSoFar / greenIdx.length : 0 });
    if (plan[plan.length - 1].cumulativeShare >= PLAN_TARGET) break;
  }
  plan.forEach((step, r) => (candidates[step.candidate].rank = r + 1));
  return { res, cells, structures, counts, candidates, bestFor, plan };
}
