// Pre-bake both navmeshes into public/nav/*.bin so the app loads them instead of rasterising
// the block on every visit. Run: node scripts/bake.mts   (npm run bake)
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { exportNavMesh } from "recast-navigation";
import { parseOsm } from "../src/lib/geo.ts";
import { AREA, DATA_URL, ORIGIN } from "../src/lib/block.ts";
import { bakeNavMesh, CS, NAV_VERSION, PROFILES, type NavManifest, type ProfileId } from "../src/lib/nav.ts";

const dataPath = `public${DATA_URL}`;
const block = parseOsm(JSON.parse(readFileSync(dataPath, "utf8")), ORIGIN);
mkdirSync("public/nav", { recursive: true });

const manifest: NavManifest = {
  version: NAV_VERSION,
  cs: CS,
  area: AREA,
  dataBytes: statSync(dataPath).size,
  generatedAt: new Date().toISOString(),
  profiles: {},
};

for (const id of Object.keys(PROFILES) as ProfileId[]) {
  const t0 = performance.now();
  const navMesh = await bakeNavMesh(block, PROFILES[id], AREA);
  const bytes = exportNavMesh(navMesh);
  const file = `/nav/${id}.bin`;
  writeFileSync(`public${file}`, bytes);
  manifest.profiles[id] = { file, bytes: bytes.byteLength, bakeMs: Math.round(performance.now() - t0) };
  navMesh.destroy();
  console.log(`${id}: ${(bytes.byteLength / 1024).toFixed(0)} KB in ${manifest.profiles[id]!.bakeMs} ms`);
}

writeFileSync("public/nav/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log("wrote public/nav/manifest.json");
