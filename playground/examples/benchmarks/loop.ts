import { addBenchCard, el } from "./helpers.ts";

export function bench_loop(): number {
  let s = 0;
  for (let i = 0; i < 1000000; i++) s = s + i;
  return s;
}

export function main(): void {
  const host = document.body;
  host.innerHTML = "";
  host.style.cssText = "margin:0;background:#111;color:#ddd;" + "font-family:system-ui,sans-serif;overflow-y:auto";
  const wrap = el("div", "padding:0.75rem");
  addBenchCard(wrap, "Loop: sum 1..1M", "Tight numeric loop, no allocations", bench_loop);
  host.appendChild(wrap);
}
