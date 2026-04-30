const re = /[a-z]+/i;
console.log(re.test("Hello"));
console.log("hello world".match(/\w+/g).join(","));
console.log("a1b2c3".replace(/\d/g, "*"));
