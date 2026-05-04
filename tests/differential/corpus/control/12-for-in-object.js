const o = { a: 1, b: 2 };
const keys = [];
for (const k in o) keys.push(k);
console.log(keys.sort().join(","));
