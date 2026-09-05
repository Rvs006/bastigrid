"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  corridorProfile,
  dist,
  makeUnprojector,
  parseOsm,
  pathLength,
  scanChokepoints,
  splitAtLength,
  type BBox,
  type Block,
  type Chokepoint,
  type HeightTable,
  type OsmJson,
  type ProfileSample,
  type Pt,
} from "@/lib/geo";
import { bakeSolver, inArea, loadSolver, HOSE_LIMIT_M, PROFILES, type AgentProfile, type ProfileId, type Solver } from "@/lib/nav";
import { AREA, DATA_URL, ORIGIN } from "@/lib/block";
import { computeCoverage, computeWardCoverage, streetCandidates, type Coverage, type WardCoverage } from "@/lib/coverage";
import { IMAGERY_ATTRIBUTION, loadImagery, type Imagery } from "@/lib/satellite";
import { digipin } from "@/lib/brief";
import ClearanceChart from "./ClearanceChart";
import Brief from "./Brief";

const BlockScene = dynamic(() => import("./BlockScene"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-paper" />,
});

// ?demo presets a solved scene: engine on the living street, fire on a hut at the edge of the densest
// cluster (34 m stretcher route through a 1.11 m alley). Interior huts there are on-foot only. Override
// with ?s=x,y (engine) and ?i=x,y (fire) in local metres; ?demo=coverage or ?demo=ward opens Planning.
const DEMO: { engine: Pt; fire: Pt } = { engine: [72.4, -31.9], fire: [80.8, -6.3] };
const IMAGERY_MARGIN_M = 60;
const HEIGHTS_URL = "/data/heights.json";

type Screen = "dispatch" | "planning";
type PlanMode = "engine" | "ward";
type CoverageMode = "off" | PlanMode;
type Tap = "fire" | "engine";
type GroundMode = "imagery" | "paper";

const CREW: Record<ProfileId, { label: string; short: string; detail: string }> = {
  stretcher: { label: "Stretcher crew", short: "Stretcher crew", detail: "two bearers with a scoop stretcher, needs 0.85 m" },
  walker: { label: "Firefighter on foot", short: "On foot", detail: "one person with the hose, fits through 0.5 m" },
};

interface Route {
  profile: AgentProfile;
  path: Pt[];
  length: number;
  within: Pt[];
  beyond: Pt[];
  samples: ProfileSample[];
  min: ProfileSample;
  nearFlags: { flag: Chokepoint; at: number }[];
  offsetM: number; // distance from the tapped building to where the route actually ends
}

interface Blocked {
  partial: Pt[]; // how far the crew gets before the alley closes
  reachedM: number;
}

interface LogEntry {
  id: number;
  t: string;
  text: string;
  tone?: "ok" | "warn";
}

