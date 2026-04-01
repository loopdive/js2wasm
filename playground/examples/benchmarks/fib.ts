import { addBenchCard, el } from "./helpers.ts";

export function fib(n: number): number {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

export function bench_fib(): number {
  return fib(30);
}

export function main(): void {
  const host = document.body;
  host.innerHTML = "";
  host.style.cssText =
    "margin:0;background:#111;color:#ddd;" +
    "font-family:system-ui,sans-serif;overflow-y:auto";
  const wrap = el("div", "padding:0.75rem");
  addBenchCard(wrap, "fib(30)", "Recursive — pure i32/f64 math, no host calls", bench_fib);
  host.appendChild(wrap);
}
