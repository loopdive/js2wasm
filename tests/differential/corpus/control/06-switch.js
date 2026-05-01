function f(x) {
  switch (x) {
    case 1:
      return "one";
    case 2:
    case 3:
      return "two-or-three";
    default:
      return "other";
  }
}
console.log(f(1));
console.log(f(2));
console.log(f(3));
console.log(f(99));
