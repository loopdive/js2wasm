import { addBenchCard, el } from "./helpers.ts";

export function bench_string(): number {
  let str = "";
  for (let i = 0; i < 1000; i++) str = str + "abcde";
  return str.length;
}

export function main(): void {
  const host = document.body;
  host.innerHTML = "";
  host.style.cssText =
    "margin:0;background:#111;color:#ddd;" +
    "font-family:system-ui,sans-serif;overflow-y:auto";
  const wrap = el("div", "padding:0.75rem");
  addBenchCard(wrap, "String: concat 1k", "wasm:js-string concat per iteration", bench_string);
  host.appendChild(wrap);
}
