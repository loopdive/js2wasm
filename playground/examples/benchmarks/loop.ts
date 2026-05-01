import { addBenchCard, el } from "./helpers.ts";

export function bench_loop(): number {
  let s = 0;
  for (let i = 0; i < 1000000; i++) s = (s + i) | 0;
  return s;
}

export function main(): void {
  const host = document.body;
  host.innerHTML = "";
  host.style.cssText = "margin:0;background:#111;color:#ddd;" + "font-family:system-ui,sans-serif;overflow-y:auto";
  const wrap = el("div", "padding:0.75rem");
  addBenchCard(wrap, "Loop: 1M Int32 sum", "Tight i32 loop with explicit | 0 wrap, no allocations", bench_loop);
  host.appendChild(wrap);
}
