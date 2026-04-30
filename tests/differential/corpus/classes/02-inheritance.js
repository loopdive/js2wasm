class Animal {
  constructor(name) {
    this.name = name;
  }
  describe() {
    return this.name;
  }
}
class Dog extends Animal {
  describe() {
    return "dog " + super.describe();
  }
}
console.log(new Dog("rex").describe());
