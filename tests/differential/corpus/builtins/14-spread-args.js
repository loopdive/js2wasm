function sum(...nums) {
  return nums.reduce((a, b) => a + b, 0);
}
console.log(sum(1, 2, 3, 4));
console.log(sum(...[10, 20, 30]));
console.log(Math.max(...[1, 5, 3]));
