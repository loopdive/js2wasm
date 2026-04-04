import { addBenchCard, el } from "./helpers.ts";

export function bench_dom(): number {
  const host = document.body;
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

export function main(): void {
  const host = document.body;
  host.innerHTML = "";
  host.style.cssText = "margin:0;background:#111;color:#ddd;" + "font-family:system-ui,sans-serif;overflow-y:auto";
  const wrap = el("div", "padding:0.75rem");
  addBenchCard(wrap, "DOM: 100 elements", "Host boundary — createElement + appendChild", bench_dom);
  host.appendChild(wrap);
}
