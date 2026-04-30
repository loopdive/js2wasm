function outer() {
  let a = 1;
  return function () {
    let b = 2;
    return function () {
      return a + b;
    };
  };
}
console.log(outer()()());
