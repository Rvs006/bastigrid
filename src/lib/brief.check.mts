// Self-check for the brief helpers. Run: node src/lib/brief.check.mts
import assert from "node:assert/strict";
import { compass, digipin, plusCode, turnLegs } from "./brief.ts";
import type { Pt, ProfileSample } from "./geo.ts";

assert.equal(compass(0, 10), "north");
assert.equal(compass(10, 0), "east");
assert.equal(compass(-7, -7), "south-west");

// Mumbai plus codes start with 7JFJ; the 8th character is followed by the separator
const code = plusCode(19.0428, 72.8573);
assert.ok(code.startsWith("7JFJ"), code);
assert.equal(code.length, 11);
assert.equal(code[8], "+");
// two points 30 m apart share the first 8 characters
assert.equal(plusCode(19.0428, 72.8573).slice(0, 8), plusCode(19.04305, 72.8573).slice(0, 8));

// an L-shaped path: north 20 m then east 15 m -> leave, right, fire
const path: Pt[] = [
  [0, 0],
  [0, 20],
  [15, 20],
];
const samples: ProfileSample[] = [];
for (let s = 0; s <= 35; s += 5) samples.push({ s, w: s < 20 ? 1.4 : 0.9, left: 0.5, right: 0.5, at: [0, 0] });
const legs = turnLegs(path, samples, 0.85);
assert.equal(legs.length, 3, JSON.stringify(legs));
assert.ok(/^Leave the engine on foot, head north 20 m/.test(legs[0].instruction), legs[0].instruction);
assert.ok(/^Right, head east 15 m, tight at 0.90 m/.test(legs[1].instruction), legs[1].instruction);
assert.equal(legs[2].instruction, "Fire");
assert.equal(Math.round(legs[2].atM), 35);

// DIGIPIN: India Post's worked example (Dak Bhawan, New Delhi) and the official README example (Chennai)
assert.equal(digipin(28.622788, 77.213033), "39J-49L-L8T4");
assert.equal(digipin(13.11179621, 80.20264269), "4T3-96F-42L7");
assert.equal(digipin(51.5, -0.1), null);
assert.equal(digipin(19.0428, 72.8573)?.length, 12);
// 30 m apart never shares the last cell; 1 m apart differs at most in the last character
assert.notEqual(digipin(19.0428, 72.8573), digipin(19.04307, 72.8573));
assert.equal(digipin(19.0428, 72.8573)?.slice(0, 8), digipin(19.042809, 72.8573)?.slice(0, 8));

console.log("brief.check: ok");
