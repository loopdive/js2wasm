// ═══════════════════════════════════════════════════════════════════════════
// Layout engine — VS Code-like draggable panel system
// ═══════════════════════════════════════════════════════════════════════════

// ─── Types ───────────────────────────────────────────────────────────────

export interface TabItem {
  id: string;
  title: string;
  kind: "editor" | "dom";
  permanent?: boolean;
}

export type LayoutNode = SplitNode | LeafNode;

export interface SplitNode {
  type: "split";
  direction: "horizontal" | "vertical"; // horizontal = row, vertical = column
  ratio: number; // 0–1, first child's share
  children: [LayoutNode, LayoutNode];
}

export interface LeafNode {
  type: "leaf";
  id: string;
  tabs: string[];
  activeTab: string;
}

export type DropZone = "center" | "top" | "bottom" | "left" | "right";

const LAYOUT_KEY = "ts2wasm_layout_v2";
const MIN_PANEL_SIZE = 80; // px

export function clearSavedLayout(): void {
  try {
    localStorage.removeItem(LAYOUT_KEY);
  } catch { /* ignore */ }
}

// ─── Default layout ──────────────────────────────────────────────────────

export function getDefaultLayout(): LayoutNode {
  return {
    type: "split", direction: "horizontal", ratio: 0.18,
    children: [
      { type: "leaf", id: "sidebar-left", tabs: ["test262"], activeTab: "test262" },
      { type: "split", direction: "vertical", ratio: 0.6, children: [
        { type: "split", direction: "horizontal", ratio: 0.5,
          children: [
            { type: "leaf", id: "editor-left", tabs: ["ts-source"], activeTab: "ts-source" },
            { type: "leaf", id: "editor-right", tabs: ["wat-output", "wasm-hex", "modular-ts"], activeTab: "wat-output" },
          ],
        },
        { type: "split", direction: "horizontal", ratio: 0.5,
          children: [
            { type: "leaf", id: "output-left", tabs: ["errors", "preview", "console"], activeTab: "preview" },
            { type: "leaf", id: "output-right", tabs: ["treemap"], activeTab: "treemap" },
          ],
        },
      ]},
    ],
  };
}

// ─── Layout Manager ──────────────────────────────────────────────────────

export class LayoutManager {
  private root: LayoutNode;
  private container: HTMLElement;
  private tabs = new Map<string, TabItem>();
  private panelEls = new Map<string, { panel: HTMLElement; tabBar: HTMLElement; content: HTMLElement; activeTab: string }>();
  private panelCounter = 100;

  // Drag state
  private dragTabId: string | null = null;
  private dragSourcePanelId: string | null = null;
  private dropOverlay: HTMLElement | null = null;
  private dropZone: DropZone | null = null;
  private dropTargetPanelId: string | null = null;

