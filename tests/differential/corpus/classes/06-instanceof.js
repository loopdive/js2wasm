class A {}
class B extends A {}
const b = new B();
console.log(b instanceof B);
console.log(b instanceof A);
console.log(b instanceof Object);
