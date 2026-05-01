class Foo {
  a = 1;
  b = "x";
  c = [1, 2, 3];
}
const f = new Foo();
console.log(f.a);
console.log(f.b);
console.log(f.c.join(","));
