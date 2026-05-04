function makePair() {
  let n = 0;
  return {
    get: () => n,
    inc: () => {
      n++;
    },
  };
}
const p = makePair();
p.inc();
p.inc();
console.log(p.get());
