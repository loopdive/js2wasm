/**
 * <trend-chart> — Reusable stacked area / line SVG chart component.
 *
 * Usage:
 *   <trend-chart src="./data.json" mode="stacked|line|step" height="240"></trend-chart>
 *
 * JSON format: array of objects with numeric fields. The component reads
 * `series` attribute for field names and colors:
 *   series='[{"key":"pass","color":"#fff","opacity":0.4},...]'
 *
 * Or provide data via JS: el.data = [...]; el.render();
 */

class TrendChart extends HTMLElement {
  static get observedAttributes() {
    return ["src", "series", "mode", "height", "labels-key", "x-key"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._data = null;
  }

  set data(d) {
    this._data = d;
    this._render();
  }

  connectedCallback() {
    this._render();
  }

  attributeChangedCallback() {
    this._render();
  }

  async _render() {
    let data = this._data;

    if (!data) {
      const src = this.getAttribute("src");
      if (!src) return;
      try {
        const resp = await fetch(src);
        if (!resp.ok) return;
        data = await resp.json();
        if (!Array.isArray(data) || data.length === 0) return;
      } catch {
        return;
      }
    }

    if (!data || data.length < 2) return;

    const mode = this.getAttribute("mode") || "stacked";
    const H = parseInt(this.getAttribute("height") || "240", 10);
    const W = 500;
    const labelsKey = this.getAttribute("labels-key") || null;

    let seriesDef;
    try {
      seriesDef = JSON.parse(this.getAttribute("series") || "[]");
    } catch {
      seriesDef = [];
    }

    if (seriesDef.length === 0) return;

    const PAD = { top: 20, right: 40, bottom: 40, left: 60 };
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const n = data.length;
    const xKey = this.getAttribute("x-key") || null;
    const x = this._buildXAccessor(data, xKey, PAD.left, plotW, n);

    if (mode === "stacked") {
      this._renderStacked(data, seriesDef, W, H, PAD, plotW, plotH, n, x, labelsKey);
    } else {
      this._renderLine(data, seriesDef, W, H, PAD, plotW, plotH, n, x, labelsKey, mode === "step");
    }
  }

  _buildXAccessor(data, xKey, left, plotW, n) {
    if (xKey) {
      const values = data.map((d) => Number(d?.[xKey]));
      const valid = values.every((v) => Number.isFinite(v));
      if (valid) {
        const min = Math.min(...values);
        const max = Math.max(...values);
        const range = max - min || 1;
        return (i) => left + ((values[i] - min) / range) * plotW;
      }
    }
    return (i) => left + (i / Math.max(n - 1, 1)) * plotW;
  }

  _buildXLabels(data, labelsKey, x, H, PAD) {
    let labels = "";
    let lastX = -Infinity;
    const minGap = 42;
    for (let i = 0; i < data.length; i++) {
      const xi = x(i);
      const isEdge = i === 0 || i === data.length - 1;
      if (!isEdge && xi - lastX < minGap) continue;
      const label = labelsKey ? String(data[i][labelsKey] || "") : String(i);
      labels += `<text x="${xi}" y="${H - PAD.bottom + 16}" text-anchor="middle" fill="rgba(255,255,255,0.3)" font-size="10" font-family="monospace">${label}</text>`;
      lastX = xi;
    }
    return labels;
  }

  _renderStacked(data, seriesDef, W, H, PAD, plotW, plotH, n, x, labelsKey) {
    // Build cumulative stacks
    const stacks = [];
    for (let si = 0; si < seriesDef.length; si++) {
      const key = seriesDef[si].key;
      stacks[si] = data.map((d, i) => {
        const val = typeof key === "function" ? key(d) : Number(d[key] || 0);
        return (si > 0 ? stacks[si - 1][i] : 0) + val;
      });
    }

    const maxVal = Math.max(...stacks[stacks.length - 1]);
    const yMax = Math.ceil(maxVal / 5000) * 5000 || maxVal * 1.1;
    const y = (val) => PAD.top + plotH - (val / yMax) * plotH;

    const areaPath = (topFn, baseFn) => {
      let p = `M ${x(0)} ${topFn(0)}`;
      for (let i = 1; i < n; i++) p += ` L ${x(i)} ${topFn(i)}`;
      for (let i = n - 1; i >= 0; i--) p += ` L ${x(i)} ${baseFn(i)}`;
      return p + " Z";
    };

    const linePath = (valFn) => {
      let p = `M ${x(0)} ${valFn(0)}`;
      for (let i = 1; i < n; i++) p += ` L ${x(i)} ${valFn(i)}`;
      return p;
    };

    // Grid
    const gridSteps = 4;
    let gridSvg = "";
    for (let i = 0; i <= gridSteps; i++) {
      const val = (yMax / gridSteps) * i;
      const yPos = y(val);
      gridSvg += `<line x1="${PAD.left}" y1="${yPos}" x2="${W - PAD.right}" y2="${yPos}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
      gridSvg += `<text x="${PAD.left - 8}" y="${yPos + 4}" text-anchor="end" fill="rgba(255,255,255,0.3)" font-size="10" font-family="monospace">${val >= 1000 ? (val / 1000).toFixed(0) + "k" : val}</text>`;
    }

    // X labels
    const xLabels = this._buildXLabels(data, labelsKey, x, H, PAD);

    // Gradient for pass area
    let defs = `<defs>
      <linearGradient id="passGradStacked" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="white" stop-opacity="0"/>
        <stop offset="25%" stop-color="white" stop-opacity="0.055"/>
        <stop offset="100%" stop-color="white" stop-opacity="0.41"/>
      </linearGradient>
      <filter id="passGlow"><feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>`;

    // Areas + lines (bottom to top, pass first)
    let areas = "";
    let lines = "";
    for (let si = 0; si < seriesDef.length; si++) {
      const s = seriesDef[si];
      const top = stacks[si];
      const base = si > 0 ? stacks[si - 1] : top.map(() => 0);
      const color = s.color || "rgba(255,255,255,0.5)";

      if (si === 0) {
        // Pass area — gradient fill
        areas += `<path d="${areaPath(
          (i) => y(top[i]),
          (i) => y(base[i]),
        )}" fill="url(#passGradStacked)"/>`;
        // Pass line — prominent with glow
        lines += `<path d="${linePath((i) => y(top[i]))}" fill="none" stroke="#fff" stroke-width="2" filter="url(#passGlow)"/>`;
      } else {
        const opacity = s.areaOpacity ?? 0.06;
        areas += `<path d="${areaPath(
          (i) => y(top[i]),
          (i) => y(base[i]),
        )}" fill="${color}" opacity="${opacity}"/>`;
      }
    }

