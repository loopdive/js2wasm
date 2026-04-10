export function bench_style() {
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
export function main() {
    const host = document.body;
    host.innerHTML = "";
    host.style.cssText = "margin:0;background:#111;color:#ddd;" + "font-family:system-ui,sans-serif;overflow-y:auto";
    const wrap = el("div", "padding:0.75rem");
    addBenchCard(wrap, "Style: 100 updates", "Host boundary — style.background per iteration", bench_style);
    host.appendChild(wrap);
}
export function el(tag, css) {
    const e = document.createElement(tag);
    e.style.cssText = css;
    return e;
}
export function bcrd(title, desc, parent) {
    const card = el("div", "padding:0.75rem;background:#1a1a35;" +
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
export function addBenchCard(wrap, title, desc, fn) {
    const card = bcrd(title, desc, wrap);
    card.addEventListener("click", () => {
        const t0 = performance.now();
        const v = fn();
        const ms = performance.now() - t0;
        const out = card.children[2];
        out.textContent = v.toString() + " in " + ms.toFixed(2) + "ms";
    });
}
