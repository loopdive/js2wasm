export const benchmark = {
  id: "object-ops",
  label: "Object field churn",
  coldArg: 1000,
  runtimeArg: 800000,
  coldRuns: 7,
  runtimeRuns: 5,
};

/** @param {number} n @returns {number} */
export function run(n) {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const record = {
      a: i | 0,
      b: (i * 3) | 0,
      c: (i ^ 0x55aa) | 0,
    };
    acc = (acc + record.a + record.b - record.c) | 0;
  }
  return acc | 0;
}
