const a = { x: 1, y: 2 };
const b = { ...a, z: 3 };
console.log(Object.keys(b).join(","));
console.log(b.x);
console.log(b.z);
