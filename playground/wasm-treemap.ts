// WASM Binary Treemap — embeddable module
// Parses .wasm binaries and renders an interactive treemap visualization.

// ─── Types ──────────────────────────────────────────────────────────────

interface WasmSection {
  id: number;
  name: string;
  offset: number;
  headerSize: number;
  dataSize: number;
  totalSize: number;
  customName?: string | null;
}

interface WasmImport {
  module: string;
  name: string;
  kind: string;
  index: number;
  size: number;
}

interface WasmExport {
  name: string;
  kind: string;
  index: number;
}

interface WasmFunctionBody {
  index: number;
  bodySize: number;
  totalSize: number;
  offset: number;
}

interface WasmData {
  fileSize: number;
  version: number;
  headerSize: number;
  sections: WasmSection[];
  functionNames: Map<number, string>;
  imports: WasmImport[];
  exports: WasmExport[];
  functionBodies: WasmFunctionBody[];
  typeCount: number;
  importFuncCount: number;
  exportNames: Map<number, string>;
}

interface TreeNode {
  _id: number;
  _originalId?: number;
  name: string;
  children: Record<string, TreeNode>;
  size: number;
  fullPath: string;
  isLeaf: boolean;
  isRemainder: boolean;
  remainderCount?: number;
  isRoot?: boolean;
}

interface LayoutItem {
  size: number;
  node: TreeNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

type ViewMode = "sections" | "functions";

// ─── Section names ──────────────────────────────────────────────────────

const SECTION_NAMES: Record<number, string> = {
  0: "custom",
  1: "type",
  2: "import",
  3: "function",
  4: "table",
  5: "memory",
  6: "global",
  7: "export",
  8: "start",
  9: "element",
  10: "code",
  11: "data",
  12: "datacount",
};

// ─── Fixed section colors ───────────────────────────────────────────────

const SECTION_COLORS: Record<string, [number, number, number]> = {
  code: [70, 140, 200],
  type: [180, 100, 60],
  import: [100, 170, 80],
  export: [200, 160, 50],
  data: [160, 80, 160],
  function: [80, 160, 160],
  table: [200, 100, 100],
  memory: [100, 100, 200],
  global: [150, 150, 80],
  element: [80, 150, 130],
  start: [180, 120, 80],
  custom: [120, 120, 140],
  datacount: [130, 100, 150],
  header: [60, 60, 80],
};

const HUE_PALETTE: [number, number, number][] = (() => {
  const colors: [number, number, number][] = [];
  const golden = 137.508;
  for (let i = 0; i < 40; i++) {
    const h = (i * golden) % 360;
    const s = 0.75,
      l = 0.55;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r: number, g: number, b: number;
    if (h < 60) {
      r = c;
      g = x;
      b = 0;
    } else if (h < 120) {
      r = x;
      g = c;
      b = 0;
    } else if (h < 180) {
      r = 0;
      g = c;
      b = x;
    } else if (h < 240) {
      r = 0;
      g = x;
      b = c;
    } else if (h < 300) {
      r = x;
      g = 0;
      b = c;
    } else {
      r = c;
      g = 0;
      b = x;
    }
    colors.push([
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255),
    ]);
  }
  return colors;
})();

// ─── LEB128 decoder ─────────────────────────────────────────────────────

