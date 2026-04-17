export const benchmark = {
  id: "fib-recursive",
  label: "Fibonacci recursion",
  coldArg: 10,
  runtimeArg: 30,
  coldRuns: 7,
  runtimeRuns: 5,
};

/** @param {number} n @returns {number} */
function fib(n) {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

/** @param {number} n @returns {number} */
export function run(n) {
  return fib(n);
}
