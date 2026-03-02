import type {
  FuncTypeDef,
  GlobalDef,
  Instr,
  WasmModule,
} from "../ir/types.js";

/** Heap starts at byte offset 1024 (leave low addresses for null/sentinel) */
const HEAP_START = 1024;

/**
 * Add linear-memory runtime functions to the module.
 * - 1 page of memory (64 KiB)
 * - __heap_ptr global (mutable i32, starts at HEAP_START)
 * - __malloc(size: i32) → i32: bump allocator, 8-byte aligned
 */
export function addRuntime(mod: WasmModule): void {
  // Add memory (1 page = 64 KiB, growable to 256 pages)
  if (mod.memories.length === 0) {
    mod.memories.push({ min: 1, max: 256 });
    // Export memory so tests can inspect it
    mod.exports.push({
      name: "memory",
      desc: { kind: "memory", index: 0 },
    });
  }

  // Add __heap_ptr global
  const heapPtrGlobalIdx = mod.globals.length;
  const heapPtrGlobal: GlobalDef = {
    name: "__heap_ptr",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: HEAP_START }],
  };
  mod.globals.push(heapPtrGlobal);

  // Register __malloc function type
  const mallocTypeIdx = mod.types.length;
  const mallocType: FuncTypeDef = {
    kind: "func",
    name: "$type___malloc",
    params: [{ kind: "i32" }], // size
    results: [{ kind: "i32" }], // pointer
  };
  mod.types.push(mallocType);

  // __malloc implementation:
  // 1. Get current heap pointer (this will be the returned address)
  // 2. Add size to heap pointer
  // 3. Align to 8 bytes: (ptr + 7) & ~7
  // 4. Store new heap pointer
  // 5. Return old pointer
  const mallocBody: Instr[] = [
    // Save current heap pointer as return value
    { op: "global.get", index: heapPtrGlobalIdx },
    // Compute new heap pointer: old + size
    { op: "global.get", index: heapPtrGlobalIdx },
    { op: "local.get", index: 0 }, // size param
    { op: "i32.add" },
    // Align to 8: (ptr + 7) & ~7
    { op: "i32.const", value: 7 },
    { op: "i32.add" },
    { op: "i32.const", value: -8 }, // ~7 = 0xFFFFFFF8 = -8 in two's complement
    { op: "i32.and" },
    // Store new heap pointer
    { op: "global.set", index: heapPtrGlobalIdx },
    // Return old pointer (already on stack from first global.get)
  ];

  const mallocFuncIdx = mod.functions.length;
  mod.functions.push({
    name: "__malloc",
    typeIdx: mallocTypeIdx,
    locals: [],
    body: mallocBody,
    exported: false,
  });

  // Note: __malloc is NOT exported; it's internal. Register in a way
  // that codegen can find it. The function index will be:
  // numImportFuncs + mallocFuncIdx (but since we add early, it's just mallocFuncIdx for now)
}

/**
 * Add Uint8Array runtime functions to the module.
 * Layout: [header 8B][len:u32 at +8][bytes at +12...]
 *
 * Functions added:
 * - __u8arr_new(len: i32) → i32 (pointer)
 * - __u8arr_get(ptr: i32, idx: i32) → i32
 * - __u8arr_set(ptr: i32, idx: i32, val: i32) → void
 * - __u8arr_len(ptr: i32) → i32
 */
export function addUint8ArrayRuntime(mod: WasmModule): void {
  const mallocIdx = findFuncIndex(mod, "__malloc");

  // __u8arr_new: allocate header(8) + len(4) + bytes(len)
  // extra locals: local 1 = ptr (result)
  addRuntimeFunc(mod, "__u8arr_new", [{ kind: "i32" }], [{ kind: "i32" }], [], (local1Idx) => [
    // Allocate: 12 + len bytes
    { op: "i32.const", value: 12 },
    { op: "local.get", index: 0 }, // len
    { op: "i32.add" },
    { op: "call", funcIdx: mallocIdx },
    { op: "local.set", index: local1Idx },
    // Store len at ptr+8
    { op: "local.get", index: local1Idx },
    { op: "local.get", index: 0 }, // len
    { op: "i32.store", align: 2, offset: 8 },
    // Return ptr
    { op: "local.get", index: local1Idx },
  ], 1);

  // __u8arr_get: load byte at ptr + 12 + idx
  addRuntimeFunc(mod, "__u8arr_get", [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], [], () => [
    { op: "local.get", index: 0 }, // ptr
    { op: "local.get", index: 1 }, // idx
    { op: "i32.add" },
    { op: "i32.load8_u", align: 0, offset: 12 },
  ]);

  // __u8arr_set: store byte at ptr + 12 + idx
  addRuntimeFunc(mod, "__u8arr_set", [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }], [], [], () => [
    { op: "local.get", index: 0 }, // ptr
    { op: "local.get", index: 1 }, // idx
    { op: "i32.add" },
    { op: "local.get", index: 2 }, // val
    { op: "i32.store8", align: 0, offset: 12 },
  ]);

  // __u8arr_len: load i32 at ptr+8
  addRuntimeFunc(mod, "__u8arr_len", [{ kind: "i32" }], [{ kind: "i32" }], [], () => [
    { op: "local.get", index: 0 }, // ptr
    { op: "i32.load", align: 2, offset: 8 },
  ]);
}

