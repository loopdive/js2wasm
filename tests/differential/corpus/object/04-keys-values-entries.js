const o = { a: 1, b: 2 };
console.log(Object.keys(o).join(","));
console.log(Object.values(o).join(","));
console.log(
  Object.entries(o)
    .map((e) => e[0] + "=" + e[1])
    .join(","),
);
