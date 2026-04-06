/**
 * <perf-benchmark-chart> — animated Wasm vs JS performance bar chart.
 *
 * Attributes:
 *   src     — URL to playground-benchmark-sidebar.json
 *   title   — chart heading (default: "Benchmark Performance (Wasm vs JS)")
 *   legend  — legend text (default: "WASM runtime performance relative to JS (larger is better)")
 *
 * Usage:
 *   <perf-benchmark-chart src="./benchmarks/results/playground-benchmark-sidebar.json"></perf-benchmark-chart>
 */

class PerfBenchmarkChart extends HTMLElement {
  static get observedAttributes() {
    return ["src", "title", "legend", "mode"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._rendered = false;
  }

  connectedCallback() {
    if (!this._rendered) {
      this._rendered = true;
      this._render();
    }
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal !== newVal && this._rendered) {
      this._rendered = false;
      this.shadowRoot.innerHTML = "";
      this._rendered = true;
      this._render();
    }
  }

  _render() {
    const src = this.getAttribute("src") || "./benchmarks/results/playground-benchmark-sidebar.json";
    const title = this.getAttribute("title") || "Benchmark Performance (Wasm vs JS)";
    const legend = this.getAttribute("legend") || "WASM runtime performance relative to JS (larger is better)";

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }

