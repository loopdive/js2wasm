const buf = new ArrayBuffer(4);
const view = new DataView(buf);
view.setInt32(0, 0x12345678, false);
console.log(view.getInt32(0, false).toString(16));
console.log(view.getUint8(0));
