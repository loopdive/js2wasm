// ═══════════════════════════════════════════════════════
// JS Builtins — showcase of wasm:js-string, Math, Arrays
// ═══════════════════════════════════════════════════════

function el(tag: string, css: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  return e;
}

function crd(title: string, parent: HTMLElement): HTMLElement {
  const c = el("div",
    "padding:0.5rem 0.75rem;background:#1a1a35;" +
    "border-radius:6px;border:1px solid #2a2a4a;" +
    "margin-bottom:0.5rem");
  const t = el("div", "font-size:0.8rem;color:#7c3aed;font-weight:bold;margin-bottom:4px");
  t.textContent = title;
  c.appendChild(t);
  parent.appendChild(c);
  return c;
}

function rw(label: string, value: string, parent: HTMLElement): void {
  const r = el("div",
    "display:flex;justify-content:space-between;" +
    "font-size:0.7rem;padding:1px 0");
  const l = el("span", "color:#888");
  l.textContent = label;
  const v = el("span", "color:#ddd;font-family:monospace");
  v.textContent = value;
  r.appendChild(l);
  r.appendChild(v);
  parent.appendChild(r);
}

export function main(): void {
  const host = document.getElementById("preview-panel")!;
  host.innerHTML = "";
  host.style.cssText =
    "margin:0;background:#111;color:#ddd;" +
    "font-family:system-ui,sans-serif;overflow-y:auto";

  const wrap = el("div", "padding:0.75rem");

  // Math
  const m = crd("Math", wrap);
  rw("Math.pow(2, 10)", Math.pow(2, 10).toString(), m);
  rw("Math.sqrt(144)", Math.sqrt(144).toString(), m);
  rw("Math.log2(1024)", Math.log2(1024).toFixed(1), m);
  rw("Math.sin(3.14159/2)", Math.sin(3.14159 / 2).toFixed(6), m);
  rw("Math.cos(0)", Math.cos(0).toString(), m);
  rw("Math.atan2(1, 1)", Math.atan2(1, 1).toFixed(6), m);
  rw("Math.exp(1)", Math.exp(1).toFixed(6), m);
  rw("Math.log(Math.exp(1))", Math.log(Math.exp(1)).toFixed(6), m);

  // Strings
  const s = crd("Strings", wrap);
  const hello = "Hello, WebAssembly!";
  rw("length", hello.length.toString(), s);
  rw("toUpperCase()", hello.toUpperCase(), s);
  rw("toLowerCase()", hello.toLowerCase(), s);
  rw("slice(0, 5)", hello.slice(0, 5), s);
  rw("indexOf('Wasm')", hello.indexOf("Wasm").toString(), s);
  rw("includes('Assembly')", hello.includes("Assembly") ? "true" : "false", s);
  rw("replace('Hello','Hi')", hello.replace("Hello", "Hi"), s);
  rw("trim('  hi  ')", "  hi  ".trim(), s);

  // Arrays
  const a = crd("Arrays", wrap);
  const arr: number[] = [];
  for (let i = 0; i < 5; i++) arr.push((i + 1) * 10);
  let arrStr = "";
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) arrStr = arrStr + ",";
    arrStr = arrStr + arr[i].toString();
  }
  rw("arr", "[" + arrStr + "]", a);
  rw("arr.length", arr.length.toString(), a);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum = sum + arr[i];
  rw("sum(arr)", sum.toString(), a);

  // Bitwise
  const b = crd("Bitwise", wrap);
  rw("0xFF << 8", (0xFF << 8).toString(), b);
  rw("0xABCD & 0xFF", (0xABCD & 0xFF).toString(), b);
  rw("0x55 | 0xAA", (0x55 | 0xAA).toString(), b);
  rw("0xFF ^ 0x0F", (0xFF ^ 0x0F).toString(), b);
  rw("~0", (~0).toString(), b);

  host.appendChild(wrap);
}
