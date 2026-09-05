"use client";

import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { Environment, Html, Lightformer, Line, MapControls } from "@react-three/drei";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { MapControls as MapControlsImpl } from "three-stdlib";
import { useEffect, useMemo, useRef } from "react";
import type { Block, Chokepoint, Pt } from "@/lib/geo";
import type { CellStatus, CoverageCell, StagingCandidate } from "@/lib/coverage";
import type { Imagery } from "@/lib/satellite";
import { footprintGeometry, type BakeArea } from "@/lib/nav";

export interface SceneProps {
  block: Block;
  area: BakeArea;
  imagery: Imagery | null;
  staging: Pt | null;
  incident: Pt | null;
  routeWithin: Pt[];
  routeBeyond: Pt[];
  chokepoints: Chokepoint[];
  coverage: CoverageCell[] | null;
  candidates: StagingCandidate[] | null;
  onGroundClick: (p: Pt) => void;
}

const C = {
  bg: "#f7f6f2",
  edge: "#b3afa3",
  street: "#d3d0c5",
  route: "#157a42",
  over: "#c93a30",
  accent: "#c9421f",
  accentDark: "#8f2c14",
  amber: "#b7791f",
  shadow: "#3d3524",
};
// white model city: roofs a shade under the page, walls a shade under the roofs, light does the rest
const ROOF = new THREE.Color("#eae8e3");
const WALL = new THREE.Color("#d9d6cf");
const COVER: Record<CellStatus, string> = { green: "#1a9a52", amber: "#d69a2e", red: "#c93a30" };

const up = (p: Pt, y: number): [number, number, number] => [p[0], y, -p[1]];
function flatShape(ring: Pt[]): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  ring.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Fine paper grain, felt more than seen. */
function grainTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 236 + Math.round((Math.random() - 0.5) * 12);
    img.data[i] = v;
    img.data[i + 1] = v - 2;
    img.data[i + 2] = v - 10;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(90, 90);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Copy the vertex ranges of one ExtrudeGeometry material group (0 = caps, 1 = walls) into a new geometry. */
function slice(g: THREE.BufferGeometry, materialIndex: number): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const groups = g.groups.filter((gr) => gr.materialIndex === materialIndex);
  const total = groups.reduce((n, gr) => n + gr.count, 0);
  for (const name of ["position", "normal", "uv"]) {
    const attr = g.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!attr) continue;
    const size = attr.itemSize;
    const arr = new Float32Array(total * size);
    let o = 0;
    for (const gr of groups) {
      arr.set((attr.array as Float32Array).subarray(gr.start * size, (gr.start + gr.count) * size), o);
      o += gr.count * size;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return out;
}

/**
 * Every footprint as two meshes, roofs and walls, casting soft shadows. With imagery on, roof UVs are
 * the roof's own position in the photo, so each hut wears its real roof.
 */
function Buildings({ block, imagery }: { block: Block; imagery: Imagery | null }) {
  const bounds = imagery?.bounds;
  const { roofs, walls, edges } = useMemo(() => {
    const roofParts: THREE.BufferGeometry[] = [];
    const wallParts: THREE.BufferGeometry[] = [];
    for (const b of block.buildings) {
      const g = footprintGeometry(b, b.height);
      roofParts.push(slice(g, 0));
      wallParts.push(slice(g, 1));
      g.dispose();
    }
    const roofs = mergeGeometries(roofParts)!;
    const walls = mergeGeometries(wallParts)!;
    // roof UVs in imagery space, so each roof samples its own spot in the photo (built here, not in an
    // effect: with an on-demand frameloop a later mutation would wait for the next interaction to show)
    if (bounds) {
      const [x0, y0, x1, y1] = bounds;
      const pos = roofs.getAttribute("position") as THREE.BufferAttribute;
      const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        uv[i * 2] = (pos.getX(i) - x0) / (x1 - x0);
        uv[i * 2 + 1] = (-pos.getZ(i) - y0) / (y1 - y0);
      }
      roofs.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    }
    const all = mergeGeometries([roofs, walls])!;
    const edges = new THREE.EdgesGeometry(all, 25);
    all.dispose();
    return { roofs, walls, edges };
  }, [block, bounds]);

  return (
    <group>
      <mesh geometry={roofs} castShadow receiveShadow>
        {/* keyed: a material that gains a map later keeps its old shader program, so mount a fresh one */}
        {imagery ? (
          <meshStandardMaterial key="photo" map={imagery.texture} color="#ffffff" roughness={0.95} metalness={0} />
        ) : (
          <meshStandardMaterial key="flat" color={ROOF} flatShading roughness={0.95} metalness={0} />
        )}
      </mesh>
      <mesh geometry={walls} castShadow receiveShadow>
        <meshStandardMaterial color={imagery ? "#c4bfae" : WALL} flatShading roughness={0.95} metalness={0} />
      </mesh>
      <lineSegments geometry={edges}>
        <lineBasicMaterial color={imagery ? "#6b665a" : C.edge} transparent opacity={imagery ? 0.35 : 0.55} />
      </lineSegments>
    </group>
  );
}

