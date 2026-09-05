// The one block the prototype ships: shared by the app and the bake script.
import type { BakeArea } from "./nav.ts";

export const ORIGIN = { lat: 19.0428, lon: 72.8573 }; // Dharavi, Mumbai
export const AREA: BakeArea = { cx: 75, cy: -48, half: 90 }; // densest 180 m block in the OSM pull
export const DATA_URL = "/data/dharavi-osm.json";
