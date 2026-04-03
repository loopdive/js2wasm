// Browser shim for Node.js "path" module.
// Only implements the subset used by the compiler bundle.

export function resolve(...segments) {
  const parts = [];
  for (const seg of segments) {
    if (seg.startsWith("/")) {
      parts.length = 0;
    }
    parts.push(...seg.split("/").filter(Boolean));
  }
  return "/" + parts.join("/");
}

export function dirname(p) {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function basename(p, ext) {
  let base = p.slice(p.lastIndexOf("/") + 1);
  if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
  return base;
}

export function extname(p) {
  const base = basename(p);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i);
}

export function join(...segments) {
  return segments.filter(Boolean).join("/").replace(/\/+/g, "/");
}

export function relative(from, to) {
  const a = from.split("/").filter(Boolean);
  const b = to.split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = Array(a.length - i).fill("..");
  return [...up, ...b.slice(i)].join("/") || ".";
}

export function isAbsolute(p) {
  return p.startsWith("/");
}

export const sep = "/";
export const delimiter = ":";
export const posix = { resolve, dirname, basename, extname, join, relative, isAbsolute, sep, delimiter };

export default { resolve, dirname, basename, extname, join, relative, isAbsolute, sep, delimiter, posix };