function Streets({ block }: { block: Block }) {
  return (
    <>
      {block.streets.map((s) => {
        const minor = s.kind === "footway" || s.kind === "pedestrian";
        return (
          <Line
            key={s.id}
            points={s.pts.map((p) => up(p, 0.05))}
            color={C.street}
            lineWidth={minor ? 1.2 : 2.5}
            dashed={minor}
            dashSize={1.5}
            gapSize={1}
          />
        );
      })}
    </>
  );
}

function Ground({ block, area, imagery, onClick }: { block: Block; area: BakeArea; imagery: Imagery | null; onClick: (p: Pt) => void }) {
  const grain = useMemo(() => grainTexture(), []);
  const [minX, minY, maxX, maxY] = block.bbox;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const w = maxX - minX + 400;
  const h = maxY - minY + 400;
  const x0 = area.cx - area.half;
  const x1 = area.cx + area.half;
  const y0 = area.cy - area.half;
  const y1 = area.cy + area.half;
  const outline: [number, number, number][] = [
    [x0, 0.06, -y0],
    [x1, 0.06, -y0],
    [x1, 0.06, -y1],
    [x0, 0.06, -y1],
    [x0, 0.06, -y0],
  ];
  return (
    <>
      {/* paper: unlit so the page colour stays exact, shadows come from the layer above */}
      <mesh rotation-x={-Math.PI / 2} position={[cx, -0.03, -cy]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial map={grain} color="#fdfcfa" />
      </mesh>
      {/* the photo sits on the paper like a print, unlit, true colour */}
      {imagery && (
        <mesh
          rotation-x={-Math.PI / 2}
          position={[(imagery.bounds[0] + imagery.bounds[2]) / 2, -0.02, -(imagery.bounds[1] + imagery.bounds[3]) / 2]}
        >
          <planeGeometry args={[imagery.bounds[2] - imagery.bounds[0], imagery.bounds[3] - imagery.bounds[1]]} />
          <meshBasicMaterial map={imagery.texture} />
        </mesh>
      )}
      <mesh rotation-x={-Math.PI / 2} position={[cx, 0, -cy]} receiveShadow>
        <planeGeometry args={[w, h]} />
        <shadowMaterial color={C.shadow} transparent opacity={imagery ? 0.28 : 0.15} />
      </mesh>
      {/* the block we measured: a hair lighter on paper, and always the click target */}
      <mesh
        rotation-x={-Math.PI / 2}
        position={[area.cx, 0.01, -area.cy]}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onClick([e.point.x, -e.point.z]);
        }}
      >
        <planeGeometry args={[area.half * 2, area.half * 2]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={imagery ? 0 : 0.35} depthWrite={false} />
      </mesh>
      <Line points={outline} color={imagery ? "#fbfaf6" : C.edge} lineWidth={1} dashed dashSize={2} gapSize={1.5} transparent opacity={0.8} />
    </>
  );
}

