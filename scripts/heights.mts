// Real building heights from Google Open Buildings 2.5D Temporal (v1, 2023-06-30), CC BY 4.0 / ODbL.
// Reads only the window of the 12.5 km GeoTIFF that covers the block (HTTP range requests), samples the
// height band under every OSM footprint, and writes public/data/heights.json keyed by OSM way id.
// Run: node scripts/heights.mts   (npm run heights)
import { readFileSync, writeFileSync } from "node:fs";
import { fromUrl } from "geotiff";
import { makeUnprojector, parseOsm, pointInRing, type Pt } from "../src/lib/geo.ts";
import { DATA_URL, ORIGIN } from "../src/lib/block.ts";

const BUCKET = "https://storage.googleapis.com/open-buildings-temporal-data/v1";
const MANIFEST = "3b_EPSG_32643_2023_06_30"; // S2 cell 3b, UTM zone 43N, imagery year 2023
const RES = 0.5; // m per pixel
const PRESENCE_MIN = 0.4; // building_presence probability to count a pixel as roof
const MIN_PIXELS = 3;

interface Source {
  uris: string[];
  affineTransform: { scaleX: number; translateX: number; scaleY: number; translateY: number };
  dimensions: { width: number; height: number };
}
interface Manifest {
  uriPrefix: string; // gs://bucket/v1/geotiffs/<cell>
  tilesets: { id: string; sources: Source[] }[];
  bands: { id: string; tilesetBandIndex?: number }[];
}

/** WGS84 lat/lon to UTM easting/northing for a given zone (transverse Mercator, standard series). */
function toUtm(lat: number, lon: number, zone: number): [number, number] {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const k0 = 0.9996;
  const lon0 = ((zone - 1) * 6 - 180 + 3) * (Math.PI / 180);
  const phi = (lat * Math.PI) / 180;
  const lam = (lon * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2;
  const C = (e2 / (1 - e2)) * Math.cos(phi) ** 2;
  const A = (lam - lon0) * Math.cos(phi);
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const M =
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi));
  const ep2 = e2 / (1 - e2);
  const E = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  const Nn =
    k0 *
    (M +
      N * Math.tan(phi) * ((A * A) / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  return [E, Nn];
}

const zone = Number(MANIFEST.match(/EPSG_326(\d\d)/)?.[1]);
if (!zone) throw new Error("manifest name must carry the UTM zone");

const block = parseOsm(JSON.parse(readFileSync(`public${DATA_URL}`, "utf8")), ORIGIN);
const toLatLng = makeUnprojector(ORIGIN);
const toPix = (p: Pt, src: Source): Pt => {
  const [lat, lon] = toLatLng(p);
  const [E, N] = toUtm(lat, lon, zone);
  const { scaleX, translateX, scaleY, translateY } = src.affineTransform;
  return [(E - translateX) / scaleX, (N - translateY) / scaleY];
};

console.log("manifest…");
const manifest = (await fetch(`${BUCKET}/manifests/${MANIFEST}.json`).then((r) => r.json())) as Manifest;
const [oLat, oLon] = toLatLng([0, 0]);
const [oE, oN] = toUtm(oLat, oLon, zone);
const src = manifest.tilesets.flatMap((t) => t.sources).find((s) => {
  const a = s.affineTransform;
  const x1 = a.translateX + s.dimensions.width * a.scaleX;
  const y0 = a.translateY + s.dimensions.height * a.scaleY;
  return oE >= a.translateX && oE < x1 && oN > y0 && oN <= a.translateY;
});
if (!src) throw new Error("no tile covers the block origin");
const heightBand = manifest.bands.find((b) => b.id === "building_height")?.tilesetBandIndex ?? 1;
const presenceBand = manifest.bands.find((b) => b.id === "building_presence")?.tilesetBandIndex ?? 2;
// folders are <S2 level-7 token>_<date>; the manifest splits the token into its cell prefix (3b) plus the uri (e7c_…)
const cell = manifest.uriPrefix.slice(manifest.uriPrefix.lastIndexOf("/") + 1);
const url = `${BUCKET}/geotiffs/${cell}${src.uris[0]}`;
console.log("tile", url);

// pixel window covering every footprint, padded
const [bx0, by0, bx1, by1] = block.bbox;
const corners = [toPix([bx0, by0], src), toPix([bx1, by0], src), toPix([bx0, by1], src), toPix([bx1, by1], src)];
const pad = 8;
const wx0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))) - pad);
const wy0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))) - pad);
const wx1 = Math.min(src.dimensions.width, Math.ceil(Math.max(...corners.map((c) => c[0]))) + pad);
const wy1 = Math.min(src.dimensions.height, Math.ceil(Math.max(...corners.map((c) => c[1]))) + pad);
console.log(`window ${wx1 - wx0} x ${wy1 - wy0} px at ${RES} m`);

const tiff = await fromUrl(url);
const image = await tiff.getImage();
const rasters = (await image.readRasters({ window: [wx0, wy0, wx1, wy1], samples: [heightBand, presenceBand] })) as unknown as {
  0: ArrayLike<number>;
  1: ArrayLike<number>;
  width: number;
  height: number;
};
const W = rasters.width;
const heightPx = rasters[0];
const presencePx = rasters[1];

const out: Record<string, { h: number; px: number }> = {};
let hits = 0;
for (const b of block.buildings) {
  const ring = b.ring.map((p) => {
    const [x, y] = toPix(p, src);
    return [x - wx0, y - wy0] as Pt;
  });
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const samples: number[] = [];
  for (let py = Math.floor(Math.min(...ys)); py <= Math.ceil(Math.max(...ys)); py++) {
    for (let px = Math.floor(Math.min(...xs)); px <= Math.ceil(Math.max(...xs)); px++) {
      if (px < 0 || py < 0 || px >= W || py >= rasters.height) continue;
      if (!pointInRing([px + 0.5, py + 0.5], ring)) continue;
      const i = py * W + px;
      const h = heightPx[i];
      const p = presencePx[i];
      if (h > 0 && h < 99 && p >= PRESENCE_MIN) samples.push(h);
    }
  }
  if (samples.length < MIN_PIXELS) continue;
  samples.sort((a, b) => a - b);
  const h = samples[Math.floor(samples.length * 0.8)]; // roof level, ignores edge pixels that blend with the alley
  out[String(b.id)] = { h: Math.round(Math.min(40, Math.max(2.4, h)) * 10) / 10, px: samples.length };
  hits++;
}

const result = {
  source: "Google Open Buildings 2.5D Temporal v1, building_height band, imagery year 2023 (CC BY 4.0 / ODbL)",
  manifest: MANIFEST,
  tile: src.uris[0],
  resolutionM: RES,
  method: "80th percentile of height pixels under each OSM footprint where building_presence >= 0.4",
  generatedAt: new Date().toISOString(),
  buildings: out,
};
writeFileSync("public/data/heights.json", JSON.stringify(result) + "\n");
const hs = Object.values(out).map((v) => v.h).sort((a, b) => a - b);
console.log(`heights for ${hits} of ${block.buildings.length} buildings; median ${hs[Math.floor(hs.length / 2)]} m, p10 ${hs[Math.floor(hs.length * 0.1)]} m, p90 ${hs[Math.floor(hs.length * 0.9)]} m`);
