function makeAdder(n) {
  return function (x) {
    return x + n;
  };
}
const add5 = makeAdder(5);
console.log(add5(3));
console.log(add5(10));
