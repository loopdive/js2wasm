class SiteNav extends HTMLElement {
  static get observedAttributes() {
    return ["base"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._open = false;
  }

  connectedCallback() {
    this._render();
    this._onOutsideClick = (e) => {
      if (this._open && !this.shadowRoot.querySelector(".mobile-panel").contains(e.composedPath()[0])) {
        this._close();
      }
    };
    document.addEventListener("click", this._onOutsideClick);
  }

  disconnectedCallback() {
    document.removeEventListener("click", this._onOutsideClick);
  }

  attributeChangedCallback() {
    if (this.isConnected) this._render();
  }

  _toggle() {
    this._open = !this._open;
    const panel = this.shadowRoot.querySelector(".mobile-panel");
    const burger = this.shadowRoot.querySelector(".burger");
    if (panel) panel.classList.toggle("open", this._open);
    if (burger) burger.classList.toggle("open", this._open);
  }

  _close() {
    this._open = false;
    const panel = this.shadowRoot.querySelector(".mobile-panel");
    const burger = this.shadowRoot.querySelector(".burger");
    if (panel) panel.classList.remove("open");
    if (burger) burger.classList.remove("open");
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
          font-size: 1.2rem;
          text-transform: uppercase;
          font-weight: bold;
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
          gap: 8px;
          box-sizing: border-box;
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

        .btn-icon {
          width: 14px;
          height: 14px;
          display: inline-block;
          flex: 0 0 auto;
        }

        .btn-icon svg {
          width: 100%;
          height: 100%;
          display: block;
          fill: currentColor;
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

        /* ── Burger button (mobile only) ── */
        .burger {
          display: none;
          flex-direction: column;
          justify-content: center;
          gap: 5px;
          width: 36px;
          height: 36px;
          padding: 6px;
          background: none;
          border: none;
          cursor: pointer;
          z-index: 110;
        }

        .burger span {
          display: block;
          width: 100%;
          height: 2px;
          background: var(--fg-soft, rgba(255, 255, 255, 0.68));
          border-radius: 1px;
          transition: transform 0.25s ease, opacity 0.2s ease;
        }

        .burger.open span:nth-child(1) {
          transform: translateY(7px) rotate(45deg);
        }
        .burger.open span:nth-child(2) {
          opacity: 0;
        }
        .burger.open span:nth-child(3) {
          transform: translateY(-7px) rotate(-45deg);
        }

        /* ── Mobile panel ── */
        .mobile-panel {
          display: none;
        }

        /* ── Responsive ── */
        @media (max-width: 768px) {
          .site-nav {
            padding: 0 20px;
          }

          .nav-links,
          .nav-actions {
            display: none;
          }

          .burger {
            display: flex;
          }

          .mobile-panel {
            display: block;
            position: fixed;
            top: 64px;
            right: 0;
            bottom: 0;
            width: 280px;
            background: var(--nav, rgba(6, 10, 20, 0.96));
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            box-shadow: -4px 0 24px rgba(0, 0, 0, 0.4);
            z-index: 99;
            padding: 24px;
            transform: translateX(100%);
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            overflow-y: auto;
          }

          .mobile-panel.open {
            transform: translateX(0);
          }

          .mobile-panel ul {
            list-style: none;
            margin: 0 0 24px 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            gap: 4px;
          }

          .mobile-panel a {
            display: block;
            padding: 10px 14px;
            border-radius: 8px;
            font-size: 15px;
            font-weight: 500;
            color: var(--fg-soft, rgba(255, 255, 255, 0.68));
            text-decoration: none;
            font-family: var(--font, Inter, ui-sans-serif, system-ui, sans-serif);
            transition: color 0.15s ease, background 0.15s ease;
          }

          .mobile-panel a:hover {
            color: var(--fg, #ffffff);
            background: var(--surface, rgba(255, 255, 255, 0.05));
          }

          .mobile-panel .mobile-actions {
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding-top: 16px;
            border-top: 1px solid var(--line, rgba(255, 255, 255, 0.12));
          }

          .mobile-panel .mobile-actions a {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            min-height: 38px;
            padding: 0 16px;
            text-align: center;
          }

          .mobile-panel .mobile-actions .btn-outline {
            color: var(--fg, #ffffff);
          }

          .mobile-panel .mobile-actions .btn-solid {
            color: var(--bg, #060a14);
            background: var(--fg, #ffffff);
            border-color: var(--fg, #ffffff);
          }
        }
      </style>
      <nav class="site-nav">
        <a class="nav-logo" href="${base}" aria-label="js2 home">
          <span>JS<sup style="font-size:0.55em;vertical-align:super;margin-left:1px">2</sup></span>
        </a>
        <ul class="nav-links">
          <li><a href="${isLanding ? "" : base}#mission">Mission</a></li>
          <li><a href="${isLanding ? "" : base}#goals">Compatibility</a></li>
          <li><a href="${isLanding ? "" : base}#how-it-works">How it works</a></li>
          <li><a href="${isLanding ? "" : base}#roadmap">Roadmap</a></li>
          <li><a href="${base}dashboard/">Progress</a></li>
        </ul>
        <div class="nav-actions">
          <a class="btn-outline" href="https://github.com/loopdive/js2wasm">
            <span class="btn-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" focusable="false">
                <path d="M8 0C3.58 0 0 3.67 0 8.2c0 3.63 2.29 6.71 5.47 7.8.4.08.55-.18.55-.4 0-.2-.01-.87-.01-1.58-2.01.38-2.53-.5-2.69-.96-.09-.24-.48-.96-.82-1.15-.28-.16-.68-.56-.01-.57.63-.01 1.08.59 1.23.83.72 1.24 1.87.89 2.33.68.07-.54.28-.89.51-1.09-1.78-.21-3.64-.92-3.64-4.09 0-.91.32-1.66.84-2.25-.08-.21-.37-1.07.08-2.22 0 0 .69-.23 2.26.86A7.6 7.6 0 0 1 8 3.58c.68 0 1.37.09 2.01.27 1.57-1.09 2.26-.86 2.26-.86.45 1.15.16 2.01.08 2.22.52.59.84 1.34.84 2.25 0 3.18-1.87 3.88-3.65 4.09.29.26.54.75.54 1.52 0 1.1-.01 1.98-.01 2.25 0 .22.14.49.55.4A8.21 8.21 0 0 0 16 8.2C16 3.67 12.42 0 8 0Z"></path>
              </svg>
            </span>
            <span>GitHub</span>
          </a>
          <a class="btn-solid" href="${base}playground/">Playground</a>
        </div>
        <button class="burger" aria-label="Toggle menu">
          <span></span><span></span><span></span>
        </button>
      </nav>
      <div class="mobile-panel">
        <ul>
          <li><a href="${isLanding ? "" : base}#mission">Mission</a></li>
          <li><a href="${isLanding ? "" : base}#goals">Compatibility</a></li>
          <li><a href="${isLanding ? "" : base}#how-it-works">How it works</a></li>
          <li><a href="${isLanding ? "" : base}#roadmap">Roadmap</a></li>
          <li><a href="${base}dashboard/">Progress</a></li>
        </ul>
        <div class="mobile-actions">
          <a class="btn-outline" href="https://github.com/loopdive/js2wasm">
            <span class="btn-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" focusable="false">
                <path d="M8 0C3.58 0 0 3.67 0 8.2c0 3.63 2.29 6.71 5.47 7.8.4.08.55-.18.55-.4 0-.2-.01-.87-.01-1.58-2.01.38-2.53-.5-2.69-.96-.09-.24-.48-.96-.82-1.15-.28-.16-.68-.56-.01-.57.63-.01 1.08.59 1.23.83.72 1.24 1.87.89 2.33.68.07-.54.28-.89.51-1.09-1.78-.21-3.64-.92-3.64-4.09 0-.91.32-1.66.84-2.25-.08-.21-.37-1.07.08-2.22 0 0 .69-.23 2.26.86A7.6 7.6 0 0 1 8 3.58c.68 0 1.37.09 2.01.27 1.57-1.09 2.26-.86 2.26-.86.45 1.15.16 2.01.08 2.22.52.59.84 1.34.84 2.25 0 3.18-1.87 3.88-3.65 4.09.29.26.54.75.54 1.52 0 1.1-.01 1.98-.01 2.25 0 .22.14.49.55.4A8.21 8.21 0 0 0 16 8.2C16 3.67 12.42 0 8 0Z"></path>
              </svg>
            </span>
            <span>GitHub</span>
          </a>
          <a class="btn-solid" href="${base}playground/">Playground</a>
        </div>
      </div>
    `;

    // Wire up burger toggle
    this.shadowRoot.querySelector(".burger").addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggle();
    });

    // Close on link click in mobile panel
    this.shadowRoot.querySelectorAll(".mobile-panel a").forEach((a) => {
      a.addEventListener("click", () => this._close());
    });
  }
}

customElements.define("site-nav", SiteNav);