        .chart-title {
          font-family: var(--mono, ui-monospace, monospace);
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--fg-faint, rgba(255,255,255,0.35));
          margin: 0 0 28px;
        }

        .bars-wrap {
          position: relative;
          padding-top: 24px;
        }

        .js-label {
          position: absolute;
          top: 4px;
          font-family: var(--mono, ui-monospace, monospace);
          font-size: 11px;
          color: var(--fg-soft, rgba(255,255,255,0.55));
          letter-spacing: 0.05em;
        }

        .js-line {
          position: absolute;
          top: 24px;
          bottom: 0;
          width: 2px;
          background: var(--fg-soft, rgba(255,255,255,0.55));
          opacity: 1;
          z-index: 1;
        }

        .bench-bars {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .bench-row {
          display: grid;
          grid-template-columns: 100px 1fr;
          align-items: center;
          gap: 16px;
        }

        .bench-name {
          font-family: var(--mono, ui-monospace, monospace);
          font-size: 13px;
          color: var(--fg-soft, rgba(255,255,255,0.55));
          text-align: right;
        }

        .bench-track {
          height: 28px;
          background: transparent;
          border-radius: 4px;
          overflow: visible;
          position: relative;
        }

        .bench-track-bg {
          position: absolute;
          left: 0;
          top: 0;
          height: 100%;
          background: var(--surface, rgba(255,255,255,0.04));
          border-radius: 4px;
        }

        .bench-fill {
          height: 100%;
          border-radius: 4px;
          position: absolute;
          top: 0;
        }

        .bench-value {
          font-family: var(--mono, ui-monospace, monospace);
          font-size: 12px;
          font-weight: 600;
          color: var(--fg-soft, rgba(255,255,255,0.55));
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          z-index: 2;
          white-space: nowrap;
        }

        .legend {
          margin-top: 16px;
          font-size: 12px;
          color: var(--fg-faint, rgba(255,255,255,0.35));
        }

        @media (max-width: 720px) {
          .bench-row {
            grid-template-columns: 70px 1fr;
            gap: 8px;
          }
        }
      </style>

      <h3 class="chart-title"></h3>
      <div class="bars-wrap">
        <div class="js-label">JS</div>
        <div class="js-line"></div>
        <div class="bench-bars"></div>
      </div>
      <p class="legend"></p>
    `;

    this.shadowRoot.querySelector(".chart-title").textContent = title;
    this.shadowRoot.querySelector(".legend").textContent = legend;

    this._load(src);
  }

  async _load(src) {
    const shadow = this.shadowRoot;
    const container = shadow.querySelector(".bench-bars");
    const jsLabelEl = shadow.querySelector(".js-label");
    const jsLineEl = shadow.querySelector(".js-line");

    try {
      const resp = await fetch(src);
      if (!resp.ok) {
        this.style.display = "none";
        return;
      }
      const json = await resp.json();
      const mode = this.getAttribute("mode") || "perf";

      // Transform data based on mode into [{name, ratio, label}]
      let ratios;
      if (mode === "size") {
        const benchmarks = json?.benchmarks ?? json;
        if (!Array.isArray(benchmarks) || benchmarks.length === 0) {
          this.style.display = "none";
          return;
        }
        ratios = benchmarks.map((b) => {
          const wasmBytes = b.wasmSizeGzip;
          const jsBytes = b.jsSizeGzip;
          const ratio = wasmBytes / Math.max(jsBytes, 1);
          const kb = (wasmBytes / 1024).toFixed(1);
          return { name: b.name, ratio, label: kb + " KB" };
        });
      } else if (mode === "coldstart") {
        const benchmarks = json?.benchmarks ?? json;
        if (!Array.isArray(benchmarks) || benchmarks.length === 0) {
          this.style.display = "none";
          return;
        }
        ratios = benchmarks.map((b) => {
          const wasmMs = b.wasmCompileMs;
          const jsMs = b.jsParseMs;
          const ratio = jsMs / Math.max(wasmMs, 0.0001);
          return { name: b.name, ratio };
        });
      } else {
        // Default perf mode: ratio = jsUs / wasmUs (higher = wasm faster)
        const rows = Array.isArray(json) ? json : [];
        if (rows.length === 0) {
          this.style.display = "none";
          return;
        }
        ratios = [];
        for (const row of rows) {
          const wasmUs = Number(row?.wasmUs ?? 0);
          const jsUs = Number(row?.jsUs ?? 0);
          if (wasmUs <= 0 || jsUs <= 0) continue;
          ratios.push({ ...row, ratio: jsUs / wasmUs });
        }
      }
      if (!ratios || ratios.length === 0) {
        this.style.display = "none";
        return;
      }

      const maxRatio = Math.max(...ratios.map((r) => r.ratio), 1.5);
      const maxPct = Math.ceil(maxRatio * 100);
      const scaleMax = Math.ceil(maxPct / 100) * 100;
      const jsPos = (100 / scaleMax) * 100; // JS baseline as % of track width

      // Build bar rows (start at 0, animate later)
      const barData = [];
      for (const row of ratios) {
        const ratio = row.ratio;
        const label = row.name || row.path?.replace(/^examples\/benchmarks\//, "").replace(/\.ts$/, "") || "unknown";

        let targetLeft, targetWidth;
        if (ratio >= 1) {
          targetLeft = jsPos;
          targetWidth = ((ratio - 1) / (scaleMax / 100 - 1)) * (100 - jsPos);
        } else {
          const wasmPos = (ratio / (scaleMax / 100)) * 100;
          targetLeft = wasmPos;
          targetWidth = jsPos - wasmPos;
        }

        const dist = Math.abs(ratio - 1) / Math.max(maxRatio - 1, 1);
        const edgeOpacity = (0.1 + dist * 0.9).toFixed(2);
        const baseOpacity = "0.1";
        const gradDir = ratio >= 1 ? "to right" : "to left";
        const textOpacity = (0.4 + dist * 0.6).toFixed(2);

        const rowEl = document.createElement("div");
        rowEl.className = "bench-row";
        rowEl.innerHTML = `
          <span class="bench-name">${label}</span>
          <div class="bench-track">
            <div class="bench-track-bg" style="width: ${jsPos}%"></div>
            <div class="bench-fill" style="left: ${jsPos}%; width: 0%; background: linear-gradient(${gradDir}, rgba(255,255,255,${baseOpacity}), rgba(255,255,255,0.1)); border-radius: 4px; position: absolute; height: 100%; top: 0"></div>
            <span class="bench-value" style="left: ${jsPos}%; padding-left: 6px; color: rgba(255,255,255,0)">0.0x</span>
          </div>
        `;
        container.appendChild(rowEl);

        barData.push({
          ratio,
          customLabel: row.label || null,
          targetLeft,
          targetWidth,
          gradDir,
          baseOpacity,
          edgeOpacity,
          textOpacity,
          fillEl: rowEl.querySelector(".bench-fill"),
          valueEl: rowEl.querySelector(".bench-value"),
        });
      }

      // Animation
      const duration = 3293;
      const ease = (t) => 1 - (1 - t) * (1 - t);

      function animateBars(ts) {
        if (!animateBars._start) animateBars._start = ts;
        const elapsed = ts - animateBars._start;
        const progress = Math.min(elapsed / duration, 1);
        const t = ease(progress);

        for (const d of barData) {
          const curWidth = t * d.targetWidth;
          const curLeft = d.ratio >= 1 ? d.targetLeft : jsPos - t * (jsPos - d.targetLeft);
          const curRatio = t * d.ratio;
          const scoreText = d.customLabel
            ? d.customLabel
            : curRatio >= 10
              ? `${Math.round(curRatio)}x`
              : `${curRatio.toFixed(1)}x`;

          const curEdgeOp = (0.1 + t * (parseFloat(d.edgeOpacity) - 0.1)).toFixed(2);
          const curTextOp = (t * parseFloat(d.textOpacity)).toFixed(2);

          d.fillEl.style.left = curLeft + "%";
          d.fillEl.style.width = curWidth + "%";
          d.fillEl.style.background = `linear-gradient(${d.gradDir}, rgba(255,255,255,${d.baseOpacity}), rgba(255,255,255,${curEdgeOp}))`;

          const barEnd = d.ratio >= 1 ? curLeft + curWidth : curLeft;
          if (d.ratio >= 1) {
            d.valueEl.style.left = barEnd + "%";
            d.valueEl.style.removeProperty("right");
            d.valueEl.style.paddingLeft = "6px";
            d.valueEl.style.paddingRight = "";
          } else {
            d.valueEl.style.removeProperty("left");
            d.valueEl.style.right = 100 - barEnd + "%";
            d.valueEl.style.paddingLeft = "";
            d.valueEl.style.paddingRight = "6px";
          }
          d.valueEl.style.color = `rgba(255,255,255,${curTextOp})`;
          d.valueEl.textContent = scoreText;
        }

        if (progress < 1) requestAnimationFrame(animateBars);
      }

      // Trigger animation on scroll into view
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              observer.disconnect();
              requestAnimationFrame(animateBars);
            }
          }
        },
        { threshold: 0.3 },
      );
      observer.observe(this);

      // Position JS baseline line/label
      const positionBaseline = () => {
        const track = container.querySelector(".bench-track");
        const wrap = shadow.querySelector(".bars-wrap");
        if (track && wrap && jsLabelEl && jsLineEl) {
          const wrapRect = wrap.getBoundingClientRect();
          const trackRect = track.getBoundingClientRect();
          const jsX = trackRect.left + (trackRect.width * jsPos) / 100 - wrapRect.left;
          jsLabelEl.style.left = jsX + "px";
          jsLabelEl.style.transform = "translateX(-50%)";
          jsLineEl.style.left = jsX + "px";
        }
      };
      requestAnimationFrame(positionBaseline);
      window.addEventListener("resize", positionBaseline);
    } catch {
      this.style.display = "none";
    }
  }
}

customElements.define("perf-benchmark-chart", PerfBenchmarkChart);
