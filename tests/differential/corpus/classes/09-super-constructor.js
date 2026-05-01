class A {
  constructor(x) {
    this.x = x;
  }
}
class B extends A {
  constructor(x, y) {
    super(x);
    this.y = y;
  }
}
const b = new B(1, 2);
console.log(b.x + "," + b.y);