function readU32Leb(
  bytes: Uint8Array,
  offset: number,
): { value: number; next: number } {
  let result = 0,
    shift = 0,
    pos = offset;
  while (true) {
    const byte = bytes[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result >>> 0, next: pos };
}

function readName(
  bytes: Uint8Array,
  offset: number,
): { value: string; next: number } {
  const { value: len, next: p } = readU32Leb(bytes, offset);
  const nameBytes = bytes.slice(p, p + len);
  return { value: new TextDecoder().decode(nameBytes), next: p + len };
}

// ─── WASM binary parser ─────────────────────────────────────────────────

export function parseWasm(buffer: ArrayBuffer): WasmData {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 8) throw new Error("File too small to be a valid .wasm");

  const magic =
    bytes[0] === 0x00 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x73 &&
    bytes[3] === 0x6d;
  if (!magic) throw new Error("Invalid WASM magic bytes");

  const version =
    bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);

  const result: WasmData = {
    fileSize: bytes.length,
    version,
    headerSize: 8,
    sections: [],
    functionNames: new Map(),
    imports: [],
    exports: [],
    functionBodies: [],
    typeCount: 0,
    importFuncCount: 0,
    exportNames: new Map(),
  };

  let pos = 8;

  while (pos < bytes.length) {
    const sectionId = bytes[pos++];
    const { value: sectionSize, next: dataStart } = readU32Leb(bytes, pos);
    const overhead = dataStart - (pos - 1);
    const sectionEnd = dataStart + sectionSize;

    const sectionName = SECTION_NAMES[sectionId] || `unknown_${sectionId}`;
    const section: WasmSection = {
      id: sectionId,
      name: sectionName,
      offset: pos - 1,
      headerSize: overhead,
      dataSize: sectionSize,
      totalSize: overhead + sectionSize,
      customName: null,
    };

    if (sectionId === 0) {
      const { value: cname } = readName(bytes, dataStart);
      section.customName = cname;
      section.name = `custom:"${cname}"`;
    }

    if (sectionId === 1) {
      const { value: count } = readU32Leb(bytes, dataStart);
      result.typeCount = count;
    }

    if (sectionId === 2) {
      let p = dataStart;
      const { value: count, next: p2 } = readU32Leb(bytes, p);
      p = p2;
      let funcIdx = 0;
      for (let i = 0; i < count; i++) {
        const importStart = p;
        const { value: mod, next: p3 } = readName(bytes, p);
        p = p3;
        const { value: name, next: p4 } = readName(bytes, p);
        p = p4;
        const kind = bytes[p++];
        if (kind === 0) {
          const { next: p5 } = readU32Leb(bytes, p);
          p = p5;
          result.imports.push({
            module: mod,
            name,
            kind: "func",
            index: funcIdx++,
            size: p - importStart,
          });
        } else if (kind === 1) {
          p++; // reftype
          const { value: flags, next: p5 } = readU32Leb(bytes, p);
          p = p5;
          const { next: p6 } = readU32Leb(bytes, p);
          p = p6;
          if (flags & 1) {
            const { next: p7 } = readU32Leb(bytes, p);
            p = p7;
          }
          result.imports.push({
            module: mod,
            name,
            kind: "table",
            index: i,
            size: p - importStart,
          });
        } else if (kind === 2) {
          const { value: flags, next: p5 } = readU32Leb(bytes, p);
          p = p5;
          const { next: p6 } = readU32Leb(bytes, p);
          p = p6;
          if (flags & 1) {
            const { next: p7 } = readU32Leb(bytes, p);
            p = p7;
          }
          result.imports.push({
            module: mod,
            name,
            kind: "memory",
            index: i,
            size: p - importStart,
          });
        } else if (kind === 3) {
          p++; // valtype
          p++; // mutability
          result.imports.push({
            module: mod,
            name,
            kind: "global",
            index: i,
            size: p - importStart,
          });
        }
      }
      result.importFuncCount = funcIdx;
    }

    if (sectionId === 7) {
      let p = dataStart;
      const { value: count, next: p2 } = readU32Leb(bytes, p);
      p = p2;
      for (let i = 0; i < count; i++) {
        const { value: name, next: p3 } = readName(bytes, p);
        p = p3;
        const kind = bytes[p++];
        const EXPORT_KIND: Record<number, string> = {
          0: "func",
          1: "table",
          2: "memory",
          3: "global",
        };
        const { value: index, next: p4 } = readU32Leb(bytes, p);
        p = p4;
        result.exports.push({
          name,
          kind: EXPORT_KIND[kind] || `kind_${kind}`,
          index,
        });
      }
    }

    if (sectionId === 10) {
      let p = dataStart;
      const { value: count, next: p2 } = readU32Leb(bytes, p);
      p = p2;
      for (let i = 0; i < count; i++) {
        const bodyStart = p;
        const { value: bodySize, next: codeStart } = readU32Leb(bytes, p);
        const headerBytes = codeStart - bodyStart;
        result.functionBodies.push({
          index: i,
          bodySize,
          totalSize: headerBytes + bodySize,
          offset: bodyStart,
        });
        p = codeStart + bodySize;
      }
    }

    if (sectionId === 0 && section.customName === "name") {
      try {
        const { next: afterName } = readName(bytes, dataStart);
        let p = afterName;
        while (p < sectionEnd) {
          const subId = bytes[p++];
          const { value: subSize, next: subStart } = readU32Leb(bytes, p);
          p = subStart;
          if (subId === 1) {
            let sp = p;
            const { value: nameCount, next: sp2 } = readU32Leb(bytes, sp);
            sp = sp2;
            for (let i = 0; i < nameCount && sp < p + subSize; i++) {
              const { value: funcIndex, next: sp3 } = readU32Leb(bytes, sp);
              sp = sp3;
              const { value: funcName, next: sp4 } = readName(bytes, sp);
              sp = sp4;
              result.functionNames.set(funcIndex, funcName);
            }
          }
          p += subSize;
        }
      } catch {
        /* name section parsing is best-effort */
      }
    }

    result.sections.push(section);
    pos = sectionEnd;
  }

  for (const exp of result.exports) {
    if (exp.kind === "func") {
      result.exportNames.set(exp.index, exp.name);
    }
  }

  return result;
}

