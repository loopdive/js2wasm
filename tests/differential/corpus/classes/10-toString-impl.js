class Money {
  constructor(n) {
    this.n = n;
  }
  toString() {
    return "$" + this.n;
  }
}
console.log("" + new Money(42));
console.log(`val=${new Money(7)}`);
