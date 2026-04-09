import type { Plugin, ViteDevServer } from "vite";
import { readFileSync, readdirSync, existsSync, statSync, watch } from "fs";
import { join, resolve } from "path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import type { WebSocket as WsType } from "ws";

const projectRoot = resolve(__dirname, "..");

// ── Frontmatter parser ───────────────────────────────────────
function parseFrontmatter(text: string): Record<string, any> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const obj: Record<string, any> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val: any = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (val.startsWith("[") && val.endsWith("]"))
      val = val
        .slice(1, -1)
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
    obj[key] = val;
  }
  return obj;
}

function extractTitle(text: string): string {
  const m = text.match(/^#\s+.*?—\s*(.+)$/m) || text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "Untitled";
}

// ── Data loaders ─────────────────────────────────────────────

interface Issue {
  id: string;
  title: string;
  priority: string;
  feasibility: string;
  depends_on: string[];
  goal: string;
  status: string | null;
}

function loadIssuesFromDir(dir: string): Issue[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf-8");
      const fm = parseFrontmatter(text);
      return {
        id: f.replace(".md", ""),
        title: fm.title || extractTitle(text),
        priority: fm.priority || "medium",
        feasibility: fm.feasibility || "",
        depends_on: fm.depends_on || [],
        goal: fm.goal || "",
        status: fm.status || null,
      };
    })
    .sort((a, b) => Number(b.id) - Number(a.id));
}

function loadAllIssues() {
  const allReady = loadIssuesFromDir(join(projectRoot, "plan/issues/ready"));
  const ready: Issue[] = [];
  const inprogress: Issue[] = [];
  for (const iss of allReady) {
    if (iss.status === "in-progress" || iss.status === "in_progress") {
      inprogress.push(iss);
    } else {
      ready.push(iss);
    }
  }
  return {
    blocked: loadIssuesFromDir(join(projectRoot, "plan/issues/blocked")),
    ready,
    inprogress,
    done: loadIssuesFromDir(join(projectRoot, "plan/issues/done")),
  };
}