/** H3 coverage hexes, one merged mesh per status, inset so the ground shows between cells. */
function CoverageLayer({ cells }: { cells: CoverageCell[] }) {
  const layers = useMemo(() => {
    const inset = (c: CoverageCell): Pt[] =>
      c.ring.map(([x, y]) => [c.center[0] + (x - c.center[0]) * 0.84, c.center[1] + (y - c.center[1]) * 0.84]);
    const out: { status: CellStatus; fill: THREE.BufferGeometry }[] = [];
    for (const status of ["green", "amber", "red"] as CellStatus[]) {
      const shapes = cells.filter((c) => c.status === status).map((c) => flatShape(inset(c)));
      if (shapes.length) out.push({ status, fill: mergeGeometries(shapes)! });
    }
    return out;
  }, [cells]);
  return (
    <group position-y={0.12}>
      {layers.map(({ status, fill }) => (
        <mesh key={status} geometry={fill}>
          <meshBasicMaterial color={COVER[status]} transparent opacity={0.5} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

/** Street points that serve at least one pocket; the plan's stops carry a rank badge. */
function Candidates({ list }: { list: StagingCandidate[] }) {
  return (
    <>
      {list
        .filter((c) => c.served > 0)
        .map((c, i) => {
          const top = c.rank !== null && c.rank <= 3;
          return (
            <group key={i} position={up(c.at, 0)}>
              <mesh rotation-x={-Math.PI / 2} position-y={0.4}>
                <circleGeometry args={[top ? 2.2 : 1.1, 32]} />
                <meshBasicMaterial color={top ? C.accent : C.edge} />
              </mesh>
              {top && (
                <Html position={[0, 5.5, 0]} center zIndexRange={[20, 0]}>
                  <div className="num h-6 w-6 rounded-full bg-ink text-paper border border-paper text-[12px] font-semibold flex items-center justify-center select-none">
                    {c.rank}
                  </div>
                </Html>
              )}
            </group>
          );
        })}
    </>
  );
}

/** A compact tender, low-poly: chassis, cab, hose reel, four wheels. */
function Staging({ p }: { p: Pt }) {
  return (
    <group position={up(p, 0)}>
      <mesh position={[0, 1.1, 0]} castShadow>
        <boxGeometry args={[4.6, 1.4, 2.1]} />
        <meshStandardMaterial color={C.accent} roughness={0.7} />
      </mesh>
      <mesh position={[1.75, 2.15, 0]} castShadow>
        <boxGeometry args={[1.3, 0.9, 2.0]} />
        <meshStandardMaterial color={C.accentDark} roughness={0.7} />
      </mesh>
      <mesh position={[-0.9, 2.05, 0]} rotation-z={Math.PI / 2}>
        <cylinderGeometry args={[0.45, 0.45, 1.2, 16]} />
        <meshStandardMaterial color="#e8e2d2" roughness={0.9} />
      </mesh>
      {[-1.5, 1.5].map((x) =>
        [-1.05, 1.05].map((z) => (
          <mesh key={`${x}${z}`} position={[x, 0.42, z]} rotation-x={Math.PI / 2}>
            <cylinderGeometry args={[0.42, 0.42, 0.3, 16]} />
            <meshStandardMaterial color="#2b2822" roughness={0.9} />
          </mesh>
        )),
      )}
    </group>
  );
}

function Incident({ p }: { p: Pt }) {
  return (
    <group position={up(p, 0)}>
      <mesh rotation-x={-Math.PI / 2} position-y={0.14}>
        <ringGeometry args={[1.5, 2.2, 48]} />
        <meshBasicMaterial color={C.over} transparent opacity={0.85} side={THREE.DoubleSide} />
      </mesh>
      <mesh position-y={3.2}>
        <cylinderGeometry args={[0.1, 0.1, 6.4, 8]} />
        <meshBasicMaterial color={C.over} />
      </mesh>
      <mesh position-y={6.6}>
        <sphereGeometry args={[0.6, 16, 16]} />
        <meshBasicMaterial color={C.over} />
      </mesh>
    </group>
  );
}

function Flags({ chokepoints }: { chokepoints: Chokepoint[] }) {
  return (
    <>
      {chokepoints.map((c, i) => (
        <mesh key={i} position={up(c.at, 1.9)}>
          <octahedronGeometry args={[0.42]} />
          <meshStandardMaterial color={C.amber} />
        </mesh>
      ))}
    </>
  );
}

/** Glides the camera to frame whatever is on stage: engine, fire and route. */
function Framer({ focus, controls }: { focus: Pt[]; controls: React.RefObject<MapControlsImpl | null> }) {
  const { camera, invalidate, size } = useThree();
  const key = focus.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("|");
  // a phone held upright has the verdict card over the top half, so the action is pushed further down the screen
  const portrait = size.height > size.width;
  useEffect(() => {
    if (!focus.length || !controls.current) return;
    const xs = focus.map((p) => p[0]);
    const ys = focus.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const span = Math.max(40, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const d = span * (portrait ? 3.1 : 2.3);
    // aim north of the action so it sits between the verdict card and the chart
    const aimY = cy + span * (portrait ? 0.5 : 0.2);
    const toTarget = new THREE.Vector3(cx, 0, -aimY);
    const to = new THREE.Vector3(cx + d * 0.15, d * 0.75, -aimY + d * 0.7);
    const from = camera.position.clone();
    const fromTarget = controls.current.target.clone();
    const t0 = performance.now();
    const step = (k: number) => {
      const e = 1 - Math.pow(1 - k, 3);
      camera.position.lerpVectors(from, to, e);
      controls.current?.target.lerpVectors(fromTarget, toTarget, e);
      controls.current?.update();
      invalidate();
    };
    // timer-driven tween: animation frames are paused in background or embedded tabs, timers are not
    let timer = 0;
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / 650);
      step(k);
      if (k < 1) timer = window.setTimeout(tick, 16);
    };
    tick();
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, portrait]);
  return null;
}

export default function BlockScene(props: SceneProps) {
  const { block, area, imagery, staging, incident, routeWithin, routeBeyond, chokepoints, coverage, candidates, onGroundClick } = props;
  const controls = useRef<MapControlsImpl | null>(null);
  const focus = useMemo(() => {
    const pts: Pt[] = [];
    if (staging) pts.push(staging);
    if (incident) pts.push(incident);
    return pts.concat(routeWithin, routeBeyond);
  }, [staging, incident, routeWithin, routeBeyond]);
  const [bx0, by0, bx1, by1] = block.bbox;
  const lightTarget = useMemo(() => {
    const o = new THREE.Object3D();
    o.position.set((bx0 + bx1) / 2, 0, -(by0 + by1) / 2);
    return o;
  }, [bx0, by0, bx1, by1]);

  return (
    <Canvas
      frameloop="demand"
      shadows="soft"
      dpr={[1, 1.5]}
      camera={{ position: [area.cx + 10, 115, -area.cy + 100], fov: 38, near: 1, far: 3000 }}
      gl={{ antialias: true, toneMapping: THREE.NoToneMapping }}
    >
      <color attach="background" args={[C.bg]} />
      <fog attach="fog" args={[C.bg, 260, 720]} />
      {/* image-based light from three soft panels, no external HDR: warm sky above, cool fill at the horizon, ground bounce */}
      <Environment resolution={128} frames={1} environmentIntensity={0.5}>
        <Lightformer form="rect" intensity={1.1} color="#fdfbf7" position={[0, 60, 0]} rotation-x={Math.PI / 2} scale={[200, 200, 1]} />
        <Lightformer form="rect" intensity={0.45} color="#dde6ee" position={[0, 12, -90]} scale={[220, 40, 1]} />
        <Lightformer form="rect" intensity={0.3} color="#e6e3dc" position={[0, -20, 0]} rotation-x={-Math.PI / 2} scale={[200, 200, 1]} />
      </Environment>
      <hemisphereLight args={["#fbf8f0", "#ddd6c4", 0.2]} />
      <primitive object={lightTarget} />
      <directionalLight
        castShadow
        target={lightTarget}
        position={[(bx0 + bx1) / 2 - 160, 210, -(by0 + by1) / 2 + 190]}
        intensity={0.85}
        color="#fff7ec"
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-320}
        shadow-camera-right={320}
        shadow-camera-top={320}
        shadow-camera-bottom={-320}
        shadow-camera-near={20}
        shadow-camera-far={800}
        shadow-bias={-0.0004}
        shadow-normalBias={0.12}
        shadow-radius={4}
      />
      <Ground block={block} area={area} imagery={imagery} onClick={onGroundClick} />
      {!imagery && <Streets block={block} />}
      {coverage && coverage.length > 0 && <CoverageLayer cells={coverage} />}
      <Buildings block={block} imagery={imagery} />
      <Flags chokepoints={chokepoints} />
      {routeWithin.length > 1 && (
        <>
          <Line points={routeWithin.map((p) => up(p, 0.28))} color={C.bg} lineWidth={7} transparent opacity={0.9} />
          <Line points={routeWithin.map((p) => up(p, 0.3))} color={C.route} lineWidth={3.5} />
        </>
      )}
      {routeBeyond.length > 1 && (
        <>
          <Line points={routeBeyond.map((p) => up(p, 0.28))} color={C.bg} lineWidth={7} transparent opacity={0.9} />
          <Line points={routeBeyond.map((p) => up(p, 0.3))} color={C.over} lineWidth={3.5} dashed dashSize={1.2} gapSize={0.8} />
        </>
      )}
      {candidates && candidates.length > 0 && <Candidates list={candidates} />}
      {staging && <Staging p={staging} />}
      {incident && <Incident p={incident} />}
      <MapControls ref={controls} target={[area.cx, 0, -area.cy]} maxPolarAngle={Math.PI / 2.4} minDistance={25} maxDistance={600} />
      <Framer focus={focus} controls={controls} />
    </Canvas>
  );
}
