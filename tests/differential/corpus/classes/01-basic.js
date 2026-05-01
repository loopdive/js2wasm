class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  toString() {
    return this.x + "," + this.y;
  }
}
const p = new Point(3, 4);
console.log(p.toString());