function loadRuns(): any[] {
  const runsPath = join(projectRoot, "benchmarks/results/runs/index.json");
  if (!existsSync(runsPath)) return [];
  try {
    const all = JSON.parse(readFileSync(runsPath, "utf-8")) as any[];
    // Before Mar 20: smaller suite (~23K), keep all runs > 20K.
    // After the suite expansion, keep only full conformance runs and exclude
    // tiny crash artifacts, but do not require totals to stay near the old
    // proposal-inclusive 48K size because official-scope runs are lower.
    return all
      .filter((r: any) => {
        const ts = r.timestamp || "";
        if (ts < "2026-03-20") return r.total >= 20000;
        return r.total >= 40000;
      })
      .sort((a: any, b: any) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  } catch {
    return [];
  }
}

function extractSprintNumber(name: string): number | null {
  const match = String(name).match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function extractIssueIds(text: string): number[] {
  const ids = new Set<number>();
  const queueSection = text.match(/## Task queue[\s\S]*?(?=\n## |\s*$)/i)?.[0];
  if (!queueSection) return [];
  for (const line of queueSection.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    if (/^\|\s*-/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((s) => s.trim());
    if (cells.length < 2) continue;
    const m = cells[1].match(/#(\d{2,4})\b/);
    if (m) ids.add(parseInt(m[1], 10));
  }
  return [...ids].sort((a, b) => a - b);
}

function extractIssueBullets(text: string): Array<{ line: string; ids: number[] }> {
  const issueSection = text.match(/## Issues[\s\S]*?(?=\n## |\s*$)/i)?.[0];
  if (!issueSection) return [];
  const rows: Array<{ line: string; ids: number[] }> = [];
  for (const line of issueSection.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;
    const ids = [...trimmed.matchAll(/#(\d{2,4})\b/g)].map((m) => parseInt(m[1], 10));
    if (!ids.length) continue;
    rows.push({ line: trimmed, ids });
  }
  return rows;
}

function extractListedIssueIds(text: string): number[] {
  const ids = new Set<number>();
  for (const row of extractIssueBullets(text)) {
    for (const id of row.ids) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

function extractCompletedIssueIds(text: string): number[] {
  const ids = new Set<number>();
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    if (/^\|\s*-/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((s) => s.trim());
    if (cells.length < 2) continue;
    const issueCell = cells.find((cell) => /#\d{2,4}\b/.test(cell));
    if (!issueCell) continue;
    const issueMatch = issueCell.match(/#(\d{2,4})\b/);
    if (!issueMatch) continue;
    const tail = cells.slice(cells.indexOf(issueCell) + 1).join(" | ");
    if (/\b(done|merged|complete(?:d)?|verified fixed)\b/i.test(tail)) {
      ids.add(parseInt(issueMatch[1], 10));
    }
  }
  return [...ids].sort((a, b) => a - b);
}

function mergeUniqueIds(...lists: number[][]): number[] {
  const ids = new Set<number>();
  for (const list of lists) {
    for (const id of list || []) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

function deriveHistoricalCompletedIssueIds(text: string, issueIds: number[]): number[] {
  const doneIds = new Set(
    readdirSync(join(projectRoot, "plan/issues/done"))
      .filter((f) => /^[0-9]+\.md$/.test(f))
      .map((f) => parseInt(f.replace(".md", ""), 10)),
  );
  const createdIds = new Set<number>();
  for (const row of extractIssueBullets(text)) {
    if (!/\bcreated\b/i.test(row.line)) continue;
    for (const id of row.ids) createdIds.add(id);
  }
  return issueIds.filter((id) => doneIds.has(id) && !createdIds.has(id));
}

function loadDoneSprintMap(): Map<number, number[]> {
  const p = join(projectRoot, "plan/issues/done/log.md");
  const bySprint = new Map<number, number[]>();
  if (!existsSync(p)) return bySprint;
  const text = readFileSync(p, "utf-8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\|\s*([0-9]+)\s*\|\s*[^|]*\|\s*[^|]*\|\s*Sprint[- ]?(\d+)\s*\|/i);
    if (!m) continue;
    const id = parseInt(m[1], 10);
    const sprint = parseInt(m[2], 10);
    const current = bySprint.get(sprint) || [];
    current.push(id);
    bySprint.set(sprint, current);
  }
  return bySprint;
}

function loadSprints(): any[] {
  const dir = join(projectRoot, "plan/sprints");
  if (!existsSync(dir)) return [];
  const sprints: any[] = [];
  const doneBySprint = loadDoneSprintMap();
  for (const f of readdirSync(dir)
    .filter((f) => /^sprint-\d+\.md$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/(\d+)/)?.[1] ?? "0", 10);
      const numB = parseInt(b.match(/(\d+)/)?.[1] ?? "0", 10);
      return numA - numB;
    })) {
    const text = readFileSync(join(dir, f), "utf-8");
    const name = f.replace(".md", "").replace(/-/g, " ");
    const dateM = text.match(/\*\*Date\*\*:\s*(.+)/);
    const baseM = text.match(/\*\*Baseline\*\*:\s*(.+)/);
    const resultM = text.match(/\*\*Final numbers?\*\*:\s*(.+)/i) || text.match(/\*\*Result\*\*:\s*(.+)/i);
    const mergedCount = (text.match(/\*\*Merged\*\*/gi) || []).length;
    const sprintNumber = extractSprintNumber(name);
    const issueIds = mergeUniqueIds(extractIssueIds(text), extractListedIssueIds(text));
    const completedFromLog = sprintNumber != null ? doneBySprint.get(sprintNumber) || [] : [];
    const completedFromSprint = extractCompletedIssueIds(text);
    const explicitCarryOver =
      /Issues not completed in this sprint were returned to the backlog/i.test(text) ||
      /moved into \[sprint-\d+\.md\]/i.test(text) ||
      /contains only the unfinished carry-over work/i.test(text);
    const completedFromHistory = explicitCarryOver ? deriveHistoricalCompletedIssueIds(text, issueIds) : [];
    const completedIssueIds = mergeUniqueIds(completedFromLog, completedFromSprint, completedFromHistory);
    sprints.push({
      name,
      sprintNumber,
      date: dateM ? dateM[1].trim() : "",
      baseline: baseM ? baseM[1].trim() : "",
      result: resultM ? resultM[1].trim() : "",
      issueCount: mergedCount,
      issueIds,
      completedIssueIds,
      explicitCarryOver,
    });
  }
  const maxSprintNumber = Math.max(...sprints.map((s) => s.sprintNumber || 0), 0);
  for (const sprint of sprints) {
    sprint.isClosed = Boolean(sprint.sprintNumber && sprint.sprintNumber < maxSprintNumber) || sprint.explicitCarryOver;
  }
  return sprints;
}

function loadBurndown(): { timestamps: string[]; remaining: number[]; completed: number[] } {
  // Build burndown from git commit history — find commits that close issues (#NNN)
  const doneDir = join(projectRoot, "plan/issues/done");
  if (!existsSync(doneDir)) return { timestamps: [], remaining: [], completed: [] };

  const doneFiles = readdirSync(doneDir).filter((f) => f.endsWith(".md"));
  const readyFiles = readdirSync(join(projectRoot, "plan/issues/ready")).filter((f) => f.endsWith(".md"));
  const blockedDir = join(projectRoot, "plan/issues/blocked");
  const blockedFiles = existsSync(blockedDir) ? readdirSync(blockedDir).filter((f) => f.endsWith(".md")) : [];

  const totalIssues = doneFiles.length + readyFiles.length + blockedFiles.length;
  const doneIssueIds = new Set(doneFiles.map((f) => f.replace(".md", "")));

  // Parse git log for issue-closing commits
  interface IssueCompletion {
    issueId: string;
    timestamp: Date;
  }
  const completions: IssueCompletion[] = [];
  const seenIssues = new Set<string>();

  try {
    // execSync imported at top level from node:child_process
    const log = execSync("git log --format='%aI %s' --reverse", {
      cwd: projectRoot,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    for (const line of log.split("\n")) {
      if (!line.trim()) continue;
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx < 0) continue;
      const dateStr = line.slice(0, spaceIdx).replace(/^'/, "");
      const subject = line.slice(spaceIdx + 1);
      // Match issue references like #854, #862, etc.
      const issueRefs = subject.match(/#(\d+)/g);
      if (!issueRefs) continue;
      const timestamp = new Date(dateStr);
      if (isNaN(timestamp.getTime())) continue;
      for (const ref of issueRefs) {
        const id = ref.slice(1);
        // Only count issues that are actually in done/
        if (doneIssueIds.has(id) && !seenIssues.has(id)) {
          seenIssues.add(id);
          completions.push({ issueId: id, timestamp });
        }
      }
    }
  } catch {
    // Git not available — fall back to file mtime
    const doneWithTime = doneFiles
      .map((f) => ({
        issueId: f.replace(".md", ""),
        timestamp: new Date(statSync(join(doneDir, f)).mtimeMs),
      }))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    completions.push(...doneWithTime);
  }

  // Sort by timestamp
  completions.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const timestamps: string[] = [];
  const remaining: number[] = [];
  const completed: number[] = [];

  // Start point
  timestamps.push("Start");
  remaining.push(totalIssues);
  completed.push(0);

  for (let i = 0; i < completions.length; i++) {
    const d = completions[i].timestamp;
    timestamps.push(`${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`);
    remaining.push(totalIssues - (i + 1));
    completed.push(i + 1);
  }

  return { timestamps, remaining, completed };
}

// ── Plugin ───────────────────────────────────────────────────

export function dashboardPlugin(): Plugin {
  const wsClients = new Set<WsType>();

  function broadcast(data: any) {
    const msg = JSON.stringify(data);
    for (const ws of wsClients) {
      try {
        ws.send(msg);
      } catch {
        wsClients.delete(ws);
      }
    }
  }

  // Debounced file change handler
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  function onFileChange(path: string) {
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      broadcast({ type: "refresh", path, timestamp: Date.now() });
    }, 500);
  }

  return {
    name: "dashboard",
    configureServer(server: ViteDevServer) {
      // Watch project dirs for changes
      const watchDirs = [join(projectRoot, "plan"), join(projectRoot, "benchmarks/results")];

      for (const dir of watchDirs) {
        if (existsSync(dir)) {
          try {
            watch(dir, { recursive: true }, (_event, filename) => {
              if (filename) onFileChange(String(filename));
            });
          } catch {
            // fs.watch with recursive may not be supported — non-fatal
          }
        }
      }

      // WebSocket endpoint for live updates
      server.httpServer?.on("upgrade", (req, socket, head) => {
        if (req.url !== "/dashboard-ws") return;

        // Manual WebSocket handshake
        const key = req.headers["sec-websocket-key"];
        if (!key) {
          socket.destroy();
          return;
        }
        // createHash imported at top level from node:crypto
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-5AB5DC587183")
          .digest("base64");

        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n` +
            "\r\n",
        );

        // Wrap raw socket in a minimal WS-like interface
        const ws = {
          send(data: string) {
            const buf = Buffer.from(data);
            const header = Buffer.alloc(buf.length < 126 ? 2 : 4);
            header[0] = 0x81; // text frame, FIN
            if (buf.length < 126) {
              header[1] = buf.length;
            } else {
              header[1] = 126;
              header.writeUInt16BE(buf.length, 2);
            }
            socket.write(Buffer.concat([header, buf]));
          },
          close() {
            socket.destroy();
          },
        } as unknown as WsType;

        wsClients.add(ws);
        socket.on("close", () => wsClients.delete(ws));
        socket.on("error", () => wsClients.delete(ws));
      });

      // API endpoints
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);

        // Serve dashboard HTML
        if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
          const dashHtml = readFileSync(join(projectRoot, "dashboard/index.html"), "utf-8");
          // Inject live-reload WebSocket client and API-based data loading
          const injectedHtml = dashHtml
            .replace(
              '<script src="data.js" onerror=""></script>',
              `<script>
// Live dashboard — data loaded via API, auto-refreshes via WebSocket
window.__DASHBOARD_API__ = true;
</script>`,
            )
            .replace("runs = await loadJSON('data/runs.json');", "runs = await loadJSON('/api/dashboard/runs');")
            .replace("if (!runs) runs = await loadJSON('../benchmarks/results/runs/index.json');", "")
            .replace(
              "const issueIndex = await loadJSON('./data/issues.json');",
              "const issueIndex = await loadJSON('/api/dashboard/issues');",
            )
            .replace(
              "const sprintIndex = await loadJSON('./data/sprints.json');",
              "const sprintIndex = await loadJSON('/api/dashboard/sprints');",
            )
            .replace(
              "main().catch(err => console.error('Dashboard error:', err));",
              `main().catch(err => console.error('Dashboard error:', err));

// Burndown chart
async function loadBurndown() {
  const data = await loadJSON('/api/dashboard/burndown');
  if (!data || !data.timestamps || data.timestamps.length < 2) return;
  const container = document.querySelector('.grid-2:last-of-type');
  if (!container) return;
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = '<h2>Sprint Burndown</h2><div class="chart-container"><canvas id="chart-burndown"></canvas></div>';
  container.appendChild(panel);
  setTimeout(() => {
    drawChart(document.getElementById('chart-burndown'), {
      labels: data.timestamps,
      series: [
        { label: 'Remaining', data: data.remaining, color: '#f87171', fill: true },
        { label: 'Completed', data: data.completed, color: '#34d399', fill: false },
      ],
    });
  }, 100);
}
loadBurndown();

// WebSocket live reload
(function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host + '/dashboard-ws');
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'refresh') {
        console.log('[dashboard] File changed:', msg.path, '— refreshing...');
        main().catch(console.error);
        loadBurndown();
      }
    } catch {}
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
  ws.onerror = () => ws.close();
})();`,
            );
          res.setHeader("Content-Type", "text/html");
          res.end(injectedHtml);
          return;
        }

        // API: issues
        if (url.pathname === "/api/dashboard/issues") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(loadAllIssues()));
          return;
        }

        // API: test262 runs
        if (url.pathname === "/api/dashboard/runs") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(loadRuns()));
          return;
        }

        // API: sprints
        if (url.pathname === "/api/dashboard/sprints") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(loadSprints()));
          return;
        }

        // API: burndown
        if (url.pathname === "/api/dashboard/burndown") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(loadBurndown()));
          return;
        }

        next();
      });
    },
  };
}