/**
 * Add Array runtime functions to the module.
 * Layout: [header 8B][len:u32 at +8][cap:u32 at +12][elements: i32×cap at +16...]
 *
 * Functions added:
 * - __arr_new(cap: i32) → i32 (pointer)
 * - __arr_push(ptr: i32, val: i32) → void
 * - __arr_get(ptr: i32, idx: i32) → i32
 * - __arr_set(ptr: i32, idx: i32, val: i32) → void
 * - __arr_len(ptr: i32) → i32
 */
export function addArrayRuntime(mod: WasmModule): void {
  const mallocIdx = findFuncIndex(mod, "__malloc");

  // __arr_new: allocate header(8) + len(4) + cap(4) + elements(cap*4)
  // extra locals: local 1 = ptr
  addRuntimeFunc(mod, "__arr_new", [{ kind: "i32" }], [{ kind: "i32" }], [], (local1Idx) => [
    // Allocate: 16 + cap*4
    { op: "i32.const", value: 16 },
    { op: "local.get", index: 0 }, // cap
    { op: "i32.const", value: 4 },
    { op: "i32.mul" },
    { op: "i32.add" },
    { op: "call", funcIdx: mallocIdx },
    { op: "local.set", index: local1Idx },
    // Store len=0 at ptr+8
    { op: "local.get", index: local1Idx },
    { op: "i32.const", value: 0 },
    { op: "i32.store", align: 2, offset: 8 },
    // Store cap at ptr+12
    { op: "local.get", index: local1Idx },
    { op: "local.get", index: 0 }, // cap
    { op: "i32.store", align: 2, offset: 12 },
    // Return ptr
    { op: "local.get", index: local1Idx },
  ], 1);

  // __arr_push: store val at ptr+16+len*4, increment len
  addRuntimeFunc(mod, "__arr_push", [{ kind: "i32" }, { kind: "i32" }], [], [], (local2Idx) => [
    // Load current len
    { op: "local.get", index: 0 }, // ptr
    { op: "i32.load", align: 2, offset: 8 },
    { op: "local.set", index: local2Idx },
    // Store val at ptr + 16 + len*4
    { op: "local.get", index: 0 }, // ptr
    { op: "local.get", index: local2Idx }, // len
    { op: "i32.const", value: 4 },
    { op: "i32.mul" },
    { op: "i32.add" },
    { op: "local.get", index: 1 }, // val
    { op: "i32.store", align: 2, offset: 16 },
    // Increment len: store len+1 at ptr+8
    { op: "local.get", index: 0 }, // ptr
    { op: "local.get", index: local2Idx }, // len
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "i32.store", align: 2, offset: 8 },
  ], 1);

  // __arr_get: load i32 at ptr + 16 + idx*4
  addRuntimeFunc(mod, "__arr_get", [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], [], () => [
    { op: "local.get", index: 0 }, // ptr
    { op: "local.get", index: 1 }, // idx
    { op: "i32.const", value: 4 },
    { op: "i32.mul" },
    { op: "i32.add" },
    { op: "i32.load", align: 2, offset: 16 },
  ]);

  // __arr_set: store i32 at ptr + 16 + idx*4
  addRuntimeFunc(mod, "__arr_set", [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }], [], [], () => [
    { op: "local.get", index: 0 }, // ptr
    { op: "local.get", index: 1 }, // idx
    { op: "i32.const", value: 4 },
    { op: "i32.mul" },
    { op: "i32.add" },
    { op: "local.get", index: 2 }, // val
    { op: "i32.store", align: 2, offset: 16 },
  ]);

  // __arr_len: load i32 at ptr+8
  addRuntimeFunc(mod, "__arr_len", [{ kind: "i32" }], [{ kind: "i32" }], [], () => [
    { op: "local.get", index: 0 }, // ptr
    { op: "i32.load", align: 2, offset: 8 },
  ]);
}

/**
 * Add String runtime functions to the module.
 * Layout: [header 8B][len:u32 at +8][utf8 bytes at +12...]
 *
 * Functions added:
 * - __str_from_data(offset: i32, len: i32) → i32 (pointer)
 * - __str_eq(a: i32, b: i32) → i32 (boolean)
 * - __str_hash(ptr: i32) → i32 (FNV-1a hash)
 * - __str_len(ptr: i32) → i32
 * - __str_concat(a: i32, b: i32) → i32 (new string pointer)
 */
