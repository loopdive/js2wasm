const a = [1, 2, 3];
const b = [...a, 4, 5];
console.log(b.join(","));
const [first, ...rest] = b;
console.log(first);
console.log(rest.join(","));
