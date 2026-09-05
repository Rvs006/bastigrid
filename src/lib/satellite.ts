// Esri World Imagery tiles stitched into one texture that covers a rectangle of the block, in metres.
// Tiles are Web Mercator; over 600 m the projection difference to our local metre grid is centimetres.
import * as THREE from "three";
import { makeProjector, makeUnprojector, type BBox } from "./geo.ts";

export const IMAGERY_ATTRIBUTION = "Imagery: Esri, Maxar, Earthstar Geographics";
export const IMAGERY_ZOOM = 19; // ~0.28 m per pixel at this latitude; z20 is empty here

const tileUrl = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

export interface Imagery {
  texture: THREE.CanvasTexture;
  bounds: BBox; // metres, [minX, minY, maxX, maxY]
  tiles: number;
  failed: number;
}

const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const xToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const yToLat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

function loadTile(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // the tile server sends CORS headers; without this the canvas taints and WebGL refuses it
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(url));
    img.src = url;
  });
}

export async function loadImagery(origin: { lat: number; lon: number }, bounds: BBox, zoom = IMAGERY_ZOOM): Promise<Imagery> {
  const toLatLng = makeUnprojector(origin);
  const [minX, minY, maxX, maxY] = bounds;
  const [latS, lonW] = toLatLng([minX, minY]);
  const [latN, lonE] = toLatLng([maxX, maxY]);
  const tx0 = Math.floor(lonToX(lonW, zoom));
  const tx1 = Math.floor(lonToX(lonE, zoom));
  const ty0 = Math.floor(latToY(latN, zoom));
  const ty1 = Math.floor(latToY(latS, zoom));
  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;

  const canvas = document.createElement("canvas");
  canvas.width = cols * 256;
  canvas.height = rows * 256;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#d9d5c8"; // a tile that never arrives shows as paper, not black
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let failed = 0;
  const jobs: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(
        loadTile(tileUrl(zoom, tx, ty))
          .then((img) => ctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256))
          .catch(() => {
            failed++;
          }),
      );
    }
  }
  await Promise.all(jobs);

  const proj = makeProjector(origin);
  const nw = proj(yToLat(ty0, zoom), xToLon(tx0, zoom));
  const se = proj(yToLat(ty1 + 1, zoom), xToLon(tx1 + 1, zoom));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return { texture, bounds: [nw[0], se[1], se[0], nw[1]], tiles: cols * rows, failed };
}
