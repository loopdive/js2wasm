import { addBenchCard, el } from "./helpers.ts";

export function bench_style(): number {
  const host = document.body;
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

export function main(): void {
  const host = document.body;
  host.innerHTML = "";
  host.style.cssText = "margin:0;background:#111;color:#ddd;" + "font-family:system-ui,sans-serif;overflow-y:auto";
  const wrap = el("div", "padding:0.75rem");
  addBenchCard(wrap, "Style: 100 updates", "Host boundary — style.background per iteration", bench_style);
  host.appendChild(wrap);
}
