#!/usr/bin/env node
import { execFileSync } from "node:child_process";

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

run(process.execPath, ["scripts/sync-sprint-issue-tables.mjs"]);
run(process.execPath, ["scripts/sync-goal-issue-tables.mjs"]);
run(process.execPath, ["dashboard/build-data.js"]);
run(process.execPath, ["--experimental-strip-types", "plan/generate-graph.ts"]);
