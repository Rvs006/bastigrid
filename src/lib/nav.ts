// Clearance brain: Recast navmesh per agent profile, baked from the block footprints.
// Meshes are pre-baked by scripts/bake.mts into public/nav/*.bin and loaded at runtime;
// bakeSolver() is the live fallback. Three.js coordinates: x east, y up, z = -north.
import * as THREE from "three";
import { importNavMesh, init, NavMeshQuery, type NavMesh } from "recast-navigation";
import { threeToTiledNavMesh } from "@recast-navigation/three";
import type { Block, Building, Pt } from "./geo.ts";

export type ProfileId = "stretcher" | "walker";

export interface AgentProfile {
  id: ProfileId;
  label: string;
  width: number; // m
  height: number; // m
  speed: number; // m/s, loaded, in alleys
  note: string;
}

export const PROFILES: Record<ProfileId, AgentProfile> = {
  stretcher: { id: "stretcher", label: "Stretcher", width: 0.85, height: 1.9, speed: 0.75, note: "scoop stretcher, two bearers" },
  walker: { id: "walker", label: "Walker", width: 0.5, height: 1.9, speed: 1.2, note: "single responder, hose on shoulder" },
};

export const HOSE_LIMIT_M = 100;

export interface BakeArea {
  cx: number;
  cy: number;
  half: number;
}

export interface SolveResult {
  ok: boolean;
  path: Pt[];
  reason?: string;
}

export interface SolveOptions {
  /** How far (m) the end point may snap to reach walkable ground. Default 12: a click on a roof finds the alley beside it. */
  endSnap?: number;
}

export interface Solver {
  profile: AgentProfile;
  bakeMs: number;
  source: "baked" | "live";
  solve(start: Pt, end: Pt, opts?: SolveOptions): SolveResult;
  dispose(): void;
}

/** Written by scripts/bake.mts next to the binaries. */
export interface NavManifest {
  version: number;
  cs: number;
  area: BakeArea;
  dataBytes: number;
  generatedAt: string;
  profiles: Partial<Record<ProfileId, { file: string; bytes: number; bakeMs: number }>>;
}

export const NAV_VERSION = 2; // bump when the geometry rules or the Recast config change; stale binaries are then ignored
export const CS = 0.075; // voxel size (m): walker radius -> 3 vx, stretcher -> 6 vx
const CH = 0.2;
const OBSTACLE_H = 1.2; // lower than walkableHeight, so ground under a footprint becomes unwalkable

export function footprintGeometry(b: Building, height: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  b.ring.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  g.rotateX(-Math.PI / 2); // shape y (north) -> -z, depth -> +y
  return g;
}

export function inArea(b: Building, a: BakeArea): boolean {
  return (
    b.bbox[2] > a.cx - a.half &&
    b.bbox[0] < a.cx + a.half &&
    b.bbox[3] > a.cy - a.half &&
    b.bbox[1] < a.cy + a.half
  );
}

/** Recast config for a profile. Radius, height and climb are in voxels. */
export function navConfig(profile: AgentProfile) {
  return {
    cs: CS,
    ch: CH,
    tileSize: 128,
    walkableSlopeAngle: 45,
    walkableHeight: Math.ceil(profile.height / CH),
    walkableClimb: Math.ceil(0.3 / CH),
    walkableRadius: Math.round(profile.width / 2 / CS),
    maxEdgeLen: 12,
    maxSimplificationError: 1.3,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxVertsPerPoly: 6,
    detailSampleDist: 6,
    detailSampleMaxError: 1,
  };
}

/** Rasterise the block into a navmesh: a ground plane plus every footprint as a low obstacle. */
export async function bakeNavMesh(block: Block, profile: AgentProfile, area: BakeArea): Promise<NavMesh> {
  await init();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(area.half * 2, area.half * 2));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(area.cx, 0, -area.cy);
  const meshes = [
    ground,
    ...block.buildings.filter((b) => inArea(b, area)).map((b) => new THREE.Mesh(footprintGeometry(b, OBSTACLE_H))),
  ];
  meshes.forEach((m) => m.updateMatrixWorld(true));
  const result = threeToTiledNavMesh(meshes, navConfig(profile));
  meshes.forEach((m) => m.geometry.dispose());
  if (!result.success) throw new Error(result.error);
  return result.navMesh;
}

export function solverFromNavMesh(navMesh: NavMesh, profile: AgentProfile, bakeMs: number, source: Solver["source"]): Solver {
  const query = new NavMeshQuery(navMesh);
  // y < OBSTACLE_H so points never snap onto obstacle caps
  const stagingExtents = { x: 4, y: 0.6, z: 4 };
  const toNav = (p: Pt) => ({ x: p[0], y: 0, z: -p[1] });
  return {
    profile,
    bakeMs,
    source,
    solve(start, end, opts) {
      const snap = opts?.endSnap ?? 12;
      const endExtents = { x: snap, y: 0.6, z: snap };
      const s = query.findClosestPoint(toNav(start), { halfExtents: stagingExtents });
      if (!s.success || !s.polyRef) return { ok: false, path: [], reason: "Staging point is not on open ground" };
      const e = query.findClosestPoint(toNav(end), { halfExtents: endExtents });
      if (!e.success || !e.polyRef) {
        return { ok: false, path: [], reason: `No ${profile.width} m clearance at the incident point` };
      }
      const r = query.computePath(s.point, e.point, { halfExtents: stagingExtents, maxPathPolys: 2048, maxStraightPathPoints: 2048 });
      const path: Pt[] = r.path.map((p) => [p.x, -p.z]);
      if (!r.success || path.length < 2) return { ok: false, path: [], reason: r.error?.name ?? "No route" };
      const last = path[path.length - 1];
      const short = Math.hypot(last[0] - e.point.x, last[1] + e.point.z);
      if (short > 1.5) {
        return { ok: false, path, reason: `Route stops ${short.toFixed(0)} m short: no ${profile.width} m-wide way through` };
      }
      return { ok: true, path };
    },
    dispose() {
      query.destroy();
      navMesh.destroy();
    },
  };
}

/** Live bake in the browser, the fallback when no pre-baked mesh matches. */
export async function bakeSolver(block: Block, profile: AgentProfile, area: BakeArea): Promise<Solver> {
  const t0 = performance.now();
  const navMesh = await bakeNavMesh(block, profile, area);
  return solverFromNavMesh(navMesh, profile, Math.round(performance.now() - t0), "live");
}

/**
 * Load a pre-baked mesh. Returns null when the manifest is missing, from another NAV_VERSION,
 * or baked from a different data file, so the caller can fall back to a live bake.
 */
export async function loadSolver(profile: AgentProfile, dataBytes: number, manifestUrl = "/nav/manifest.json"): Promise<Solver | null> {
  try {
    const t0 = performance.now();
    const res = await fetch(manifestUrl);
    if (!res.ok) return null;
    const manifest = (await res.json()) as NavManifest;
    const entry = manifest.version === NAV_VERSION && manifest.dataBytes === dataBytes ? manifest.profiles[profile.id] : undefined;
    if (!entry) return null;
    const bin = await fetch(entry.file);
    if (!bin.ok) return null;
    const data = new Uint8Array(await bin.arrayBuffer());
    await init();
    const { navMesh } = importNavMesh(data);
    return solverFromNavMesh(navMesh, profile, Math.round(performance.now() - t0), "baked");
  } catch {
    return null;
  }
}
