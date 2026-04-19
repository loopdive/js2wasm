/**
 * <dep-graph> — Interactive dependency graph web component.
 *
 * Usage:
 *   <dep-graph src="./public/graph-data.json"></dep-graph>
 *
 * Reads the generated graph-data.json (nodes + links) and renders
 * a layered DAG with SVG. No external dependencies.
 *
 * Color scheme matches the landing page (rgba(255,255,255,*) on dark gradient).
 */

class DepGraph extends HTMLElement {
  static get observedAttributes() {
    return ["src"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._data = null;
    this._filters = { status: new Set(["ready", "blocked", "in-progress"]), sprint: "active" };
    this._highlighted = null;
  }

  connectedCallback() {
    this._render();
  }

  attributeChangedCallback() {
    this._render();
  }

  async _render() {
    const src = this.getAttribute("src");
    if (!src) return;

    if (!this._data) {
      try {
        const resp = await fetch(src);
        if (!resp.ok) return;
        this._data = await resp.json();
      } catch {
        return;
      }
    }

    const { nodes, links } = this._data;
    if (!nodes || !links) return;

    // Filter nodes
    const filtered = this._filterNodes(nodes);
    const nodeMap = new Map(filtered.map((n) => [n.id, n]));
    const filteredLinks = links.filter((l) => nodeMap.has(l.source) && nodeMap.has(l.target));

    // Layout
    const layout = this._layeredLayout(filtered, filteredLinks);

    // Get unique sprints and statuses for filters
    const sprints = [...new Set(nodes.map((n) => n.sprint).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
    const statuses = [...new Set(nodes.map((n) => n.status || n.raw_status))];

    this.shadowRoot.innerHTML = `
      ${this._styles()}
      <div class="container">
        <div class="filter-bar">
          <div class="filter-group">
            <span class="filter-label">Status</span>
            ${statuses
              .map(
                (s) => `
              <button class="filter-btn ${this._filters.status.has(s) ? "active" : ""}"
                      data-filter="status" data-value="${s}">${s}</button>
            `,
              )
              .join("")}
          </div>
          <div class="filter-group">
            <span class="filter-label">Sprint</span>
            <button class="filter-btn ${this._filters.sprint === "active" ? "active" : ""}"
                    data-filter="sprint" data-value="active">Active</button>
            <button class="filter-btn ${this._filters.sprint === "all" ? "active" : ""}"
                    data-filter="sprint" data-value="all">All</button>
            ${sprints
              .slice(-5)
              .map(
                (s) => `
              <button class="filter-btn ${this._filters.sprint === s ? "active" : ""}"
                      data-filter="sprint" data-value="${s}">${s}</button>
            `,
              )
              .join("")}
          </div>
        </div>
        <div class="graph-wrap">
          ${this._renderSVG(layout, filteredLinks, nodeMap)}
        </div>
        <div class="tooltip" id="tooltip"></div>
      </div>
    `;

    this._attachEvents();
  }

  _filterNodes(nodes) {
    return nodes.filter((n) => {
      const st = n.status || n.raw_status;
      if (!this._filters.status.has(st)) return false;
      if (this._filters.sprint === "active") {
        // Show latest 3 sprints + no-sprint
        const s = Number(n.sprint);
        if (!n.sprint) return true;
        const maxSprint = Math.max(...nodes.map((x) => Number(x.sprint) || 0));
        return s >= maxSprint - 2;
      }
      if (this._filters.sprint !== "all" && n.sprint !== this._filters.sprint) return false;
      return true;
    });
  }

  _layeredLayout(nodes, links) {
    if (nodes.length === 0) return { nodes: [], width: 0, height: 0 };

    // Build adjacency
    const children = new Map();
    const parents = new Map();
    const nodeMap = new Map();
    for (const n of nodes) {
      nodeMap.set(n.id, n);
      children.set(n.id, []);
      parents.set(n.id, []);
    }
    for (const l of links) {
      if (children.has(l.source) && parents.has(l.target)) {
        children.get(l.source).push(l.target);
        parents.get(l.target).push(l.source);
      }
    }

    // Assign layers via longest-path from roots
    const layer = new Map();
    const visited = new Set();

    const assignLayer = (id) => {
      if (visited.has(id)) return layer.get(id) || 0;
      visited.add(id);
      const ps = parents.get(id) || [];
      if (ps.length === 0) {
        layer.set(id, 0);
        return 0;
      }
      const maxParent = Math.max(...ps.map((p) => assignLayer(p)));
      const l = maxParent + 1;
      layer.set(id, l);
      return l;
    };

    for (const n of nodes) assignLayer(n.id);

    // Group by layer
    const layers = new Map();
    for (const n of nodes) {
      const l = layer.get(n.id) || 0;
      if (!layers.has(l)) layers.set(l, []);
      layers.get(l).push(n);
    }

    // Sort layers by max count, assign x/y
    const NODE_W = 140;
    const NODE_H = 36;
    const GAP_X = 24;
    const GAP_Y = 60;
    const PAD = 40;

    const sortedLayers = [...layers.keys()].sort((a, b) => a - b);
    const maxPerLayer = Math.max(...sortedLayers.map((l) => layers.get(l).length), 1);
    const totalW = maxPerLayer * (NODE_W + GAP_X) - GAP_X + PAD * 2;
    const totalH = sortedLayers.length * (NODE_H + GAP_Y) - GAP_Y + PAD * 2;

    const positions = new Map();
    for (const li of sortedLayers) {
      const layerNodes = layers.get(li);
      const count = layerNodes.length;
      const layerW = count * (NODE_W + GAP_X) - GAP_X;
      const startX = (totalW - layerW) / 2;

      // Sort nodes in each layer by goal cluster for visual grouping
      layerNodes.sort((a, b) => (a.cluster || "").localeCompare(b.cluster || ""));

      for (let i = 0; i < count; i++) {
        const n = layerNodes[i];
        positions.set(n.id, {
          x: startX + i * (NODE_W + GAP_X),
          y: PAD + li * (NODE_H + GAP_Y),
          w: NODE_W,
          h: NODE_H,
          node: n,
        });
      }
    }

    return { nodes: positions, width: totalW, height: totalH };
  }

  _renderSVG(layout, links, nodeMap) {
    const { nodes: positions, width, height } = layout;
    if (positions.size === 0) {
      return '<div class="empty">No issues match current filters.</div>';
    }

    const svgW = Math.max(width, 600);
    const svgH = Math.max(height, 200);

    let edges = "";
    for (const l of links) {
      const from = positions.get(l.source);
      const to = positions.get(l.target);
      if (!from || !to) continue;

      const x1 = from.x + from.w / 2;
      const y1 = from.y + from.h;
      const x2 = to.x + to.w / 2;
      const y2 = to.y;
      const cy1 = y1 + (y2 - y1) * 0.4;
      const cy2 = y1 + (y2 - y1) * 0.6;

      edges += `<path class="edge" data-source="${l.source}" data-target="${l.target}"
        d="M${x1},${y1} C${x1},${cy1} ${x2},${cy2} ${x2},${y2}"
        fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1.5"
        marker-end="url(#arrowhead)"/>`;
    }

    let nodesSvg = "";
    for (const [id, pos] of positions) {
      const n = pos.node;
      const status = n.status || n.raw_status;
      const priority = n.priority || "medium";
      const cls = `node node-${status} node-p-${priority}`;

      // Truncate title
      const label = n.title.length > 20 ? n.title.slice(0, 18) + "\u2026" : n.title;
      const idLabel = `#${id}`;

      nodesSvg += `
        <g class="${cls}" data-id="${id}" transform="translate(${pos.x},${pos.y})">
          <rect width="${pos.w}" height="${pos.h}" rx="6" ry="6"/>
          <text class="node-id" x="8" y="15" font-size="10">${idLabel}</text>
          <text class="node-label" x="8" y="28" font-size="10">${this._escapeHtml(label)}</text>
        </g>`;
    }

    return `
      <svg viewBox="0 0 ${svgW} ${svgH}" width="100%" preserveAspectRatio="xMidYMin meet">
        <defs>
          <marker id="arrowhead" viewBox="0 0 10 7" refX="10" refY="3.5"
                  markerWidth="8" markerHeight="6" orient="auto-start-reverse">
            <polygon points="0 0, 10 3.5, 0 7" fill="rgba(255,255,255,0.3)"/>
          </marker>
        </defs>
        ${edges}
        ${nodesSvg}
      </svg>`;
  }

  _attachEvents() {
    const root = this.shadowRoot;

    // Filter buttons
    root.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const type = btn.dataset.filter;
        const val = btn.dataset.value;

        if (type === "status") {
          if (this._filters.status.has(val)) {
            this._filters.status.delete(val);
          } else {
            this._filters.status.add(val);
          }
        } else if (type === "sprint") {
          this._filters.sprint = val;
        }

        this._render();
      });
    });

