import { exportWalrusFeed } from "./exports/walrusFeed.js";

const result = exportWalrusFeed();
console.log(`walrus export: wrote ${result.artifacts.length} artifacts to ${result.outDir}`);
console.log(`walrus export: manifest ${result.manifestPath}`);
