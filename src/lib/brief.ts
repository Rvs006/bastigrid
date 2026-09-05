// Action Brief content: turn-by-turn legs from the solved path, compass words, Plus Codes.
import { dist, type Pt, type ProfileSample } from "./geo.ts";

export interface Leg {
  step: number;
  instruction: string;
  atM: number; // metres from the engine where this step starts
  lengthM: number;
  narrowest: number | null; // corridor width on this leg, metres
}

const DIRS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** Compass word for a step vector in local metres (x east, y north). */
export function compass(dx: number, dy: number): string {
  const deg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360; // 0 = north, clockwise
  return DIRS[Math.round(deg / 45) % 8];
}

/** Drop vertices closer than `minM` to the previous kept one; keeps the last point. */
function thin(path: Pt[], minM: number): Pt[] {
  const out: Pt[] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) if (dist(out[out.length - 1], path[i]) >= minM) out.push(path[i]);
  out.push(path[path.length - 1]);
  return out;
}

function narrowestBetween(samples: ProfileSample[], from: number, to: number): number | null {
  let m: number | null = null;
  for (const s of samples) if (s.s >= from - 0.01 && s.s <= to + 0.01 && (m === null || s.w < m)) m = s.w;
  return m;
}

/** Turn-by-turn from the string-pulled path: a new step at every heading change over `turnDeg`. */
export function turnLegs(path: Pt[], samples: ProfileSample[], crewWidth: number, turnDeg = 22): Leg[] {
  if (path.length < 2) return [];
  const pts = thin(path, 1.5);
  const legs: Leg[] = [];
  let legStart = 0; // metres
  let legFrom = pts[0];
  let s = 0;
  let step = 1;
  const push = (to: Pt, atEnd: number, turnWord: string | null) => {
    const dx = to[0] - legFrom[0];
    const dy = to[1] - legFrom[1];
    const len = atEnd - legStart;
    const narrowest = narrowestBetween(samples, legStart, atEnd);
    const tight = narrowest !== null && narrowest < crewWidth + 0.15 ? `, tight at ${narrowest.toFixed(2)} m` : "";
    const head = `head ${compass(dx, dy)} ${len.toFixed(0)} m${tight}`;
    legs.push({
      step: step++,
      instruction: turnWord ? `${turnWord}, ${head}` : `Leave the engine on foot, ${head}`,
      atM: legStart,
      lengthM: len,
      narrowest,
    });
  };
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    s += dist(a, b);
    const h1 = Math.atan2(b[0] - a[0], b[1] - a[1]);
    const h2 = Math.atan2(c[0] - b[0], c[1] - b[1]);
    let turn = ((h2 - h1) * 180) / Math.PI;
    turn = ((turn + 540) % 360) - 180; // -180..180, positive = right
    if (Math.abs(turn) < turnDeg) continue;
    push(b, s, null);
    // the next leg starts here with a turn word
    const word = Math.abs(turn) > 120 ? (turn > 0 ? "Sharp right" : "Sharp left") : turn > 0 ? "Right" : "Left";
    legStart = s;
    legFrom = b;
    // stash the turn word on the next push by wrapping
    legs.push({ step: step, instruction: word, atM: s, lengthM: 0, narrowest: null }); // placeholder, merged below
  }
  s += dist(pts[pts.length - 2], pts[pts.length - 1]);
  push(pts[pts.length - 1], s, null);
  // merge placeholder turn words into the leg that follows them
  const merged: Leg[] = [];
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    if (l.lengthM === 0 && l.narrowest === null && i + 1 < legs.length) {
      const next = legs[i + 1];
      merged.push({ ...next, step: merged.length + 1, instruction: `${l.instruction}, ${next.instruction.replace(/^Leave the engine on foot, /, "")}` });
      i++;
    } else {
      merged.push({ ...l, step: merged.length + 1 });
    }
  }
  merged.push({ step: merged.length + 1, instruction: "Fire", atM: s, lengthM: 0, narrowest: null });
  return merged;
}

const OLC = "23456789CFGHJMPQRVWX";

/** 10-character Open Location Code (Plus Code), the open grid Google Maps shows. India Post's own grid is DIGIPIN, below. */
export function plusCode(lat: number, lng: number): string {
  let latitude = Math.min(89.999999, Math.max(-90, lat)) + 90;
  let longitude = (((lng + 180) % 360) + 360) % 360;
  let code = "";
  let res = 20;
  for (let i = 0; i < 5; i++) {
    const la = Math.min(19, Math.floor(latitude / res + 1e-9));
    const lo = Math.min(19, Math.floor(longitude / res + 1e-9));
    code += OLC[la] + OLC[lo];
    latitude -= la * res;
    longitude -= lo * res;
    res /= 20;
    if (i === 3) code += "+";
  }
  return code;
}

// India Post DIGIPIN (2025): ten characters, a 4 x 4 grid subdivided ten times over India's bounding box,
// about 3.8 m per cell, hyphenated 3-3-4 as India Post prints it. Port of the official encoder
// (github.com/INDIAPOST-gov/digipin, Apache 2.0). Offline, no key, no lookup.
const DIGIPIN_GRID = ["FC98", "J327", "K456", "LMPT"];
const DIGIPIN_BOUNDS = { minLat: 2.5, maxLat: 38.5, minLon: 63.5, maxLon: 99.5 };

export function digipin(lat: number, lon: number): string | null {
  let { minLat, maxLat, minLon, maxLon } = DIGIPIN_BOUNDS;
  if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) return null;
  let code = "";
  for (let level = 1; level <= 10; level++) {
    const latDiv = (maxLat - minLat) / 4;
    const lonDiv = (maxLon - minLon) / 4;
    const row = Math.max(0, Math.min(3, 3 - Math.floor((lat - minLat) / latDiv))); // row 0 is the northern band
    const col = Math.max(0, Math.min(3, Math.floor((lon - minLon) / lonDiv)));
    code += DIGIPIN_GRID[row][col];
    if (level === 3 || level === 6) code += "-";
    maxLat = minLat + latDiv * (4 - row);
    minLat = minLat + latDiv * (3 - row);
    minLon = minLon + lonDiv * col;
    maxLon = minLon + lonDiv;
  }
  return code;
}

export function briefId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `INC-${p(d.getDate())}${p(d.getMonth() + 1)}-${p(d.getHours())}${p(d.getMinutes())}`;
}
