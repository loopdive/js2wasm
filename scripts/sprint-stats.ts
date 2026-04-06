#!/usr/bin/env npx tsx
/**
 * Derive sprint statistics from git tags.
 * Tags: sprint/N (N = sprint number, tag commit = sprint end)
 * Duration: time between previous tag and this tag
 *
 * Output: dashboard/data/sprint-stats.json
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "dashboard", "data", "sprint-stats.json");

interface SprintStat {
  sprint: number;
  date: string;
  epoch: number;
  durationHours: number;
  duration: string;
  commits: number;
  issues: number;
}

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { encoding: "utf-8", cwd: ROOT }).trim();
}

function formatDuration(secs: number): string {
  if (secs < 0) secs = -secs;
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (hours < 1) return `${mins}m`;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
}

function formatDate(isoDate: string): string {
  const d = new Date(isoDate);
  const now = new Date();
  const day = d.getDate();
  const month = d.getMonth() + 1;
  const year = d.getFullYear();
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

  if (year === now.getFullYear()) {
    return `${day}.${month}. ${time}`;
  }
  return `${day}.${month}.${year} ${time}`;
}

// Get all sprint tags sorted by version
const tags = git('tag -l "sprint/*" --sort=version:refname').split("\n").filter(Boolean);

const stats: SprintStat[] = [];
let prevEpoch: number | null = null;
let prevTag: string | null = null;

for (const tag of tags) {
  const num = parseInt(tag.replace("sprint/", ""), 10);
  if (isNaN(num)) continue;

  const commitDate = git(`log -1 --format="%ci" ${tag}`);
  const epoch = parseInt(git(`log -1 --format="%ct" ${tag}`), 10);

  const date = formatDate(commitDate);
  const duration = prevEpoch !== null ? formatDuration(epoch - prevEpoch) : "";
  const commits = prevTag
    ? parseInt(git(`rev-list --count ${prevTag}..${tag}`), 10)
    : parseInt(git(`rev-list --count ${tag}`), 10);

  // Count unique issue numbers in commit messages between tags
  const range = prevTag ? `${prevTag}..${tag}` : tag;
  const messages = git(`log --format="%s" ${range}`);
  const issueNums = new Set<string>();
  for (const m of messages.match(/#(\d+)/g) || []) {
    issueNums.add(m);
  }
  const issues = issueNums.size;

  const durationHours = prevEpoch !== null ? (epoch - prevEpoch) / 3600 : 0;
  stats.push({
    sprint: num,
    date,
    epoch,
    durationHours: Math.round(durationHours * 10) / 10,
    duration,
    commits,
    issues,
  });

  prevEpoch = epoch;
  prevTag = tag;
}

// Add repo boundaries
const firstCommitEpoch = parseInt(git('log --reverse --format="%ct" | head -1'), 10);
const lastCommitEpoch = parseInt(git('log -1 --format="%ct"'), 10);

// All commit timestamps (for dot rendering on timeline)
const allCommitEpochs = git('log --format="%ct"')
  .split("\n")
  .filter(Boolean)
  .map((s) => parseInt(s, 10));

const output = {
  repoStart: firstCommitEpoch,
  repoEnd: lastCommitEpoch,
  commitEpochs: allCommitEpochs,
  sprints: stats,
};

mkdirSync(join(ROOT, "dashboard", "data"), { recursive: true });
writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n");
console.log(`Wrote ${stats.length} sprints to ${OUT}`);
