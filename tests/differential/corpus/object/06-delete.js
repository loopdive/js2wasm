const o = { a: 1, b: 2 };
delete o.a;
console.log(Object.keys(o).join(","));
console.log(o.a);