// ─── Treemap widget ─────────────────────────────────────────────────────

export class WasmTreemap {
  private container: HTMLElement;
  private tooltip: HTMLElement;
  private treemapEl: HTMLElement;
  private infoBar: HTMLElement;
  private breadcrumbsBar: HTMLElement;
  private controlsBar: HTMLElement;

  private wasmData: WasmData | null = null;
  private treeRoot: TreeNode | null = null;
  private totalFileSize = 0;
  private viewMode: ViewMode = "sections";
  private thresholdPct = 2;

  private nextNodeId = 0;
  private nodeById = new Map<number, TreeNode>();
  private colorMap = new Map<string, [number, number, number]>();
  private colorIdx = 0;
  private zoomStack: {
    nodeId: number;
    crateRgb: [number, number, number] | null;
    name: string;
  }[] = [];

  private resizeObserver: ResizeObserver;
  private resizeTimer = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    container.innerHTML = "";
    container.style.flexDirection = "column";
    container.style.overflow = "hidden";
    container.style.height = "100%";

    // Controls bar (view toggle + threshold)
    this.controlsBar = document.createElement("div");
    this.controlsBar.className = "tm-controls";
    this.controlsBar.innerHTML = `
      <div class="tm-view-toggle">
        <button class="tm-toggle active" data-mode="sections">Sections</button>
        <button class="tm-toggle" data-mode="functions">Functions</button>
      </div>
      <div class="tm-threshold">
        <label>Remainder:</label>
        <input type="range" min="0" max="20" value="2" step="0.5">
        <span>2%</span>
      </div>
    `;
    container.appendChild(this.controlsBar);

    // Info bar
    this.infoBar = document.createElement("div");
    this.infoBar.className = "tm-info-bar";
    this.infoBar.style.display = "none";
    container.appendChild(this.infoBar);

    // Breadcrumbs
    this.breadcrumbsBar = document.createElement("div");
    this.breadcrumbsBar.className = "tm-breadcrumbs";
    container.appendChild(this.breadcrumbsBar);

    // Treemap area
    this.treemapEl = document.createElement("div");
    this.treemapEl.className = "tm-treemap";
    container.appendChild(this.treemapEl);

    // Empty state
    this.showEmpty();

    // Tooltip (appended to body to avoid clipping)
    this.tooltip = document.createElement("div");
    this.tooltip.className = "tm-tooltip";
    this.tooltip.innerHTML = `
      <div class="tm-tt-path"></div>
      <div class="tm-tt-row"><span class="tm-tt-label">Size</span><span class="tm-tt-value"></span></div>
      <div class="tm-tt-row"><span class="tm-tt-label">% of file</span><span class="tm-tt-value"></span></div>
      <div class="tm-tt-row tm-tt-parent"><span class="tm-tt-label">% of parent</span><span class="tm-tt-value"></span></div>
      <div class="tm-tt-row tm-tt-children" style="display:none"><span class="tm-tt-label">Children</span><span class="tm-tt-value"></span></div>
      <div class="tm-tt-hint"></div>
    `;
    document.body.appendChild(this.tooltip);

