class Box {
  constructor() {
    this._v = 0;
  }
  get value() {
    return this._v;
  }
  set value(x) {
    this._v = x * 2;
  }
}
const b = new Box();
b.value = 5;
console.log(b.value);
