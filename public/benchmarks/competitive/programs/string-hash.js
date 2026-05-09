export const benchmark = {
  id: "string-hash",
  label: "String build + hash",
  coldArg: 100,
  runtimeArg: 20000,
  coldRuns: 7,
  runtimeRuns: 5,
};

/** @param {number} n @returns {number} */
export function run(n) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz012345";
  let text = "";
  for (let i = 0; i < n; i++) {
    const a = (i * 13) & 31;
    const b = (a + 7) & 31;
    text += alphabet.charAt(a);
    text += alphabet.charAt(b);
    text += ";";
  }

  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return hash | 0;
}
