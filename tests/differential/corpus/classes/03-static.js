class Counter {
  static n = 0;
  static inc() {
    return ++Counter.n;
  }
}
console.log(Counter.inc());
console.log(Counter.inc());
console.log(Counter.n);
