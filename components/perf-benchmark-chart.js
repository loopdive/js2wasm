/**
 * <perf-benchmark-chart> — animated Wasm vs JS comparison chart.
 *
 * Attributes:
 *   src     — URL to playground-benchmark-sidebar.json
 *   title   — chart heading (default: "Benchmark Performance (Wasm vs JS)")
 *   legend  — legend text (default: "WASM runtime performance relative to JS (larger is better)")
 *   mode    — perf | size | coldstart | loadtime
 *
 * Usage:
 *   <perf-benchmark-chart src="./benchmarks/results/playground-benchmark-sidebar.json"></perf-benchmark-chart>
 */

class PerfBenchmarkChart extends HTMLElement {
  static get observedAttributes() {
    return ["src", "title", "legend", "mode", "benchmark", "browser-runtime-src"];
  }

  static _measurementQueue = Promise.resolve();

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
          grid-template-columns: 112px 1fr;
          align-items: center;
          gap: 16px;
        }

        .bench-name {
          font-family: var(--mono, ui-monospace, monospace);
          font-size: 13px;
          color: var(--fg-soft, rgba(255,255,255,0.55));
          text-align: right;
          white-space: nowrap;
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

        .bench-errorbar {
          position: absolute;
          top: 50%;
          height: 0;
          border-top: 1px solid rgba(255,255,255,0.4);
          transform: translateY(-50%);
          z-index: 2;
          opacity: 0;
        }

        .bench-errorbar::before,
        .bench-errorbar::after {
          content: "";
          position: absolute;
          top: -4px;
          width: 0;
          height: 8px;
          border-left: 1px solid rgba(255,255,255,0.4);
        }

        .bench-errorbar::before {
          left: 0;
        }

        .bench-errorbar::after {
          right: 0;
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
          text-shadow:
            0 1px 1px rgba(6, 10, 20, 0.85),
            0 0 10px rgba(6, 10, 20, 0.45);
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

  async _measureJsModuleLoad(jsUrl, rounds = 3) {
    const samples = [];
    for (let i = 0; i < rounds; i++) {
      const cacheBust = `${jsUrl}${jsUrl.includes("?") ? "&" : "?"}load=${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
      const t0 = performance.now();
      const response = await fetch(cacheBust, { cache: "no-store" });
      const source = await response.text();
      const blob = new Blob([source], { type: "text/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      try {
        await import(/* @vite-ignore */ blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return {
      samples,
      median: samples[Math.floor(samples.length / 2)] ?? 0,
      stddev: this._stddev(samples),
    };
  }

  async _measureWasmLoad(entry, wasmUrl, instantiateWasmStreaming, buildImports, rounds = 3) {
    const samples = [];
    for (let i = 0; i < rounds; i++) {
      const imports = buildImports(
        entry.imports ?? [],
        {
          document,
          window,
          performance,
          globalThis,
        },
        entry.stringPool ?? [],
      );
      const cacheBust = `${wasmUrl}${wasmUrl.includes("?") ? "&" : "?"}load=${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
      const t0 = performance.now();
      const result = await instantiateWasmStreaming(
        fetch(cacheBust, { cache: "no-store" }),
        imports.env,
        imports.string_constants,
      );
      if (imports.setExports) imports.setExports(result.instance.exports);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return {
      samples,
      median: samples[Math.floor(samples.length / 2)] ?? 0,
      stddev: this._stddev(samples),
    };
  }

  _stddev(values) {
    if (!Array.isArray(values) || values.length <= 1) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  _median(values) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  }

  _timeIt(fn, iterations) {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    return performance.now() - t0;
  }

  _calibrate(fn) {
    let iterations = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 100) {
      fn();
      iterations++;
    }
    return Math.max(10, Math.ceil((iterations / 100) * 300));
  }

  _snapshotBodyState() {
    return {
      innerHTML: document.body.innerHTML,
      cssText: document.body.style.cssText,
    };
  }

  _restoreBodyState(state) {
    document.body.innerHTML = state.innerHTML;
    document.body.style.cssText = state.cssText;
  }

  async _loadJsRuntimeFunction(jsUrl, exportName) {
    const cacheBust = `${jsUrl}${jsUrl.includes("?") ? "&" : "?"}runtime=${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const response = await fetch(cacheBust, { cache: "no-store" });
    const source = await response.text();
    const blob = new Blob([source], { type: "text/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    try {
      const mod = await import(/* @vite-ignore */ blobUrl);
      return mod?.[exportName];
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  async _measureBrowserRuntime(entry, jsUrl, wasmUrl, runtimeHelpers) {
    const exportName = entry?.exportName || `bench_${entry?.name || ""}`;
    const jsFn = await this._loadJsRuntimeFunction(jsUrl, exportName);
    if (typeof jsFn !== "function") {
      throw new Error(`JS benchmark export ${exportName} not found`);
    }

    const imports = runtimeHelpers.buildImports(
      entry.imports ?? [],
      { document, window, performance, globalThis },
      entry.stringPool ?? [],
    );
    const wasmBytes = new Uint8Array(await (await fetch(wasmUrl, { cache: "no-store" })).arrayBuffer());
    const wasmResult = await runtimeHelpers.instantiateWasm(wasmBytes, imports.env, imports.string_constants);
    if (imports.setExports) imports.setExports(wasmResult.instance.exports);
    const wasmFn = wasmResult.instance.exports?.[exportName];
    if (typeof wasmFn !== "function") {
      throw new Error(`Wasm benchmark export ${exportName} not found`);
    }

    const bodyState = this._snapshotBodyState();
    try {
      for (let i = 0; i < 80; i++) {
        wasmFn();
        jsFn();
      }

      const iterations = this._calibrate(wasmFn);
      const warmupRounds = 2;
      const measuredRounds = 9;
      for (let i = 0; i < warmupRounds; i++) {
        this._timeIt(wasmFn, iterations);
        this._timeIt(jsFn, iterations);
      }

      const wasmSamplesUs = [];
      const jsSamplesUs = [];
      const ratioSamples = [];
      for (let i = 0; i < measuredRounds; i++) {
        const wasmUs = (this._timeIt(wasmFn, iterations) / iterations) * 1000;
        const jsUs = (this._timeIt(jsFn, iterations) / iterations) * 1000;
        wasmSamplesUs.push(wasmUs);
        jsSamplesUs.push(jsUs);
        ratioSamples.push(jsUs / Math.max(wasmUs, 0.000001));
      }

      return {
        path: entry.path,
        name: entry.name,
        wasmUs: this._median(wasmSamplesUs),
        jsUs: this._median(jsSamplesUs),
        wasmStdUs: this._stddev(wasmSamplesUs),
        jsStdUs: this._stddev(jsSamplesUs),
        ratioStd: this._stddev(ratioSamples),
        warmupRounds,
        measuredRounds,
      };
    } finally {
      this._restoreBodyState(bodyState);
    }
  }

  async _waitForStableLoadBenchmarkStart() {
    if (document.readyState !== "complete") {
      await new Promise((resolve) => window.addEventListener("load", resolve, { once: true }));
    }

    if (document.fonts?.ready) {
      try {
        await document.fonts.ready;
      } catch {
        // Ignore font readiness failures and continue.
      }
    }

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    if ("requestIdleCallback" in window) {
      await new Promise((resolve) => {
        window.requestIdleCallback(() => resolve(), { timeout: 500 });
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  async _runSerialMeasurement(task) {
    const run = PerfBenchmarkChart._measurementQueue.then(async () => {
      await this._waitForStableLoadBenchmarkStart();
      return task();
    });

    PerfBenchmarkChart._measurementQueue = run.catch(() => {});
    return run;
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
      const benchmarkFilter = (this.getAttribute("benchmark") || "").trim();

      // Transform data based on mode into [{name, ratio, label}]
      let ratios;
      if (mode === "benchmark-runtime") {
        const rows = Array.isArray(json) ? json : [];
        if (rows.length === 0 || !benchmarkFilter) {
          this.style.display = "none";
          return;
        }
        const filtered = rows.filter((row) => row?.name === benchmarkFilter);
        const jsRow = filtered.find((row) => row?.strategy === "js");
        if (!jsRow || !(jsRow.medianMs > 0)) {
          this.style.display = "none";
          return;
        }
        ratios = filtered
          .filter((row) => row?.strategy && row.strategy !== "js" && row.medianMs > 0)
          .map((row) => ({
            name: row.strategy,
            ratio: jsRow.medianMs / row.medianMs,
            label: (jsRow.medianMs / row.medianMs).toFixed(1) + "x",
          }));
      } else if (mode === "size") {
        const benchmarks = json?.benchmarks ?? json;
        if (!Array.isArray(benchmarks) || benchmarks.length === 0) {
          this.style.display = "none";
          return;
        }
        ratios = benchmarks.map((b) => {
          const wasmBytes = b.wasmTotalGzip ?? b.wasmSizeGzip;
          const jsBytes = b.jsSizeGzip;
          const ratio = wasmBytes / Math.max(jsBytes, 1);
          return { name: b.name, ratio, label: ratio.toFixed(1) + "x" };
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
      } else if (mode === "loadtime") {
        const benchmarks = json?.benchmarks ?? json;
        if (!Array.isArray(benchmarks) || benchmarks.length === 0) {
          this.style.display = "none";
          return;
        }
        ratios = await this._runSerialMeasurement(async () => {
          const manifestUrl = new URL(src, window.location.href);
          const runtimeUrl = new URL("./loadtime/runtime.js", manifestUrl).href;
          const { buildImports, instantiateWasmStreaming } = await import(/* @vite-ignore */ runtimeUrl);
          const measured = [];
          for (const bench of benchmarks) {
            if (!bench?.jsUrl || !bench?.wasmUrl) continue;
            try {
              const jsUrl = new URL(bench.jsUrl, manifestUrl).href;
              const wasmUrl = new URL(bench.wasmUrl, manifestUrl).href;
              await this._measureJsModuleLoad(jsUrl, 1);
              await this._measureWasmLoad(bench, wasmUrl, instantiateWasmStreaming, buildImports, 1);
              const jsMetrics = await this._measureJsModuleLoad(jsUrl, 7);
              const wasmMetrics = await this._measureWasmLoad(
                bench,
                wasmUrl,
                instantiateWasmStreaming,
                buildImports,
                7,
              );
              if (jsMetrics.median <= 0 || wasmMetrics.median <= 0) continue;
              const ratioSamples = jsMetrics.samples.map((jsSample, index) => {
                const wasmSample = wasmMetrics.samples[index] ?? wasmMetrics.median;
                return jsSample / Math.max(wasmSample, 0.0001);
              });
              const ratio = jsMetrics.median / wasmMetrics.median;
              measured.push({
                name: bench.name,
                ratio,
                ratioStd: this._stddev(ratioSamples),
                label: ratio.toFixed(1) + "x",
              });
              await new Promise((resolve) => setTimeout(resolve, 80));
            } catch (error) {
              console.warn("[perf-benchmark-chart] loadtime benchmark skipped", bench?.name, error);
            }
          }
          return measured;
        });
      } else {
        // Default perf mode: ratio = jsUs / wasmUs (higher = wasm faster)
        let rows = Array.isArray(json) ? json : [];
        if (benchmarkFilter) {
          rows = rows.filter((row) => {
            const path = String(row?.path || "");
            const shortPath = path.replace(/^examples\/benchmarks\//, "").replace(/\.ts$/, "");
            const shortName = String(row?.name || "");
            return shortPath === benchmarkFilter || shortName === benchmarkFilter || path === benchmarkFilter;
          });
        }
        if (rows.length === 0) {
          this.style.display = "none";
          return;
        }
        ratios = [];
        for (const row of rows) {
          const wasmUs = Number(row?.wasmUs ?? 0);
          const jsUs = Number(row?.jsUs ?? 0);
          if (wasmUs <= 0 || jsUs <= 0) continue;
          ratios.push({ ...row, ratio: jsUs / wasmUs, ratioStd: Number(row?.ratioStd ?? 0) });
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
            <div class="bench-errorbar" style="left: ${jsPos}%; width: 0%"></div>
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
          ratioStd: Number(row.ratioStd ?? 0),
          fillEl: rowEl.querySelector(".bench-fill"),
          errorEl: rowEl.querySelector(".bench-errorbar"),
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

          const stdRatio = Math.min(
            d.ratioStd || 0,
            Math.max(d.ratio - 0.01, 0),
            Math.max(scaleMax / 100 - d.ratio, 0),
          );
          if (stdRatio > 0) {
            const stdLeft = (Math.max(d.ratio - stdRatio, 0.01) / (scaleMax / 100)) * 100;
            const stdRight = (Math.min(d.ratio + stdRatio, scaleMax / 100) / (scaleMax / 100)) * 100;
            const currentStdLeft = jsPos + t * (stdLeft - jsPos);
            const currentStdRight = jsPos + t * (stdRight - jsPos);
            d.errorEl.style.left = `${Math.min(currentStdLeft, currentStdRight)}%`;
            d.errorEl.style.width = `${Math.abs(currentStdRight - currentStdLeft)}%`;
            d.errorEl.style.opacity = `${0.25 + 0.55 * t}`;
          } else {
            d.errorEl.style.opacity = "0";
          }

          const barEnd = d.ratio >= 1 ? curLeft + curWidth : curLeft;
          if (d.ratio >= 1) {
            d.valueEl.style.left = `min(calc(${barEnd}% + 10px), calc(100% - 3.6ch))`;
            d.valueEl.style.removeProperty("right");
            d.valueEl.style.paddingLeft = "0";
            d.valueEl.style.paddingRight = "";
          } else {
            d.valueEl.style.left = `max(calc(${barEnd}% + 10px), 12%)`;
            d.valueEl.style.removeProperty("right");
            d.valueEl.style.paddingLeft = "0";
            d.valueEl.style.paddingRight = "";
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
