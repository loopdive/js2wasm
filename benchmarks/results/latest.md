# js2wasm Benchmark Results

Date: 2026-04-10
Node: v22.22.2
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.117ms | 0.051ms | 0.212ms | — | host-call |
| string/concat-long | 0.018ms | 0.010ms | 0.034ms | — | host-call |
| string/indexOf | 0.002ms | 0.104ms | 0.047ms | — | js |
| string/includes | 0.003ms | 0.143ms | 0.049ms | — | js |
| string/split | 0.341ms | 9.06ms | 1.90ms | — | js |
| string/replace | 0.040ms | 0.123ms | 0.122ms | — | js |
| string/case-convert | <0.001ms | 0.289ms | 0.080ms | — | js |
| string/substring | 0.005ms | 0.825ms | 0.050ms | — | js |
| string/trim | 0.201ms | 0.862ms | 0.294ms | — | js |
| string/startsWith-endsWith | 0.381ms | 2.96ms | 0.373ms | — | gc-native |
| array/push-pop | 1.46ms | 1.60ms | 1.04ms | — | gc-native |
| array/sort-i32 | 0.753ms | 0.190ms | 0.265ms | — | host-call |
| array/map-filter | 0.157ms | 0.102ms | — | — | host-call |
| array/reduce | 2.11ms | 1.61ms | — | — | host-call |
| array/indexOf | 4.69ms | 4.01ms | 2.44ms | — | gc-native |
| array/slice | 0.037ms | 0.035ms | 0.029ms | — | gc-native |
| array/reverse | 7.32ms | 4.20ms | 3.96ms | — | gc-native |
| array/forEach | 0.076ms | 0.063ms | — | 0.033ms | linear-memory |
| array/find | 0.341ms | 0.629ms | — | — | js |
| dom/create-elements | 0.052ms | — | — | — | js |
| dom/set-attributes | 0.126ms | — | — | — | js |
| dom/read-attributes | 0.066ms | — | — | — | js |
| dom/modify-text | 0.071ms | — | — | — | js |
| mixed/csv-parse | 0.425ms | 4.48ms | 1.41ms | — | js |
| mixed/text-search | 0.350ms | 5.68ms | 1.12ms | — | js |
| mixed/fibonacci | 0.173ms | 0.228ms | 0.089ms | 0.392ms | gc-native |
| mixed/matrix-multiply | 0.221ms | 0.623ms | 0.207ms | — | gc-native |
| mixed/sieve | 1.66ms | 2.79ms | 1.55ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 2.29x faster | 1.82x slower | — |
| string/concat-long | 1.75x faster | 1.90x slower | — |
| string/indexOf | 42.96x slower | 19.55x slower | — |
| string/includes | 55.36x slower | 19.13x slower | — |
| string/split | 26.62x slower | 5.59x slower | — |
| string/replace | 3.09x slower | 3.08x slower | — |
| string/case-convert | 507.29x slower | 139.82x slower | — |
| string/substring | 178.26x slower | 10.87x slower | — |
| string/trim | 4.28x slower | 1.46x slower | — |
| string/startsWith-endsWith | 7.76x slower | 1.02x faster | — |
| array/push-pop | 1.09x slower | 1.40x faster | — |
| array/sort-i32 | 3.97x faster | 2.84x faster | — |
| array/map-filter | 1.55x faster | — | — |
| array/reduce | 1.31x faster | — | — |
| array/indexOf | 1.17x faster | 1.92x faster | — |
| array/slice | 1.05x faster | 1.28x faster | — |
| array/reverse | 1.74x faster | 1.85x faster | — |
| array/forEach | 1.20x faster | — | 2.26x faster |
| array/find | 1.84x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 10.54x slower | 3.32x slower | — |
| mixed/text-search | 16.22x slower | 3.20x slower | — |
| mixed/fibonacci | 1.32x slower | 1.94x faster | 2.27x slower |
| mixed/matrix-multiply | 2.82x slower | 1.07x faster | — |
| mixed/sieve | 1.68x slower | 1.07x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 4.15x slower |
| string/concat-long | 3.33x slower |
| string/indexOf | 2.20x faster |
| string/includes | 2.89x faster |
| string/split | 4.76x faster |
| string/replace | 1.00x faster |
| string/case-convert | 3.63x faster |
| string/substring | 16.40x faster |
| string/trim | 2.94x faster |
| string/startsWith-endsWith | 7.94x faster |
| array/push-pop | 1.53x faster |
| array/sort-i32 | 1.40x slower |
| array/indexOf | 1.64x faster |
| array/slice | 1.22x faster |
| array/reverse | 1.06x faster |
| mixed/csv-parse | 3.17x faster |
| mixed/text-search | 5.07x faster |
| mixed/fibonacci | 2.56x faster |
| mixed/matrix-multiply | 3.01x faster |
| mixed/sieve | 1.80x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 283B | 4.3KB | — |
| string/concat-long | 325B | 4.3KB | — |
| string/indexOf | 337B | 4.4KB | — |
| string/includes | 348B | 4.4KB | — |
| string/split | 380B | 4.5KB | — |
| string/replace | 370B | 4.5KB | — |
| string/case-convert | 355B | 4.4KB | — |
| string/substring | 323B | 4.4KB | — |
| string/trim | 283B | 4.3KB | — |
| string/startsWith-endsWith | 436B | 4.5KB | — |
| array/push-pop | 516B | 4.6KB | — |
| array/sort-i32 | 1.7KB | 5.7KB | — |
| array/map-filter | 854B | — | — |
| array/reduce | 567B | — | — |
| array/indexOf | 578B | 4.6KB | — |
| array/slice | 669B | 4.7KB | — |
| array/reverse | 611B | 4.6KB | — |
| array/forEach | 684B | — | 3.6KB |
| array/find | 674B | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 804B | 5.0KB | — |
| mixed/text-search | 734B | 4.9KB | — |
| mixed/fibonacci | 323B | 4.3KB | 3.7KB |
| mixed/matrix-multiply | 1.1KB | 5.1KB | — |
| mixed/sieve | 1.1KB | 5.1KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1093.9ms | 512.4ms | — |
| string/concat-long | 371.3ms | 316.5ms | — |
| string/indexOf | 261.5ms | 263.5ms | — |
| string/includes | 248.1ms | 260.5ms | — |
| string/split | 248.8ms | 268.7ms | — |
| string/replace | 254.5ms | 250.1ms | — |
| string/case-convert | 563.2ms | 319.3ms | — |
| string/substring | 246.9ms | 245.1ms | — |
| string/trim | 241.9ms | 247.9ms | — |
| string/startsWith-endsWith | 250.6ms | 253.2ms | — |
| array/push-pop | 265.1ms | 276.3ms | — |
| array/sort-i32 | 250.9ms | 257.8ms | — |
| array/map-filter | 586.6ms | — | — |
| array/reduce | 259.6ms | — | — |
| array/indexOf | 254.1ms | 259.5ms | — |
| array/slice | 243.0ms | 241.2ms | — |
| array/reverse | 247.3ms | 253.0ms | — |
| array/forEach | 257.1ms | — | 250.3ms |
| array/find | 249.7ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 291.1ms | 267.2ms | — |
| mixed/text-search | 261.5ms | 273.9ms | — |
| mixed/fibonacci | 269.8ms | 264.5ms | 267.9ms |
| mixed/matrix-multiply | 257.9ms | 263.4ms | — |
| mixed/sieve | 258.8ms | 615.3ms | — |
