console.log([1, [2, [3, [4]]]].flat().join(","));
console.log([1, [2, [3, [4]]]].flat(Infinity).join(","));
console.log([1, 2, 3].flatMap((x) => [x, x * 2]).join(","));