    // Node hover
    root.querySelectorAll(".node").forEach((g) => {
      g.addEventListener("mouseenter", (e) => {
        const id = g.dataset.id;
        this._showTooltip(id, e);
        this._highlightPaths(id);
      });
      g.addEventListener("mouseleave", () => {
        this._hideTooltip();
        this._clearHighlight();
      });
      g.addEventListener("click", () => {
        const id = g.dataset.id;
        this._highlightPaths(id, true);
      });
    });

    // Mobile: tap on tooltip area dismisses
    const tooltip = root.getElementById("tooltip");
    if (tooltip) {
      tooltip.addEventListener("click", () => this._hideTooltip());
    }
  }

  _showTooltip(nodeId, event) {
    if (!this._data) return;
    const node = this._data.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const tooltip = this.shadowRoot.getElementById("tooltip");
    if (!tooltip) return;

    tooltip.innerHTML = `
      <div class="tt-title">#${node.id}: ${this._escapeHtml(node.title)}</div>
      <div class="tt-meta">
        <span>Status: ${node.status || node.raw_status}</span>
        <span>Priority: ${node.priority || "—"}</span>
        ${node.sprint ? `<span>Sprint: ${node.sprint}</span>` : ""}
        ${node.goal ? `<span>Goal: ${node.goal}</span>` : ""}
      </div>
    `;
    tooltip.style.display = "block";

    // Position near the node
    const rect = this.shadowRoot.querySelector(".graph-wrap").getBoundingClientRect();
    const x = event.clientX - rect.left + 12;
    const y = event.clientY - rect.top - 10;
    tooltip.style.left = `${Math.min(x, rect.width - 260)}px`;
    tooltip.style.top = `${y}px`;
  }

  _hideTooltip() {
    const tooltip = this.shadowRoot.getElementById("tooltip");
    if (tooltip) tooltip.style.display = "none";
  }

  _highlightPaths(nodeId, sticky) {
    if (!this._data) return;
    const { links } = this._data;

    // BFS ancestors and descendants
    const ancestors = new Set();
    const descendants = new Set();
    const nodeSet = new Set(this._data.nodes.map((n) => n.id));

    // Ancestors (follow links backward: target→source)
    const queue = [nodeId];
    while (queue.length > 0) {
      const curr = queue.shift();
      for (const l of links) {
        if (l.target === curr && !ancestors.has(l.source) && nodeSet.has(l.source)) {
          ancestors.add(l.source);
          queue.push(l.source);
        }
      }
    }

    // Descendants (follow links forward: source→target)
    const queue2 = [nodeId];
    while (queue2.length > 0) {
      const curr = queue2.shift();
      for (const l of links) {
        if (l.source === curr && !descendants.has(l.target) && nodeSet.has(l.target)) {
          descendants.add(l.target);
          queue2.push(l.target);
        }
      }
    }

    const highlighted = new Set([nodeId, ...ancestors, ...descendants]);

    // Dim non-highlighted nodes
    this.shadowRoot.querySelectorAll(".node").forEach((g) => {
      g.classList.toggle("dimmed", !highlighted.has(g.dataset.id));
      g.classList.toggle("highlighted", g.dataset.id === nodeId);
    });

    // Highlight relevant edges
    this.shadowRoot.querySelectorAll(".edge").forEach((edge) => {
      const s = edge.dataset.source;
      const t = edge.dataset.target;
      const onPath = highlighted.has(s) && highlighted.has(t);
      edge.classList.toggle("dimmed", !onPath);
      edge.classList.toggle("highlighted", onPath);
    });
  }

  _clearHighlight() {
    this.shadowRoot.querySelectorAll(".node").forEach((g) => {
      g.classList.remove("dimmed", "highlighted");
    });
    this.shadowRoot.querySelectorAll(".edge").forEach((e) => {
      e.classList.remove("dimmed", "highlighted");
    });
  }

  _escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  _styles() {
    return `<style>
      :host {
        display: block;
        width: 100%;
      }
      .container {
        position: relative;
        width: 100%;
      }
      .filter-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 16px;
        padding: 0 4px;
      }
      .filter-group {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .filter-label {
        font-size: 11px;
        font-weight: 600;
        color: rgba(255,255,255,0.5);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-family: var(--mono, monospace);
      }
      .filter-btn {
        font-size: 11px;
        padding: 3px 10px;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.15);
        background: transparent;
        color: rgba(255,255,255,0.5);
        cursor: pointer;
        transition: all 0.15s;
        font-family: var(--mono, monospace);
      }
      .filter-btn:hover {
        border-color: rgba(255,255,255,0.5);
        color: rgba(255,255,255,0.8);
      }
      .filter-btn.active {
        border-color: rgba(255,255,255,0.6);
        background: rgba(255,255,255,0.1);
        color: rgba(255,255,255,0.9);
      }
      .graph-wrap {
        overflow-x: auto;
        overflow-y: auto;
        max-height: 600px;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 8px;
        background: rgba(255,255,255,0.02);
      }
      svg {
        display: block;
        min-width: 600px;
      }

      /* Node styles */
      .node rect {
        fill: rgba(255,255,255,0.06);
        stroke: rgba(255,255,255,0.25);
        stroke-width: 1.2;
        cursor: pointer;
        transition: all 0.15s;
      }
      .node:hover rect {
        fill: rgba(255,255,255,0.12);
        stroke: rgba(255,255,255,0.7);
      }
      .node.highlighted rect {
        fill: rgba(255,255,255,0.15);
        stroke: rgba(255,255,255,0.9);
        stroke-width: 2;
      }
      .node.dimmed { opacity: 0.15; }

      .node-id {
        fill: rgba(255,255,255,0.5);
        font-family: var(--mono, monospace);
      }
      .node-label {
        fill: rgba(255,255,255,0.85);
        font-family: var(--font, sans-serif);
      }

      /* Status variants */
      .node-done rect { fill: rgba(255,255,255,0.03); stroke: rgba(255,255,255,0.1); stroke-dasharray: none; }
      .node-done .node-label, .node-done .node-id { fill: rgba(255,255,255,0.25); }
      .node-blocked rect { stroke-dasharray: 4 3; stroke: rgba(255,255,255,0.3); }
      .node-backlog rect { fill: rgba(255,255,255,0.02); stroke: rgba(255,255,255,0.08); }
      .node-backlog .node-label { fill: rgba(255,255,255,0.3); }
      .node-wont-fix rect { stroke: rgba(255,255,255,0.08); }
      .node-wont-fix .node-label { fill: rgba(255,255,255,0.2); text-decoration: line-through; }
      .node-in-progress rect { stroke: rgba(255,255,255,0.5); fill: rgba(255,255,255,0.08); }
      .node-ready rect { stroke: rgba(255,255,255,0.35); }

      /* Priority sizing */
      .node-p-critical rect { stroke-width: 2; }
      .node-p-high rect { stroke-width: 1.5; }

      /* Edges */
      .edge { transition: all 0.15s; }
      .edge.highlighted { stroke: rgba(255,255,255,0.7) !important; stroke-width: 2 !important; }
      .edge.dimmed { opacity: 0.08; }

      /* Tooltip */
      .tooltip {
        display: none;
        position: absolute;
        z-index: 20;
        background: rgba(12,18,32,0.95);
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 6px;
        padding: 10px 14px;
        max-width: 280px;
        pointer-events: none;
        backdrop-filter: blur(8px);
      }
      .tt-title {
        font-size: 12px;
        font-weight: 600;
        color: rgba(255,255,255,0.9);
        margin-bottom: 6px;
        font-family: var(--font, sans-serif);
      }
      .tt-meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .tt-meta span {
        font-size: 11px;
        color: rgba(255,255,255,0.5);
        font-family: var(--mono, monospace);
      }
      .empty {
        padding: 40px;
        text-align: center;
        color: rgba(255,255,255,0.4);
        font-size: 14px;
      }

      /* Mobile */
      @media (max-width: 440px) {
        .filter-bar {
          flex-direction: column;
          gap: 8px;
        }
        .filter-group {
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          padding-bottom: 4px;
        }
        .graph-wrap {
          max-height: 400px;
        }
        .tooltip {
          pointer-events: auto;
        }
      }
    </style>`;
  }
}

customElements.define("dep-graph", DepGraph);
