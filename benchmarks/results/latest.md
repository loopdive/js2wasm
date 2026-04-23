# js2wasm Benchmark Results

Date: 2026-04-23
Node: v25.8.2
Platform: linux arm64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.058ms | 0.097ms | 0.074ms | — | js |
| string/concat-long | 0.002ms | 0.006ms | 0.012ms | — | js |
| string/indexOf | 0.010ms | 0.213ms | 0.029ms | — | js |
| string/includes | 0.011ms | 0.222ms | 0.026ms | — | js |
| string/split | 0.163ms | 6.17ms | 0.799ms | — | js |
| string/replace | 0.020ms | 0.216ms | 0.062ms | — | js |
| string/case-convert | <0.001ms | 0.413ms | 0.038ms | — | js |
| string/substring | 0.003ms | 2.02ms | 0.023ms | — | js |
| string/trim | 0.077ms | 1.84ms | 0.103ms | — | js |
| string/startsWith-endsWith | 0.239ms | 4.16ms | 0.181ms | — | gc-native |
| array/push-pop | 0.674ms | 0.728ms | 0.535ms | — | gc-native |
| array/sort-i32 | 0.330ms | 0.092ms | 0.084ms | — | gc-native |
| array/map-filter | 0.086ms | 0.045ms | — | — | host-call |
| array/reduce | 1.14ms | 0.825ms | — | — | host-call |
| array/indexOf | 0.740ms | 2.12ms | 2.12ms | — | js |
| array/slice | 0.021ms | 0.022ms | 0.018ms | — | gc-native |
| array/reverse | 3.91ms | 2.43ms | 2.42ms | — | gc-native |
| array/forEach | 0.064ms | 0.033ms | — | 0.007ms | linear-memory |
| array/find | 0.170ms | 0.479ms | — | — | js |
| dom/create-elements | 0.021ms | — | — | — | js |
| dom/set-attributes | 0.063ms | — | — | — | js |
| dom/read-attributes | 0.033ms | — | — | — | js |
| dom/modify-text | 0.025ms | — | — | — | js |
| mixed/csv-parse | 0.199ms | 9.49ms | 0.572ms | — | js |
| mixed/text-search | 0.134ms | 8.82ms | 0.700ms | — | js |
| mixed/fibonacci | 0.087ms | 0.081ms | 0.051ms | 0.121ms | gc-native |
| mixed/matrix-multiply | 0.111ms | 0.176ms | 0.088ms | — | gc-native |
| mixed/sieve | 0.758ms | 0.946ms | 0.688ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.67x slower | 1.28x slower | — |
| string/concat-long | 2.45x slower | 5.05x slower | — |
| string/indexOf | 21.33x slower | 2.87x slower | — |
| string/includes | 20.03x slower | 2.32x slower | — |
| string/split | 37.75x slower | 4.89x slower | — |
| string/replace | 11.03x slower | 3.15x slower | — |
| string/case-convert | 1239.88x slower | 114.94x slower | — |
| string/substring | 694.44x slower | 7.98x slower | — |
| string/trim | 23.88x slower | 1.33x slower | — |
| string/startsWith-endsWith | 17.40x slower | 1.32x faster | — |
| array/push-pop | 1.08x slower | 1.26x faster | — |
| array/sort-i32 | 3.58x faster | 3.91x faster | — |
| array/map-filter | 1.89x faster | — | — |
| array/reduce | 1.38x faster | — | — |
| array/indexOf | 2.87x slower | 2.86x slower | — |
| array/slice | 1.08x slower | 1.16x faster | — |
| array/reverse | 1.61x faster | 1.62x faster | — |
| array/forEach | 1.94x faster | — | 9.55x faster |
| array/find | 2.82x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 47.62x slower | 2.87x slower | — |
| mixed/text-search | 65.66x slower | 5.21x slower | — |
| mixed/fibonacci | 1.08x faster | 1.71x faster | 1.39x slower |
| mixed/matrix-multiply | 1.59x slower | 1.26x faster | — |
| mixed/sieve | 1.25x slower | 1.10x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.31x faster |
| string/concat-long | 2.06x slower |
| string/indexOf | 7.42x faster |
| string/includes | 8.62x faster |
| string/split | 7.73x faster |
| string/replace | 3.50x faster |
| string/case-convert | 10.79x faster |
| string/substring | 87.02x faster |
| string/trim | 17.93x faster |
| string/startsWith-endsWith | 23.01x faster |
| array/push-pop | 1.36x faster |
| array/sort-i32 | 1.09x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.26x faster |
| array/reverse | 1.00x faster |
| mixed/csv-parse | 16.58x faster |
| mixed/text-search | 12.60x faster |
| mixed/fibonacci | 1.59x faster |
| mixed/matrix-multiply | 2.01x faster |
| mixed/sieve | 1.38x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 283B | 4.0KB | — |
| string/concat-long | 325B | 3.9KB | — |
| string/indexOf | 337B | 4.0KB | — |
| string/includes | 348B | 4.0KB | — |
| string/split | 422B | 4.1KB | — |
| string/replace | 370B | 4.1KB | — |
| string/case-convert | 355B | 4.0KB | — |
| string/substring | 323B | 4.0KB | — |
| string/trim | 283B | 4.0KB | — |
| string/startsWith-endsWith | 436B | 4.2KB | — |
| array/push-pop | 516B | 4.2KB | — |
| array/sort-i32 | 1.7KB | 5.4KB | — |
| array/map-filter | 1.0KB | — | — |
| array/reduce | 567B | — | — |
| array/indexOf | 578B | 4.2KB | — |
| array/slice | 669B | 4.3KB | — |
| array/reverse | 611B | 4.3KB | — |
| array/forEach | 831B | — | 3.6KB |
| array/find | 860B | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 886B | 4.6KB | — |
| mixed/text-search | 734B | 4.6KB | — |
| mixed/fibonacci | 323B | 4.0KB | 3.7KB |
| mixed/matrix-multiply | 1.1KB | 4.7KB | — |
| mixed/sieve | 1.1KB | 4.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 373.2ms | 213.6ms | — |
| string/concat-long | 142.6ms | 144.6ms | — |
| string/indexOf | 136.7ms | 150.7ms | — |
| string/includes | 134.0ms | 132.8ms | — |
| string/split | 134.1ms | 136.9ms | — |
| string/replace | 132.8ms | 128.4ms | — |
| string/case-convert | 129.2ms | 127.4ms | — |
| string/substring | 129.4ms | 124.8ms | — |
| string/trim | 128.5ms | 127.8ms | — |
| string/startsWith-endsWith | 149.3ms | 141.0ms | — |
| array/push-pop | 135.7ms | 136.8ms | — |
| array/sort-i32 | 134.0ms | 137.0ms | — |
| array/map-filter | 132.7ms | — | — |
| array/reduce | 132.1ms | — | — |
| array/indexOf | 130.5ms | 127.1ms | — |
| array/slice | 217.9ms | 149.4ms | — |
| array/reverse | 136.1ms | 137.8ms | — |
| array/forEach | 134.4ms | — | 130.7ms |
| array/find | 137.3ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 138.0ms | 135.1ms | — |
| mixed/text-search | 132.1ms | 227.1ms | — |
| mixed/fibonacci | 146.3ms | 139.0ms | 143.4ms |
| mixed/matrix-multiply | 137.8ms | 145.0ms | — |
| mixed/sieve | 139.3ms | 135.9ms | — |
