function chain(start) {
  let n = start;
  const api = {
    add(x) {
      n += x;
      return api;
    },
    sub(x) {
      n -= x;
      return api;
    },
    val() {
      return n;
    },
  };
  return api;
}
console.log(chain(10).add(5).sub(2).val());
