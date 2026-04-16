/**
 * Shared web components for test262 conformance charts.
 * Used on both the landing page (index.html) and report page (report.html).
 *
 * Components:
 *   <t262-donut pass="..." fail="..." ce="..." skip="..." total="...">
 *   <t262-edition-bars src="./benchmarks/results/test262-editions.json">
 */

/* ── <t262-donut> ─────────────────────────────────────────────── */

class T262Donut extends HTMLElement {
  static get observedAttributes() {
    return ["pass", "fail", "ce", "skip", "total", "src", "include-sloppy"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this._render();
  }

  attributeChangedCallback() {
    this._render();
  }

  async _render() {
    let pass = Number(this.getAttribute("pass") || 0);
    let fail = Number(this.getAttribute("fail") || 0);
    let ce = Number(this.getAttribute("ce") || 0);
    let skip = Number(this.getAttribute("skip") || 0);
    let total = Number(this.getAttribute("total") || 0);

    // Auto-fetch from report JSON if no attributes given
    if (pass === 0 && fail === 0 && ce === 0 && skip === 0) {
      const src = this.getAttribute("src") || "./benchmarks/results/test262-report.json";
      try {
        const resp = await fetch(src);
        if (!resp.ok) return;
        const report = await resp.json();
        // Default: exclude sloppy-mode-only tests (noStrict).
        // With include-sloppy attribute: show all tests including sloppy.
        const includeSloppy = this.hasAttribute("include-sloppy");
        const s = !includeSloppy && report?.no_sloppy_summary ? report.no_sloppy_summary : report?.summary;
        if (!s) return;
        pass = Number(s.pass ?? 0);
        fail = Number(s.fail ?? 0);
        ce = Number(s.compile_error ?? 0) + Number(s.compile_timeout ?? 0);
        skip = Number(s.skip ?? 0);
        total = pass + fail + ce + skip;
      } catch {
        return;
      }
    }

    if (total <= 0) total = pass + fail + ce + skip;
    if (total <= 0) return;

    const pct = ((pass / total) * 100).toFixed(1);

    const segments = [
      { value: pass, color: "rgba(255,255,255,1)", label: "Pass" },
      { value: fail, color: "rgba(255,255,255,0.2)", label: "Fail" },
      { value: ce, color: "rgba(255,255,255,0.2)", label: "CE" },
      { value: skip, color: "rgba(255,255,255,0.2)", label: "Skipped" },
    ];

    // Build the conic-gradient donut
    const totalSafe = Math.max(total, 1);
    const passDeg = (pass / totalSafe) * 360;
    const failDeg = passDeg + (fail / totalSafe) * 360;
    const ceDeg = failDeg + (ce / totalSafe) * 360;

    // Orbit stats — positioned around the donut
    // Container is 380x320, .gauge-core has inset: 45px 0 0 (height 275px from y=45)
    // gauge-wrap is 250x250 centered in gauge-core, so donut center y = 45 + (275-250)/2 + 125 = 182.5
    const centerX = 190;
    const centerY = 182;
    const orbitPoint = (angle, radius) => {
      const rad = ((angle - 90) * Math.PI) / 180;
      return { x: centerX + Math.cos(rad) * radius, y: centerY + Math.sin(rad) * radius };
    };

    // Compute label positions, pushing out if they collide with previous labels
    const minLabelDist = 55; // minimum pixel distance between label centers
    const stats = [
      { value: pass, label: "Passed", color: "rgba(255,255,255,0.9)", angle: passDeg / 2, radius: 164, id: "pass" },
      { value: fail, label: "Failed", color: "rgba(255,255,255,0.7)", angle: (passDeg + failDeg) / 2, radius: 170 },
      { value: ce, label: "Compile Errors", color: "rgba(255,255,255,0.7)", angle: (failDeg + ceDeg) / 2, radius: 164 },
      { value: skip, label: "Skipped", color: "rgba(255,255,255,0.7)", angle: (ceDeg + 360) / 2, radius: 178 },
    ];
    // Compute positions and resolve collisions by extending radius
    const placed = [];
    for (const s of stats) {
      let radius = s.radius;
      let lp;
      for (let attempt = 0; attempt < 8; attempt++) {
        lp = orbitPoint(s.angle, radius);
        const collides = placed.some((p) => {
          const dx = p.lp.x - lp.x;
          const dy = p.lp.y - lp.y;
          return Math.sqrt(dx * dx + dy * dy) < minLabelDist;
        });
        if (!collides) break;
        radius += 18;
      }
      placed.push({ ...s, radius, lp });
    }

    // Label positions are expressed as deltas from the orbit's actual center
    // (left:50%) so they track the donut when the orbit container is narrower
    // than its 380px design width (i.e. on mobile, min(100%, 380px)).
    const makeOrbitStat = (stat) => {
      const { value, label, color, angle, radius, id, lp } = stat;
      const ls = orbitPoint(angle, 126);
      const dx = lp.x - ls.x;
      const dy = lp.y - ls.y;
      const lineLen = Math.max(Math.sqrt(dx * dx + dy * dy) - 34, 0);
      const dataAttr = id ? ` data-stat="${id}"` : "";
      const labelDx = lp.x - centerX;
      const labelDy = lp.y - centerY;
      const lineDx = ls.x - centerX;
      const lineDy = ls.y - centerY;
      return `
        <div class="orbit-connector" style="left:50%;top:50%;width:${lineLen}px;transform:translate(${lineDx}px,${lineDy}px) rotate(${angle - 90}deg)"></div>
        <div class="orbit-stat" style="left:50%;top:50%;transform:translate(calc(-50% + ${labelDx}px), calc(-50% + ${labelDy}px))">
          <div class="orbit-value"${dataAttr} style="color:${color}">${id === "pass" ? "0" : Number(value).toLocaleString()}</div>
          <div class="orbit-label">${label}</div>
        </div>`;
    };

    const orbitHTML = placed.map(makeOrbitStat).join("");

    // Build legend
    const legendHTML = segments
      .map(
        (s) =>
          `<div class="legend-item">
            <span class="legend-dot" style="background:${s.color}"></span>
            ${s.label}
            <span class="legend-count">${s.value.toLocaleString()}</span>
          </div>`,
      )
      .join("");

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          max-width: 100%;
          overflow-x: clip;
          --_pass: var(--t262-pass, #3fb950);
          --_fail: var(--t262-fail, #f85149);
          --_ce: var(--t262-ce, #d29922);
          --_skip: var(--t262-skip, #8b949e);
          --_text: var(--t262-text, currentColor);
          --_text-muted: var(--t262-text-muted, rgba(139, 148, 158, 1));
          --_bg: var(--t262-bg, #0d1117);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
          color: var(--_text);
        }
        .gauge-orbit {
          position: relative;
          width: min(100%, 380px);
          height: 320px;
          margin: 0 auto;
          overflow: visible;
        }
        .gauge-wrap {
          position: relative;
          display: grid;
          place-items: center;
          margin: 0 auto;
          width: 250px;
          aspect-ratio: 1 / 1;
          border-radius: 50%;
          background: conic-gradient(
            var(--_bg) 0deg 1deg,
            rgba(255,255,255,0.06) 1deg,
            rgba(255,255,255,0.06) ${failDeg - 1}deg,
            var(--_bg) ${failDeg - 1}deg ${failDeg + 1}deg,
            rgba(255,255,255,0.06) ${failDeg + 1}deg ${ceDeg - 1}deg,
            var(--_bg) ${ceDeg - 1}deg ${ceDeg + 1}deg,
            rgba(255,255,255,0.06) ${ceDeg + 1}deg ${359}deg,
            var(--_bg) ${359}deg 360deg
          );
        }
        .gauge-glow {
          position: absolute;
          inset: -8px;
          border-radius: 50%;
          background: conic-gradient(
            rgba(255,255,255,0) 0deg,
            rgba(255,255,255,0) 1deg 360deg
          );
          filter: blur(6px);
          pointer-events: none;
          z-index: 0;
        }
        .gauge-wrap::before {
          content: "";
          position: absolute;
          inset: 22px;
          border-radius: 50%;
          background: var(--_bg);
          border: 1px solid rgba(255,255,255,0.04);
        }
        .pass-tick {
          position: absolute;
          width: 8px;
          height: 68px;
          background: #fff;
          left: calc(50% - 4px);
          top: calc(50% - 135px);
          transform-origin: 4px 135px;
          transform: rotate(0deg);
          z-index: 3;
          clip-path: polygon(35% 0%, 50% -4%, 65% 0%, 95% 100%, 50% 104%, 5% 100%);
          border-radius: 3px;
          filter: drop-shadow(0 0 8px rgba(0,0,0,1));
        }
        .gauge-core {
          position: absolute;
          inset: 45px 0 0;
          display: grid;
          place-items: center;
        }
        .gauge-center {
          position: absolute;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          transform: translateY(8px);
        }
        .gauge-value {
          font-size: 2.5rem;
          font-weight: 800;
          line-height: 1;
          color: #fff;
        }
        .gauge-caption {
          margin-top: 0.35rem;
          display: grid;
          gap: 0.05rem;
          justify-items: center;
          color: var(--_text-muted);
        }
        .gauge-caption-main {
          font-size: 0.86rem;
          letter-spacing: 0.08em;
        }
        .gauge-caption-sub {
          font-size: 0.78rem;
          letter-spacing: 0.08em;
        }
        .orbit-connector {
          position: absolute;
          height: 1px;
          background: rgba(255,255,255,0.06);
          transform-origin: left center;
          pointer-events: none;
        }
        .orbit-stat {
          position: absolute;
          display: grid;
          gap: 0.1rem;
          text-align: center;
          font-variant-numeric: tabular-nums;
          width: 100px;
          transform: translate(-50%, -50%);
        }
        .orbit-value {
          font-size: 0.85rem;
          font-weight: 700;
        }
        .orbit-label {
          font-size: 0.6rem;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--_text-muted);
        }
        .legend {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px 16px;
          margin-top: 24px;
        }
        /* Narrow viewports: orbit labels don't fit; rely on the legend below.
           The donut itself is 250px and fits comfortably in ~360px viewports. */
        @media (max-width: 440px) {
          .gauge-orbit {
            height: 280px;
          }
          .orbit-connector,
          .orbit-stat {
            display: none;
          }
        }
        .legend-item {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          color: var(--_text-muted);
        }
        .legend-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .legend-count {
          margin-left: auto;
          font-family: "SF Mono", SFMono-Regular, Consolas, monospace;
          font-size: 12px;
        }
      </style>
      <div class="gauge-orbit">
        ${orbitHTML}
        <div class="gauge-core">
          <div class="gauge-wrap">
            <div class="gauge-glow"></div>
            <div class="gauge-center">
              <div class="gauge-value">0.0%</div>
              <div class="gauge-caption">
                <div class="gauge-caption-main">ECMAScript</div>
                <div class="gauge-caption-sub">conformance</div>
              </div>
            </div>
          </div>
          <div class="pass-tick"></div>
        </div>
      </div>
      <div class="legend">
        ${legendHTML}
      </div>
    `;

    // Animate: sweep tick from 0 to passDeg, count up percentage
    const tick = this.shadowRoot.querySelector(".pass-tick");
    const valueEl = this.shadowRoot.querySelector(".gauge-value");
    const wrap = this.shadowRoot.querySelector(".gauge-wrap");
    const glow = this.shadowRoot.querySelector(".gauge-glow");
    const passCountEl = this.shadowRoot.querySelector('[data-stat="pass"]');
    if (!tick || !valueEl || !wrap) return;

    const duration = 3293;
    const targetPct = parseFloat(pct);
    const targetDeg = passDeg;
    let start = null;

    const ease = (t) => 1 - (1 - t) * (1 - t); // ease-out quad

    const animate = (ts) => {
      if (!start) start = ts;
      const elapsed = ts - start;
      const progress = Math.min(elapsed / duration, 1);
      const t = ease(progress);

      const curDeg = t * targetDeg;
      const curPct = (t * targetPct).toFixed(1);

      // Update tick rotation
      tick.style.transform = "rotate(" + curDeg + "deg)";

      // Update percentage and pass count
      valueEl.textContent = curPct + "%";
      if (passCountEl) {
        passCountEl.textContent = Math.round(t * pass).toLocaleString();
      }

      // Update conic-gradient to reveal pass segment up to curDeg
      wrap.style.background =
        "conic-gradient(" +
        "var(--_bg) 0deg 1deg," +
        "rgba(255,255,255,0.06) 1deg," +
        "rgba(255,255,255,0.9) " +
        curDeg +
        "deg," +
        "rgba(255,255,255,0.06) " +
        curDeg +
        "deg " +
        (failDeg - 1) +
        "deg," +
        "var(--_bg) " +
        (failDeg - 1) +
        "deg " +
        (failDeg + 1) +
        "deg," +
        "rgba(255,255,255,0.06) " +
        (failDeg + 1) +
        "deg " +
        (ceDeg - 1) +
        "deg," +
        "var(--_bg) " +
        (ceDeg - 1) +
        "deg " +
        (ceDeg + 1) +
        "deg," +
        "rgba(255,255,255,0.06) " +
        (ceDeg + 1) +
        "deg 359deg," +
        "var(--_bg) 359deg 360deg)";

      // Update glow to follow the needle
      if (glow) {
        glow.style.background =
          "conic-gradient(" +
          "rgba(255,255,255,0) 0deg," +
          "rgba(255,255,255,0.25) " +
          curDeg +
          "deg," +
          "rgba(255,255,255,0) " +
          (curDeg + 1) +
          "deg 360deg)";
      }

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    // Start animation when element enters viewport
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            observer.disconnect();
            requestAnimationFrame(animate);
          }
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(this);
  }
}

customElements.define("t262-donut", T262Donut);

/* ── <t262-edition-bars> ──────────────────────────────────────── */

class T262EditionBars extends HTMLElement {
  static get observedAttributes() {
    return ["src", "mode"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this._render();
  }

  attributeChangedCallback() {
    this._render();
  }

  async _render() {
    const src = this.getAttribute("src") || "./benchmarks/results/test262-editions.json";
    const chartMode = this.getAttribute("mode") || "both";
    let editions;
    try {
      const resp = await fetch(src);
      if (!resp.ok) return;
      editions = await resp.json();
      if (!Array.isArray(editions) || editions.length === 0) return;
    } catch {
      return;
    }

    const eds = editions.filter((ed) => ed && ed.total > 0);
    const n = eds.length;
    if (n === 0) return;

    const W = 500,
      H = 240;
    const PAD = { top: 20, right: 40, bottom: 40, left: 60 };
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;

    const maxTotal = Math.max(...eds.map((d) => d.total));

    const x = (i) => PAD.left + (i / (n - 1)) * plotW;
    const y = (val) => PAD.top + plotH - (val / maxTotal) * plotH;

    // Stacked values per edition (pass on bottom, skip on top)
    const cumPass = eds.map((d) => d.pass);
    const cumFail = eds.map((d, i) => cumPass[i] + d.fail);
    const cumCe = eds.map((d, i) => cumFail[i] + d.ce);
    const cumSkip = eds.map((d, i) => cumCe[i] + d.skip);

    const areaPath = (valueFn, baseFn) => {
      let p = `M ${x(0)} ${valueFn(0)}`;
      for (let i = 1; i < n; i++) p += ` L ${x(i)} ${valueFn(i)}`;
      for (let i = n - 1; i >= 0; i--) p += ` L ${x(i)} ${baseFn(i)}`;
      return p + " Z";
    };
    const linePath = (valueFn) => {
      let p = `M ${x(0)} ${valueFn(0)}`;
      for (let i = 1; i < n; i++) p += ` L ${x(i)} ${valueFn(i)}`;
      return p;
    };

    // Grid lines
    const gridSteps = 4;
    const yMax = Math.ceil(maxTotal / 5000) * 5000;
    const yG = (val) => PAD.top + plotH - (val / yMax) * plotH;
    let gridSvg = "";
    for (let i = 0; i <= gridSteps; i++) {
      const val = (yMax / gridSteps) * i;
      const yPos = yG(val);
      gridSvg += `<line x1="${PAD.left}" y1="${yPos}" x2="${W - PAD.right}" y2="${yPos}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
      gridSvg += `<text x="${PAD.left - 8}" y="${yPos + 4}" text-anchor="end" fill="rgba(255,255,255,0.3)" font-size="10" font-family="monospace">${(val / 1000).toFixed(0)}k</text>`;
    }

    // X-axis labels
    let xLabels = "";
    for (let i = 0; i < n; i++) {
      const label = eds[i].edition.replace("ES20", "'");
      xLabels += `<text x="${x(i)}" y="${H - PAD.bottom + 16}" text-anchor="middle" fill="rgba(255,255,255,0.3)" font-size="10" font-family="monospace">${label}</text>`;
    }

    // Pass rate dots + labels
    let dots = "";
    const maxPassIdx = cumPass.reduce((mi, v, i, a) => (v > a[mi] ? i : mi), 0);
    for (let i = 0; i < n; i++) {
      const cx = x(i);
      dots += `<circle cx="${cx}" cy="${y(cumSkip[i])}" r="2" fill="none"/>`;
      dots += `<circle cx="${cx}" cy="${y(cumCe[i])}" r="2" fill="none"/>`;
      dots += `<circle cx="${cx}" cy="${y(cumFail[i])}" r="2" fill="none"/>`;
      dots += `<circle cx="${cx}" cy="${y(cumSkip[i])}" r="2.5" fill="#4a5060"/>`;
      dots += `<circle cx="${cx}" cy="${y(cumPass[i])}" r="3" fill="rgba(255,255,255,0.9)"/>`;
      if (i === maxPassIdx) {
        dots += `<text x="${cx}" y="${y(cumPass[i]) - 8}" text-anchor="middle" fill="rgba(255,255,255,0.8)" font-size="10" font-family="monospace">${cumPass[i].toLocaleString()}</text>`;
      }
    }

    const svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">
      <defs>
        <linearGradient id="passGrad" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="white" stop-opacity="0"/>
          <stop offset="25%" stop-color="white" stop-opacity="0.055"/>
          <stop offset="100%" stop-color="white" stop-opacity="0.41"/>
        </linearGradient>
        <linearGradient id="failGrad" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="#0a0e16" stop-opacity="1"/>
          <stop offset="100%" stop-color="#1a2436" stop-opacity="1"/>
        </linearGradient>
        <linearGradient id="ceGrad" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="#090d14" stop-opacity="1"/>
          <stop offset="100%" stop-color="#141c2c" stop-opacity="1"/>
        </linearGradient>
        <linearGradient id="skipGrad" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="#080c12" stop-opacity="1"/>
          <stop offset="100%" stop-color="#0f1520" stop-opacity="1"/>
        </linearGradient>
        <filter id="passLineGlow">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      ${gridSvg}
      ${xLabels}
      <path d="${areaPath(
        (i) => y(cumSkip[i]),
        (i) => y(cumCe[i]),
      )}" fill="url(#skipGrad)"/>
      <path d="${areaPath(
        (i) => y(cumCe[i]),
        (i) => y(cumFail[i]),
      )}" fill="url(#ceGrad)"/>
      <path d="${areaPath(
        (i) => y(cumFail[i]),
        (i) => y(cumPass[i]),
      )}" fill="url(#failGrad)"/>
      <path d="${areaPath(
        (i) => y(cumPass[i]),
        () => y(0),
      )}" fill="url(#passGrad)"/>
      <path d="${linePath((i) => y(cumSkip[i]))}" fill="none" stroke="#4a5060" stroke-width="1.5"/>
      <path d="${linePath((i) => y(cumCe[i]))}" fill="none" stroke="none"/>
      <path d="${linePath((i) => y(cumFail[i]))}" fill="none" stroke="none"/>
      <path d="${linePath((i) => y(cumPass[i]))}" fill="none" stroke="#fff" stroke-width="2" filter="url(#passLineGlow)"/>
      ${dots}
    </svg>`;

    // Percentage chart (normalized to 100%)
    const yPct = (pct) => PAD.top + plotH - (pct / 100) * plotH;

    const pctPass = eds.map((d) => (d.pass / d.total) * 100);
    const pctFail = eds.map((d, i) => pctPass[i] + (d.fail / d.total) * 100);
    const pctCe = eds.map((d, i) => pctFail[i] + (d.ce / d.total) * 100);

    let gridPct = "";
    for (let i = 0; i <= gridSteps; i++) {
      const pct = (100 / gridSteps) * i;
      const yPos = yPct(pct);
      gridPct += `<line x1="${PAD.left}" y1="${yPos}" x2="${W - PAD.right}" y2="${yPos}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
      gridPct += `<text x="${PAD.left - 8}" y="${yPos + 4}" text-anchor="end" fill="rgba(255,255,255,0.3)" font-size="10" font-family="monospace">${pct.toFixed(0)}%</text>`;
    }

    let dotsPct = "";
    const maxPctIdx = pctPass.reduce((mi, v, i, a) => (v > a[mi] ? i : mi), 0);
    for (let i = 0; i < n; i++) {
      const cx = x(i);
      dotsPct += `<circle cx="${cx}" cy="${yPct(100)}" r="2" fill="none"/>`;
      dotsPct += `<circle cx="${cx}" cy="${yPct(pctCe[i])}" r="2" fill="none"/>`;
      dotsPct += `<circle cx="${cx}" cy="${yPct(pctFail[i])}" r="2" fill="none"/>`;
      dotsPct += `<circle cx="${cx}" cy="${yPct(pctPass[i])}" r="3" fill="rgba(255,255,255,0.9)"/>`;
      if (i === maxPctIdx) {
        dotsPct += `<text x="${cx}" y="${yPct(pctPass[i]) - 8}" text-anchor="middle" fill="rgba(255,255,255,0.8)" font-size="10" font-family="monospace">${Math.round(pctPass[i])}%</text>`;
      }
    }

    const svgPct = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">
      <defs>
        <linearGradient id="passGradPct" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="white" stop-opacity="0"/>
          <stop offset="25%" stop-color="white" stop-opacity="0.055"/>
          <stop offset="100%" stop-color="white" stop-opacity="0.41"/>
        </linearGradient>
        <linearGradient id="failGradPct" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="#0a0e16" stop-opacity="1"/>
          <stop offset="100%" stop-color="#1a2436" stop-opacity="1"/>
        </linearGradient>
        <linearGradient id="ceGradPct" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="#090d14" stop-opacity="1"/>
          <stop offset="100%" stop-color="#141c2c" stop-opacity="1"/>
        </linearGradient>
        <linearGradient id="skipGradPct" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="#080c12" stop-opacity="1"/>
          <stop offset="100%" stop-color="#0f1520" stop-opacity="1"/>
        </linearGradient>
        <filter id="passLineGlowPct">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      ${gridPct}
      ${xLabels}
      <path d="${areaPath(
        () => yPct(100),
        (i) => yPct(pctCe[i]),
      )}" fill="url(#skipGradPct)"/>
      <path d="${areaPath(
        (i) => yPct(pctCe[i]),
        (i) => yPct(pctFail[i]),
      )}" fill="url(#ceGradPct)"/>
      <path d="${areaPath(
        (i) => yPct(pctFail[i]),
        (i) => yPct(pctPass[i]),
      )}" fill="url(#failGradPct)"/>
      <path d="${areaPath(
        (i) => yPct(pctPass[i]),
        () => yPct(0),
      )}" fill="url(#passGradPct)"/>
      <path d="${linePath(() => yPct(100))}" fill="none" stroke="none"/>
      <path d="${linePath((i) => yPct(pctCe[i]))}" fill="none" stroke="none"/>
      <path d="${linePath((i) => yPct(pctFail[i]))}" fill="none" stroke="none"/>
      <path d="${linePath((i) => yPct(pctPass[i]))}" fill="none" stroke="#fff" stroke-width="2" filter="url(#passLineGlowPct)"/>
      ${dotsPct}
    </svg>`;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        }
        .charts { display: flex; flex-direction: column; gap: 24px; }
      </style>
      <div class="charts">
        ${chartMode !== "percentage" ? svg : ""}
        ${chartMode !== "absolute" ? svgPct : ""}
      </div>
    `;
  }
}

customElements.define("t262-edition-bars", T262EditionBars);