  // Callbacks
  onMount: ((panelId: string, tabId: string, contentEl: HTMLElement) => void) | null = null;
  onUnmount: ((panelId: string, tabId: string) => void) | null = null;
  onLayoutChanged: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.root = getDefaultLayout();
  }

  registerTab(item: TabItem): void {
    this.tabs.set(item.id, item);
  }

  init(root?: LayoutNode): void {
    this.root = root ?? getDefaultLayout();
    // Ensure panelCounter won't collide with IDs from a loaded layout
    this.forEachLeaf(this.root, (leaf) => {
      const m = leaf.id.match(/^panel-(\d+)$/);
      if (m) this.panelCounter = Math.max(this.panelCounter, Number(m[1]) + 1);
    });
    this.render();
  }

  getRoot(): LayoutNode { return this.root; }

  // ─── Queries ─────────────────────────────────────────────────────────

  findPanelForTab(tabId: string): string | null {
    const leaf = this.findLeafByTab(tabId);
    return leaf?.id ?? null;
  }

  getPanelContentEl(panelId: string): HTMLElement | null {
    return this.panelEls.get(panelId)?.content ?? null;
  }

  getActiveTabForPanel(panelId: string): string | null {
    const leaf = this.findLeafById(this.root, panelId);
    return leaf?.activeTab ?? null;
  }

  getTabElement(tabId: string): HTMLElement | null {
    for (const { tabBar } of this.panelEls.values()) {
      const el = tabBar.querySelector(`[data-tab="${tabId}"]`) as HTMLElement | null;
      if (el) return el;
    }
    return null;
  }

  // ─── Tab switching ───────────────────────────────────────────────────

  switchTab(panelId: string, tabId: string): void {
    const leaf = this.findLeafById(this.root, panelId);
    if (!leaf || !leaf.tabs.includes(tabId) || leaf.activeTab === tabId) return;

    const prevTab = leaf.activeTab;
    this.onUnmount?.(panelId, prevTab);

    leaf.activeTab = tabId;

    // Update tab bar active state and tracked activeTab
    const els = this.panelEls.get(panelId);
    if (els) {
      els.activeTab = tabId;
      els.tabBar.querySelectorAll(".panel-tab").forEach((t) => {
        t.classList.toggle("active", (t as HTMLElement).dataset.tab === tabId);
      });
      this.onMount?.(panelId, tabId, els.content);
    }
  }

  // ─── Rendering ───────────────────────────────────────────────────────

  render(): void {
    // Unmount all current content (use tracked activeTab, not tree lookup)
    for (const [panelId, els] of this.panelEls) {
      this.onUnmount?.(panelId, els.activeTab);
    }
    this.panelEls.clear();

    // Build new DOM
    this.container.innerHTML = "";
    const dom = this.renderNode(this.root);
    this.container.appendChild(dom);

    // Mount content for all active tabs
    this.forEachLeaf(this.root, (leaf) => {
      const els = this.panelEls.get(leaf.id);
      if (els && leaf.activeTab) {
        this.onMount?.(leaf.id, leaf.activeTab, els.content);
      }
    });
  }

  private renderNode(node: LayoutNode): HTMLElement {
    if (node.type === "leaf") return this.renderLeaf(node);
    return this.renderSplit(node);
  }

  private renderSplit(node: SplitNode): HTMLElement {
    const el = document.createElement("div");
    el.className = "layout-split";
    el.style.display = "flex";
    el.style.flexDirection = node.direction === "horizontal" ? "row" : "column";
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.minWidth = "0";
    el.style.minHeight = "0";

    const child1 = this.renderNode(node.children[0]);
    child1.className = "layout-child";
    child1.style.flex = `0 0 calc(${(node.ratio * 100).toFixed(2)}% - 3px)`;
    child1.style.minWidth = "0";
    child1.style.minHeight = "0";
    child1.style.overflow = "hidden";

    const divider = document.createElement("div");
    divider.className = node.direction === "horizontal" ? "layout-divider-h" : "layout-divider-v";
    this.setupDivider(divider, node, el, child1);

    const child2 = this.renderNode(node.children[1]);
    child2.className = "layout-child";
    child2.style.flex = "1 1 0";
    child2.style.minWidth = "0";
    child2.style.minHeight = "0";
    child2.style.overflow = "hidden";

    el.appendChild(child1);
    el.appendChild(divider);
    el.appendChild(child2);
    return el;
  }

  private renderLeaf(leaf: LeafNode): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "layout-panel";
    panel.dataset.panel = leaf.id;
    panel.style.display = "flex";
    panel.style.flexDirection = "column";
    panel.style.width = "100%";
    panel.style.height = "100%";
    panel.style.minWidth = "0";
    panel.style.minHeight = "0";
    panel.style.overflow = "hidden";

    // Tab bar
    const tabBar = document.createElement("div");
    tabBar.className = "panel-tab-bar";
    for (const tabId of leaf.tabs) {
      const tab = this.tabs.get(tabId);
      if (!tab) continue;
      const tabEl = document.createElement("div");
      tabEl.className = "panel-tab" + (tabId === leaf.activeTab ? " active" : "");
      tabEl.dataset.tab = tabId;

      const label = document.createElement("span");
      label.className = "panel-tab-label";
      label.textContent = tab.title;
      tabEl.appendChild(label);

      if (!tab.permanent) {
        const closeBtn = document.createElement("span");
        closeBtn.className = "close-btn";
        closeBtn.textContent = "\u00d7";
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const currentPanel = this.findPanelForTab(tabId);
          if (currentPanel) this.closeTab(currentPanel, tabId);
        });
        tabEl.appendChild(closeBtn);
      }

      // Enable draggable only from the label area, not the close button
      tabEl.addEventListener("mousedown", (e) => {
        if (!(e.target as HTMLElement).classList.contains("close-btn")) {
          tabEl.draggable = true;
        }
      });
      tabEl.addEventListener("mouseup", () => { tabEl.draggable = false; });
      tabEl.addEventListener("click", () => this.switchTab(leaf.id, tabId));
      this.setupTabDrag(tabEl, tabId, leaf.id);
      tabBar.appendChild(tabEl);
    }
    panel.appendChild(tabBar);

    // Content area
    const content = document.createElement("div");
    content.className = "panel-content";
    content.style.flex = "1";
    content.style.position = "relative";
    content.style.overflow = "hidden";
    content.style.minHeight = "0";
    panel.appendChild(content);

    // Setup drop zone
    this.setupDropZone(panel, leaf.id);

    this.panelEls.set(leaf.id, { panel, tabBar, content, activeTab: leaf.activeTab });
    return panel;
  }

  private closeTab(panelId: string, tabId: string): void {
    const leaf = this.findLeafById(this.root, panelId);
    if (!leaf) return;

    const tab = this.tabs.get(tabId);
    if (tab?.permanent) return;

    const idx = leaf.tabs.indexOf(tabId);
    if (idx === -1) return;

    if (leaf.tabs.length <= 1) {
      // Last tab in panel — remove the entire panel
      this.onUnmount?.(panelId, tabId);
      leaf.tabs.splice(idx, 1);
      this.removeEmptyLeaf(panelId);
      this.render();
      this.saveLayout();
      return;
    }

    if (leaf.activeTab === tabId) {
      this.onUnmount?.(panelId, tabId);
      leaf.tabs.splice(idx, 1);
      leaf.activeTab = leaf.tabs[Math.min(idx, leaf.tabs.length - 1)];
      this.render();
    } else {
      leaf.tabs.splice(idx, 1);
      const els = this.panelEls.get(panelId);
      if (els) {
        const tabEl = els.tabBar.querySelector(`[data-tab="${tabId}"]`);
        tabEl?.remove();
      }
    }
    this.saveLayout();
  }

  // ─── Divider resize ──────────────────────────────────────────────────

  private setupDivider(divider: HTMLElement, node: SplitNode, splitEl: HTMLElement, child1: HTMLElement): void {
    divider.addEventListener("mousedown", (e) => {
      e.preventDefault();
      divider.classList.add("active");

      const isH = node.direction === "horizontal";
      const rect = splitEl.getBoundingClientRect();

      const onMove = (ev: MouseEvent) => {
        const pos = isH ? ev.clientX - rect.left : ev.clientY - rect.top;
        const total = isH ? rect.width : rect.height;
        const ratio = Math.max(MIN_PANEL_SIZE / total, Math.min(1 - MIN_PANEL_SIZE / total, pos / total));
        node.ratio = ratio;
        child1.style.flex = `0 0 calc(${(ratio * 100).toFixed(2)}% - 3px)`;
        // Trigger editor relayout
        this.onLayoutChanged?.();
      };

      const onUp = () => {
        divider.classList.remove("active");
        this.saveLayout();
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    // Double-click to reset to 50%
    divider.addEventListener("dblclick", () => {
      node.ratio = 0.5;
      child1.style.flex = `0 0 calc(50% - 3px)`;
      this.saveLayout();
      this.onLayoutChanged?.();
    });
  }

  // ─── Tab drag and drop ───────────────────────────────────────────────

  private setupTabDrag(tabEl: HTMLElement, tabId: string, panelId: string): void {
    tabEl.addEventListener("dragstart", (e) => {
      this.dragTabId = tabId;
      this.dragSourcePanelId = panelId;
      tabEl.classList.add("dragging");
      e.dataTransfer!.effectAllowed = "move";
      e.dataTransfer!.setData("text/plain", tabId);

      // Small drag image
      const ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.textContent = this.tabs.get(tabId)?.title ?? tabId;
      document.body.appendChild(ghost);
      e.dataTransfer!.setDragImage(ghost, 0, 0);
      requestAnimationFrame(() => ghost.remove());
    });

    tabEl.addEventListener("dragend", () => {
      tabEl.classList.remove("dragging");
      this.dragTabId = null;
      this.dragSourcePanelId = null;
      this.clearDropOverlay();
    });
  }

  private setupDropZone(panelEl: HTMLElement, panelId: string): void {
    panelEl.addEventListener("dragover", (e) => {
      if (!this.dragTabId) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";

      const zone = this.detectDropZone(panelEl, e.clientX, e.clientY);
      if (zone !== this.dropZone || panelId !== this.dropTargetPanelId) {
        this.dropZone = zone;
        this.dropTargetPanelId = panelId;
        this.showDropOverlay(panelEl, zone);
      }
    });

    panelEl.addEventListener("dragleave", (e) => {
      // Only clear if we actually left the panel (not just entering a child)
      if (!panelEl.contains(e.relatedTarget as Node)) {
        this.clearDropOverlay();
        this.dropZone = null;
        this.dropTargetPanelId = null;
      }
    });

    panelEl.addEventListener("drop", (e) => {
      e.preventDefault();
      const tabId = this.dragTabId;
      const sourcePanel = this.dragSourcePanelId;
      const zone = this.dropZone;

      this.clearDropOverlay();
      this.dragTabId = null;
      this.dragSourcePanelId = null;
      this.dropZone = null;
      this.dropTargetPanelId = null;

      if (!tabId || !sourcePanel || !zone) return;
      // Don't drop on own panel center (no-op) or if it's the same single-tab panel
      if (sourcePanel === panelId && zone === "center") return;
      if (sourcePanel === panelId) {
        // Splitting within same panel — only if panel has >1 tab
        const leaf = this.findLeafById(this.root, sourcePanel);
        if (!leaf || leaf.tabs.length <= 1) return;
      }

      this.moveTab(tabId, sourcePanel, panelId, zone);
    });
  }

  private detectDropZone(panel: HTMLElement, x: number, y: number): DropZone {
    const rect = panel.getBoundingClientRect();
    const relX = (x - rect.left) / rect.width;
    const relY = (y - rect.top) / rect.height;

    if (relY < 0.22) return "top";
    if (relY > 0.78) return "bottom";
    if (relX < 0.22) return "left";
    if (relX > 0.78) return "right";
    return "center";
  }

  private showDropOverlay(panel: HTMLElement, zone: DropZone): void {
    this.clearDropOverlay();
    const overlay = document.createElement("div");
    overlay.className = "drop-overlay";

    const indicator = document.createElement("div");
    indicator.className = "drop-indicator";

    switch (zone) {
      case "center":
        indicator.style.inset = "0";
        break;
      case "top":
        indicator.style.cssText = "top:0;left:0;right:0;height:50%";
        break;
      case "bottom":
        indicator.style.cssText = "bottom:0;left:0;right:0;height:50%";
        break;
      case "left":
        indicator.style.cssText = "top:0;left:0;bottom:0;width:50%";
        break;
      case "right":
        indicator.style.cssText = "top:0;right:0;bottom:0;width:50%";
        break;
    }

    overlay.appendChild(indicator);
    panel.style.position = "relative";
    panel.appendChild(overlay);
    this.dropOverlay = overlay;
  }

  private clearDropOverlay(): void {
    if (this.dropOverlay) {
      this.dropOverlay.remove();
      this.dropOverlay = null;
    }
  }

  // ─── Tree mutations ──────────────────────────────────────────────────

  moveTab(tabId: string, sourcePanelId: string, targetPanelId: string, zone: DropZone): void {
    const sourceLeaf = this.findLeafById(this.root, sourcePanelId);
    const targetLeaf = this.findLeafById(this.root, targetPanelId);
    if (!sourceLeaf || !targetLeaf) return;

    // Remove tab from source
    const idx = sourceLeaf.tabs.indexOf(tabId);
    if (idx === -1) return;
    sourceLeaf.tabs.splice(idx, 1);
    if (sourceLeaf.activeTab === tabId) {
      sourceLeaf.activeTab = sourceLeaf.tabs[Math.min(idx, sourceLeaf.tabs.length - 1)] ?? "";
    }

    if (zone === "center") {
      // Merge: add tab to target panel
      targetLeaf.tabs.push(tabId);
      targetLeaf.activeTab = tabId;
    } else {
      // Split: create new panel with the dropped tab
      const newLeafId = `panel-${this.panelCounter++}`;
      const newLeaf: LeafNode = { type: "leaf", id: newLeafId, tabs: [tabId], activeTab: tabId };

      // Deep copy the target leaf so we don't share the tabs array
      const targetCopy: LeafNode = {
        type: "leaf",
        id: targetLeaf.id,
        tabs: [...targetLeaf.tabs],
        activeTab: targetLeaf.activeTab,
      };

      const direction: "horizontal" | "vertical" =
        zone === "left" || zone === "right" ? "horizontal" : "vertical";
      const first = zone === "left" || zone === "top" ? newLeaf : targetCopy;
      const second = zone === "left" || zone === "top" ? targetCopy : newLeaf;

      const splitNode: SplitNode = {
        type: "split",
        direction,
        ratio: 0.5,
        children: [first, second],
      };

      // Replace target in tree (handle root-is-leaf case)
      if (this.root === targetLeaf) {
        this.root = splitNode;
      } else {
        this.replaceNode(this.root, targetPanelId, splitNode);
      }
    }

    // Remove empty source panel
    if (sourceLeaf.tabs.length === 0) {
      this.removeEmptyLeaf(sourcePanelId);
    }

    this.render();
    this.saveLayout();
  }

  private replaceNode(root: LayoutNode, targetId: string, replacement: LayoutNode): boolean {
    if (root.type !== "split") return false;
    for (let i = 0; i < 2; i++) {
      const child = root.children[i];
      if (child.type === "leaf" && child.id === targetId) {
        root.children[i] = replacement;
        return true;
      }
      if (child.type === "split" && this.replaceNode(child, targetId, replacement)) return true;
    }
    return false;
  }

  private removeEmptyLeaf(leafId: string): void {
    this.removeLeafFromTree(null, this.root, leafId);
  }

  private removeLeafFromTree(parent: SplitNode | null, node: LayoutNode, targetId: string): boolean {
    if (node.type === "leaf") return false;

    for (let i = 0; i < 2; i++) {
      const child = node.children[i];
      if (child.type === "leaf" && child.id === targetId) {
        // Replace this split node with the other child
        const sibling = node.children[1 - i];
        if (parent) {
          const parentIdx = parent.children.indexOf(node);
          if (parentIdx !== -1) parent.children[parentIdx] = sibling;
        } else {
          // node is root — replace root directly
          this.root = sibling;
        }
        return true;
      }
      if (child.type === "split" && this.removeLeafFromTree(node, child, targetId)) return true;
    }
    return false;
  }

  resetLayout(): void {
    this.root = getDefaultLayout();
    this.render();
    this.saveLayout();
  }

  // ─── Tree traversal ──────────────────────────────────────────────────

  private findLeafByTab(tabId: string): LeafNode | null {
    return this.findLeafWhere(this.root, (l) => l.tabs.includes(tabId));
  }

  private findLeafById(node: LayoutNode, id: string): LeafNode | null {
    return this.findLeafWhere(node, (l) => l.id === id);
  }

  private findLeafWhere(node: LayoutNode, predicate: (leaf: LeafNode) => boolean): LeafNode | null {
    if (node.type === "leaf") return predicate(node) ? node : null;
    return this.findLeafWhere(node.children[0], predicate) ?? this.findLeafWhere(node.children[1], predicate);
  }

  private forEachLeaf(node: LayoutNode, fn: (leaf: LeafNode) => void): void {
    if (node.type === "leaf") { fn(node); return; }
    this.forEachLeaf(node.children[0], fn);
    this.forEachLeaf(node.children[1], fn);
  }

  // ─── Persistence ─────────────────────────────────────────────────────

  saveLayout(): void {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(this.serializeNode(this.root)));
    } catch { /* quota exceeded */ }
  }

  static loadLayout(allTabIds: Set<string>): LayoutNode | null {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // Validate: all tab IDs in the layout must exist in allTabIds
      const layoutTabs = new Set<string>();
      collectTabIds(parsed, layoutTabs);
      if (layoutTabs.size === 0) return null;
      // Every tab in layout must be known
      for (const id of layoutTabs) {
        if (!allTabIds.has(id)) return null;
      }
      // Every known tab must be in layout
      for (const id of allTabIds) {
        if (!layoutTabs.has(id)) return null;
      }
      return parsed as LayoutNode;
    } catch {
      return null;
    }
  }

  private serializeNode(node: LayoutNode): any {
    if (node.type === "leaf") {
      return { type: "leaf", id: node.id, tabs: node.tabs, activeTab: node.activeTab };
    }
    return {
      type: "split",
      direction: node.direction,
      ratio: node.ratio,
      children: [this.serializeNode(node.children[0]), this.serializeNode(node.children[1])],
    };
  }
}

function collectTabIds(node: any, set: Set<string>): void {
  if (node.type === "leaf" && Array.isArray(node.tabs)) {
    for (const t of node.tabs) set.add(t);
  } else if (node.type === "split" && Array.isArray(node.children)) {
    for (const c of node.children) collectTabIds(c, set);
  }
}
