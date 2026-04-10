// ═══════════════════════════════════════════════════════
// Booking Calendar — date picker with price grid
// ═══════════════════════════════════════════════════════
// Rendered entirely by WebAssembly. The host browser
// provides DOM APIs via imports; all logic, layout, and
// event handling runs inside the Wasm sandbox.
function el(tag, css) {
    const e = document.createElement(tag);
    e.style.cssText = css;
    return e;
}
function mname(m) {
    if (m === 0)
        return "Jan";
    if (m === 1)
        return "Feb";
    if (m === 2)
        return "Mar";
    if (m === 3)
        return "Apr";
    if (m === 4)
        return "May";
    if (m === 5)
        return "Jun";
    if (m === 6)
        return "Jul";
    if (m === 7)
        return "Aug";
    if (m === 8)
        return "Sep";
    if (m === 9)
        return "Oct";
    if (m === 10)
        return "Nov";
    return "Dec";
}
function dimOf(y, m) {
    if (m === 1) {
        if (y % 400 === 0)
            return 29;
        if (y % 100 === 0)
            return 28;
        if (y % 4 === 0)
            return 29;
        return 28;
    }
    if (m === 3 || m === 5 || m === 8 || m === 10)
        return 30;
    return 31;
}
function fdow(y, m) {
    const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let yr = y;
    if (m < 2)
        yr = yr - 1;
    const d = (yr + ((yr / 4) | 0) - ((yr / 100) | 0) + ((yr / 400) | 0) + t[m] + 1) % 7;
    return (d + 6) % 7;
}
// Deterministic price 100-950
function priceOf(y, m, d) {
    const h = ((y * 373 + m * 631 + d * 997) & 0x7fffffff) % 18;
    return (h + 2) * 50;
}
let curYear = new Date().getFullYear();
let curMonth = new Date().getMonth();
let selStart = -1;
let selEnd = -1;
let gridEl = null;
let monthEl = null;
let yearEl = null;
let nightsEl = null;
let totalEl = null;
function renderCal() {
    if (gridEl === null)
        return;
    gridEl.innerHTML = "";
    const offset = fdow(curYear, curMonth);
    const days = dimOf(curYear, curMonth);
    const prevM = curMonth === 0 ? 11 : curMonth - 1;
    const prevY = curMonth === 0 ? curYear - 1 : curYear;
    const prevDays = dimOf(prevY, prevM);
    for (let i = 0; i < offset; i++) {
        const d = prevDays - offset + 1 + i;
        const cell = el("div", "padding:8px 4px;text-align:center;font-size:0.8rem;" + "color:#555;font-style:italic");
        const dn = el("div", "font-weight:bold");
        dn.textContent = d.toString();
        cell.appendChild(dn);
        const pr = el("div", "font-size:0.6rem;margin-top:2px");
        pr.textContent = priceOf(prevY, prevM, d).toString() + " \u20AC";
        cell.appendChild(pr);
        gridEl.appendChild(cell);
    }
    const now = new Date();
    const todayD = now.getDate();
    const todayM = now.getMonth();
    const todayY = now.getFullYear();
    for (let d = 1; d <= days; d++) {
        let bg = "transparent";
        let fg = "#ddd";
        let border = "2px solid transparent";
        let priceFg = "#aaa";
        const isToday = d === todayD && curMonth === todayM && curYear === todayY;
        const inRange = selStart > 0 && selEnd > 0 && d >= selStart && d <= selEnd;
        if (inRange) {
            bg = "#333";
        }
        if (d === selStart) {
            bg = "#fff";
            fg = "#111";
            priceFg = "#666";
        }
        if (d === selEnd && selEnd !== selStart) {
            bg = "#fff";
            fg = "#111";
            priceFg = "#666";
        }
        if (isToday && bg === "transparent") {
            bg = "#7c3aed";
            fg = "#fff";
            priceFg = "rgba(255,255,255,0.6)";
        }
        if (isToday && bg !== "#7c3aed") {
            border = "2px solid #7c3aed";
        }
        const cell = el("div", "padding:6px 4px;text-align:center;font-size:0.8rem;" +
            "cursor:pointer;border-radius:4px;" +
            "background:" +
            bg +
            ";color:" +
            fg +
            ";" +
            "border:" +
            border +
            ";transition:background 0.1s");
        const dn = el("div", "font-weight:bold");
        dn.textContent = d.toString();
        cell.appendChild(dn);
        const pr = el("div", "font-size:0.6rem;margin-top:2px;color:" + priceFg);
        pr.textContent = priceOf(curYear, curMonth, d).toString() + " \u20AC";
        cell.appendChild(pr);
        const day = d;
        const cellBg = bg;
        cell.addEventListener("click", () => {
            onDay(day);
        });
        cell.addEventListener("mouseenter", () => {
            if (cellBg === "transparent")
                cell.style.background = "#222";
        });
        cell.addEventListener("mouseleave", () => {
            if (cellBg === "transparent")
                cell.style.background = "transparent";
        });
        gridEl.appendChild(cell);
    }
    const total = offset + days;
    const rem = total % 7 === 0 ? 0 : 7 - (total % 7);
    const nextM = curMonth === 11 ? 0 : curMonth + 1;
    const nextY = curMonth === 11 ? curYear + 1 : curYear;
    for (let i = 1; i <= rem; i++) {
        const cell = el("div", "padding:8px 4px;text-align:center;font-size:0.8rem;" + "color:#555;font-style:italic");
        const dn = el("div", "font-weight:bold");
        dn.textContent = i.toString();
        cell.appendChild(dn);
        const pr = el("div", "font-size:0.6rem;margin-top:2px");
        pr.textContent = priceOf(nextY, nextM, i).toString() + " \u20AC";
        cell.appendChild(pr);
        gridEl.appendChild(cell);
    }
    if (monthEl !== null)
        monthEl.textContent = mname(curMonth);
    if (yearEl !== null)
        yearEl.textContent = curYear.toString();
}
function onDay(d) {
    if (selStart < 0) {
        selStart = d;
        selEnd = -1;
    }
    else if (selEnd < 0) {
        if (d > selStart)
            selEnd = d;
        else if (d < selStart) {
            selEnd = selStart;
            selStart = d;
        }
        else {
            selStart = -1;
            selEnd = -1;
        }
    }
    else {
        selStart = d;
        selEnd = -1;
    }
    updFoot();
    renderCal();
}
function updFoot() {
    if (selStart > 0 && selEnd > 0) {
        const n = selEnd - selStart;
        let sum = 0;
        for (let i = selStart; i < selEnd; i++) {
            sum = sum + priceOf(curYear, curMonth, i);
        }
        if (nightsEl !== null)
            nightsEl.textContent = n.toString() + " nights";
        if (totalEl !== null)
            totalEl.textContent = sum.toString() + " \u20AC";
    }
    else {
        if (nightsEl !== null)
            nightsEl.textContent = "0 nights";
        if (totalEl !== null)
            totalEl.textContent = "";
    }
}
export function main() {
    const host = document.body;
    host.innerHTML = "";
    host.style.cssText = "margin:0;background:#111;color:#ddd;" + "font-family:system-ui,sans-serif;overflow:hidden";
    const wrap = el("div", "padding:1rem;max-width:420px;margin:0 auto");
    const hdr = el("div", "display:flex;justify-content:space-between;align-items:baseline;" + "margin-bottom:0.5rem");
    monthEl = el("div", "font-size:3.5rem;font-weight:bold;color:#fff;line-height:1");
    yearEl = el("div", "font-size:1.1rem;color:#888");
    hdr.appendChild(monthEl);
    hdr.appendChild(yearEl);
    wrap.appendChild(hdr);
    const dayNames = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
    const wh = el("div", "display:grid;grid-template-columns:repeat(7,1fr);" +
        "text-align:center;font-size:0.6rem;color:#666;margin-bottom:4px");
    for (let i = 0; i < 7; i++) {
        const c = el("div", "padding:2px");
        c.textContent = dayNames[i];
        wh.appendChild(c);
    }
    wrap.appendChild(wh);
    gridEl = el("div", "display:grid;grid-template-columns:repeat(7,1fr);gap:2px");
    wrap.appendChild(gridEl);
    const wh2 = el("div", "display:grid;grid-template-columns:repeat(7,1fr);" +
        "text-align:center;font-size:0.6rem;color:#666;margin-top:4px");
    for (let i = 0; i < 7; i++) {
        const c = el("div", "padding:2px");
        c.textContent = dayNames[i];
        wh2.appendChild(c);
    }
    wrap.appendChild(wh2);
    const nav = el("div", "display:flex;justify-content:space-between;margin:0.75rem 0");
    const prev = el("div", "cursor:pointer;font-size:1.2rem;color:#888;padding:4px 12px");
    prev.textContent = "\u2190";
    prev.addEventListener("click", () => {
        if (curMonth === 0) {
            curMonth = 11;
            curYear = curYear - 1;
        }
        else {
            curMonth = curMonth - 1;
        }
        selStart = -1;
        selEnd = -1;
        updFoot();
        renderCal();
    });
    const next = el("div", "cursor:pointer;font-size:1.2rem;color:#888;padding:4px 12px");
    next.textContent = "\u2192";
    next.addEventListener("click", () => {
        if (curMonth === 11) {
            curMonth = 0;
            curYear = curYear + 1;
        }
        else {
            curMonth = curMonth + 1;
        }
        selStart = -1;
        selEnd = -1;
        updFoot();
        renderCal();
    });
    nav.appendChild(prev);
    nav.appendChild(next);
    wrap.appendChild(nav);
    const foot1 = el("div", "display:flex;align-items:center;justify-content:space-between;" + "margin-top:0.75rem;font-size:0.85rem");
    const clr = el("span", "color:#888;cursor:pointer;text-decoration:underline");
    clr.textContent = "Clear Dates";
    clr.addEventListener("click", () => {
        selStart = -1;
        selEnd = -1;
        updFoot();
        renderCal();
    });
    foot1.appendChild(clr);
    nightsEl = el("span", "color:#aaa");
    nightsEl.textContent = "0 nights";
    foot1.appendChild(nightsEl);
    wrap.appendChild(foot1);
    const foot2 = el("div", "display:flex;align-items:center;justify-content:space-between;" + "margin-top:0.5rem");
    totalEl = el("div", "color:#fff;font-weight:bold;font-size:2rem");
    totalEl.textContent = "";
    foot2.appendChild(totalEl);
    const saveBtn = el("div", "padding:8px 28px;background:#fff;color:#111;" +
        "border-radius:999px;cursor:pointer;font-size:0.9rem;font-weight:600");
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => {
        console.log("saved " + selStart.toString() + "-" + selEnd.toString());
    });
    foot2.appendChild(saveBtn);
    wrap.appendChild(foot2);
    host.appendChild(wrap);
    renderCal();
}