export function addStringRuntime(mod: WasmModule): void {
  const mallocIdx = findFuncIndex(mod, "__malloc");

  // __str_from_data: copy `len` bytes from data segment at `offset` into a new string
  // extra locals: local 2 = ptr (result), local 3 = i (loop counter)
  addRuntimeFunc(mod, "__str_from_data", [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], [], (firstLocalIdx) => {
    const ptrLocal = firstLocalIdx;
    const iLocal = firstLocalIdx + 1;
    return [
      // Allocate: 12 + len
      { op: "i32.const", value: 12 },
      { op: "local.get", index: 1 }, // len
      { op: "i32.add" },
      { op: "call", funcIdx: mallocIdx },
      { op: "local.set", index: ptrLocal },
      // Store len at ptr+8
      { op: "local.get", index: ptrLocal },
      { op: "local.get", index: 1 }, // len
      { op: "i32.store", align: 2, offset: 8 },
      // Copy bytes: for i=0; i<len; i++ { mem[ptr+12+i] = mem[offset+i] }
      { op: "i32.const", value: 0 },
      { op: "local.set", index: iLocal },
      {
        op: "block", blockType: { kind: "empty" }, body: [
          {
            op: "loop", blockType: { kind: "empty" }, body: [
              // break if i >= len
              { op: "local.get", index: iLocal },
              { op: "local.get", index: 1 }, // len
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // Store byte: mem[ptr+12+i] = mem[offset+i]
              { op: "local.get", index: ptrLocal },
              { op: "local.get", index: iLocal },
              { op: "i32.add" },
              // Load source byte
              { op: "local.get", index: 0 }, // offset
              { op: "local.get", index: iLocal },
              { op: "i32.add" },
              { op: "i32.load8_u", align: 0, offset: 0 },
              // Store at dest
              { op: "i32.store8", align: 0, offset: 12 },
              // i++
              { op: "local.get", index: iLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: iLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // Return ptr
      { op: "local.get", index: ptrLocal },
    ];
  }, 2); // 2 extra locals

  // __str_len: load i32 at ptr+8
  addRuntimeFunc(mod, "__str_len", [{ kind: "i32" }], [{ kind: "i32" }], [], () => [
    { op: "local.get", index: 0 },
    { op: "i32.load", align: 2, offset: 8 },
  ]);

  // __str_eq: compare two strings byte-by-byte
  // extra locals: local 2 = lenA, local 3 = i
  addRuntimeFunc(mod, "__str_eq", [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], [], (firstLocalIdx) => {
    const lenALocal = firstLocalIdx;
    const iLocal = firstLocalIdx + 1;
    return [
      // Load lenA
      { op: "local.get", index: 0 },
      { op: "i32.load", align: 2, offset: 8 },
      { op: "local.set", index: lenALocal },
      // If lenA != lenB, return 0
      { op: "local.get", index: lenALocal },
      { op: "local.get", index: 1 },
      { op: "i32.load", align: 2, offset: 8 },
      { op: "i32.ne" },
      { op: "if", blockType: { kind: "empty" }, then: [
        { op: "i32.const", value: 0 },
        { op: "return" },
      ] },
      // Compare bytes
      { op: "i32.const", value: 0 },
      { op: "local.set", index: iLocal },
      {
        op: "block", blockType: { kind: "empty" }, body: [
          {
            op: "loop", blockType: { kind: "empty" }, body: [
              // break if i >= lenA
              { op: "local.get", index: iLocal },
              { op: "local.get", index: lenALocal },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // Compare bytes
              { op: "local.get", index: 0 },
              { op: "local.get", index: iLocal },
              { op: "i32.add" },
              { op: "i32.load8_u", align: 0, offset: 12 },
              { op: "local.get", index: 1 },
              { op: "local.get", index: iLocal },
              { op: "i32.add" },
              { op: "i32.load8_u", align: 0, offset: 12 },
              { op: "i32.ne" },
              { op: "if", blockType: { kind: "empty" }, then: [
                { op: "i32.const", value: 0 },
                { op: "return" },
              ] },
              // i++
              { op: "local.get", index: iLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: iLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // All bytes match
      { op: "i32.const", value: 1 },
    ];
  }, 2);

  // __str_hash: FNV-1a hash
  // FNV offset basis = 2166136261 (0x811c9dc5)
  // FNV prime = 16777619 (0x01000193)
  // extra locals: local 1 = hash, local 2 = len, local 3 = i
  addRuntimeFunc(mod, "__str_hash", [{ kind: "i32" }], [{ kind: "i32" }], [], (firstLocalIdx) => {
    const hashLocal = firstLocalIdx;
    const lenLocal = firstLocalIdx + 1;
    const iLocal = firstLocalIdx + 2;
    return [
      // hash = FNV offset basis
      { op: "i32.const", value: 0x811c9dc5 | 0 }, // sign-extend to i32
      { op: "local.set", index: hashLocal },
      // len = str.len
      { op: "local.get", index: 0 },
      { op: "i32.load", align: 2, offset: 8 },
      { op: "local.set", index: lenLocal },
      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: iLocal },
      {
        op: "block", blockType: { kind: "empty" }, body: [
          {
            op: "loop", blockType: { kind: "empty" }, body: [
              // break if i >= len
              { op: "local.get", index: iLocal },
              { op: "local.get", index: lenLocal },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // hash ^= byte[i]
              { op: "local.get", index: hashLocal },
              { op: "local.get", index: 0 }, // ptr
              { op: "local.get", index: iLocal },
              { op: "i32.add" },
              { op: "i32.load8_u", align: 0, offset: 12 },
              { op: "i32.xor" },
              // hash *= FNV prime
              { op: "i32.const", value: 16777619 },
              { op: "i32.mul" },
              { op: "local.set", index: hashLocal },
              // i++
              { op: "local.get", index: iLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: iLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: hashLocal },
    ];
  }, 3);

  // __str_concat: concatenate two strings
  // extra locals: local 2 = lenA, local 3 = lenB, local 4 = ptr, local 5 = i
  addRuntimeFunc(mod, "__str_concat", [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], [], (firstLocalIdx) => {
    const lenALocal = firstLocalIdx;
    const lenBLocal = firstLocalIdx + 1;
    const ptrLocal = firstLocalIdx + 2;
    const iLocal = firstLocalIdx + 3;
    return [
      // lenA
      { op: "local.get", index: 0 },
      { op: "i32.load", align: 2, offset: 8 },
      { op: "local.set", index: lenALocal },
      // lenB
      { op: "local.get", index: 1 },
      { op: "i32.load", align: 2, offset: 8 },
      { op: "local.set", index: lenBLocal },
      // Allocate: 12 + lenA + lenB
      { op: "i32.const", value: 12 },
      { op: "local.get", index: lenALocal },
      { op: "i32.add" },
      { op: "local.get", index: lenBLocal },
      { op: "i32.add" },
      { op: "call", funcIdx: mallocIdx },
      { op: "local.set", index: ptrLocal },
      // Store total len at ptr+8
      { op: "local.get", index: ptrLocal },
      { op: "local.get", index: lenALocal },
      { op: "local.get", index: lenBLocal },
      { op: "i32.add" },
      { op: "i32.store", align: 2, offset: 8 },
      // Copy first string bytes
      { op: "i32.const", value: 0 },
      { op: "local.set", index: iLocal },
      {
        op: "block", blockType: { kind: "empty" }, body: [
          {
            op: "loop", blockType: { kind: "empty" }, body: [
              { op: "local.get", index: iLocal },
              { op: "local.get", index: lenALocal },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: ptrLocal },
              { op: "local.get", index: iLocal },
              { op: "i32.add" },
              { op: "local.get", index: 0 },
              { op: "local.get", index: iLocal },
              { op: "i32.add" },
              { op: "i32.load8_u", align: 0, offset: 12 },
              { op: "i32.store8", align: 0, offset: 12 },
              { op: "local.get", index: iLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: iLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // Copy second string bytes
      { op: "i32.const", value: 0 },
      { op: "local.set", index: iLocal },
      {
        op: "block", blockType: { kind: "empty" }, body: [
          {
            op: "loop", blockType: { kind: "empty" }, body: [
              { op: "local.get", index: iLocal },
              { op: "local.get", index: lenBLocal },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // dest: ptr + 12 + lenA + i
              { op: "local.get", index: ptrLocal },
              { op: "local.get", index: lenALocal },
              { op: "i32.add" },
              { op: "local.get", index: iLocal },
              { op: "i32.add" },
              // src byte
              { op: "local.get", index: 1 },
              { op: "local.get", index: iLocal },
              { op: "i32.add" },
              { op: "i32.load8_u", align: 0, offset: 12 },
              { op: "i32.store8", align: 0, offset: 12 },
              { op: "local.get", index: iLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: iLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: ptrLocal },
    ];
  }, 4);
}

/**
 * Add Map runtime functions (open-addressing hash table with string keys).
 * Layout: [header 8B][count:u32 at +8][cap:u32 at +12][entries at +16...]
 * Entry: [hash:u32][key:i32][val:i32] = 12 bytes each
 * Empty entry: hash=0
 *
 * Functions added:
 * - __map_new(cap: i32) → i32
 * - __map_set(map: i32, key: i32, val: i32) → void
 * - __map_get(map: i32, key: i32) → i32
 * - __map_has(map: i32, key: i32) → i32
 * - __map_size(map: i32) → i32
 */
export function addMapRuntime(mod: WasmModule): void {
  const mallocIdx = findFuncIndex(mod, "__malloc");
  const strHashIdx = findFuncIndex(mod, "__str_hash");
  const strEqIdx = findFuncIndex(mod, "__str_eq");

  // __map_new: allocate map with given capacity
  // extra locals: local 1 = ptr, local 2 = totalSize, local 3 = i
  addRuntimeFunc(mod, "__map_new", [{ kind: "i32" }], [{ kind: "i32" }], [], (firstLocalIdx) => {
    const ptrLocal = firstLocalIdx;
    const totalSizeLocal = firstLocalIdx + 1;
    const iLocal = firstLocalIdx + 2;
    return [
      // totalSize = 16 + cap * 12
      { op: "i32.const", value: 16 },
      { op: "local.get", index: 0 }, // cap
      { op: "i32.const", value: 12 },
      { op: "i32.mul" },
      { op: "i32.add" },
      { op: "local.set", index: totalSizeLocal },
      // Allocate
      { op: "local.get", index: totalSizeLocal },
      { op: "call", funcIdx: mallocIdx },
      { op: "local.set", index: ptrLocal },
      // Store count=0
      { op: "local.get", index: ptrLocal },
      { op: "i32.const", value: 0 },
      { op: "i32.store", align: 2, offset: 8 },
      // Store cap
      { op: "local.get", index: ptrLocal },
      { op: "local.get", index: 0 }, // cap
      { op: "i32.store", align: 2, offset: 12 },
      // Zero out entries (hash=0 means empty)
      { op: "i32.const", value: 0 },
      { op: "local.set", index: iLocal },
      {
        op: "block", blockType: { kind: "empty" }, body: [
          {
            op: "loop", blockType: { kind: "empty" }, body: [
              { op: "local.get", index: iLocal },
              { op: "local.get", index: 0 }, // cap
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // Zero out hash at entry[i]
              { op: "local.get", index: ptrLocal },
              { op: "local.get", index: iLocal },
              { op: "i32.const", value: 12 },
              { op: "i32.mul" },
              { op: "i32.add" },
              { op: "i32.const", value: 0 },
              { op: "i32.store", align: 2, offset: 16 },
              { op: "local.get", index: iLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: iLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: ptrLocal },
    ];
  }, 3);

  // __map_set: insert or update key-value pair using linear probing
  // extra locals: local 3-7 = hash, cap, idx, entryAddr, entryHash
  addRuntimeFunc(mod, "__map_set", [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }], [], [], (firstLocalIdx) => {
    const hashLocal = firstLocalIdx;
    const capLocal = firstLocalIdx + 1;
    const idxLocal = firstLocalIdx + 2;
    const entryAddrLocal = firstLocalIdx + 3;
    const entryHashLocal = firstLocalIdx + 4;
    return [
      // hash = __str_hash(key) | ensure non-zero by OR with 1
      { op: "local.get", index: 1 }, // key
      { op: "call", funcIdx: strHashIdx },
      { op: "i32.const", value: 1 },
      { op: "i32.or" }, // ensure hash != 0 (0 = empty sentinel)
      { op: "local.set", index: hashLocal },
      // cap = map.cap
      { op: "local.get", index: 0 },
      { op: "i32.load", align: 2, offset: 12 },
      { op: "local.set", index: capLocal },
      // idx = hash % cap (unsigned)
      { op: "local.get", index: hashLocal },
      { op: "local.get", index: capLocal },
      { op: "i32.rem_u" },
      { op: "local.set", index: idxLocal },
      // Linear probe loop
      {
        op: "block", blockType: { kind: "empty" }, body: [
          {
            op: "loop", blockType: { kind: "empty" }, body: [
              // entryAddr = map + 16 + idx * 12
              { op: "local.get", index: 0 },
              { op: "local.get", index: idxLocal },
              { op: "i32.const", value: 12 },
              { op: "i32.mul" },
              { op: "i32.add" },
              { op: "local.set", index: entryAddrLocal },
              // entryHash = load hash at entryAddr+16
              { op: "local.get", index: entryAddrLocal },
              { op: "i32.load", align: 2, offset: 16 },
              { op: "local.set", index: entryHashLocal },
              // If empty slot (hash=0): insert here
              { op: "local.get", index: entryHashLocal },
              { op: "i32.eqz" },
              {
                op: "if", blockType: { kind: "empty" }, then: [
                  // Store hash
                  { op: "local.get", index: entryAddrLocal },
                  { op: "local.get", index: hashLocal },
                  { op: "i32.store", align: 2, offset: 16 },
                  // Store key
                  { op: "local.get", index: entryAddrLocal },
                  { op: "local.get", index: 1 },
                  { op: "i32.store", align: 2, offset: 20 },
                  // Store val
                  { op: "local.get", index: entryAddrLocal },
                  { op: "local.get", index: 2 },
                  { op: "i32.store", align: 2, offset: 24 },
                  // Increment count
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 0 },
                  { op: "i32.load", align: 2, offset: 8 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "i32.store", align: 2, offset: 8 },
                  { op: "return" },
                ],
              },
              // If same hash AND keys equal: update value
              { op: "local.get", index: entryHashLocal },
              { op: "local.get", index: hashLocal },
              { op: "i32.eq" },
              {
                op: "if", blockType: { kind: "empty" }, then: [
                  // Check string equality
                  { op: "local.get", index: entryAddrLocal },
                  { op: "i32.load", align: 2, offset: 20 }, // existing key
                  { op: "local.get", index: 1 }, // new key
                  { op: "call", funcIdx: strEqIdx },
                  {
                    op: "if", blockType: { kind: "empty" }, then: [
                      // Update value
                      { op: "local.get", index: entryAddrLocal },
                      { op: "local.get", index: 2 },
                      { op: "i32.store", align: 2, offset: 24 },
                      { op: "return" },
                    ],
                  },
                ],
              },
              // Advance: idx = (idx + 1) % cap
              { op: "local.get", index: idxLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.get", index: capLocal },
              { op: "i32.rem_u" },
              { op: "local.set", index: idxLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ];
  }, 5);

  // __map_get: look up value by key (returns 0 if not found)
  // extra locals: local 2-6 = hash, cap, idx, entryAddr, entryHash
  addRuntimeFunc(mod, "__map_get", [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], [], (firstLocalIdx) => {
    const hashLocal = firstLocalIdx;
    const capLocal = firstLocalIdx + 1;
    const idxLocal = firstLocalIdx + 2;
    const entryAddrLocal = firstLocalIdx + 3;
    const entryHashLocal = firstLocalIdx + 4;
    return [
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: strHashIdx },
      { op: "i32.const", value: 1 },
      { op: "i32.or" },
      { op: "local.set", index: hashLocal },
      { op: "local.get", index: 0 },
      { op: "i32.load", align: 2, offset: 12 },
      { op: "local.set", index: capLocal },
      { op: "local.get", index: hashLocal },
      { op: "local.get", index: capLocal },
      { op: "i32.rem_u" },
      { op: "local.set", index: idxLocal },
      {
        op: "block", blockType: { kind: "empty" }, body: [
          {
            op: "loop", blockType: { kind: "empty" }, body: [
              { op: "local.get", index: 0 },
              { op: "local.get", index: idxLocal },
              { op: "i32.const", value: 12 },
              { op: "i32.mul" },
              { op: "i32.add" },
              { op: "local.set", index: entryAddrLocal },
              { op: "local.get", index: entryAddrLocal },
              { op: "i32.load", align: 2, offset: 16 },
              { op: "local.set", index: entryHashLocal },
              // Empty slot → not found
              { op: "local.get", index: entryHashLocal },
              { op: "i32.eqz" },
              {
                op: "if", blockType: { kind: "empty" }, then: [
                  { op: "i32.const", value: 0 },
                  { op: "return" },
                ],
              },
              // Check hash + key equality
              { op: "local.get", index: entryHashLocal },
              { op: "local.get", index: hashLocal },
              { op: "i32.eq" },
              {
                op: "if", blockType: { kind: "empty" }, then: [
                  { op: "local.get", index: entryAddrLocal },
                  { op: "i32.load", align: 2, offset: 20 },
                  { op: "local.get", index: 1 },
                  { op: "call", funcIdx: strEqIdx },
                  {
                    op: "if", blockType: { kind: "empty" }, then: [
                      { op: "local.get", index: entryAddrLocal },
                      { op: "i32.load", align: 2, offset: 24 },
                      { op: "return" },
                    ],
                  },
                ],
              },
              { op: "local.get", index: idxLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.get", index: capLocal },
              { op: "i32.rem_u" },
              { op: "local.set", index: idxLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "i32.const", value: 0 },
    ];
  }, 5);

  // __map_has: check if key exists (returns 0 or 1)
  // extra locals: local 2-6 = hash, cap, idx, entryAddr, entryHash
  addRuntimeFunc(mod, "__map_has", [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], [], (firstLocalIdx) => {
    const hashLocal = firstLocalIdx;
    const capLocal = firstLocalIdx + 1;
    const idxLocal = firstLocalIdx + 2;
    const entryAddrLocal = firstLocalIdx + 3;
    const entryHashLocal = firstLocalIdx + 4;
    return [
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: strHashIdx },
      { op: "i32.const", value: 1 },
      { op: "i32.or" },
      { op: "local.set", index: hashLocal },
      { op: "local.get", index: 0 },
      { op: "i32.load", align: 2, offset: 12 },
      { op: "local.set", index: capLocal },
      { op: "local.get", index: hashLocal },
      { op: "local.get", index: capLocal },
      { op: "i32.rem_u" },
      { op: "local.set", index: idxLocal },
      {
        op: "block", blockType: { kind: "empty" }, body: [
          {
            op: "loop", blockType: { kind: "empty" }, body: [
              { op: "local.get", index: 0 },
              { op: "local.get", index: idxLocal },
              { op: "i32.const", value: 12 },
              { op: "i32.mul" },
              { op: "i32.add" },
              { op: "local.set", index: entryAddrLocal },
              { op: "local.get", index: entryAddrLocal },
              { op: "i32.load", align: 2, offset: 16 },
              { op: "local.set", index: entryHashLocal },
              { op: "local.get", index: entryHashLocal },
              { op: "i32.eqz" },
              {
                op: "if", blockType: { kind: "empty" }, then: [
                  { op: "i32.const", value: 0 },
                  { op: "return" },
                ],
              },
              { op: "local.get", index: entryHashLocal },
              { op: "local.get", index: hashLocal },
              { op: "i32.eq" },
              {
                op: "if", blockType: { kind: "empty" }, then: [
                  { op: "local.get", index: entryAddrLocal },
                  { op: "i32.load", align: 2, offset: 20 },
                  { op: "local.get", index: 1 },
                  { op: "call", funcIdx: strEqIdx },
                  {
                    op: "if", blockType: { kind: "empty" }, then: [
                      { op: "i32.const", value: 1 },
                      { op: "return" },
                    ],
                  },
                ],
              },
              { op: "local.get", index: idxLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.get", index: capLocal },
              { op: "i32.rem_u" },
              { op: "local.set", index: idxLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "i32.const", value: 0 },
    ];
  }, 5);

  // __map_size: load count at offset 8
  addRuntimeFunc(mod, "__map_size", [{ kind: "i32" }], [{ kind: "i32" }], [], () => [
    { op: "local.get", index: 0 },
    { op: "i32.load", align: 2, offset: 8 },
  ]);
}

/**
 * Add Set runtime functions (open-addressing hash set with string keys).
 * Layout: [header 8B][count:u32 at +8][cap:u32 at +12][entries at +16...]
 * Entry: [hash:u32][key:i32] = 8 bytes each
 *
 * Functions added:
 * - __set_new(cap: i32) → i32
 * - __set_add(set: i32, key: i32) → void
 * - __set_has(set: i32, key: i32) → i32
 * - __set_size(set: i32) → i32
 */
export function addSetRuntime(mod: WasmModule): void {
  const mallocIdx = findFuncIndex(mod, "__malloc");
  const strHashIdx = findFuncIndex(mod, "__str_hash");
  const strEqIdx = findFuncIndex(mod, "__str_eq");

  // __set_new
  // extra locals: local 1 = ptr, local 2 = i
  addRuntimeFunc(mod, "__set_new", [{ kind: "i32" }], [{ kind: "i32" }], [], (firstLocalIdx) => {
    const ptrLocal = firstLocalIdx;
    const iLocal = firstLocalIdx + 1;
    return [
      // Allocate: 16 + cap * 8
      { op: "i32.const", value: 16 },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 8 },
      { op: "i32.mul" },
      { op: "i32.add" },
      { op: "call", funcIdx: mallocIdx },
      { op: "local.set", index: ptrLocal },
      // count = 0
      { op: "local.get", index: ptrLocal },
      { op: "i32.const", value: 0 },
      { op: "i32.store", align: 2, offset: 8 },
      // cap
      { op: "local.get", index: ptrLocal },
      { op: "local.get", index: 0 },
      { op: "i32.store", align: 2, offset: 12 },
      // Zero entries
      { op: "i32.const", value: 0 },
      { op: "local.set", index: iLocal },
      {
        op: "block", blockType: { kind: "empty" }, body: [
          {
            op: "loop", blockType: { kind: "empty" }, body: [
              { op: "local.get", index: iLocal },
              { op: "local.get", index: 0 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: ptrLocal },
              { op: "local.get", index: iLocal },
              { op: "i32.const", value: 8 },
              { op: "i32.mul" },
              { op: "i32.add" },
              { op: "i32.const", value: 0 },
              { op: "i32.store", align: 2, offset: 16 },
              { op: "local.get", index: iLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: iLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: ptrLocal },
    ];
  }, 2);

  // __set_add
  // extra locals: local 2-6 = hash, cap, idx, entryAddr, entryHash
  addRuntimeFunc(mod, "__set_add", [{ kind: "i32" }, { kind: "i32" }], [], [], (firstLocalIdx) => {
    const hashLocal = firstLocalIdx;
    const capLocal = firstLocalIdx + 1;
    const idxLocal = firstLocalIdx + 2;
    const entryAddrLocal = firstLocalIdx + 3;
    const entryHashLocal = firstLocalIdx + 4;
    return [
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: strHashIdx },
      { op: "i32.const", value: 1 },
      { op: "i32.or" },
      { op: "local.set", index: hashLocal },
      { op: "local.get", index: 0 },
      { op: "i32.load", align: 2, offset: 12 },
      { op: "local.set", index: capLocal },
      { op: "local.get", index: hashLocal },
      { op: "local.get", index: capLocal },
      { op: "i32.rem_u" },
      { op: "local.set", index: idxLocal },
      {
        op: "block", blockType: { kind: "empty" }, body: [
          {
            op: "loop", blockType: { kind: "empty" }, body: [
              { op: "local.get", index: 0 },
              { op: "local.get", index: idxLocal },
              { op: "i32.const", value: 8 },
              { op: "i32.mul" },
              { op: "i32.add" },
              { op: "local.set", index: entryAddrLocal },
              { op: "local.get", index: entryAddrLocal },
              { op: "i32.load", align: 2, offset: 16 },
              { op: "local.set", index: entryHashLocal },
              // Empty slot → insert
              { op: "local.get", index: entryHashLocal },
              { op: "i32.eqz" },
              {
                op: "if", blockType: { kind: "empty" }, then: [
                  { op: "local.get", index: entryAddrLocal },
                  { op: "local.get", index: hashLocal },
                  { op: "i32.store", align: 2, offset: 16 },
                  { op: "local.get", index: entryAddrLocal },
                  { op: "local.get", index: 1 },
                  { op: "i32.store", align: 2, offset: 20 },
                  // Increment count
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 0 },
                  { op: "i32.load", align: 2, offset: 8 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "i32.store", align: 2, offset: 8 },
                  { op: "return" },
                ],
              },
              // Same hash → check equality
              { op: "local.get", index: entryHashLocal },
              { op: "local.get", index: hashLocal },
              { op: "i32.eq" },
              {
                op: "if", blockType: { kind: "empty" }, then: [
                  { op: "local.get", index: entryAddrLocal },
                  { op: "i32.load", align: 2, offset: 20 },
                  { op: "local.get", index: 1 },
                  { op: "call", funcIdx: strEqIdx },
                  {
                    op: "if", blockType: { kind: "empty" }, then: [
                      { op: "return" }, // already in set
                    ],
                  },
                ],
              },
              { op: "local.get", index: idxLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.get", index: capLocal },
              { op: "i32.rem_u" },
              { op: "local.set", index: idxLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ];
  }, 5);

  // __set_has
  // extra locals: local 2-6 = hash, cap, idx, entryAddr, entryHash
  addRuntimeFunc(mod, "__set_has", [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], [], (firstLocalIdx) => {
    const hashLocal = firstLocalIdx;
    const capLocal = firstLocalIdx + 1;
    const idxLocal = firstLocalIdx + 2;
    const entryAddrLocal = firstLocalIdx + 3;
    const entryHashLocal = firstLocalIdx + 4;
    return [
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: strHashIdx },
      { op: "i32.const", value: 1 },
      { op: "i32.or" },
      { op: "local.set", index: hashLocal },
      { op: "local.get", index: 0 },
      { op: "i32.load", align: 2, offset: 12 },
      { op: "local.set", index: capLocal },
      { op: "local.get", index: hashLocal },
      { op: "local.get", index: capLocal },
      { op: "i32.rem_u" },
      { op: "local.set", index: idxLocal },
      {
        op: "block", blockType: { kind: "empty" }, body: [
          {
            op: "loop", blockType: { kind: "empty" }, body: [
              { op: "local.get", index: 0 },
              { op: "local.get", index: idxLocal },
              { op: "i32.const", value: 8 },
              { op: "i32.mul" },
              { op: "i32.add" },
              { op: "local.set", index: entryAddrLocal },
              { op: "local.get", index: entryAddrLocal },
              { op: "i32.load", align: 2, offset: 16 },
              { op: "local.set", index: entryHashLocal },
              { op: "local.get", index: entryHashLocal },
              { op: "i32.eqz" },
              {
                op: "if", blockType: { kind: "empty" }, then: [
                  { op: "i32.const", value: 0 },
                  { op: "return" },
                ],
              },
              { op: "local.get", index: entryHashLocal },
              { op: "local.get", index: hashLocal },
              { op: "i32.eq" },
              {
                op: "if", blockType: { kind: "empty" }, then: [
                  { op: "local.get", index: entryAddrLocal },
                  { op: "i32.load", align: 2, offset: 20 },
                  { op: "local.get", index: 1 },
                  { op: "call", funcIdx: strEqIdx },
                  {
                    op: "if", blockType: { kind: "empty" }, then: [
                      { op: "i32.const", value: 1 },
                      { op: "return" },
                    ],
                  },
                ],
              },
              { op: "local.get", index: idxLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.get", index: capLocal },
              { op: "i32.rem_u" },
              { op: "local.set", index: idxLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "i32.const", value: 0 },
    ];
  }, 5);

  // __set_size
  addRuntimeFunc(mod, "__set_size", [{ kind: "i32" }], [{ kind: "i32" }], [], () => [
    { op: "local.get", index: 0 },
    { op: "i32.load", align: 2, offset: 8 },
  ]);
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Find a function's absolute index by name */
function findFuncIndex(mod: WasmModule, name: string): number {
  const numImports = mod.imports.filter((i) => i.desc.kind === "func").length;
  for (let i = 0; i < mod.functions.length; i++) {
    if (mod.functions[i].name === name) {
      return numImports + i;
    }
  }
  throw new Error(`Runtime function not found: ${name}`);
}

/**
 * Helper to add a runtime function to the module.
 * @param extraLocalsCount how many extra locals (beyond params) the function needs
 */
function addRuntimeFunc(
  mod: WasmModule,
  name: string,
  params: ValType[],
  results: ValType[],
  _extraLocalPlaceholders: unknown[],
  bodyFn: (firstExtraLocalIdx: number) => Instr[],
  extraLocalsCount?: number,
): void {
  const typeIdx = mod.types.length;
  mod.types.push({
    kind: "func",
    name: `$type_${name}`,
    params,
    results,
  });

  const numExtraLocals = extraLocalsCount ?? _extraLocalPlaceholders.length;
  const locals = [];
  for (let i = 0; i < numExtraLocals; i++) {
    locals.push({ name: `$l${i}`, type: { kind: "i32" as const } });
  }

  const firstExtraLocalIdx = params.length;
  const body = bodyFn(firstExtraLocalIdx);

  mod.functions.push({
    name,
    typeIdx,
    locals,
    body,
    exported: false,
  });
}
