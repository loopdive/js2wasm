function* range(n) {
  for (let i = 0; i < n; i++) yield i;
}
const out = [];
for (const x of range(5)) out.push(x);
console.log(out.join(","));
