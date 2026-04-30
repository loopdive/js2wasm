const t = { a: 1 };
const r = Object.assign(t, { b: 2 }, { c: 3 });
console.log(Object.keys(r).join(","));
console.log(r === t);
