const a = [1, 2, 3, 4];
console.log(a.reduce((acc, x) => acc + x, 0));
console.log(a.reduce((acc, x) => acc * x, 1));
console.log(["a", "b", "c"].reduce((s, c) => s + c, ""));
