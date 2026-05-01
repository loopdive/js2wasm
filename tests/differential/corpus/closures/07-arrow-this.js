function f() {
  this.x = 10;
  const g = () => this.x;
  return g();
}
console.log(f.call({}));
