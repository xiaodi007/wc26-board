import { pollResultSources } from "./sources/results.js";

const summary = await pollResultSources();
console.log(JSON.stringify(summary, null, 2));
