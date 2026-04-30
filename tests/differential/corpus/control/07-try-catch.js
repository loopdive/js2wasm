try {
  throw new Error("boom");
} catch (e) {
  console.log("caught:" + e.message);
}
console.log("after");
