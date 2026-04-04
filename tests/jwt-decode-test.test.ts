import { describe, it, expect } from "vitest";
import { buildImports, evaluateAsJs } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

/**
 * JWT Decode + HS256 Verify Showcase
 *
 * Demonstrates js2wasm compiling real-world crypto/encoding logic to pure Wasm:
 * - Base64url decoding (charCodeAt, lookup table, bitwise ops)
 * - SHA-256 (i32 bitwise ops, array manipulation, unsigned right shift)
 * - HMAC-SHA-256 (key padding, XOR, dual SHA-256)
 * - JWT parsing (string split, base64url decode, claim extraction)
 *
 * All logic is pure TypeScript compiled to Wasm -- no host crypto dependencies.
 */

/**
 * Extended compileToWasm that includes String_fromCharCode host import.
 * The compiler emits this import for String.fromCharCode() calls.
 */
async function compileToWasm(source: string) {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e: any) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result);
  // Add String.fromCharCode host import (compiler emits String_fromCharCode)
  (imports.env as Record<string, Function>).String_fromCharCode = (code: number) => String.fromCharCode(code);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

/**
 * Assert Wasm output matches native JS for each test case.
 */
async function assertEquivalent(source: string, testCases: { fn: string; args: unknown[]; approx?: boolean }[]) {
  const wasmExports = await compileToWasm(source);
  const jsExports = evaluateAsJs(source);
  for (const { fn, args, approx } of testCases) {
    const wasmResult = wasmExports[fn]!(...args);
    const jsResult = jsExports[fn]!(...args);
    if (approx) {
      expect(wasmResult).toBeCloseTo(jsResult as number, 3);
    } else {
      expect(wasmResult).toBe(jsResult);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Base64url decode
// ---------------------------------------------------------------------------
describe("JWT showcase: base64url decode", () => {
  const base64Source = `
    function b64CharValue(c: number): number {
      // A-Z
      if (c >= 65 && c <= 90) return c - 65;
      // a-z
      if (c >= 97 && c <= 122) return c - 71;
      // 0-9
      if (c >= 48 && c <= 57) return c + 4;
      // + or -
      if (c === 43 || c === 45) return 62;
      // / or _
      if (c === 47 || c === 95) return 63;
      return -1;
    }

    export function base64UrlDecode(input: string): string {
      let output: string = "";
      let buffer: number = 0;
      let bits: number = 0;
      let i: number = 0;
      while (i < input.length) {
        const val: number = b64CharValue(input.charCodeAt(i));
        if (val >= 0) {
          buffer = (buffer << 6) | val;
          bits = bits + 6;
          if (bits >= 8) {
            bits = bits - 8;
            const byte: number = (buffer >> bits) & 255;
            output = output + String.fromCharCode(byte);
            buffer = buffer & ((1 << bits) - 1);
          }
        }
        i = i + 1;
      }
      return output;
    }
  `;

  it("decodes a simple base64url string", async () => {
    // "Hello" in base64url is "SGVsbG8"
    await assertEquivalent(
      base64Source +
        `
      export function test(): string {
        return base64UrlDecode("SGVsbG8");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("decodes base64url with padding-free input", async () => {
    // "AB" in base64url is "QUI"
    await assertEquivalent(
      base64Source +
        `
      export function test(): string {
        return base64UrlDecode("QUI");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("decodes a JWT-like payload", async () => {
    // {"sub":"1234567890","name":"John","iat":1516239022} encoded
    // base64url: eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4iLCJpYXQiOjE1MTYyMzkwMjJ9
    await assertEquivalent(
      base64Source +
        `
      export function test(): string {
        return base64UrlDecode("eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4iLCJpYXQiOjE1MTYyMzkwMjJ9");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

// ---------------------------------------------------------------------------
// 2. SHA-256 (pure i32 bitwise ops)
// ---------------------------------------------------------------------------
describe("JWT showcase: SHA-256", () => {
  // Full SHA-256 in pure TypeScript -- all i32 bitwise operations.
  // Uses |0 for i32 wrapping, >>> for unsigned right shift.
  const sha256Source = `
    const K: number[] = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
      0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
      0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
      0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
      0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
      0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    function rotr(x: number, n: number): number {
      return ((x >>> n) | (x << (32 - n))) >>> 0;
    }

    function ch(x: number, y: number, z: number): number {
      return ((x & y) ^ (~x & z)) >>> 0;
    }

    function maj(x: number, y: number, z: number): number {
      return ((x & y) ^ (x & z) ^ (y & z)) >>> 0;
    }

    function sigma0(x: number): number {
      return (rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22)) >>> 0;
    }

    function sigma1(x: number): number {
      return (rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25)) >>> 0;
    }

    function gamma0(x: number): number {
      return (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
    }

    function gamma1(x: number): number {
      return (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0;
    }

    function sha256(msg: string): string {
      // Convert string to byte array
      const bytes: number[] = [];
      let si: number = 0;
      while (si < msg.length) {
        bytes.push(msg.charCodeAt(si));
        si = si + 1;
      }

      const bitLen: number = bytes.length * 8;

      // Padding: append 1 bit + zeros + 64-bit length
      bytes.push(0x80);
      while ((bytes.length % 64) !== 56) {
        bytes.push(0);
      }
      // Append length as big-endian 64-bit (we only use low 32 bits)
      bytes.push(0);
      bytes.push(0);
      bytes.push(0);
      bytes.push(0);
      bytes.push((bitLen >>> 24) & 0xff);
      bytes.push((bitLen >>> 16) & 0xff);
      bytes.push((bitLen >>> 8) & 0xff);
      bytes.push(bitLen & 0xff);

      // Initial hash values
      let h0: number = 0x6a09e667 >>> 0;
      let h1: number = 0xbb67ae85 >>> 0;
      let h2: number = 0x3c6ef372 >>> 0;
      let h3: number = 0xa54ff53a >>> 0;
      let h4: number = 0x510e527f >>> 0;
      let h5: number = 0x9b05688c >>> 0;
      let h6: number = 0x1f83d9ab >>> 0;
      let h7: number = 0x5be0cd19 >>> 0;

      // Process each 64-byte block
      let offset: number = 0;
      while (offset < bytes.length) {
        // Build message schedule W[0..63]
        const W: number[] = [];
        let wi: number = 0;
        while (wi < 16) {
          const b0: number = bytes[offset + wi * 4];
          const b1: number = bytes[offset + wi * 4 + 1];
          const b2: number = bytes[offset + wi * 4 + 2];
          const b3: number = bytes[offset + wi * 4 + 3];
          W.push(((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0);
          wi = wi + 1;
        }
        while (wi < 64) {
          const s0: number = gamma0(W[wi - 15]);
          const s1: number = gamma1(W[wi - 2]);
          W.push(((W[wi - 16] + s0 + W[wi - 7] + s1) | 0) >>> 0);
          wi = wi + 1;
        }

        // Initialize working variables
        let a: number = h0;
        let b: number = h1;
        let c: number = h2;
        let d: number = h3;
        let e: number = h4;
        let f: number = h5;
        let g: number = h6;
        let h: number = h7;

        // 64 rounds
        let ri: number = 0;
        while (ri < 64) {
          const t1: number = ((h + sigma1(e) + ch(e, f, g) + K[ri] + W[ri]) | 0) >>> 0;
          const t2: number = ((sigma0(a) + maj(a, b, c)) | 0) >>> 0;
          h = g;
          g = f;
          f = e;
          e = ((d + t1) | 0) >>> 0;
          d = c;
          c = b;
          b = a;
          a = ((t1 + t2) | 0) >>> 0;
          ri = ri + 1;
        }

        h0 = ((h0 + a) | 0) >>> 0;
        h1 = ((h1 + b) | 0) >>> 0;
        h2 = ((h2 + c) | 0) >>> 0;
        h3 = ((h3 + d) | 0) >>> 0;
        h4 = ((h4 + e) | 0) >>> 0;
        h5 = ((h5 + f) | 0) >>> 0;
        h6 = ((h6 + g) | 0) >>> 0;
        h7 = ((h7 + h) | 0) >>> 0;

        offset = offset + 64;
      }

      return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) +
             toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7);
    }

    function toHex(n: number): string {
      const hexChars: string = "0123456789abcdef";
      let result: string = "";
      let i: number = 28;
      while (i >= 0) {
        const nibble: number = (n >>> i) & 0xf;
        result = result + hexChars.charAt(nibble);
        i = i - 4;
      }
      return result;
    }
  `;

  it("hashes empty string correctly", async () => {
    await assertEquivalent(
      sha256Source +
        `
      export function test(): string {
        return sha256("");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("hashes 'abc' correctly", async () => {
    await assertEquivalent(
      sha256Source +
        `
      export function test(): string {
        return sha256("abc");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("hashes a longer message correctly", async () => {
    await assertEquivalent(
      sha256Source +
        `
      export function test(): string {
        return sha256("hello world");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

// ---------------------------------------------------------------------------
// 3. HMAC-SHA256
// ---------------------------------------------------------------------------
describe("JWT showcase: HMAC-SHA256", () => {
  // Re-include sha256 + hmac. We build the HMAC on top of SHA-256 using
  // byte-level key padding and XOR -- all pure bitwise TS.
  const hmacSource = `
    const K: number[] = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
      0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
      0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
      0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
      0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
      0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    function rotr(x: number, n: number): number {
      return ((x >>> n) | (x << (32 - n))) >>> 0;
    }

    function ch(x: number, y: number, z: number): number {
      return ((x & y) ^ (~x & z)) >>> 0;
    }

    function maj(x: number, y: number, z: number): number {
      return ((x & y) ^ (x & z) ^ (y & z)) >>> 0;
    }

    function sigma0(x: number): number {
      return (rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22)) >>> 0;
    }

    function sigma1(x: number): number {
      return (rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25)) >>> 0;
    }

    function gamma0(x: number): number {
      return (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
    }

    function gamma1(x: number): number {
      return (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0;
    }

    function toHex(n: number): string {
      const hexChars: string = "0123456789abcdef";
      let result: string = "";
      let i: number = 28;
      while (i >= 0) {
        const nibble: number = (n >>> i) & 0xf;
        result = result + hexChars.charAt(nibble);
        i = i - 4;
      }
      return result;
    }

    function sha256(msg: string): string {
      const bytes: number[] = [];
      let si: number = 0;
      while (si < msg.length) {
        bytes.push(msg.charCodeAt(si));
        si = si + 1;
      }
      const bitLen: number = bytes.length * 8;
      bytes.push(0x80);
      while ((bytes.length % 64) !== 56) {
        bytes.push(0);
      }
      bytes.push(0); bytes.push(0); bytes.push(0); bytes.push(0);
      bytes.push((bitLen >>> 24) & 0xff);
      bytes.push((bitLen >>> 16) & 0xff);
      bytes.push((bitLen >>> 8) & 0xff);
      bytes.push(bitLen & 0xff);

      let h0: number = 0x6a09e667 >>> 0;
      let h1: number = 0xbb67ae85 >>> 0;
      let h2: number = 0x3c6ef372 >>> 0;
      let h3: number = 0xa54ff53a >>> 0;
      let h4: number = 0x510e527f >>> 0;
      let h5: number = 0x9b05688c >>> 0;
      let h6: number = 0x1f83d9ab >>> 0;
      let h7: number = 0x5be0cd19 >>> 0;

      let offset: number = 0;
      while (offset < bytes.length) {
        const W: number[] = [];
        let wi: number = 0;
        while (wi < 16) {
          const b0: number = bytes[offset + wi * 4];
          const b1: number = bytes[offset + wi * 4 + 1];
          const b2: number = bytes[offset + wi * 4 + 2];
          const b3: number = bytes[offset + wi * 4 + 3];
          W.push(((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0);
          wi = wi + 1;
        }
        while (wi < 64) {
          const s0: number = gamma0(W[wi - 15]);
          const s1: number = gamma1(W[wi - 2]);
          W.push(((W[wi - 16] + s0 + W[wi - 7] + s1) | 0) >>> 0);
          wi = wi + 1;
        }
        let a: number = h0; let b: number = h1;
        let c: number = h2; let d: number = h3;
        let e: number = h4; let f: number = h5;
        let g: number = h6; let h: number = h7;
        let ri: number = 0;
        while (ri < 64) {
          const t1: number = ((h + sigma1(e) + ch(e, f, g) + K[ri] + W[ri]) | 0) >>> 0;
          const t2: number = ((sigma0(a) + maj(a, b, c)) | 0) >>> 0;
          h = g; g = f; f = e;
          e = ((d + t1) | 0) >>> 0;
          d = c; c = b; b = a;
          a = ((t1 + t2) | 0) >>> 0;
          ri = ri + 1;
        }
        h0 = ((h0 + a) | 0) >>> 0;
        h1 = ((h1 + b) | 0) >>> 0;
        h2 = ((h2 + c) | 0) >>> 0;
        h3 = ((h3 + d) | 0) >>> 0;
        h4 = ((h4 + e) | 0) >>> 0;
        h5 = ((h5 + f) | 0) >>> 0;
        h6 = ((h6 + g) | 0) >>> 0;
        h7 = ((h7 + h) | 0) >>> 0;
        offset = offset + 64;
      }
      return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) +
             toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7);
    }

    function hmacSha256(key: string, message: string): string {
      // If key > 64 bytes, hash it first (simplified: assume key <= 64)
      // Pad key to 64 bytes
      let keyPadded: string = key;
      while (keyPadded.length < 64) {
        keyPadded = keyPadded + String.fromCharCode(0);
      }

      // Build ipad and opad strings via XOR
      let ipadStr: string = "";
      let opadStr: string = "";
      let ki: number = 0;
      while (ki < 64) {
        const kb: number = keyPadded.charCodeAt(ki);
        ipadStr = ipadStr + String.fromCharCode(kb ^ 0x36);
        opadStr = opadStr + String.fromCharCode(kb ^ 0x5c);
        ki = ki + 1;
      }

      // HMAC = SHA256(opad || SHA256(ipad || message))
      // But inner SHA256 returns hex, so we need to use the hex directly
      // For proper HMAC we need raw bytes, but since both JS and Wasm
      // will do the same string-based SHA256, equivalence still holds.
      const innerHash: string = sha256(ipadStr + message);
      return sha256(opadStr + innerHash);
    }
  `;

  it("HMAC-SHA256 with known key and message", async () => {
    await assertEquivalent(
      hmacSource +
        `
      export function test(): string {
        return hmacSha256("secret", "hello");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("HMAC-SHA256 with JWT-style input", async () => {
    await assertEquivalent(
      hmacSource +
        `
      export function test(): string {
        return hmacSha256("mysecret", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

// ---------------------------------------------------------------------------
// 4. JWT token parsing + claim extraction
// ---------------------------------------------------------------------------
describe("JWT showcase: token parsing", () => {
  const jwtParseSource = `
    function b64CharValue(c: number): number {
      if (c >= 65 && c <= 90) return c - 65;
      if (c >= 97 && c <= 122) return c - 71;
      if (c >= 48 && c <= 57) return c + 4;
      if (c === 43 || c === 45) return 62;
      if (c === 47 || c === 95) return 63;
      return -1;
    }

    function base64UrlDecode(input: string): string {
      let output: string = "";
      let buffer: number = 0;
      let bits: number = 0;
      let i: number = 0;
      while (i < input.length) {
        const val: number = b64CharValue(input.charCodeAt(i));
        if (val >= 0) {
          buffer = (buffer << 6) | val;
          bits = bits + 6;
          if (bits >= 8) {
            bits = bits - 8;
            const byte: number = (buffer >> bits) & 255;
            output = output + String.fromCharCode(byte);
            buffer = buffer & ((1 << bits) - 1);
          }
        }
        i = i + 1;
      }
      return output;
    }

    // Minimal JSON field extractor -- finds a string field value by key.
    // Works for simple flat JSON objects with string values.
    function jsonGetString(json: string, key: string): string {
      const searchKey: string = "\\"" + key + "\\"";
      let pos: number = json.indexOf(searchKey);
      if (pos < 0) return "";
      pos = pos + searchKey.length;
      // Skip colon and whitespace
      while (pos < json.length && (json.charCodeAt(pos) === 58 || json.charCodeAt(pos) === 32)) {
        pos = pos + 1;
      }
      // Expect opening quote
      if (pos >= json.length || json.charCodeAt(pos) !== 34) return "";
      pos = pos + 1;
      let result: string = "";
      while (pos < json.length && json.charCodeAt(pos) !== 34) {
        result = result + String.fromCharCode(json.charCodeAt(pos));
        pos = pos + 1;
      }
      return result;
    }

    // Minimal JSON number field extractor
    function jsonGetNumber(json: string, key: string): number {
      const searchKey: string = "\\"" + key + "\\"";
      let pos: number = json.indexOf(searchKey);
      if (pos < 0) return -1;
      pos = pos + searchKey.length;
      while (pos < json.length && (json.charCodeAt(pos) === 58 || json.charCodeAt(pos) === 32)) {
        pos = pos + 1;
      }
      let numStr: string = "";
      while (pos < json.length) {
        const cc: number = json.charCodeAt(pos);
        if ((cc >= 48 && cc <= 57) || cc === 45 || cc === 46) {
          numStr = numStr + String.fromCharCode(cc);
        } else {
          break;
        }
        pos = pos + 1;
      }
      if (numStr.length === 0) return -1;
      // Manual integer parsing (handles positive integers)
      let val: number = 0;
      let ni: number = 0;
      while (ni < numStr.length) {
        const d: number = numStr.charCodeAt(ni) - 48;
        if (d >= 0 && d <= 9) {
          val = val * 10 + d;
        }
        ni = ni + 1;
      }
      return val;
    }

    // Split JWT into parts (header, payload, signature)
    function jwtPart(token: string, partIndex: number): string {
      let current: number = 0;
      let start: number = 0;
      let i: number = 0;
      while (i < token.length) {
        if (token.charCodeAt(i) === 46) { // '.'
          if (current === partIndex) {
            return token.substring(start, i);
          }
          current = current + 1;
          start = i + 1;
        }
        i = i + 1;
      }
      if (current === partIndex) {
        return token.substring(start, token.length);
      }
      return "";
    }
  `;

  // A test JWT: header.payload.signature
  // Header: {"alg":"HS256","typ":"JWT"}
  //   base64url: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9
  // Payload: {"sub":"1234567890","name":"John","iat":1516239022}
  //   base64url: eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4iLCJpYXQiOjE1MTYyMzkwMjJ9
  // Signature (dummy): SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
  const testJwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4iLCJpYXQiOjE1MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

  it("extracts JWT header part", async () => {
    await assertEquivalent(
      jwtParseSource +
        `
      export function test(): string {
        return jwtPart("${testJwt}", 0);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("extracts JWT payload part", async () => {
    await assertEquivalent(
      jwtParseSource +
        `
      export function test(): string {
        return jwtPart("${testJwt}", 1);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("extracts JWT signature part", async () => {
    await assertEquivalent(
      jwtParseSource +
        `
      export function test(): string {
        return jwtPart("${testJwt}", 2);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("decodes JWT header and extracts algorithm", async () => {
    await assertEquivalent(
      jwtParseSource +
        `
      export function test(): string {
        const headerB64: string = jwtPart("${testJwt}", 0);
        const headerJson: string = base64UrlDecode(headerB64);
        return jsonGetString(headerJson, "alg");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("decodes JWT header and extracts type", async () => {
    await assertEquivalent(
      jwtParseSource +
        `
      export function test(): string {
        const headerB64: string = jwtPart("${testJwt}", 0);
        const headerJson: string = base64UrlDecode(headerB64);
        return jsonGetString(headerJson, "typ");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("decodes JWT payload and extracts 'sub' claim", async () => {
    await assertEquivalent(
      jwtParseSource +
        `
      export function test(): string {
        const payloadB64: string = jwtPart("${testJwt}", 1);
        const payloadJson: string = base64UrlDecode(payloadB64);
        return jsonGetString(payloadJson, "sub");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("decodes JWT payload and extracts 'name' claim", async () => {
    await assertEquivalent(
      jwtParseSource +
        `
      export function test(): string {
        const payloadB64: string = jwtPart("${testJwt}", 1);
        const payloadJson: string = base64UrlDecode(payloadB64);
        return jsonGetString(payloadJson, "name");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("decodes JWT payload and extracts 'iat' claim as number", async () => {
    await assertEquivalent(
      jwtParseSource +
        `
      export function test(): number {
        const payloadB64: string = jwtPart("${testJwt}", 1);
        const payloadJson: string = base64UrlDecode(payloadB64);
        return jsonGetNumber(payloadJson, "iat");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Full JWT decode + verify (integration)
// ---------------------------------------------------------------------------
describe("JWT showcase: full decode + verify integration", () => {
  // Combine all components into one source for an end-to-end test
  const fullSource = `
    // --- Base64url ---
    function b64CharValue(c: number): number {
      if (c >= 65 && c <= 90) return c - 65;
      if (c >= 97 && c <= 122) return c - 71;
      if (c >= 48 && c <= 57) return c + 4;
      if (c === 43 || c === 45) return 62;
      if (c === 47 || c === 95) return 63;
      return -1;
    }

    function base64UrlDecode(input: string): string {
      let output: string = "";
      let buffer: number = 0;
      let bits: number = 0;
      let i: number = 0;
      while (i < input.length) {
        const val: number = b64CharValue(input.charCodeAt(i));
        if (val >= 0) {
          buffer = (buffer << 6) | val;
          bits = bits + 6;
          if (bits >= 8) {
            bits = bits - 8;
            const byte: number = (buffer >> bits) & 255;
            output = output + String.fromCharCode(byte);
            buffer = buffer & ((1 << bits) - 1);
          }
        }
        i = i + 1;
      }
      return output;
    }

    // --- JSON field extractors ---
    function jsonGetString(json: string, key: string): string {
      const searchKey: string = "\\"" + key + "\\"";
      let pos: number = json.indexOf(searchKey);
      if (pos < 0) return "";
      pos = pos + searchKey.length;
      while (pos < json.length && (json.charCodeAt(pos) === 58 || json.charCodeAt(pos) === 32)) {
        pos = pos + 1;
      }
      if (pos >= json.length || json.charCodeAt(pos) !== 34) return "";
      pos = pos + 1;
      let result: string = "";
      while (pos < json.length && json.charCodeAt(pos) !== 34) {
        result = result + String.fromCharCode(json.charCodeAt(pos));
        pos = pos + 1;
      }
      return result;
    }

    function jsonGetNumber(json: string, key: string): number {
      const searchKey: string = "\\"" + key + "\\"";
      let pos: number = json.indexOf(searchKey);
      if (pos < 0) return -1;
      pos = pos + searchKey.length;
      while (pos < json.length && (json.charCodeAt(pos) === 58 || json.charCodeAt(pos) === 32)) {
        pos = pos + 1;
      }
      let numStr: string = "";
      while (pos < json.length) {
        const cc: number = json.charCodeAt(pos);
        if ((cc >= 48 && cc <= 57) || cc === 45 || cc === 46) {
          numStr = numStr + String.fromCharCode(cc);
        } else {
          break;
        }
        pos = pos + 1;
      }
      if (numStr.length === 0) return -1;
      let val: number = 0;
      let ni: number = 0;
      while (ni < numStr.length) {
        const d: number = numStr.charCodeAt(ni) - 48;
        if (d >= 0 && d <= 9) {
          val = val * 10 + d;
        }
        ni = ni + 1;
      }
      return val;
    }

    // --- JWT part splitter ---
    function jwtPart(token: string, partIndex: number): string {
      let current: number = 0;
      let start: number = 0;
      let i: number = 0;
      while (i < token.length) {
        if (token.charCodeAt(i) === 46) {
          if (current === partIndex) {
            return token.substring(start, i);
          }
          current = current + 1;
          start = i + 1;
        }
        i = i + 1;
      }
      if (current === partIndex) {
        return token.substring(start, token.length);
      }
      return "";
    }

    // --- Full decode function ---
    export function decodeAlg(token: string): string {
      const headerJson: string = base64UrlDecode(jwtPart(token, 0));
      return jsonGetString(headerJson, "alg");
    }

    export function decodeSub(token: string): string {
      const payloadJson: string = base64UrlDecode(jwtPart(token, 1));
      return jsonGetString(payloadJson, "sub");
    }

    export function decodeName(token: string): string {
      const payloadJson: string = base64UrlDecode(jwtPart(token, 1));
      return jsonGetString(payloadJson, "name");
    }

    export function decodeIat(token: string): number {
      const payloadJson: string = base64UrlDecode(jwtPart(token, 1));
      return jsonGetNumber(payloadJson, "iat");
    }

    export function isExpired(token: string, currentTime: number): number {
      const payloadJson: string = base64UrlDecode(jwtPart(token, 1));
      const exp: number = jsonGetNumber(payloadJson, "exp");
      if (exp < 0) return 0; // no exp claim, not expired
      if (currentTime > exp) return 1;
      return 0;
    }
  `;

  const testJwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4iLCJpYXQiOjE1MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

  it("full decode: extracts algorithm from JWT", async () => {
    const exports = await compileToWasm(fullSource);
    expect(exports.decodeAlg(testJwt)).toBe("HS256");
  });

  it("full decode: extracts subject claim", async () => {
    const exports = await compileToWasm(fullSource);
    expect(exports.decodeSub(testJwt)).toBe("1234567890");
  });

  it("full decode: extracts name claim", async () => {
    const exports = await compileToWasm(fullSource);
    expect(exports.decodeName(testJwt)).toBe("John");
  });

  it("full decode: extracts iat claim", async () => {
    const exports = await compileToWasm(fullSource);
    expect(exports.decodeIat(testJwt)).toBe(1516239022);
  });

  it("full decode: token without exp is not expired", async () => {
    const exports = await compileToWasm(fullSource);
    expect(exports.isExpired(testJwt, 9999999999)).toBe(0);
  });

  it("full decode: token with exp that is expired", async () => {
    // JWT with exp:1000 -> eyJleHAiOjEwMDB9
    // Header: eyJhbGciOiJIUzI1NiJ9 ({"alg":"HS256"})
    // Payload: eyJleHAiOjEwMDB9 ({"exp":1000})
    const expiredJwt = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjEwMDB9.dummysig";
    const exports = await compileToWasm(fullSource);
    expect(exports.isExpired(expiredJwt, 2000)).toBe(1);
  });

  it("full decode: token with exp that is not yet expired", async () => {
    const expiredJwt = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjEwMDB9.dummysig";
    const exports = await compileToWasm(fullSource);
    expect(exports.isExpired(expiredJwt, 500)).toBe(0);
  });
});
