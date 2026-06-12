// Phase A 健康检查 CLI 壳;核心逻辑在 queries/healthChecks.ts(dashboard 同源复用)
import { runHealthChecks } from "./queries/healthChecks.js";

const { checks, counts } = runHealthChecks();

console.log("Phase A health");
for (const check of checks) {
  console.log(`${check.level.toUpperCase()} ${check.message}`);
}
console.log(`summary: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail`);

if (counts.fail > 0) process.exitCode = 1;