    // Top line
    const topStack = stacks[stacks.length - 1];
    lines += `<path d="${linePath((i) => y(topStack[i]))}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1.5"/>`;

    // Dots on pass line
    let dots = "";
    const passStack = stacks[0];
    const maxIdx = passStack.reduce((mi, v, i, a) => (v > a[mi] ? i : mi), 0);
    for (let i = 0; i < n; i++) {
      dots += `<circle cx="${x(i)}" cy="${y(passStack[i])}" r="2.5" fill="rgba(255,255,255,0.9)"/>`;
      if (i === maxIdx) {
        dots += `<text x="${x(i)}" y="${y(passStack[i]) - 8}" text-anchor="middle" fill="rgba(255,255,255,0.8)" font-size="10" font-family="monospace">${passStack[i].toLocaleString()}</text>`;
      }
    }

    this.shadowRoot.innerHTML = `
      <style>:host { display: block; }</style>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
        ${defs}${gridSvg}${xLabels}${areas}${lines}${dots}
      </svg>`;
  }

  _renderLine(data, seriesDef, W, H, PAD, plotW, plotH, n, x, labelsKey, stepped = false) {
    const leftSeries = seriesDef.filter((s) => (s.axis || "left") !== "right");
    const rightSeries = seriesDef.filter((s) => s.axis === "right");

    const calcDomain = (series) => {
      let min = Infinity;
      let max = -Infinity;
      for (const s of series) {
        for (const d of data) {
          const v = Number(d[s.key] || 0);
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return { min: 0, max: 1 };
      }
      const range = max - min || 1;
      return {
        min: Math.max(0, min - range * 0.05),
        max: max + range * 0.05,
      };
    };

    const leftDomain = calcDomain(leftSeries.length ? leftSeries : seriesDef);
    const rightDomain = rightSeries.length ? calcDomain(rightSeries) : null;

    const makeY = (domain) => (val) => PAD.top + plotH - ((val - domain.min) / (domain.max - domain.min || 1)) * plotH;
    const yLeft = makeY(leftDomain);
    const yRight = rightDomain ? makeY(rightDomain) : null;
    const yForSeries = (series) => (series.axis === "right" && yRight ? yRight : yLeft);

    const linePath = (valFn) => {
      let p = `M ${x(0)} ${valFn(0)}`;
      for (let i = 1; i < n; i++) {
        if (stepped) {
          p += ` L ${x(i)} ${valFn(i - 1)} L ${x(i)} ${valFn(i)}`;
        } else {
          p += ` L ${x(i)} ${valFn(i)}`;
        }
      }
      return p;
    };

    // Grid
    const gridSteps = 4;
    let gridSvg = "";
    for (let i = 0; i <= gridSteps; i++) {
      const val = leftDomain.max - (i / gridSteps) * (leftDomain.max - leftDomain.min);
      const yPos = yLeft(val);
      gridSvg += `<line x1="${PAD.left}" y1="${yPos}" x2="${W - PAD.right}" y2="${yPos}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
      gridSvg += `<text x="${PAD.left - 8}" y="${yPos + 4}" text-anchor="end" fill="rgba(255,255,255,0.3)" font-size="10" font-family="monospace">${val >= 1000 ? (val / 1000).toFixed(1) + "k" : val.toFixed(0)}</text>`;
      if (rightDomain) {
        const rightVal = rightDomain.max - (i / gridSteps) * (rightDomain.max - rightDomain.min);
        gridSvg += `<text x="${W - PAD.right + 8}" y="${yPos + 4}" text-anchor="start" fill="rgba(255,255,255,0.16)" font-size="10" font-family="monospace">${rightVal >= 1000 ? (rightVal / 1000).toFixed(0) + "k" : rightVal.toFixed(0)}</text>`;
      }
    }

    // X labels
    const xLabels = this._buildXLabels(data, labelsKey, x, H, PAD);

    // Lines + gradient fills
    let paths = "";
    for (let si = 0; si < seriesDef.length; si++) {
      const s = seriesDef[si];
      const color = s.color || "#fff";
      const width = s.lineWidth ?? (si === 0 ? 2 : 1.5);
      const opacity = s.lineOpacity ?? 1;
      const dasharray = s.dasharray ? ` stroke-dasharray="${s.dasharray}"` : "";
      const y = yForSeries(s);

      paths += `<path d="${linePath((i) => y(Number(data[i][s.key] || 0)))}" fill="none" stroke="${color}" stroke-width="${width}" opacity="${opacity}"${dasharray}/>`;

      if (s.fill) {
        const gradId = `grad-${si}`;
        paths =
          `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient></defs>` + paths;

        let fillPath = linePath((i) => y(Number(data[i][s.key] || 0)));
        fillPath += ` L ${x(n - 1)} ${PAD.top + plotH} L ${x(0)} ${PAD.top + plotH} Z`;
        paths += `<path d="${fillPath}" fill="url(#${gradId})"/>`;
      }
    }

    // Dots on primary series
    let dots = "";
    if (seriesDef.length > 0) {
      const s = seriesDef[0];
      const y = yForSeries(s);
      for (let i = 0; i < n; i++) {
        const v = Number(data[i][s.key] || 0);
        dots += `<circle cx="${x(i)}" cy="${y(v)}" r="2.5" fill="rgba(255,255,255,0.9)"/>`;
      }
    }

    this.shadowRoot.innerHTML = `
      <style>:host { display: block; }</style>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
        ${gridSvg}${xLabels}${paths}${dots}
      </svg>`;
  }
}

customElements.define("trend-chart", TrendChart);
