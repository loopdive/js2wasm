export function el(tag: string, css: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  return e;
}

export function bcrd(title: string, desc: string, parent: HTMLElement): HTMLElement {
  const card = el("div",
    "padding:0.75rem;background:#1a1a35;" +
    "border-radius:6px;border:1px solid #2a2a4a;" +
    "margin-bottom:0.5rem;cursor:pointer");
  const t = el("div", "font-size:0.8rem;color:#fff;font-weight:bold");
  t.textContent = title;
  card.appendChild(t);
  const d = el("div", "font-size:0.7rem;color:#666;margin:2px 0 6px");
  d.textContent = desc;
  card.appendChild(d);
  const out = el("div", "font-size:0.75rem;color:#888");
  out.textContent = "tap to run";
  card.appendChild(out);
  parent.appendChild(card);
  return card;
}

export function addBenchCard(wrap: HTMLElement, title: string, desc: string, fn: () => number): void {
  const card = bcrd(title, desc, wrap);
  card.addEventListener("click", () => {
    const t0 = performance.now();
    const v = fn();
    const ms = performance.now() - t0;
    const out = card.children[2];
    out.textContent = v.toString() + " in " + ms.toFixed(2) + "ms";
  });
}
