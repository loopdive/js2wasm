#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync, watch } from "node:fs";
import { join, relative, basename } from "node:path";

const LOG_FILE = join(import.meta.dir, "events.log");
const MAX_QUEUE = 50;

// --- Event queue (drains when MCP connects) ---
interface QueuedEvent {
  content: string;
  meta: Record<string, string>;
}
const queue: QueuedEvent[] = [];
let connected = false;

function logEvent(event: string, payload: Record<string, unknown>) {
  const line = `${new Date().toISOString()} [${event}] ${JSON.stringify(payload)}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // ignore write errors
  }
}

// --- Event type → message formatting ---
function formatMessage(
  event: string,
  payload: Record<string, unknown>
): string {
  switch (event) {
    case "test-run-done":
      return `Test run completed: ${payload.passed ?? 0} passing, ${payload.failed ?? 0} failing. Analyse the top failure categories in .claude/last-run.json and implement the highest-ROI fix.`;
    case "cron-tick":
      return "Periodic check: review current test262 failure distribution and propose the next implementation target.";
    case "issue-opened":
      return `New GitHub issue opened: "${payload.title ?? ""}". Check if this relates to a known test262 failure category and comment with findings.`;
    case "milestone-started":
      return `Milestone started: "${payload.title ?? ""}". Create an implementation plan based on open issues and current test262 gaps.`;
    case "custom":
      return String(payload.message ?? JSON.stringify(payload));
    default:
      return `Unknown event "${event}": ${JSON.stringify(payload)}`;
  }
}

// --- MCP server ---
const mcp = new Server(
  { name: "js2wasm-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions: [
      'Events from the js2wasm-channel arrive as <channel source="js2wasm-channel" event="...">.',
      "They are one-way alerts from the build/test infrastructure.",
      "When a channel message arrives, handle it immediately before continuing other work.",
      "Event types: test-run-done (analyse failures), cron-tick (review test262 gaps), issue-opened (triage), milestone-started (plan), issues-changed (plan/issues file watcher), custom (verbatim).",
    ].join(" "),
  }
);

async function pushEvent(event: string, payload: Record<string, unknown>) {
  const content = formatMessage(event, payload);
  const meta: Record<string, string> = { event };

  if (!connected) {
    queue.push({ content, meta });
    if (queue.length > MAX_QUEUE) queue.shift(); // drop oldest
    return;
  }

  await mcp.notification({
    method: "notifications/claude/channel",
    params: { content, meta },
  });
}

// --- Drain queue on connect ---
const origConnect = mcp.connect.bind(mcp);
mcp.connect = async (transport: InstanceType<typeof StdioServerTransport>) => {
  await origConnect(transport);
  connected = true;

  // Drain queued events
  while (queue.length > 0) {
    const item = queue.shift()!;
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content: item.content, meta: item.meta },
    });
  }
};

// Connect to Claude Code over stdio
await mcp.connect(new StdioServerTransport());

// --- HTTP server on port 7373 ---
Bun.serve({
  port: 7373,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(req.url);
    if (url.pathname !== "/event") {
      return new Response("Not found", { status: 404 });
    }

    try {
      const body = await req.json();
      const event: string = body.event ?? "custom";
      const payload: Record<string, unknown> = body.payload ?? {};

      logEvent(event, payload);
      await pushEvent(event, payload);

      return Response.json({ ok: true, event });
    } catch (err) {
      return Response.json(
        { ok: false, error: String(err) },
        { status: 400 }
      );
    }
  },
});

console.error(
  `[js2wasm-channel] HTTP server listening on http://127.0.0.1:7373/event`
);

// --- Watch plan/issues/ for file changes ---
const ISSUES_DIR = join(import.meta.dir, "../../plan/issues");
const watchDebounce = new Map<string, number>();
const DEBOUNCE_MS = 500;

function watchIssuesDir(dir: string) {
  try {
    watch(dir, { recursive: true }, async (eventType, filename) => {
      if (!filename) return;

      const now = Date.now();
      const key = `${eventType}:${filename}`;
      const last = watchDebounce.get(key) ?? 0;
      if (now - last < DEBOUNCE_MS) return;
      watchDebounce.set(key, now);

      // Determine which subfolder changed (ready, blocked, done, etc.)
      const parts = filename.split("/");
      const subfolder = parts.length > 1 ? parts[0] : "root";
      const file = basename(filename);

      const payload: Record<string, unknown> = {
        type: eventType,
        subfolder,
        file: filename,
      };

      logEvent("issues-changed", payload);

      const content = `Issue file ${eventType}: plan/issues/${filename} (${subfolder}/ folder). Check if this affects the dependency graph or unblocks other issues.`;
      const meta: Record<string, string> = { event: "issues-changed" };

      if (connected) {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: { content, meta },
        });
      } else {
        queue.push({ content, meta });
        if (queue.length > MAX_QUEUE) queue.shift();
      }
    });
    console.error(`[js2wasm-channel] Watching ${dir} for changes`);
  } catch (err) {
    console.error(`[js2wasm-channel] Could not watch ${dir}: ${err}`);
  }
}

watchIssuesDir(ISSUES_DIR);
