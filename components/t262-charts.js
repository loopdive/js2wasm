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
      { value: ce, color: "rgba(255,255,255,0.1)", label: "CE" },
      { value: skip, color: "rgba(255,255,255,0)", label: "Skip" },
    ];

    // Build the conic-gradient donut
    const totalSafe = Math.max(total, 1);
    const passDeg = (pass / totalSafe) * 360;
    const failDeg = passDeg + (fail / totalSafe) * 360;
    const ceDeg = failDeg + (ce / totalSafe) * 360;

    // Orbit stats — positioned around the donut
    const centerX = 190;
    const centerY = 193;
    const orbitPoint = (angle, radius) => {
      const rad = ((angle - 90) * Math.PI) / 180;
      return { x: centerX + Math.cos(rad) * radius, y: centerY + Math.sin(rad) * radius };
    };

    const makeOrbitStat = (value, label, color, angle, labelRadius) => {
      const lp = orbitPoint(angle, labelRadius);
      const ls = orbitPoint(angle, 126);
      const dx = lp.x - ls.x;
      const dy = lp.y - ls.y;
      const lineLen = Math.max(Math.sqrt(dx * dx + dy * dy) - 34, 0);
      return `
        <div class="orbit-connector" style="left:${ls.x}px;top:${ls.y}px;width:${lineLen}px;transform:rotate(${angle - 90}deg)"></div>
        <div class="orbit-stat" style="left:${lp.x}px;top:${lp.y}px">
          <div class="orbit-value" style="color:${color}">${Number(value).toLocaleString()}</div>
          <div class="orbit-label">${label}</div>
        </div>`;
    };

    const orbitHTML =
      makeOrbitStat(pass, "Passed", "rgba(255,255,255,0.9)", passDeg / 2, 184) +
      makeOrbitStat(fail, "Failed", "rgba(255,255,255,0.4)", (passDeg + failDeg) / 2, 194) +
      makeOrbitStat(ce, "Compile Errors", "rgba(255,255,255,0.25)", (failDeg + ceDeg) / 2, 180) +
      makeOrbitStat(skip, "Unsupported", "rgba(255,255,255,0.15)", (ceDeg + 360) / 2, 214);

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
          height: 340px;
          margin: 0 auto;
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
            rgba(255,255,255,0.2) 0deg,
            rgba(255,255,255,1) ${passDeg}deg,
            rgba(255,255,255,0.1) ${passDeg}deg ${failDeg - 0.4}deg,
            var(--_bg) ${failDeg - 0.4}deg ${failDeg + 0.4}deg,
            rgba(255,255,255,0.1) ${failDeg + 0.4}deg ${ceDeg}deg,
            rgba(255,255,255,0) ${ceDeg}deg 360deg
          );
        }
        .gauge-wrap::before {
          content: "";
          position: absolute;
          inset: 22px;
          border-radius: 50%;
          background: var(--_bg);
          border: 1px solid rgba(255,255,255,0.04);
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
          color: var(--_pass);
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
          background: rgba(255,255,255,0.18);
          transform-origin: left center;
          pointer-events: none;
        }
        .orbit-stat {
          position: absolute;
          display: grid;
          gap: 0.15rem;
          text-align: center;
          font-variant-numeric: tabular-nums;
          width: 120px;
          transform: translate(-50%, -50%);
        }
        .orbit-value {
          font-size: 1rem;
          font-weight: 700;
        }
        .orbit-label {
          font-size: 0.68rem;
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
            <div class="gauge-center">
              <div class="gauge-value">${pct}%</div>
              <div class="gauge-caption">
                <div class="gauge-caption-main">ECMAScript</div>
                <div class="gauge-caption-sub">conformance</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="legend">${legendHTML}</div>
    `;
  }
}

customElements.define("t262-donut", T262Donut);

/* ── <t262-edition-bars> ──────────────────────────────────────── */

class T262EditionBars extends HTMLElement {
  static get observedAttributes() {
    return ["src"];
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
    let editions;
    try {
      const resp = await fetch(src);
      if (!resp.ok) return;
      editions = await resp.json();
      if (!Array.isArray(editions) || editions.length === 0) return;
    } catch {
      return;
    }

    const rowsHTML = editions
      .filter((ed) => ed && ed.total > 0)
      .map(
        (ed) => `
        <div class="es-row">
          <span class="es-label">${ed.edition}</span>
          <div class="es-bar-track">
            <div class="es-bar-fill" style="width:${ed.pct}%"></div>
          </div>
          <span class="es-pct">${ed.pct}%</span>
        </div>`,
      )
      .join("");

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          --_pass: var(--t262-pass, #3fb950);
          --_text: var(--t262-text, currentColor);
          --_text-muted: var(--t262-text-muted, rgba(139, 148, 158, 1));
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
          color: var(--_text);
        }
        .es-timeline {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .es-row {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .es-label {
          font-family: "SF Mono", SFMono-Regular, Consolas, monospace;
          font-size: 12px;
          font-weight: 500;
          color: var(--_text-muted);
          min-width: 58px;
          text-align: right;
          flex-shrink: 0;
        }
        .es-bar-track {
          flex: 1;
          height: 22px;
          background: rgba(255,255,255,0.04);
          border-radius: 4px;
          overflow: hidden;
          position: relative;
        }
        .es-bar-fill {
          height: 100%;
          border-radius: 4px;
          background: var(--_pass);
          transition: width 0.8s ease;
          position: relative;
        }
        .es-bar-fill::after {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(180deg, rgba(255,255,255,0.12) 0%, transparent 50%);
          border-radius: 4px;
        }
        .es-pct {
          font-family: "SF Mono", SFMono-Regular, Consolas, monospace;
          font-size: 12px;
          color: var(--_text-muted);
          min-width: 38px;
          text-align: right;
          flex-shrink: 0;
        }
      </style>
      <div class="es-timeline">${rowsHTML}</div>
    `;
  }
}

customElements.define("t262-edition-bars", T262EditionBars);
