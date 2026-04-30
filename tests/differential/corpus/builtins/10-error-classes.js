try {
  throw new TypeError("type problem");
} catch (e) {
  console.log(e instanceof TypeError);
  console.log(e.message);
}
try {
  throw new RangeError("range issue");
} catch (e) {
  console.log(e instanceof RangeError);
}
