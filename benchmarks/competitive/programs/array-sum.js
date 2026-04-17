export const benchmark = {
  id: "array-sum",
  label: "Array fill + sum",
  coldArg: 2000,
  runtimeArg: 1000000,
  coldRuns: 7,
  runtimeRuns: 5,
};

/** @param {number} n @returns {number} */
export function run(n) {
  const values = [];
  for (let i = 0; i < n; i++) {
    values[i] = ((i * 17) ^ (i >>> 3)) & 1023;
  }

  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum = (sum + values[i]) | 0;
  }
  return sum | 0;
}
