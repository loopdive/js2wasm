import { addBenchCard, el } from "./helpers.ts";

export function bench_array(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  let total = 0;
  for (let i = 0; i < arr.length; i++) total = total + arr[i];
  return total;
}

export function main(): void {
  const host = document.body;
  host.innerHTML = "";
  host.style.cssText =
    "margin:0;background:#111;color:#ddd;" +
    "font-family:system-ui,sans-serif;overflow-y:auto";
  const wrap = el("div", "padding:0.75rem");
  addBenchCard(wrap, "Array: fill+sum 10k", "Wasm GC array — push / get loop", bench_array);
  host.appendChild(wrap);
}
