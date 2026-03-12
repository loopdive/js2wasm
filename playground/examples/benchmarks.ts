// ═══════════════════════════════════════════════════════
// Benchmarks — measure WASM execution speed
// ═══════════════════════════════════════════════════════

function el(tag: string, css: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  return e;
}

export function fib(n: number): number {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

export function bench_fib(): number {
  return fib(30);
}

export function bench_loop(): number {
  let s = 0;
  for (let i = 0; i < 1000000; i++) s = s + i;
  return s;
}

export function bench_dom(): number {
  const host = document.getElementById("preview-panel")!;
  const box = document.createElement("div");
  box.style.cssText = "display:none";
  host.appendChild(box);
  for (let i = 0; i < 100; i++) {
    const d = document.createElement("span");
    d.textContent = i.toString();
    box.appendChild(d);
  }
  host.removeChild(box);
  return 100;
}

export function bench_string(): number {
  let str = "";
  for (let i = 0; i < 1000; i++) str = str + "abcde";
  return str.length;
}

export function bench_array(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  let total = 0;
  for (let i = 0; i < arr.length; i++) total = total + arr[i];
  return total;
}

export function bench_style(): number {
  const host = document.getElementById("preview-panel")!;
  const box = document.createElement("div");
  box.style.cssText = "width:1px;height:1px;position:fixed;top:-9px";
  host.appendChild(box);
  for (let i = 0; i < 100; i++) {
    const r = (i * 7) & 255;
    const g = (i * 13) & 255;
    box.style.background = "rgb(" + r.toString() + "," + g.toString() + ",128)";
  }
  host.removeChild(box);
  return 100;
}

function bcrd(title: string, desc: string, parent: HTMLElement): HTMLElement {
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

function addBenchCard(wrap: HTMLElement, title: string, desc: string, fn: () => number): void {
  const card = bcrd(title, desc, wrap);
  card.addEventListener("click", () => {
    const t0 = performance.now();
    const v = fn();
    const ms = performance.now() - t0;
    const out = card.children[2];
    out.textContent = v.toString() + " in " + ms.toFixed(2) + "ms";
  });
}

export function main(): void {
  const host = document.getElementById("preview-panel")!;
  host.innerHTML = "";
  host.style.cssText =
    "margin:0;background:#111;color:#ddd;" +
    "font-family:system-ui,sans-serif;overflow-y:auto";

  const wrap = el("div", "padding:0.75rem");

  const intro = el("div",
    "font-size:0.75rem;color:#777;margin-bottom:0.75rem;line-height:1.5");
  intro.textContent =
    "Each benchmark runs inside the Wasm sandbox. " +
    "Click a card to measure.";
  wrap.appendChild(intro);

  addBenchCard(wrap, "fib(30)", "Recursive — pure i32/f64 math, no host calls", bench_fib);
  addBenchCard(wrap, "Loop: sum 1..1M", "Tight numeric loop, no allocations", bench_loop);
  addBenchCard(wrap, "DOM: 100 elements", "Host boundary — createElement + appendChild", bench_dom);
  addBenchCard(wrap, "String: concat 1k", "wasm:js-string concat per iteration", bench_string);
  addBenchCard(wrap, "Array: fill+sum 10k", "Wasm GC array — push / get loop", bench_array);
  addBenchCard(wrap, "Style: 100 updates", "Host boundary — style.background per iteration", bench_style);

  host.appendChild(wrap);
}
