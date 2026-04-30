const k = "dynamic";
const o = { [k]: 1, [`${k}2`]: 2 };
console.log(o.dynamic);
console.log(o.dynamic2);
