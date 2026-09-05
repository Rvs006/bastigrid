"use client";

import type { Block, Chokepoint, Pt, ProfileSample } from "@/lib/geo";
import { makeUnprojector } from "@/lib/geo";
import { briefId, digipin, plusCode, turnLegs } from "@/lib/brief";
import { HOSE_LIMIT_M, type AgentProfile } from "@/lib/nav";
import ClearanceChart from "./ClearanceChart";

export interface BriefProps {
  block: Block;
  crewLabel: string;
  profile: AgentProfile;
  engine: Pt;
  fire: Pt;
  path: Pt[];
  length: number;
  samples: ProfileSample[];
  min: ProfileSample;
  nearFlags: { flag: Chokepoint; at: number }[];
  offsetM: number;
  heightsMeasured: number;
  dataAsOf: string;
  imageryOn: boolean;
  onBack: () => void;
}

/** Top-down plan of the route in metres, north up. */
function Plan({ block, engine, fire, path, flags }: { block: Block; engine: Pt; fire: Pt; path: Pt[]; flags: Chokepoint[] }) {
  const pts = [engine, fire, ...path];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const pad = 22;
  const x0 = Math.min(...xs) - pad;
  const x1 = Math.max(...xs) + pad;
  const y0 = Math.min(...ys) - pad;
  const y1 = Math.max(...ys) + pad;
  const w = x1 - x0;
  const h = y1 - y0;
  const X = (x: number) => x - x0;
  const Y = (y: number) => y1 - y; // north up
  const near = block.buildings.filter((b) => b.bbox[2] > x0 && b.bbox[0] < x1 && b.bbox[3] > y0 && b.bbox[1] < y1);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto block" role="img" aria-label="Plan of the route, north up">
      <rect x={0} y={0} width={w} height={h} fill="#eceadf" />
      {near.map((b) => (
        <polygon key={b.id} points={b.ring.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")} fill="#d3cfc0" stroke="#a8a493" strokeWidth={0.15} />
      ))}
      <polyline points={path.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")} fill="none" stroke="#f6f4ee" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <polyline points={path.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")} fill="none" stroke="#157a42" strokeWidth={0.8} strokeLinejoin="round" strokeLinecap="round" />
      {flags.map((f, i) => (
        <polygon
          key={i}
          points={`${X(f.at[0])},${Y(f.at[1]) - 1.2} ${X(f.at[0]) + 1.2},${Y(f.at[1])} ${X(f.at[0])},${Y(f.at[1]) + 1.2} ${X(f.at[0]) - 1.2},${Y(f.at[1])}`}
          fill="#b7791f"
        />
      ))}
      <rect x={X(engine[0]) - 2.3} y={Y(engine[1]) - 1.1} width={4.6} height={2.2} fill="#c9421f" />
      <circle cx={X(fire[0])} cy={Y(fire[1])} r={1.6} fill="none" stroke="#c93a30" strokeWidth={0.6} />
      <circle cx={X(fire[0])} cy={Y(fire[1])} r={0.6} fill="#c93a30" />
      {/* scale and north */}
      <line x1={4} y1={h - 4} x2={24} y2={h - 4} stroke="#191914" strokeWidth={0.5} />
      <text x={4} y={h - 5.5} fontSize={2.6} fill="#191914" fontFamily="var(--font-mono)">
        20 M
      </text>
      <text x={w - 6} y={7} fontSize={3.2} fill="#191914" fontFamily="var(--font-sans)" fontWeight={600} textAnchor="middle">
        N
      </text>
      <polygon points={`${w - 6},1.5 ${w - 7.4},4.6 ${w - 4.6},4.6`} fill="#191914" />
    </svg>
  );
}

export default function Brief(p: BriefProps) {
  const toLatLng = makeUnprojector(p.block.origin);
  const [fLat, fLng] = toLatLng(p.fire);
  const [eLat, eLng] = toLatLng(p.engine);
  const legs = turnLegs(p.path, p.samples, p.profile.width);
  const hoseOk = p.length <= HOSE_LIMIT_M;
  const who = p.crewLabel.toLowerCase();
  const now = new Date();
  const time = now.toLocaleTimeString("en-IN", { hour12: false, hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const cell = "px-2 py-1.5 align-top";
  return (
    <div id="brief" className="min-h-full bg-paper text-ink print:bg-white">
      <div className="print:hidden sticky top-0 z-10 flex items-center gap-3 px-5 py-3 border-b border-line bg-paper">
        <button onClick={p.onBack} className="text-[13px] font-semibold px-3 py-1.5 rounded-md bg-paper-2 text-ink-2 hover:text-ink">
          Back to the map
        </button>
        <button onClick={() => window.print()} className="text-[13px] font-semibold px-3 py-1.5 rounded-md bg-accent text-white">
          Print or save as PDF
        </button>
        <span className="text-[12px] text-ink-2">One A4 page. Hand it to the crew.</span>
      </div>

      <article className="mx-auto max-w-[800px] px-6 py-6 print:max-w-none print:px-0 print:py-0">
        <header className="flex items-start justify-between gap-6 border-b border-line pb-3">
          <div className="flex items-center gap-3">
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
              <path d="M2 2h18v7h-7v11H2z" fill="var(--accent)" />
            </svg>
            <div>
              <div className="text-[14px] font-semibold tracking-[0.18em]">BASTIGRID</div>
              <div className="lbl">Incident action brief</div>
            </div>
          </div>
          <div className="text-right">
            <div className="num text-[13px]">{briefId(now)}</div>
            <div className="lbl">
              {date} · {time} IST
            </div>
          </div>
        </header>

        <section className="mt-4">
          <div className="lbl">Fire</div>
          <div className="text-[17px] font-semibold leading-tight">
            Dharavi block, building at DIGIPIN <span className="num">{digipin(fLat, fLng) ?? "outside India"}</span>
          </div>
          <div className="text-[12px] text-ink-2 num">
            Plus Code {plusCode(fLat, fLng)} · {fLat.toFixed(5)} N {fLng.toFixed(5)} E
          </div>
        </section>

        <section className="mt-4">
          <div className={`text-[20px] font-semibold leading-tight ${hoseOk ? "text-route" : "text-warn"}`}>
            {hoseOk ? `Map says the ${who} fits and the hose reaches.` : `Map says the ${who} fits, the hose does not.`}
          </div>
          <div className="mt-1 text-[12px] text-ink-2">
            Walls from OpenStreetMap{p.dataAsOf ? ` as of ${p.dataAsOf}` : ""}.{" "}
            {p.heightsMeasured ? `Heights measured for ${p.heightsMeasured} of ${p.block.buildings.length} buildings` : "Heights estimated from footprint size"}.
            Cables, stalls and steps are not surveyed.
          </div>
        </section>

        <section className="mt-4 grid grid-cols-3 gap-x-6 gap-y-3">
          <div>
            <div className="lbl">Engine stop</div>
            <div className="num text-[14px]">{digipin(eLat, eLng) ?? plusCode(eLat, eLng)}</div>
            <div className="text-[12px] text-ink-2">DIGIPIN, nearest road point with a way in</div>
          </div>
          <div>
            <div className="lbl">On foot</div>
            <div className="num text-[20px] leading-none">{p.length.toFixed(0)} M</div>
            <div className="text-[12px] text-ink-2">about {Math.round(p.length / p.profile.speed)} s at {p.profile.speed} m/s</div>
          </div>
          <div>
            <div className="lbl">Tightest gap</div>
            <div className="num text-[20px] leading-none">{p.min.w.toFixed(2)} M</div>
            <div className="text-[12px] text-ink-2">
              {p.min.s.toFixed(0)} m in · {p.crewLabel.toLowerCase()} needs {p.profile.width} m
            </div>
          </div>
          <div>
            <div className="lbl">Hose plan</div>
            <div className="num text-[20px] leading-none">
              {Math.min(p.length, HOSE_LIMIT_M).toFixed(0)} / {HOSE_LIMIT_M} M
            </div>
            <div className="text-[12px] text-ink-2">
              {hoseOk ? `${(HOSE_LIMIT_M - p.length).toFixed(0)} m spare` : `${(p.length - HOSE_LIMIT_M).toFixed(0)} m short, relay pump`}
            </div>
          </div>
          <div>
            <div className="lbl">Crew</div>
            <div className="text-[14px] font-semibold">{p.crewLabel}</div>
            <div className="text-[12px] text-ink-2">{p.profile.note}</div>
          </div>
          <div>
            <div className="lbl">Route ends</div>
            <div className="text-[14px] font-semibold">{p.offsetM > 3 ? `${p.offsetM.toFixed(0)} m from the building` : "at the building"}</div>
            <div className="text-[12px] text-ink-2">{p.offsetM > 3 ? "last stretch not mapped as open ground" : "on mapped open ground"}</div>
          </div>
        </section>

        <section className="mt-4 grid grid-cols-[1.1fr_1fr] gap-4 items-start">
          <div className="border border-line rounded-[6px] overflow-hidden">
            <Plan block={p.block} engine={p.engine} fire={p.fire} path={p.path} flags={p.nearFlags.map((f) => f.flag)} />
          </div>
          <div>
            <div className="lbl mb-1">Alley width along the route</div>
            <ClearanceChart samples={p.samples} limit={p.profile.width} total={p.length} hoseLimit={HOSE_LIMIT_M} />
          </div>
        </section>

        <section className="mt-4">
          <div className="lbl mb-1">Turn by turn</div>
          <table className="w-full text-[12px] border-t border-line">
            <thead>
              <tr className="lbl text-left">
                <th className={cell}>Step</th>
                <th className={cell}>Instruction</th>
                <th className={`${cell} text-right`}>At</th>
                <th className={`${cell} text-right`}>Narrowest</th>
              </tr>
            </thead>
            <tbody>
              {legs.map((l) => (
                <tr key={l.step} className="border-t border-line">
                  <td className={`${cell} num`}>{l.step}</td>
                  <td className={cell}>{l.instruction}</td>
                  <td className={`${cell} num text-right`}>{l.atM.toFixed(0)} M</td>
                  <td className={`${cell} num text-right ${l.narrowest !== null && l.narrowest < p.profile.width + 0.15 ? "text-warn" : ""}`}>
                    {l.narrowest !== null ? `${l.narrowest.toFixed(2)} M` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="mt-4">
          <div className="lbl mb-1">Hazards on approach</div>
          <ul className="text-[12px] leading-snug space-y-1">
            {p.nearFlags.length === 0 && <li>No side gaps under 0.75 m within 10 m of the route.</li>}
            {p.nearFlags.map((f, i) => (
              <li key={i}>
                Side gap <span className="num">{f.flag.width.toFixed(2)} m</span> near the <span className="num">{f.at.toFixed(0)} m</span> mark. The route does not use
                it. Do not shortcut between lanes.
              </li>
            ))}
            <li>
              {hoseOk
                ? `Hose spare is ${(HOSE_LIMIT_M - p.length).toFixed(0)} m. Confirm couplings before the ${Math.max(0, p.length - 10).toFixed(0)} m mark.`
                : `Hose is ${(p.length - HOSE_LIMIT_M).toFixed(0)} m short. Stage a relay pump or stop the engine closer.`}
            </li>
            <li>Overhead wires and overhangs are not surveyed. Head height is for the crew to judge on approach.</li>
          </ul>
        </section>

        <footer className="mt-5 pt-3 border-t border-line lbl leading-relaxed">
          Generated {time}:{String(now.getSeconds()).padStart(2, "0")} · footprints OpenStreetMap (ODbL) ·{" "}
          {p.heightsMeasured ? `heights Open Buildings 2.5D 2023 (${p.heightsMeasured} of ${p.block.buildings.length})` : "heights estimated"}
          {p.imageryOn && " · imagery Esri, Maxar, Earthstar Geographics"} · conditions change, verify on approach · 1 / 1
        </footer>
      </article>
    </div>
  );
}
