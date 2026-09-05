"use client";

import type { ProfileSample } from "@/lib/geo";

interface Props {
  samples: ProfileSample[];
  limit: number; // agent width, m
  total: number; // route length, m
  hoseLimit: number; // m
}

const W = 900;
const H = 150;
const PAD = { l: 44, r: 18, t: 16, b: 26 };
const MAX_W = 3; // display cap, m

export default function ClearanceChart({ samples, limit, total, hoseLimit }: Props) {
  if (samples.length < 2) return null;
  const x = (s: number) => PAD.l + (s / Math.max(total, 1)) * (W - PAD.l - PAD.r);
  const y = (w: number) => PAD.t + (1 - Math.min(w, MAX_W) / MAX_W) * (H - PAD.t - PAD.b);
  const pts = samples.map((p) => `${x(p.s).toFixed(1)},${y(p.w).toFixed(1)}`);
  const line = `M${pts.join("L")}`;
  const area = `${line}L${x(samples[samples.length - 1].s).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const min = samples.reduce((m, p) => (p.w < m.w ? p : m), samples[0]);
  const yTicks = [0, 1, 2, 3];
  const sTicks = [0, 25, 50, 75, 100, 125, 150].filter((t) => t < total - 6);
  const labelStyle = { fontFamily: "var(--font-mono)", fontSize: 10, fill: "var(--muted)", letterSpacing: "0.08em" } as const;
  const minLabelRight = x(min.s) > W - 140;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label="Corridor width along the route">
      {yTicks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="rgba(84,80,66,0.12)" />
          <text x={PAD.l - 8} y={y(t) + 3} textAnchor="end" style={labelStyle}>
            {t === MAX_W ? `${t}+` : t.toFixed(1)}
          </text>
        </g>
      ))}
      <path d={area} fill="var(--route)" fillOpacity={0.12} />
      <path d={line} fill="none" stroke="var(--route)" strokeWidth={1.8} strokeLinejoin="round" />
      <line x1={PAD.l} x2={W - PAD.r} y1={y(limit)} y2={y(limit)} stroke="var(--warn)" strokeDasharray="5 4" strokeWidth={1.2} />
      <text x={W - PAD.r} y={y(limit) - 5} textAnchor="end" style={{ ...labelStyle, fill: "var(--warn)" }}>
        NEEDS {limit.toFixed(2)} M
      </text>
      {total > hoseLimit && (
        <>
          <line x1={x(hoseLimit)} x2={x(hoseLimit)} y1={PAD.t} y2={H - PAD.b} stroke="var(--warn)" strokeWidth={1.2} />
          <text x={x(hoseLimit) + 5} y={PAD.t + 10} style={{ ...labelStyle, fill: "var(--warn)" }}>
            HOSE END
          </text>
        </>
      )}
      <circle cx={x(min.s)} cy={y(min.w)} r={4} fill="var(--paper)" stroke="var(--ink)" strokeWidth={1.5} />
      <text
        x={x(min.s) + (minLabelRight ? -9 : 9)}
        y={y(min.w) - 8}
        textAnchor={minLabelRight ? "end" : "start"}
        style={{ ...labelStyle, fill: "var(--ink)" }}
      >
        TIGHTEST {min.w.toFixed(2)} M, {min.s.toFixed(0)} M IN
      </text>
      {sTicks.map((t) => (
        <text key={t} x={x(t)} y={H - 8} textAnchor={t === 0 ? "start" : "middle"} style={labelStyle}>
          {t} M
        </text>
      ))}
      <text x={x(total)} y={H - 8} textAnchor="end" style={{ ...labelStyle, fill: "var(--ink)" }}>
        {total.toFixed(0)} M
      </text>
    </svg>
  );
}
