function bench_string() {
    let str = "";
    for (let i = 0; i < 1000; i++)
        str = str + "abcde";
    return str.length;
}
function main() {
    const host = document.body;
    host.innerHTML = "";
    host.style.cssText = "margin:0;background:#111;color:#ddd;" + "font-family:system-ui,sans-serif;overflow-y:auto";
    const wrap = el("div", "padding:0.75rem");
    addBenchCard(wrap, "String: concat 1k", "wasm:js-string concat per iteration", bench_string);
    host.appendChild(wrap);
}
function el(tag, css) {
    const e = document.createElement(tag);
    e.style.cssText = css;
    return e;
}
function bcrd(title, desc, parent) {
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
function addBenchCard(wrap, title, desc, fn) {
    const card = bcrd(title, desc, wrap);
    card.addEventListener("click", () => {
        const t0 = performance.now();
        const v = fn();
        const ms = performance.now() - t0;
        const out = card.children[2];
        out.textContent = v.toString() + " in " + ms.toFixed(2) + "ms";
    });
}
