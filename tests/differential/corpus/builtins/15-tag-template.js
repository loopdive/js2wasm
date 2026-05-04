function tag(strs, ...vals) {
  return strs.join("|") + "::" + vals.join(",");
}
console.log(tag`hello ${1} world ${2}`);
