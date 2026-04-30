class Greeter {
  hello(name) {
    return "hi " + name;
  }
}
const g = new Greeter();
console.log(g.hello("world"));
console.log(Greeter.prototype.hello.call(g, "test"));
