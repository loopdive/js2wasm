class SiteNav extends HTMLElement {
  static get observedAttributes() {
    return ["base"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this._render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this._render();
  }

  _render() {
    const base = this.getAttribute("base") ?? "./";
    const isLanding = !this.hasAttribute("base") || base === "./";

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }

        .site-nav {
          position: fixed;
          inset: 0 0 auto 0;
          z-index: 100;
          height: 64px;
          padding: 0 56px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: var(--nav, rgba(6, 10, 20, 0.45));
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          box-shadow: inset 0 -1px 0 var(--line, rgba(255, 255, 255, 0.12));
        }

        .nav-logo {
          display: inline-flex;
          align-items: center;
          gap: 14px;
          color: inherit;
          text-decoration: none;
        }

        .nav-logo img {
          height: 34px;
          width: auto;
          display: block;
          filter: grayscale(1) contrast(2.4) brightness(1.35);
        }

        .nav-logo span {
          font-size: 0.8rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--fg-soft, rgba(255, 255, 255, 0.68));
          font-family: var(--font, Inter, ui-sans-serif, system-ui, sans-serif);
        }

        .nav-links {
          display: flex;
          gap: 6px;
          list-style: none;
          margin: 0;
          padding: 0;
        }

        .nav-links a {
          padding: 6px 14px;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 500;
          color: var(--fg-soft, rgba(255, 255, 255, 0.68));
          text-decoration: none;
          font-family: var(--font, Inter, ui-sans-serif, system-ui, sans-serif);
          transition:
            color 0.15s ease,
            background 0.15s ease;
        }

        .nav-links a:hover {
          color: var(--fg, #ffffff);
          background: var(--surface, rgba(255, 255, 255, 0.05));
        }

        .nav-actions {
          display: flex;
          gap: 12px;
        }

        .btn-outline,
        .btn-solid {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 38px;
          padding: 0 16px;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          font-family: var(--font, Inter, ui-sans-serif, system-ui, sans-serif);
          text-decoration: none;
          border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
          color: var(--fg, #ffffff);
          transition:
            background 0.15s ease,
            border-color 0.15s ease,
            opacity 0.15s ease;
        }

        .btn-outline:hover {
          background: var(--surface-hover, rgba(255, 255, 255, 0.08));
          border-color: var(--line-strong, rgba(255, 255, 255, 0.22));
        }

        .btn-solid {
          color: var(--bg, #060a14);
          background: var(--fg, #ffffff);
          border-color: var(--fg, #ffffff);
        }

        .btn-solid:hover {
          opacity: 0.9;
        }
      </style>
      <nav class="site-nav">
        <a class="nav-logo" href="${base}" aria-label="js2 home">
          <span>js2</span>
        </a>
        <ul class="nav-links">
          ${
            isLanding
              ? `
          <li><a href="#mission">Mission</a></li>
          <li><a href="#goals">Compatibility</a></li>
          <li><a href="#how-it-works">How it works</a></li>
          <li><a href="#links">Links</a></li>
          `
              : ""
          }
          <li><a href="${base}dashboard/">Dashboard</a></li>
          <li><a href="${base}benchmarks/report.html">Report</a></li>
        </ul>
        <div class="nav-actions">
          <a class="btn-outline" href="https://github.com/loopdive/js2wasm">GitHub</a>
          <a class="btn-solid" href="${base}playground/">Playground</a>
        </div>
      </nav>
    `;
  }
}

customElements.define("site-nav", SiteNav);
