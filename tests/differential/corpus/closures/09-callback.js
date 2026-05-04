function apply(arr, fn) {
  const out = [];
  for (let i = 0; i < arr.length; i++) out.push(fn(arr[i], i));
  return out;
}
console.log(apply([1, 2, 3], (x) => x * x).join(","));
