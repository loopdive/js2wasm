export class WasmEncoder {
  private buf: number[] = [];

  byte(b: number): void {
    this.buf.push(b & 0xff);
  }

  bytes(bs: number[] | Uint8Array): void {
    for (const b of bs) this.byte(b);
  }

  /** Unsigned LEB128 */
  u32(value: number): void {
    do {
      let b = value & 0x7f;
      value >>>= 7;
      if (value !== 0) b |= 0x80;
      this.byte(b);
    } while (value !== 0);
  }

  /** Signed LEB128 */
  i32(value: number): void {
    let more = true;
    while (more) {
      let b = value & 0x7f;
      value >>= 7;
      if (
        (value === 0 && (b & 0x40) === 0) ||
        (value === -1 && (b & 0x40) !== 0)
      ) {
        more = false;
      } else {
        b |= 0x80;
      }
      this.byte(b);
    }
  }

  /** Signed LEB128 i64 — truncate to 64 bits to prevent overflow */
  i64(value: bigint): void {
    value = BigInt.asIntN(64, value);
    let more = true;
    while (more) {
      let b = Number(value & 0x7fn);
      value >>= 7n;
      if (
        (value === 0n && (b & 0x40) === 0) ||
        (value === -1n && (b & 0x40) !== 0)
      ) {
        more = false;
      } else {
        b |= 0x80;
      }
      this.byte(b);
    }
  }

  /** IEEE 754 f64 little-endian */
  f64(value: number): void {
    const buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = value;
    this.bytes(new Uint8Array(buf));
  }

  /** IEEE 754 f32 little-endian */
  f32(value: number): void {
    const buf = new ArrayBuffer(4);
    new Float32Array(buf)[0] = value;
    this.bytes(new Uint8Array(buf));
  }

  /** v128 constant — 16 bytes little-endian */
  v128(bytes: Uint8Array): void {
    if (bytes.length !== 16) throw new Error("v128 must be exactly 16 bytes");
    this.bytes(bytes);
  }

  /** UTF-8 string with length prefix */
  name(s: string): void {
    const encoded = new TextEncoder().encode(s);
    this.u32(encoded.length);
    this.bytes(encoded);
  }

  /** Section: id + length-prefixed content */
  section(id: number, content: (enc: WasmEncoder) => void): void {
    const sub = new WasmEncoder();
    content(sub);
    const data = sub.finish();
    this.byte(id);
    this.u32(data.length);
    this.bytes(data);
  }

  /** Vector: u32 count + items */
  vector<T>(
    items: T[],
    encode: (item: T, enc: WasmEncoder) => void,
  ): void {
    this.u32(items.length);
    for (const item of items) encode(item, this);
  }

  /** Get current buffer length */
  get length(): number {
    return this.buf.length;
  }

  /** Get current write position (alias for length, used by relocation tracking) */
  get position(): number {
    return this.buf.length;
  }

  finish(): Uint8Array {
    return new Uint8Array(this.buf);
  }
}
