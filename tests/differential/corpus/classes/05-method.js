class Math2 {
  square(x) {
    return x * x;
  }
  cube(x) {
    return x * x * x;
  }
}
const m = new Math2();
console.log(m.square(4));
console.log(m.cube(3));
