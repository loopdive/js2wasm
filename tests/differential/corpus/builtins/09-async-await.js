async function f() {
  const a = await Promise.resolve(10);
  const b = await Promise.resolve(20);
  return a + b;
}
f().then((v) => console.log(v));