const clock = () => new Date().toLocaleTimeString("en-IN", { hour12: false, hour: "2-digit", minute: "2-digit" });
const secs = (s: number) => (s < 60 ? `${Math.round(s)} seconds` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`);
const short = (s: number) => (s < 60 ? `${Math.round(s)} S` : `${Math.floor(s / 60)} M ${String(Math.round(s % 60)).padStart(2, "0")} S`);
const pct = (n: number, total: number) => (total ? Math.round((100 * n) / total) : 0);
const dateWord = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const toLatLng = makeUnprojector(ORIGIN);

export default function Dispatch() {
  const [block, setBlock] = useState<Block | null>(null);
  const [dataAsOf, setDataAsOf] = useState("");
  const [chokepoints, setChokepoints] = useState<Chokepoint[]>([]);
  const [profileId, setProfileId] = useState<ProfileId>("stretcher");
  const [baked, setBaked] = useState<Partial<Record<ProfileId, { ms: number; source: Solver["source"] }>>>({});
  const [error, setError] = useState<string | null>(null);
  const [fire, setFire] = useState<Pt | null>(null);
  const [target, setTarget] = useState<Pt | null>(null); // reachable point the route aims at, near the fire
  const [engine, setEngine] = useState<Pt | null>(null);
  const [engineAuto, setEngineAuto] = useState(false);
  const [noWay, setNoWay] = useState(false);
  const [tap, setTap] = useState<Tap>("fire");
  const [route, setRoute] = useState<Route | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [screen, setScreen] = useState<Screen>("dispatch");
  const [planMode, setPlanMode] = useState<PlanMode>("engine");
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [ward, setWard] = useState<WardCoverage | null>(null);
  const [imagery, setImagery] = useState<Imagery | null>(null);
  const [imageryState, setImageryState] = useState<"loading" | "ok" | "failed">("loading");
  const [groundMode, setGroundMode] = useState<GroundMode>("paper");
  const [online, setOnline] = useState(true);
  const [heightsMeasured, setHeightsMeasured] = useState(0);
  const [briefOpen, setBriefOpen] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const solvers = useRef<Partial<Record<ProfileId, Solver>>>({});
  const loading = useRef<Partial<Record<ProfileId, boolean>>>({});
  const dataBytes = useRef(0);
  const wardCache = useRef<WardCoverage | null>(null);
  const logId = useRef(0);

  // the reach maps live on the Planning screen only; Dispatch shows the one fire and its route
  const coverageMode: CoverageMode = screen === "planning" ? planMode : "off";

  const say = useCallback((text: string, tone?: LogEntry["tone"]) => {
    setLog((l) => [...l.slice(-11), { id: ++logId.current, t: clock(), text, tone }]);
  }, []);

  const placeFire = useCallback((p: Pt) => {
    setFire(p);
    setTarget(null);
    setEngine(null);
    setEngineAuto(false);
    setNoWay(false);
    setTap("engine");
  }, []);

  // 0. connectivity, for the offline note
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors a platform API into state once, on mount
    setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // 1. block data, imagery, demo scene, dev hook
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(DATA_URL).then((r) => r.arrayBuffer()),
      fetch(HEIGHTS_URL)
        .then((r) => (r.ok ? (r.json() as Promise<{ buildings: HeightTable }>) : null))
        .catch(() => null),
    ])
      .then(([buf, heights]) => {
        if (cancelled) return;
        dataBytes.current = buf.byteLength;
        const json = JSON.parse(new TextDecoder().decode(buf)) as OsmJson & { osm3s?: { timestamp_osm_base?: string } };
        const b = parseOsm(json, ORIGIN, heights?.buildings ?? null);
        setBlock(b);
        const stamp = json.osm3s?.timestamp_osm_base;
        setDataAsOf(stamp ? dateWord(stamp) : "");
        const measured = b.buildings.filter((x) => x.heightSource === "open-buildings").length;
        setHeightsMeasured(measured);
        const flags = scanChokepoints(b.buildings.filter((x) => inArea(x, AREA)));
        setChokepoints(flags);
        say(`Block loaded: ${b.buildings.length} real building footprints, ${flags.length} gaps under 0.75 m found.`);
        if (measured) say(`Heights: Open Buildings 2.5D (2023 imagery) for ${measured} of ${b.buildings.length} buildings, the rest estimated.`);

        const [x0, y0, x1, y1] = b.bbox;
        const bounds: BBox = [x0 - IMAGERY_MARGIN_M, y0 - IMAGERY_MARGIN_M, x1 + IMAGERY_MARGIN_M, y1 + IMAGERY_MARGIN_M];
        loadImagery(ORIGIN, bounds)
          .then((img) => {
            if (cancelled) return;
            setImagery(img);
            setImageryState(img.failed < img.tiles ? "ok" : "failed");
            say(
              img.failed
                ? `Imagery: ${img.tiles - img.failed} of ${img.tiles} tiles loaded, the rest show as paper.`
                : `Imagery: ${img.tiles} tiles loaded, roofs drawn from the photo when Satellite is on.`,
              img.failed ? "warn" : undefined,
            );
          })
          .catch(() => {
            if (cancelled) return;
            setImageryState("failed");
            say("Imagery unavailable, showing the model.", "warn");
          });

        const params = new URLSearchParams(window.location.search);
        const demo = params.get("demo");
        const pt = (key: string, fallback: Pt): Pt => {
          const v = params.get(key)?.split(",").map(Number);
          return v && v.length === 2 && v.every(Number.isFinite) ? [v[0], v[1]] : fallback;
        };
        if (demo !== null) {
          setFire(pt("i", DEMO.fire));
          setEngine(pt("s", DEMO.engine));
          setTap("engine");
          if (demo === "ward" || demo === "coverage") {
            setScreen("planning");
            setPlanMode(demo === "ward" ? "ward" : "engine");
          }
          say("Demo scene loaded: engine on the living street, fire on a hut in the densest cluster.");
        }
        const setCoverageMode = (m: CoverageMode) => {
          if (m === "off") setScreen("dispatch");
          else {
            setScreen("planning");
            setPlanMode(m);
          }
        };
        (window as unknown as { __bastigrid?: object }).__bastigrid = {
          placeFire,
          setFire,
          setEngine,
          setEngineAuto,
          setTap,
          setScreen,
          setPlanMode,
          setCoverageMode,
          setProfileId,
          setGroundMode,
          setBriefOpen,
          solvers,
          candidates: () => streetCandidates(b, AREA),
        };
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [say, placeFire]);

  // 2. both navmeshes, strictly one after the other: pre-baked binaries first, live bake as the fallback.
  //    Two bakes racing through init() once produced a corrupt second mesh, so never run them in parallel.
  useEffect(() => {
    if (!block) return;
    // no timer and no cleanup: a re-run (strict mode, hot reload) must never cancel a load in flight,
    // it just sees the in-flight flag and leaves the first run to finish
    (async () => {
      for (const id of ["stretcher", "walker"] as ProfileId[]) {
        if (solvers.current[id] || loading.current[id]) continue;
        loading.current[id] = true;
        try {
          const profile = PROFILES[id];
          const s = (await loadSolver(profile, dataBytes.current)) ?? (await bakeSolver(block, profile, AREA));
          solvers.current[id] = s;
          setBaked((b) => ({ ...b, [id]: { ms: s.bakeMs, source: s.source } }));
          say(
            s.source === "baked"
              ? `${CREW[id].label} mesh loaded from the pre-baked file in ${(s.bakeMs / 1000).toFixed(1)} s.`
              : `${CREW[id].label} mesh measured live in ${(s.bakeMs / 1000).toFixed(1)} s (no pre-baked file matched).`,
          );
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          loading.current[id] = false;
        }
      }
    })();
  }, [block, say]);

  // 3. auto-place the engine: the road point with the shortest on-foot route to the fire. A hut's nearest
  //    walkable spot can be an enclosed pocket, so search a widening ring around the tap until a route exists.
  useEffect(() => {
    const walker = solvers.current.walker;
    if (!block || !fire || engine || !walker) return;
    const cands = streetCandidates(block, AREA);
    const dirs: Pt[] = [
      [1, 0],
      [0.707, 0.707],
      [0, 1],
      [-0.707, 0.707],
      [-1, 0],
      [-0.707, -0.707],
      [0, -1],
      [0.707, -0.707],
    ];
    let found: { at: Pt; target: Pt; len: number } | null = null;
    outer: for (const r of [0, 4, 8, 12, 16]) {
      for (const d of r === 0 ? ([[0, 0]] as Pt[]) : dirs) {
        const t: Pt = [fire[0] + r * d[0], fire[1] + r * d[1]];
        let best: { at: Pt; len: number } | null = null;
        for (const c of cands) {
          if (best && dist(c.at, t) >= best.len) continue;
          const res = walker.solve(c.at, t);
          if (!res.ok) continue;
          const len = pathLength(res.path);
          if (!best || len < best.len) best = { at: c.at, len };
        }
        if (best) {
          found = { at: best.at, target: t, len: best.len };
          break outer;
        }
      }
    }
    if (found) {
      setEngine(found.at);
      setTarget(found.target);
      setEngineAuto(true);
      setNoWay(false);
      setTap("engine");
      say(`Engine placed at the nearest road point with a route on foot (${found.len.toFixed(0)} m).`);
    } else {
      setTarget(null);
      setNoWay(true);
      say("No road point has a route on foot to that building.", "warn");
    }
  }, [block, fire, engine, baked, say]);

  // 4. solve the crew's route whenever inputs change
  useEffect(() => {
    const solver = solvers.current[profileId];
    if (!block || !solver || !engine || !fire) {
      setRoute(null);
      setBlocked(null);
      return;
    }
    const aim = target ?? fire;
    const r = solver.solve(engine, aim);
    if (!r.ok) {
      setRoute(null);
      setBlocked({ partial: r.path, reachedM: pathLength(r.path) });
      say(`${CREW[profileId].label}: ${r.reason ?? "no route"}.`, "warn");
      return;
    }
    const length = pathLength(r.path);
    const [within, beyond] = splitAtLength(r.path, HOSE_LIMIT_M);
    const samples = corridorProfile(r.path, block.buildings);
    const min = samples.reduce((m, p) => (p.w < m.w ? p : m), samples[0]);
    const nearFlags = chokepoints
      .map((flag) => {
        const s = samples.reduce((m, p) => (dist(p.at, flag.at) < dist(m.at, flag.at) ? p : m), samples[0]);
        return { flag, at: s.s, d: dist(s.at, flag.at) };
      })
      .filter((f) => f.d < 10)
      .sort((a, b) => a.at - b.at)
      .slice(0, 6);
    const end = r.path[r.path.length - 1];
    setRoute({ profile: solver.profile, path: r.path, length, within, beyond, samples, min, nearFlags, offsetM: dist(end, fire) });
    setBlocked(null);
    say(
      `${CREW[profileId].label}: route found, ${length.toFixed(0)} m, tightest gap ${min.w.toFixed(2)} m, hose ${
        length <= HOSE_LIMIT_M ? `reaches with ${(HOSE_LIMIT_M - length).toFixed(0)} m spare` : `${(length - HOSE_LIMIT_M).toFixed(0)} m short`
      }.`,
      length <= HOSE_LIMIT_M ? "ok" : "warn",
    );
  }, [block, profileId, engine, fire, target, baked, chokepoints, say]);

  // 5. reach maps: from this engine, or the block plan (nearest road point per pocket + fewest stops)
  useEffect(() => {
    const walker = solvers.current.walker;
    const stretcher = solvers.current.stretcher;
    if (coverageMode === "off" || !block || !walker || !stretcher) {
      setCoverage(null);
      return;
    }
    if (coverageMode === "engine") {
      if (!engine) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- the reach map mirrors the solvers, which live outside React
        setCoverage(null);
        return;
      }
      const cov = computeCoverage(block, AREA, engine, walker, stretcher);
      setCoverage(cov);
      const n = cov.cells.length;
      say(
        `Reach map from this engine: ${pct(cov.counts.green, n)}% of the block gets stretcher and hose, ${pct(cov.counts.amber, n)}% on foot only or hose short, ${pct(cov.counts.red, n)}% out of reach.`,
        cov.counts.red > 0 ? "warn" : "ok",
      );
      return;
    }
    let w = wardCache.current;
    if (!w) {
      w = computeWardCoverage(block, AREA, walker, stretcher);
      wardCache.current = w;
      const last = w.plan[w.plan.length - 1];
      say(
        `Block plan: ${w.plan.length} engine stops cover ${last ? Math.round(100 * last.cumulativeShare) : 0}% of the reachable block. ${pct(w.counts.red, w.cells.length)}% is out of reach from every road.`,
        w.counts.red > 0 ? "warn" : "ok",
      );
    }
    setWard(w);
    setCoverage(w);
  }, [coverageMode, block, engine, baked, say]);

  const onGroundClick = useCallback(
    (p: Pt) => {
      if (screen === "dispatch" && (!fire || tap === "fire")) {
        placeFire(p);
        return;
      }
      setEngine(p);
      setEngineAuto(false);
      say("Engine moved to your road point.");
    },
    [screen, fire, tap, placeFire, say],
  );

  const startOver = () => {
    setFire(null);
    setTarget(null);
    setEngine(null);
    setEngineAuto(false);
    setNoWay(false);
    setRoute(null);
    setBlocked(null);
    setTap("fire");
  };

  const ready = baked.stretcher !== undefined && baked.walker !== undefined;
  const crew = CREW[profileId];
  const who = crew.label.toLowerCase();
  const hoseOk = route ? route.length <= HOSE_LIMIT_M : true;
  const step = !fire ? 1 : !route && !blocked && !noWay ? 2 : 3;
  const cellCount = coverage?.cells.length ?? 0;
  const showImagery = groundMode === "imagery" && imagery !== null;
  const fireCode = fire ? digipin(...toLatLng(fire)) : null;
  // what the verdict rests on, said once, on screen
  const evidence = block
    ? `Walls from OpenStreetMap${dataAsOf ? ` as of ${dataAsOf}` : ""}. ${
        heightsMeasured ? `Heights measured for ${heightsMeasured} of ${block.buildings.length} buildings` : "Heights estimated from footprint size"
      }. Cables, stalls and steps are not surveyed.`
    : "";

  const seg = (active: boolean, onClick: () => void, label: string, key: string, size: "md" | "sm" = "md") => (
    <button
      key={key}
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`rounded-md whitespace-nowrap font-semibold transition-colors ${size === "md" ? "px-2.5 py-2 text-[13px]" : "px-2.5 py-1.5 text-[12px]"} ${
        active ? "bg-ink text-white" : "text-ink-2 hover:text-ink"
      }`}
    >
      {label}
    </button>
  );

  const chip = (label: string, value: string, tone?: "ok" | "warn") => (
    <div className="card px-3.5 py-2.5 shrink-0 pointer-events-auto">
      <div className="lbl">{label}</div>
      <div className={`num mt-0.5 text-[22px] leading-none font-medium whitespace-nowrap ${tone === "ok" ? "text-route" : tone === "warn" ? "text-warn" : "text-ink"}`}>
        {value}
      </div>
    </div>
  );

  const crewSwitch = (
    <div className="flex gap-0.5 p-0.5 rounded-lg bg-paper-2 shrink-0" role="radiogroup" aria-label="Crew">
      {(Object.keys(CREW) as ProfileId[]).map((id) => seg(profileId === id, () => setProfileId(id), CREW[id].short, id, "sm"))}
    </div>
  );

  if (briefOpen && block && route && engine && fire) {
    return (
      <div className="h-full overflow-y-auto">
        <Brief
          block={block}
          crewLabel={crew.label}
          profile={route.profile}
          engine={engine}
          fire={fire}
          path={route.path}
          length={route.length}
          samples={route.samples}
          min={route.min}
          nearFlags={route.nearFlags}
          offsetM={route.offsetM}
          heightsMeasured={heightsMeasured}
          dataAsOf={dataAsOf}
          imageryOn={showImagery}
          onBack={() => setBriefOpen(false)}
        />
      </div>
    );
  }

  const stepLabel = error
    ? "Problem"
    : !block || !ready
      ? "Getting ready"
      : step === 1
        ? "Step 1 of 3"
        : step === 2
          ? "Step 2 of 3"
          : "Step 3 of 3";

  return (
    <div className="relative h-full min-h-0 bg-paper text-ink overflow-hidden">
      {block && (
        <div className="absolute inset-0 z-0">
          <BlockScene
            block={block}
            area={AREA}
            imagery={showImagery ? imagery : null}
            staging={engine}
            incident={fire}
            routeWithin={route?.within ?? []}
            routeBeyond={route?.beyond ?? blocked?.partial ?? []}
            chokepoints={route ? route.nearFlags.map((f) => f.flag) : chokepoints}
            coverage={coverageMode !== "off" ? (coverage?.cells ?? null) : null}
            candidates={coverageMode === "ward" ? (ward?.candidates ?? null) : null}
            onGroundClick={onGroundClick}
          />
        </div>
      )}

      {/* everything floats on the map; only the cards take pointer events, the map keeps the rest */}
      <div className="absolute z-10 inset-x-3 lg:inset-x-4 top-3 lg:top-4 flex flex-col gap-3 pointer-events-none">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="card flex items-center gap-2.5 px-3.5 py-2 pointer-events-auto">
              <svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true">
                <path d="M2 2h18v7h-7v11H2z" fill="var(--accent)" />
              </svg>
              <span className="text-[14px] font-bold tracking-[0.16em] leading-none">BASTIGRID</span>
              <span className="lbl hidden sm:inline">Dharavi block</span>
            </div>
            <div className="card flex gap-0.5 p-1 pointer-events-auto" role="radiogroup" aria-label="Screen">
              {seg(screen === "dispatch", () => setScreen("dispatch"), "Dispatch", "dispatch", "sm")}
              {seg(screen === "planning", () => setScreen("planning"), "Planning", "planning", "sm")}
            </div>
            {!online && <div className="card px-3 py-2 text-[12px] font-semibold text-warn pointer-events-auto">Offline. Using the saved block and meshes.</div>}
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex gap-2">
              <div className="card flex gap-0.5 p-1 pointer-events-auto" role="radiogroup" aria-label="Ground">
                {seg(groundMode === "paper", () => setGroundMode("paper"), "Model", "paper", "sm")}
                {seg(groundMode === "imagery", () => setGroundMode("imagery"), "Satellite", "imagery", "sm")}
              </div>
              <details className="relative hidden lg:block pointer-events-auto">
                <summary className="card list-none cursor-pointer select-none px-3 py-2 text-[12px] font-semibold text-ink-2 hover:text-ink">Log</summary>
                <ol className="absolute right-0 top-full mt-2 w-[360px] max-h-[44vh] overflow-y-auto card px-4 py-3 space-y-3">
                  {log.map((e) => (
                    <li key={e.id}>
                      <div className="lbl">{e.t}</div>
                      <div className={`text-[12px] leading-snug mt-0.5 ${e.tone === "warn" ? "text-warn" : e.tone === "ok" ? "text-route" : "text-ink"}`}>{e.text}</div>
                    </li>
                  ))}
                </ol>
              </details>
            </div>
            {groundMode === "imagery" && (
              <div className="card px-2.5 py-1 text-[11px] text-ink-2 pointer-events-auto">
                {imageryState === "loading" ? "Loading the photo tiles…" : imageryState === "failed" ? "Photo tiles did not load, showing the model." : IMAGERY_ATTRIBUTION}
              </div>
            )}
          </div>
        </div>

        {screen === "dispatch" ? (
          <>
            <div className="card px-5 py-4 max-w-[560px] pointer-events-auto">
              <div className="flex items-center justify-between gap-3">
                <div className="lbl truncate">
                  {stepLabel}
                  {step === 3 && block && ready && !error && <span className="hidden sm:inline"> · verdict for the {who}</span>}
                </div>
                {block && ready && !error && crewSwitch}
              </div>
              {error ? (
                <div className="mt-1 text-[14px] text-warn">{error}</div>
              ) : !block || !ready ? (
                <div className="mt-1 text-[20px] lg:text-[24px] font-bold leading-tight">
                  {!block
                    ? "Loading the block…"
                    : baked.stretcher === undefined
                      ? "Loading the measured alleys for the stretcher crew…"
                      : "Loading the measured alleys for firefighters on foot…"}
                </div>
              ) : step === 1 ? (
                <>
                  <div className="mt-1 text-[22px] lg:text-[26px] font-bold leading-tight">Tap the building on fire.</div>
                  <div className="mt-1.5 text-[13px] leading-snug text-ink-2">
                    BastiGrid finds where the engine should stop and tells you whether the {who} and the 100 m hose can reach it through the alleys, and
                    which way to go. Drag to look around, scroll to zoom.
                  </div>
                </>
              ) : step === 2 ? (
                <div className="mt-1 text-[22px] lg:text-[26px] font-bold leading-tight">Finding where the engine should stop…</div>
              ) : noWay && !engine ? (
                <>
                  <div className="mt-1 text-[22px] lg:text-[26px] font-bold leading-tight text-warn">Map shows no way in from any road.</div>
                  <div className="mt-2 text-[14px] leading-snug">
                    Even a firefighter on foot has no mapped alley to this building within 16 m. Tap a road spot to try an engine position yourself, or
                    move the fire.
                  </div>
                </>
              ) : route ? (
                <>
                  <div className={`mt-1 text-[22px] lg:text-[26px] font-bold leading-tight ${hoseOk ? "text-route" : "text-warn"}`}>
                    {hoseOk ? `Map says the ${who} fits and the hose reaches.` : `Map says the ${who} fits, the hose does not.`}
                  </div>
                  <div className="mt-2 text-[14px] leading-snug">
                    <span className="num">{route.length.toFixed(0)} m</span> on foot from the engine, about {secs(route.length / route.profile.speed)}. Tightest
                    gap <span className="num">{route.min.w.toFixed(2)} m</span>, <span className="num">{route.min.s.toFixed(0)} m</span> in.
                    {hoseOk ? (
                      <>
                        {" "}
                        Hose reaches with <span className="num">{(HOSE_LIMIT_M - route.length).toFixed(0)} m</span> spare.
                      </>
                    ) : (
                      <>
                        {" "}
                        Hose runs out <span className="num">{(route.length - HOSE_LIMIT_M).toFixed(0)} m</span> short: relay pump, or stop the engine closer.
                      </>
                    )}
                    {route.offsetM > 3 && (
                      <span className="hidden sm:inline">
                        {" "}
                        The route ends <span className="num">{route.offsetM.toFixed(0)} m</span> from the building, the last stretch is not mapped as open
                        ground.
                      </span>
                    )}
                    {route.nearFlags.length > 0 && (
                      <span className="hidden sm:inline">
                        {" "}
                        {route.nearFlags.length} side {route.nearFlags.length > 1 ? "gaps" : "gap"} under 0.75 m along the way, do not turn into them.
                      </span>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <button onClick={() => setBriefOpen(true)} className="text-[13px] font-semibold px-3 py-1.5 rounded-md bg-accent text-white">
                      Open the action brief
                    </button>
                    <span className="text-[13px] text-ink-2 hidden sm:inline">
                      {engineAuto ? "Engine stop chosen by BastiGrid, nearest road point with a way in. " : "Engine stop set by you. "}
                      Tap a road spot to move it.
                    </span>
                  </div>
                </>
              ) : blocked ? (
                <>
                  <div className="mt-1 text-[22px] lg:text-[26px] font-bold leading-tight text-warn">
                    {blocked.reachedM > 0 ? `Map says the ${who} is blocked ${blocked.reachedM.toFixed(0)} m in.` : `Map says the ${who} is blocked at the engine.`}
                  </div>
                  <div className="mt-2 text-[14px] leading-snug">
                    {blocked.reachedM > 0 ? (
                      <>
                        They get <span className="num">{blocked.reachedM.toFixed(0)} m</span> in, then the alley narrows below {PROFILES[profileId].width} m.
                      </>
                    ) : (
                      <>No alley from this engine stop is {PROFILES[profileId].width} m wide.</>
                    )}
                    {profileId === "stretcher" && " A firefighter on foot may still get through."}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {profileId === "stretcher" && (
                      <button onClick={() => setProfileId("walker")} className="text-[13px] font-semibold px-3 py-1.5 rounded-md bg-accent text-white">
                        Try on foot
                      </button>
                    )}
                    <span className="text-[13px] text-ink-2 self-center">or tap a different road spot for the engine</span>
                  </div>
                </>
              ) : null}
              {step === 3 && (
                <div className="mt-3 text-[12px] leading-snug text-ink-2">
                  {fireCode && (
                    <>
                      Fire at DIGIPIN <span className="num text-ink">{fireCode}</span>.{" "}
                    </>
                  )}
                  {evidence}
                </div>
              )}
              {fire && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  <span className="text-[12px] text-ink-2">Next tap moves</span>
                  <div className="flex gap-0.5 p-0.5 rounded-lg bg-paper-2" role="radiogroup" aria-label="What the next tap moves">
                    {seg(tap === "fire", () => setTap("fire"), "the fire", "tap-fire", "sm")}
                    {seg(tap === "engine", () => setTap("engine"), "the engine", "tap-engine", "sm")}
                  </div>
                  <button onClick={startOver} className="ml-auto text-[12px] text-muted hover:text-ink">
                    Start over
                  </button>
                </div>
              )}
            </div>

            {route && (
              <div className="flex gap-2.5 overflow-x-auto">
                {chip("On foot", `${route.length.toFixed(0)} M`)}
                {chip("Time", short(route.length / route.profile.speed))}
                {chip("Tightest gap", `${route.min.w.toFixed(2)} M`, route.min.w >= PROFILES[profileId].width ? "ok" : "warn")}
                {chip("Hose left", `${Math.max(0, HOSE_LIMIT_M - route.length).toFixed(0)} M`, hoseOk ? "ok" : "warn")}
              </div>
            )}
          </>
        ) : (
          <div className="card px-5 py-4 max-w-[560px] pointer-events-auto">
            <div className="flex items-center justify-between gap-3">
              <div className="lbl">Planning</div>
              <div className="flex gap-0.5 p-0.5 rounded-lg bg-paper-2 shrink-0" role="radiogroup" aria-label="Reach map">
                {seg(planMode === "engine", () => setPlanMode("engine"), "This engine", "engine", "sm")}
                {seg(planMode === "ward", () => setPlanMode("ward"), "Block plan", "ward", "sm")}
              </div>
            </div>
            <div className="mt-1 text-[22px] lg:text-[26px] font-bold leading-tight">
              {!block || !ready ? "Loading the measured alleys…" : planMode === "engine" ? "What this engine stop reaches." : "Where engines should stop."}
            </div>
            <div className="mt-1.5 text-[13px] leading-snug text-ink-2">
              {planMode === "engine"
                ? engine
                  ? "Every pocket of the block, coloured by what can get there from the engine. Tap a road spot to move the engine."
                  : "Tap a road spot to place the engine, and the block colours by what can get there from it."
                : "The fewest engine stops that put the block within stretcher and hose reach, numbered on the map, best first."}
            </div>
            {coverage && (
              <div className="mt-3 grid grid-cols-[auto_auto_1fr] items-baseline gap-x-3 gap-y-1 text-[13px]">
                <span className="w-2.5 h-2.5 rounded-[3px] bg-route self-center" />
                <span className="num text-[15px] text-ink">{pct(coverage.counts.green, cellCount)} %</span>
                <span className="text-ink-2">stretcher and hose reach</span>
                <span className="w-2.5 h-2.5 rounded-[3px] bg-amber self-center" />
                <span className="num text-[15px] text-ink">{pct(coverage.counts.amber, cellCount)} %</span>
                <span className="text-ink-2">on foot only, or hose short</span>
                <span className="w-2.5 h-2.5 rounded-[3px] bg-warn self-center" />
                <span className="num text-[15px] text-ink">{pct(coverage.counts.red, cellCount)} %</span>
                <span className="text-ink-2">nobody gets in</span>
              </div>
            )}
            {planMode === "ward" && ward && ward.plan.length > 0 && (
              <ol className="mt-3 border-t border-line pt-3 space-y-1 text-[13px]">
                {ward.plan.map((s, i) => (
                  <li key={i} className="flex items-baseline gap-3">
                    <span className="num w-5 h-5 rounded-full bg-ink text-white text-[11px] font-semibold flex items-center justify-center self-center shrink-0">
                      {i + 1}
                    </span>
                    <span className="text-ink-2 min-w-0 truncate">{ward.candidates[s.candidate]?.street || "unnamed road"}</span>
                    <span className="num ml-auto text-ink whitespace-nowrap">{Math.round(100 * s.cumulativeShare)} % covered</span>
                  </li>
                ))}
              </ol>
            )}
            {block && ready && (
              <div className="mt-3 text-[12px] leading-snug text-ink-2">
                Pockets are 7 m hexes. {evidence}
              </div>
            )}
          </div>
        )}
      </div>

      {screen === "dispatch" && route && (
        <div className="absolute z-10 left-3 lg:left-4 right-3 lg:right-4 bottom-3 lg:bottom-4 card px-4 pt-3 pb-2 min-w-0 max-sm:hidden [@media(max-height:640px)]:hidden">
          <div className="flex items-baseline justify-between gap-4 min-w-0">
            <div className="lbl shrink-0">Alley width along the route</div>
            <div className="lbl truncate min-w-0">the {who} needs {PROFILES[profileId].width} m</div>
          </div>
          <ClearanceChart samples={route.samples} limit={route.profile.width} total={route.length} hoseLimit={HOSE_LIMIT_M} />
        </div>
      )}
    </div>
  );
}
