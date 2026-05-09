export const benchmark = {
  id: "fib",
  label: "Fibonacci loop",
  coldArg: 5000,
  runtimeArg: 20000000,
  coldRuns: 7,
  runtimeRuns: 5,
};

/** @param {number} n @returns {number} */
export function run(n) {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) {
    const next = (a + b) | 0;
    a = b;
    b = next;
  }
  return a | 0;
}
