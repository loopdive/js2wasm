/**
 * <dep-graph> — Interactive dependency graph web component.
 *
 * Usage:
 *   <dep-graph src="./public/graph-data.json"></dep-graph>
 *
 * Reads the generated graph-data.json (nodes + links) and renders
 * a force-directed star graph with SVG. No external dependencies.
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
    this._filters = { status: new Set(["ready", "blocked", "backlog", "in-progress"]), sprint: "all" };
    this._highlighted = null;
    this._view = { scale: 1, tx: 0, ty: 0 };
    this._activePointers = new Map();
    this._panState = null;
    this._pinchState = null;
    this._suppressClickUntil = 0;
    this._hasUserAdjustedView = false;
    this._resizeObserver = null;
    this._resetViewRaf = 0;
  }

  connectedCallback() {
    this._render();
  }

  disconnectedCallback() {
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._resetViewRaf) cancelAnimationFrame(this._resetViewRaf);
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
    const layout = this._forceStarLayout(filtered, filteredLinks);

    // Get unique sprints and statuses for filters
    const sprints = [...new Set(nodes.map((n) => n.sprint).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
    const statuses = [...new Set(nodes.map((n) => n.status || n.raw_status))].sort(
      (a, b) => this._statusOrder(a) - this._statusOrder(b) || String(a).localeCompare(String(b)),
    );

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
            <button class="filter-btn ${this._filters.sprint === "all" ? "active" : ""}"
                    data-filter="sprint" data-value="all">All</button>
            <button class="filter-btn ${this._filters.sprint === "active" ? "active" : ""}"
                    data-filter="sprint" data-value="active">Current Block</button>
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
          ${this._renderSVG(layout, filteredLinks)}
        </div>
        <div class="tooltip" id="tooltip"></div>
      </div>
    `;

    this._attachEvents();
    this._hasUserAdjustedView = false;
    this._observeGraphWrap();
    this._scheduleResetView();
  }

  _filterNodes(nodes) {
    return nodes.filter((n) => {
      const st = n.status || n.raw_status;
      if (!this._filters.status.has(st)) return false;
      if (this._filters.sprint === "active") {
        const s = Number(n.sprint);
        if (!n.sprint) return true;
        const maxSprint = Math.max(...nodes.map((x) => Number(x.sprint) || 0));
        return s >= maxSprint - 2;
      }
      if (this._filters.sprint !== "all" && n.sprint !== this._filters.sprint) return false;
      return true;
    });
  }

  _forceStarLayout(nodes, links) {
    if (nodes.length === 0) return { nodes: new Map(), width: 0, height: 0 };

    const NODE_W = 152;
    const NODE_H = 40;
    const PAD = 120;
    const positions = new Map();
    const degree = new Map();

    for (const n of nodes) {
      degree.set(n.id, 0);
    }
    for (const l of links) {
      if (!degree.has(l.source) || !degree.has(l.target)) continue;
      degree.set(l.source, degree.get(l.source) + 1);
      degree.set(l.target, degree.get(l.target) + 1);
    }

    const clusters = new Map();
    for (const n of nodes) {
      const key = n.cluster || n.goal || "Unclustered";
      if (!clusters.has(key)) clusters.set(key, []);
      clusters.get(key).push(n);
    }

    const sortedClusters = [...clusters.entries()].sort((a, b) => {
      if (b[1].length !== a[1].length) return b[1].length - a[1].length;
      return a[0].localeCompare(b[0]);
    });

    const clusterCount = Math.max(sortedClusters.length, 1);
    const anchorRadius = Math.max(180, 110 + clusterCount * 18);
    const initialRadiusStep = 78;
    const maxDegree = Math.max(...degree.values(), 1);
    const clusterMeta = new Map();

    sortedClusters.forEach(([name, clusterNodes], idx) => {
      const angle = -Math.PI / 2 + (idx * Math.PI * 2) / clusterCount;
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);
      const perpX = -dirY;
      const perpY = dirX;
      clusterMeta.set(name, { angle, dirX, dirY, perpX, perpY });

      clusterNodes.sort((a, b) => {
        const degreeDiff = degree.get(b.id) - degree.get(a.id);
        if (degreeDiff) return degreeDiff;
        const priorityDiff = this._priorityWeight(b.priority) - this._priorityWeight(a.priority);
        if (priorityDiff) return priorityDiff;
        return Number(a.id) - Number(b.id);
      });

      clusterNodes.forEach((node, localIdx) => {
        const meta = clusterMeta.get(name);
        const priorityBias = 1 - this._priorityWeight(node.priority) / 5;
        const degreeBias = 1 - degree.get(node.id) / maxDegree;
        const lane = (localIdx % 3) - 1;
        const shell = Math.floor(localIdx / 3);
        const radius = anchorRadius + shell * initialRadiusStep + degreeBias * 70 + priorityBias * 24;
        const lateral = lane * 52 + (this._hashUnit(node.id) - 0.5) * 18;
        const x = meta.dirX * radius + meta.perpX * lateral;
        const y = meta.dirY * radius + meta.perpY * lateral;
        positions.set(node.id, {
          x,
          y,
          vx: 0,
          vy: 0,
          w: NODE_W,
          h: NODE_H,
          node,
          cluster: name,
          targetX: x,
          targetY: y,
        });
      });
    });

    const states = [...positions.values()];
    const iterations = nodes.length > 140 ? 180 : 140;

    for (let step = 0; step < iterations; step++) {
      const alpha = 1 - step / iterations;
      const springStrength = 0.016 + alpha * 0.018;
      const attractStrength = 0.01 + alpha * 0.022;
      const centerStrength = 0.002 + alpha * 0.003;

      for (const state of states) {
        state.fx = 0;
        state.fy = 0;

        const meta = clusterMeta.get(state.cluster);
        const currentAlong = state.x * meta.dirX + state.y * meta.dirY;
        const currentAcross = state.x * meta.perpX + state.y * meta.perpY;
        const targetAlong = state.targetX * meta.dirX + state.targetY * meta.dirY;
        const targetAcross = state.targetX * meta.perpX + state.targetY * meta.perpY;

        state.fx += meta.dirX * (targetAlong - currentAlong) * attractStrength;
        state.fy += meta.dirY * (targetAlong - currentAlong) * attractStrength;
        state.fx += meta.perpX * (targetAcross - currentAcross) * (attractStrength * 0.65);
        state.fy += meta.perpY * (targetAcross - currentAcross) * (attractStrength * 0.65);

        const centrality = degree.get(state.node.id) / maxDegree;
        state.fx += -state.x * centerStrength * centrality;
        state.fy += -state.y * centerStrength * centrality;
      }

      for (let i = 0; i < states.length; i++) {
        const a = states[i];
        for (let j = i + 1; j < states.length; j++) {
          const b = states[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distSq = dx * dx + dy * dy;
          if (distSq < 1) {
            dx = 0.5 - this._hashUnit(`${a.node.id}:${b.node.id}`);
            dy = 0.5 - this._hashUnit(`${b.node.id}:${a.node.id}`);
            distSq = dx * dx + dy * dy;
          }
          const dist = Math.sqrt(distSq);
          const minDist = a.cluster === b.cluster ? 88 : 104;
          const repel = (a.cluster === b.cluster ? 2400 : 3600) / distSq;
          const overlap = Math.max(0, minDist - dist);
          const push = repel + overlap * 0.08;
          const nx = dx / dist;
          const ny = dy / dist;

          a.fx -= nx * push;
          a.fy -= ny * push;
          b.fx += nx * push;
          b.fy += ny * push;
        }
      }

      for (const link of links) {
        const from = positions.get(link.source);
        const to = positions.get(link.target);
        if (!from || !to) continue;

        let dx = to.x - from.x;
        let dy = to.y - from.y;
        const dist = Math.max(Math.hypot(dx, dy), 1);
        const desired = from.cluster === to.cluster ? 124 : 168;
        const stretch = dist - desired;
        const nx = dx / dist;
        const ny = dy / dist;
        const force = stretch * springStrength;

        from.fx += nx * force;
        from.fy += ny * force;
        to.fx -= nx * force;
        to.fy -= ny * force;
      }

      for (const state of states) {
        state.vx = (state.vx + state.fx) * 0.82;
        state.vy = (state.vy + state.fy) * 0.82;
        state.x += state.vx;
        state.y += state.vy;
      }
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const state of states) {
      minX = Math.min(minX, state.x - NODE_W / 2);
      minY = Math.min(minY, state.y - NODE_H / 2);
      maxX = Math.max(maxX, state.x + NODE_W / 2);
      maxY = Math.max(maxY, state.y + NODE_H / 2);
    }

    const width = Math.max(720, Math.ceil(maxX - minX + PAD * 2));
    const height = Math.max(520, Math.ceil(maxY - minY + PAD * 2));
    const offsetX = PAD - minX;
    const offsetY = PAD - minY;
    const normalized = new Map();

    for (const [id, state] of positions) {
      normalized.set(id, {
        x: state.x - NODE_W / 2 + offsetX,
        y: state.y - NODE_H / 2 + offsetY,
        w: NODE_W,
        h: NODE_H,
        node: state.node,
      });
    }

    return { nodes: normalized, width, height };
  }

  _renderSVG(layout, links) {
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
      const y1 = from.y + from.h / 2;
      const x2 = to.x + to.w / 2;
      const y2 = to.y + to.h / 2;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const nx = -(y2 - y1);
      const ny = x2 - x1;
      const normalLength = Math.max(Math.hypot(nx, ny), 1);
      const curve = from.node.cluster === to.node.cluster ? 10 : 18;
      const cx = mx + (nx / normalLength) * curve;
      const cy = my + (ny / normalLength) * curve;

      edges += `<path class="edge" data-source="${l.source}" data-target="${l.target}"
        d="M${x1},${y1} Q${cx},${cy} ${x2},${y2}"
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
      const label = n.title.length > 24 ? n.title.slice(0, 22) + "\u2026" : n.title;
      const idLabel = `#${id}`;

      nodesSvg += `
        <g class="${cls}" data-id="${id}" transform="translate(${pos.x},${pos.y})">
          <rect width="${pos.w}" height="${pos.h}" rx="6" ry="6"/>
          <text class="node-id" x="8" y="15" font-size="10">${idLabel}</text>
          <text class="node-label" x="8" y="28" font-size="10">${this._escapeHtml(label)}</text>
        </g>`;
    }

    return `
      <svg viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" preserveAspectRatio="xMidYMin meet">
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
        if (this._isInteracting()) return;
        const id = g.dataset.id;
        this._showTooltip(id, e);
        this._highlightPaths(id);
      });
      g.addEventListener("mouseleave", () => {
        this._hideTooltip();
        this._clearHighlight();
      });
      g.addEventListener("click", () => {
        if (performance.now() < this._suppressClickUntil) return;
        const id = g.dataset.id;
        this._highlightPaths(id, true);
      });
    });

    // Mobile: tap on tooltip area dismisses
    const tooltip = root.getElementById("tooltip");
    if (tooltip) {
      tooltip.addEventListener("click", () => this._hideTooltip());
    }

    this._attachViewportEvents();
  }

  _attachViewportEvents() {
    const wrap = this.shadowRoot.querySelector(".graph-wrap");
    const svg = this.shadowRoot.querySelector("svg");
    if (!wrap || !svg) return;

    const toLocalPoint = (clientX, clientY) => {
      const rect = wrap.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const setPanFromPointer = (pointerId, point) => {
      this._panState = {
        pointerId,
        startX: point.x,
        startY: point.y,
        startTx: this._view.tx,
        startTy: this._view.ty,
        dragged: false,
      };
      wrap.classList.add("is-dragging");
    };

    const clearPan = () => {
      this._panState = null;
      wrap.classList.remove("is-dragging");
    };

    const beginPinch = () => {
      const pointers = [...this._activePointers.values()];
      if (pointers.length < 2) return;
      const [a, b] = pointers;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this._pinchState = {
        startDistance: distance,
        startScale: this._view.scale,
        startTx: this._view.tx,
        startTy: this._view.ty,
        startMid: mid,
      };
      clearPan();
      this._hideTooltip();
      this._clearHighlight();
      this._suppressClickUntil = performance.now() + 250;
      this._hasUserAdjustedView = true;
    };

    const updatePan = (point) => {
      if (!this._panState) return;
      const dx = point.x - this._panState.startX;
      const dy = point.y - this._panState.startY;
      if (!this._panState.dragged && Math.hypot(dx, dy) > 4) {
        this._panState.dragged = true;
        this._hasUserAdjustedView = true;
        this._hideTooltip();
        this._clearHighlight();
        this._suppressClickUntil = performance.now() + 250;
      }
      this._view.tx = this._panState.startTx + dx;
      this._view.ty = this._panState.startTy + dy;
      this._applyViewTransform();
    };

    const clampScale = (scale) => Math.min(4, Math.max(0.35, scale));

    const zoomAboutPoint = (point, nextScale) => {
      this._hasUserAdjustedView = true;
      const scale = clampScale(nextScale);
      const prevScale = this._view.scale || 1;
      const worldX = (point.x - this._view.tx) / prevScale;
      const worldY = (point.y - this._view.ty) / prevScale;
      this._view.scale = scale;
      this._view.tx = point.x - worldX * scale;
      this._view.ty = point.y - worldY * scale;
      this._applyViewTransform();
    };

    wrap.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const point = toLocalPoint(event.clientX, event.clientY);
        const factor = Math.exp(-event.deltaY * 0.0015);
        zoomAboutPoint(point, this._view.scale * factor);
        this._hideTooltip();
      },
      { passive: false },
    );

    wrap.addEventListener("pointerdown", (event) => {
      const point = toLocalPoint(event.clientX, event.clientY);
      this._activePointers.set(event.pointerId, point);
      wrap.setPointerCapture?.(event.pointerId);
      if (this._activePointers.size === 1) {
        setPanFromPointer(event.pointerId, point);
      } else if (this._activePointers.size === 2) {
        beginPinch();
      }
    });

    wrap.addEventListener("pointermove", (event) => {
      if (!this._activePointers.has(event.pointerId)) return;
      const point = toLocalPoint(event.clientX, event.clientY);
      this._activePointers.set(event.pointerId, point);

      if (this._pinchState && this._activePointers.size >= 2) {
        const [a, b] = [...this._activePointers.values()];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 1;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const nextScale = this._pinchState.startScale * (distance / this._pinchState.startDistance);
        const scale = clampScale(nextScale);
        const worldX = (this._pinchState.startMid.x - this._pinchState.startTx) / this._pinchState.startScale;
        const worldY = (this._pinchState.startMid.y - this._pinchState.startTy) / this._pinchState.startScale;
        this._view.scale = scale;
        this._view.tx = mid.x - worldX * scale;
        this._view.ty = mid.y - worldY * scale;
        this._applyViewTransform();
        return;
      }

      if (this._panState?.pointerId === event.pointerId) {
        updatePan(point);
      }
    });

    const endPointer = (event) => {
      this._activePointers.delete(event.pointerId);
      wrap.releasePointerCapture?.(event.pointerId);

      if (this._pinchState && this._activePointers.size < 2) {
        this._pinchState = null;
        const remaining = [...this._activePointers.entries()][0];
        if (remaining) {
          const [pointerId, point] = remaining;
          setPanFromPointer(pointerId, point);
        } else {
          clearPan();
        }
        return;
      }

      if (this._panState?.pointerId === event.pointerId) {
        const wasDragged = this._panState.dragged;
        clearPan();
        if (wasDragged) this._suppressClickUntil = performance.now() + 250;
      }
    };

    wrap.addEventListener("pointerup", endPointer);
    wrap.addEventListener("pointercancel", endPointer);
    wrap.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "mouse") return;
      if (this._activePointers.has(event.pointerId)) endPointer(event);
    });
  }

  _isInteracting() {
    return Boolean(this._panState || this._pinchState);
  }

  _resetView() {
    const wrap = this.shadowRoot.querySelector(".graph-wrap");
    const svg = this.shadowRoot.querySelector("svg");
    if (!wrap || !svg) return;

    const svgWidth = Number(svg.getAttribute("width")) || 1;
    const svgHeight = Number(svg.getAttribute("height")) || 1;
    const wrapWidth = wrap.clientWidth || svgWidth;
    const wrapHeight = wrap.clientHeight || svgHeight;
    const fitScale = Math.min((wrapWidth - 24) / svgWidth, (wrapHeight - 24) / svgHeight, 1);
    const scale = Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 1;

    this._view = {
      scale,
      tx: (wrapWidth - svgWidth * scale) / 2,
      ty: (wrapHeight - svgHeight * scale) / 2,
    };
    this._applyViewTransform();
  }

  _applyViewTransform() {
    const svg = this.shadowRoot.querySelector("svg");
    if (!svg) return;
    svg.style.transform = `translate(${this._view.tx}px, ${this._view.ty}px) scale(${this._view.scale})`;
  }

  _scheduleResetView() {
    if (this._resetViewRaf) cancelAnimationFrame(this._resetViewRaf);
    this._resetViewRaf = requestAnimationFrame(() => {
      this._resetViewRaf = requestAnimationFrame(() => {
        this._resetViewRaf = 0;
        this._resetView();
      });
    });
  }

  _observeGraphWrap() {
    const wrap = this.shadowRoot.querySelector(".graph-wrap");
    if (!wrap) return;
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._resizeObserver = new ResizeObserver(() => {
      if (!this._hasUserAdjustedView) this._scheduleResetView();
    });
    this._resizeObserver.observe(wrap);
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

  _statusOrder(status) {
    switch (status) {
      case "in-progress":
        return 0;
      case "ready":
        return 1;
      case "blocked":
        return 2;
      case "backlog":
        return 3;
      case "done":
        return 4;
      case "wont-fix":
        return 5;
      default:
        return 99;
    }
  }

  _priorityWeight(priority) {
    switch (priority) {
      case "critical":
        return 4;
      case "high":
        return 3;
      case "medium":
        return 2;
      case "low":
        return 1;
      default:
        return 0;
    }
  }

  _hashUnit(seed) {
    const str = String(seed);
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) % 10000) / 10000;
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
        position: relative;
        overflow-x: auto;
        overflow-y: auto;
        max-height: 600px;
        min-height: 420px;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 8px;
        background: rgba(255,255,255,0.02);
        cursor: grab;
        touch-action: none;
        overscroll-behavior: contain;
        overflow: hidden;
      }
      .graph-wrap.is-dragging { cursor: grabbing; }
      svg {
        position: absolute;
        top: 0;
        left: 0;
        display: block;
        width: auto;
        height: auto;
        transform-origin: 0 0;
        will-change: transform;
        user-select: none;
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
          min-height: 320px;
        }
        .tooltip {
          pointer-events: auto;
        }
      }
    </style>`;
  }
}

customElements.define("dep-graph", DepGraph);
