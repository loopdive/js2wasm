function f() {
  try {
    return 1;
  } finally {
    console.log("finally");
  }
}
console.log(f());