    // Wire controls
    this.controlsBar.querySelectorAll(".tm-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.viewMode = (btn as HTMLElement).dataset.mode as ViewMode;
        this.controlsBar
          .querySelectorAll(".tm-toggle")
          .forEach((b) =>
            b.classList.toggle(
              "active",
              (b as HTMLElement).dataset.mode === this.viewMode,
            ),
          );
        if (this.wasmData) this.rebuild();
      });
    });

    const slider = this.controlsBar.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    const sliderVal = this.controlsBar.querySelector(
      ".tm-threshold span",
    ) as HTMLSpanElement;
    slider.addEventListener("input", () => {
      this.thresholdPct = parseFloat(slider.value);
      sliderVal.textContent = this.thresholdPct + "%";
      if (this.treeRoot) this.renderCurrentView();
    });

    // Escape to zoom out
    this.onKeyDown = this.onKeyDown.bind(this);
    document.addEventListener("keydown", this.onKeyDown);

    // Resize
    this.resizeObserver = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        if (this.treeRoot) this.renderCurrentView();
      }, 100);
    });
    this.resizeObserver.observe(this.treemapEl);
  }

  private showEmpty() {
    this.treemapEl.innerHTML = `
      <div class="tm-empty">
        <p>Compile to see binary treemap</p>
      </div>
    `;
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && this.zoomStack.length > 0) {
      this.zoomStack.pop();
      this.renderCurrentView();
    }
  }

  /** Load a compiled wasm binary and render the treemap */
  loadBinary(binary: Uint8Array) {
    this.wasmData = parseWasm(binary.buffer);
    this.rebuild();
  }

  private rebuild() {
    const data = this.wasmData!;
    this.totalFileSize = data.fileSize;
    this.treeRoot =
      this.viewMode === "functions"
        ? this.buildFunctionsTree(data)
        : this.buildSectionsTree(data);

    // Info bar
    const codeSection = data.sections.find((s) => s.id === 10);
    this.infoBar.style.display = "flex";
    this.infoBar.textContent = [
      `${formatSize(data.fileSize)}`,
      `Code: ${formatSize(codeSection ? codeSection.totalSize : 0)}`,
      `${data.functionBodies.length} funcs`,
      `${data.imports.length} imports`,
      `${data.exports.length} exports`,
    ].join("  \u00b7  ");

    this.zoomStack = [];
    this.renderCurrentView();
  }

  // ─── Tree building ────────────────────────────────────────────────────

  private makeNode(name: string, fullPath: string): TreeNode {
    const id = this.nextNodeId++;
    const node: TreeNode = {
      _id: id,
      name,
      children: {},
      size: 0,
      fullPath,
      isLeaf: false,
      isRemainder: false,
    };
    this.nodeById.set(id, node);
    return node;
  }

  private assignColor(name: string): [number, number, number] {
    if (SECTION_COLORS[name]) return SECTION_COLORS[name];
    if (this.colorMap.has(name)) return this.colorMap.get(name)!;
    const rgb = HUE_PALETTE[this.colorIdx % HUE_PALETTE.length];
    this.colorIdx++;
    this.colorMap.set(name, rgb);
    return rgb;
  }

  private getFunctionName(data: WasmData, bodyIndex: number): string {
    const globalIdx = data.importFuncCount + bodyIndex;
    const debugName = data.functionNames.get(globalIdx);
    const exportName = data.exportNames.get(globalIdx);
    if (debugName && exportName && debugName !== exportName)
      return `${exportName} (${debugName})`;
    return exportName || debugName || `func[${globalIdx}]`;
  }

  private buildSectionsTree(data: WasmData): TreeNode {
    this.nextNodeId = 0;
    this.nodeById.clear();
    this.colorMap.clear();
    this.colorIdx = 0;

    const root = this.makeNode("root", "root");
    root.isRoot = true;

    if (data.headerSize > 0) {
      const hdr = this.makeNode("header", "header");
      hdr.size = data.headerSize;
      hdr.isLeaf = true;
      root.children["header"] = hdr;
      root.size += data.headerSize;
      this.assignColor("header");
    }

    for (const section of data.sections) {
      const sName = section.name;
      this.assignColor(sName.split(":")[0].split('"')[0]);

      const sNode = this.makeNode(sName, sName);
      sNode.size = section.totalSize;

      if (section.id === 10 && data.functionBodies.length > 0) {
        let overhead = section.totalSize;
        for (const body of data.functionBodies) {
          const fname = this.getFunctionName(data, body.index);
          const fNode = this.makeNode(fname, `${sName}/${fname}`);
          fNode.size = body.totalSize;
          fNode.isLeaf = true;
          sNode.children[`func_${body.index}`] = fNode;
          overhead -= body.totalSize;
        }
        if (overhead > 0) {
          const oh = this.makeNode(
            "[section overhead]",
            `${sName}/[overhead]`,
          );
          oh.size = overhead;
          oh.isLeaf = true;
          sNode.children["__overhead__"] = oh;
        }
      } else if (section.id === 2 && data.imports.length > 0) {
        const byModule: Record<string, WasmImport[]> = {};
        for (const imp of data.imports) {
          if (!byModule[imp.module]) byModule[imp.module] = [];
          byModule[imp.module].push(imp);
        }
        let accounted = 0;
        for (const [mod, imps] of Object.entries(byModule)) {
          this.assignColor(mod);
          const modNode = this.makeNode(mod, `${sName}/${mod}`);
          for (const imp of imps) {
            const label = `${imp.name} [${imp.kind}]`;
            const iNode = this.makeNode(label, `${sName}/${mod}/${label}`);
            iNode.size = imp.size || 1;
            iNode.isLeaf = true;
            modNode.children[`imp_${imp.index}_${imp.kind}`] = iNode;
            modNode.size += iNode.size;
          }
          sNode.children[`mod_${mod}`] = modNode;
          accounted += modNode.size;
        }
        const overhead = section.totalSize - accounted;
        if (overhead > 0) {
          const oh = this.makeNode(
            "[section overhead]",
            `${sName}/[overhead]`,
          );
          oh.size = overhead;
          oh.isLeaf = true;
          sNode.children["__overhead__"] = oh;
        }
      } else {
        sNode.isLeaf = true;
      }

      root.children[`section_${section.id}_${section.offset}`] = sNode;
      root.size += section.totalSize;
    }

    return root;
  }

  private buildFunctionsTree(data: WasmData): TreeNode {
    this.nextNodeId = 0;
    this.nodeById.clear();
    this.colorMap.clear();
    this.colorIdx = 0;

    const root = this.makeNode("root", "root");
    root.isRoot = true;

    if (data.functionBodies.length > 0) {
      for (const body of data.functionBodies) {
        const globalIdx = data.importFuncCount + body.index;
        const name = this.getFunctionName(data, body.index);
        const isExported = data.exportNames.has(globalIdx);

        const parts = name.replace(/^\$/, "").split(/[./:]+/);
        let parent = root;
        if (parts.length > 1) {
          let path = "";
          for (let i = 0; i < parts.length - 1; i++) {
            path += (path ? "/" : "") + parts[i];
            const key = `group_${path}`;
            if (!parent.children[key]) {
              this.assignColor(parts[i]);
              parent.children[key] = this.makeNode(parts[i], path);
            }
            parent.children[key].size += body.totalSize;
            parent = parent.children[key];
          }
        }

        const leafName = parts.length > 1 ? parts[parts.length - 1] : name;
        const tag = isExported ? " [export]" : "";
        this.assignColor(name);
        const fNode = this.makeNode(leafName + tag, name);
        fNode.size = body.totalSize;
        fNode.isLeaf = true;
        parent.children[`func_${body.index}`] = fNode;
        root.size += body.totalSize;
      }
    }

    if (data.imports.length > 0) {
      const impNode = this.makeNode("[imports]", "imports");
      this.assignColor("import");
      for (const imp of data.imports) {
        if (imp.kind !== "func") continue;
        const label = `${imp.module}::${imp.name}`;
        const iNode = this.makeNode(label, `imports/${label}`);
        iNode.size = imp.size || 1;
        iNode.isLeaf = true;
        impNode.children[`imp_${imp.index}`] = iNode;
        impNode.size += iNode.size;
      }
      if (impNode.size > 0) {
        root.children["__imports__"] = impNode;
        root.size += impNode.size;
      }
    }

    const codeSize = data.functionBodies.reduce(
      (s, b) => s + b.totalSize,
      0,
    );
    const overhead = data.fileSize - codeSize;
    if (overhead > 0) {
      const oh = this.makeNode("[non-code sections]", "overhead");
      oh.size = overhead;
      oh.isLeaf = true;
      root.children["__overhead__"] = oh;
      root.size += overhead;
    }

    return root;
  }

  // ─── Remainder grouping ───────────────────────────────────────────────

  private applyRemainders(node: TreeNode, threshPct: number) {
    const childArr = Object.values(node.children);
    if (childArr.length === 0) return;
    const threshold = node.size * (threshPct / 100);
    const sorted = childArr.slice().sort((a, b) => b.size - a.size);
    const keep: TreeNode[] = [],
      small: TreeNode[] = [];
    for (const child of sorted) {
      (child.size < threshold ? small : keep).push(child);
    }
    const remainderSize = small.reduce((s, c) => s + c.size, 0);
    const remainderTooBig = remainderSize > node.size * 0.15;
    if (keep.length === 0 || remainderTooBig || small.length < 2) {
      for (const child of childArr) {
        if (!child.isLeaf) this.applyRemainders(child, threshPct);
      }
      return;
    }
    for (const child of keep) {
      if (!child.isLeaf) this.applyRemainders(child, threshPct);
    }
    node.children = {};
    for (const k of keep) node.children["_k_" + k._id] = k;
    if (small.length > 0) {
      node.children["__remainder__"] = {
        _id: -1,
        _originalId: -1,
        name: `[${small.length} smaller items]`,
        children: {},
        size: remainderSize,
        fullPath: node.fullPath + "/[other]",
        isLeaf: true,
        isRemainder: true,
        remainderCount: small.length,
      };
    }
  }

  private deepCloneTree(node: TreeNode): TreeNode {
    const clone: TreeNode = {
      ...node,
      _originalId: node._id,
      children: {},
    };
    for (const [k, v] of Object.entries(node.children)) {
      clone.children[k] = this.deepCloneTree(v);
    }
    return clone;
  }

  // ─── Squarify layout ─────────────────────────────────────────────────

  private squarify(
    items: { size: number; node: TreeNode }[],
    x: number,
    y: number,
    w: number,
    h: number,
  ): LayoutItem[] {
    if (items.length === 0) return [];
    const total = items.reduce((s, i) => s + i.size, 0);
    if (total <= 0 || w <= 0 || h <= 0) return [];
    const sorted = items.slice().sort((a, b) => b.size - a.size);
    const result: LayoutItem[] = [];
    this.layoutRows(sorted, x, y, w, h, total, result);
    return result;
  }

  private layoutRows(
    items: { size: number; node: TreeNode }[],
    x: number,
    y: number,
    w: number,
    h: number,
    total: number,
    result: LayoutItem[],
  ) {
    if (items.length === 0) return;
    if (items.length === 1) {
      result.push({ ...items[0], x, y, w, h });
      return;
    }
    const vertical = h > w;
    const mainLen = vertical ? h : w;
    const crossLen = vertical ? w : h;
    const rowItems: { size: number; node: TreeNode }[] = [];
    let rowSize = 0,
      bestWorst = Infinity,
      bestN = 1;
    for (let i = 0; i < items.length; i++) {
      rowItems.push(items[i]);
      rowSize += items[i].size;
      const rowDim = (rowSize / total) * mainLen;
      let worst = 0;
      for (const ri of rowItems) {
        const itemCross = (ri.size / rowSize) * crossLen;
        if (rowDim > 0 && itemCross > 0) {
          worst = Math.max(
            worst,
            Math.max(rowDim / itemCross, itemCross / rowDim),
          );
        } else worst = Infinity;
      }
      if (worst <= bestWorst) {
        bestWorst = worst;
        bestN = i + 1;
      } else break;
    }
    const row = items.slice(0, bestN);
    const rest = items.slice(bestN);
    const rSize = row.reduce((s, i) => s + i.size, 0);
    const rowDim = (rSize / total) * mainLen;
    let offset = 0;
    for (const item of row) {
      const itemCross = (item.size / rSize) * crossLen;
      if (vertical)
        result.push({ ...item, x: x + offset, y, w: itemCross, h: rowDim });
      else result.push({ ...item, x, y: y + offset, w: rowDim, h: itemCross });
      offset += itemCross;
    }
    if (rest.length > 0) {
      const restTotal = total - rSize;
      if (vertical)
        this.layoutRows(rest, x, y + rowDim, w, h - rowDim, restTotal, result);
      else
        this.layoutRows(rest, x + rowDim, y, w - rowDim, h, restTotal, result);
    }
  }

  // ─── Rendering ────────────────────────────────────────────────────────

  private static HEADER_H = 20;
  private static MIN_LABEL_W = 35;
  private static MIN_LABEL_H = 16;
  private static MIN_CHILD_AREA = 600;

  private getNodeColor(node: TreeNode): [number, number, number] {
    const base = node.fullPath
      .split("/")[0]
      .split(":")[0]
      .replace(/^custom$/, "custom");
    return (
      SECTION_COLORS[base] ||
      this.colorMap.get(node.name) ||
      this.colorMap.get(base) || [80, 80, 100]
    );
  }

  private renderTreemap(
    rootNode: TreeNode,
    container: HTMLElement,
    initialRgb: [number, number, number] | null,
  ) {
    container.innerHTML = "";
    const rect = container.getBoundingClientRect();
    this.renderNode(
      rootNode,
      container,
      0,
      0,
      rect.width,
      rect.height,
      0,
      initialRgb,
      rootNode.size,
    );
  }

  private renderNode(
    node: TreeNode,
    container: HTMLElement,
    x: number,
    y: number,
    w: number,
    h: number,
    depth: number,
    crateRgb: [number, number, number] | null,
    parentSize: number,
  ) {
    if (w < 2 || h < 2) return;
    const children = Object.values(node.children);
    const hasChildren = children.length > 0 && !node.isLeaf;
    const isLeaf = !hasChildren;

    if (!crateRgb) crateRgb = this.getNodeColor(node);
    if (depth === 1 && !crateRgb) crateRgb = [80, 80, 100];
    const baseRgb = crateRgb || [80, 80, 100];

    const el = document.createElement("div");
    el.className =
      "tm-node" +
      (isLeaf ? " tm-leaf" : " tm-branch") +
      (node.isRemainder ? " tm-remainder" : "");
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.width = w + "px";
    el.style.height = h + "px";

    const inner = document.createElement("div");
    inner.className = "tm-node-inner";
    const bw = Math.max(1, 3 - depth);
    inner.style.inset = bw + "px";

    if (depth === 0) {
      inner.style.background = "transparent";
      inner.style.inset = "0";
      el.style.background = "transparent";
    } else if (node.isRemainder) {
      inner.style.background = "rgba(128,128,128,0.35)";
    } else {
      inner.style.background = rgbaStr(baseRgb, 0.35);
    }

    const canLabel = w > WasmTreemap.MIN_LABEL_W && h > WasmTreemap.MIN_LABEL_H;
    let headerH = 0;
    if (canLabel && !isLeaf && depth > 0) {
      const label = document.createElement("div");
      label.className = "tm-label";
      label.innerHTML = `<span>${esc(node.name)}</span> <span class="tm-label-size">${formatSize(node.size)}</span>`;
      label.style.color = node.isRemainder ? "#999" : "#ddd";
      label.style.background = node.isRemainder
        ? "rgba(128,128,128,0.35)"
        : rgbaStr(baseRgb, 0.35);
      label.style.borderBottom = "2px solid #000";
      label.style.zIndex = "2";
      el.appendChild(label);
      headerH = WasmTreemap.HEADER_H;
    } else if (canLabel && isLeaf) {
      const label = document.createElement("div");
      label.className = "tm-label";
      label.textContent = node.name;
      label.style.color = node.isRemainder ? "#888" : "#ccc";
      label.style.fontSize = w < 70 ? "9px" : "11px";
      inner.appendChild(label);
    }

    (el as any)._tmNode = node;
    (el as any)._tmParentSize = parentSize;
    (el as any)._tmCrateRgb = crateRgb;

    el.addEventListener("mouseenter", (e) => this.onNodeEnter(e));
    el.addEventListener("mousemove", (e) => this.onTooltipMove(e));
    el.addEventListener("mouseleave", () => this.onNodeLeave());
    if (!isLeaf && depth > 0)
      el.addEventListener("click", (e) => this.onNodeClick(e));

    el.appendChild(inner);
    container.appendChild(el);

    if (hasChildren) {
      const iy = bw + headerH;
      const iw = w,
        ih = h - iy;
      if (
        iw * ih >= WasmTreemap.MIN_CHILD_AREA &&
        iw > 10 &&
        ih > 10
      ) {
        const childItems = children.map((c) => ({ size: c.size, node: c }));
        const laid = this.squarify(childItems, 0, 0, iw, ih);
        for (const item of laid) {
          const childRgb =
            depth === 0 ? this.getNodeColor(item.node) : crateRgb;
          this.renderNode(
            item.node,
            el,
            item.x,
            iy + item.y,
            item.w,
            item.h,
            depth + 1,
            childRgb,
            node.size,
          );
        }
      }
    }
  }

  // ─── Tooltip ──────────────────────────────────────────────────────────

  private onNodeEnter(e: MouseEvent) {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const node = (el as any)._tmNode as TreeNode;
    const parentSize = (el as any)._tmParentSize as number;

    this.tooltip.querySelector(".tm-tt-path")!.textContent =
      node.fullPath || node.name;
    const vals = this.tooltip.querySelectorAll(".tm-tt-value");
    vals[0].textContent = formatSize(node.size);
    vals[1].textContent =
      ((node.size / this.totalFileSize) * 100).toFixed(2) + "%";

    const parentRow = this.tooltip.querySelector(
      ".tm-tt-parent",
    ) as HTMLElement;
    if (parentSize && parentSize > 0) {
      vals[2].textContent =
        ((node.size / parentSize) * 100).toFixed(1) + "%";
      parentRow.style.display = "flex";
    } else parentRow.style.display = "none";

    const childrenRow = this.tooltip.querySelector(
      ".tm-tt-children",
    ) as HTMLElement;
    const hint = this.tooltip.querySelector(".tm-tt-hint") as HTMLElement;
    const children = Object.values(node.children || {});
    if (children.length > 0 && !node.isLeaf) {
      childrenRow.style.display = "flex";
      childrenRow.querySelector(".tm-tt-value")!.textContent =
        children.length + " items";
      hint.textContent = "Click to zoom in";
    } else {
      childrenRow.style.display = "none";
      hint.textContent = "";
    }
    if (node.isRemainder)
      hint.textContent = "Grouped items below remainder threshold";

    this.tooltip.style.display = "block";
    this.positionTooltip(e);
  }

  private onTooltipMove(e: MouseEvent) {
    this.positionTooltip(e);
  }

  private onNodeLeave() {
    this.tooltip.style.display = "none";
  }

  private positionTooltip(e: MouseEvent) {
    let tx = e.clientX + 14,
      ty = e.clientY + 14;
    const tw = this.tooltip.offsetWidth,
      th = this.tooltip.offsetHeight;
    if (tx + tw > window.innerWidth - 10) tx = e.clientX - tw - 14;
    if (ty + th > window.innerHeight - 10) ty = e.clientY - th - 14;
    this.tooltip.style.left = tx + "px";
    this.tooltip.style.top = ty + "px";
  }

  // ─── Zoom / Breadcrumbs ───────────────────────────────────────────────

  private onNodeClick(e: MouseEvent) {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const node = (el as any)._tmNode as TreeNode;
    const crateRgb = (el as any)._tmCrateRgb as [number, number, number];
    const origId = node._originalId != null ? node._originalId : node._id;
    if (origId < 0) return;
    this.zoomStack.push({ nodeId: origId, crateRgb, name: node.name });
    this.renderCurrentView();
  }

  private renderCurrentView() {
    let viewNode: TreeNode,
      crateRgb: [number, number, number] | null;
    if (this.zoomStack.length === 0) {
      viewNode = this.treeRoot!;
      crateRgb = null;
    } else {
      const top = this.zoomStack[this.zoomStack.length - 1];
      viewNode = this.nodeById.get(top.nodeId)!;
      crateRgb = top.crateRgb;
      if (!viewNode) {
        this.zoomStack = [];
        viewNode = this.treeRoot!;
        crateRgb = null;
      }
    }

    const viewCopy = this.deepCloneTree(viewNode);
    this.applyRemainders(viewCopy, this.thresholdPct);
    this.renderTreemap(viewCopy, this.treemapEl, crateRgb);

    // Breadcrumbs
    this.breadcrumbsBar.innerHTML = "";
    const rootCrumb = document.createElement("button");
    rootCrumb.className = "tm-crumb";
    rootCrumb.textContent = "root";
    rootCrumb.onclick = () => {
      this.zoomStack = [];
      this.renderCurrentView();
    };
    this.breadcrumbsBar.appendChild(rootCrumb);

    for (let i = 0; i < this.zoomStack.length; i++) {
      const sep = document.createElement("span");
      sep.className = "tm-crumb-sep";
      sep.textContent = "/";
      this.breadcrumbsBar.appendChild(sep);
      const crumb = document.createElement("button");
      crumb.className = "tm-crumb";
      crumb.textContent = this.zoomStack[i].name;
      const idx = i;
      crumb.onclick = () => {
        this.zoomStack = this.zoomStack.slice(0, idx + 1);
        this.renderCurrentView();
      };
      this.breadcrumbsBar.appendChild(crumb);
    }
  }

  dispose() {
    document.removeEventListener("keydown", this.onKeyDown);
    this.resizeObserver.disconnect();
    this.tooltip.remove();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function rgbaStr([r, g, b]: [number, number, number], a: number): string {
  return `rgba(${r},${g},${b},${a})`;
}
