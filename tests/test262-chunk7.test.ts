/** Test262 chunk 7/8 — vitest distributes by file, so 8 files = 8 forks. */
import { TEST_CATEGORIES } from "./test262-runner.js";
import { runTest262Categories } from "./test262-shared.js";

const TOTAL_CHUNKS = 8;
const CHUNK_INDEX = 6;
const chunkSize = Math.ceil(TEST_CATEGORIES.length / TOTAL_CHUNKS);
const categories = TEST_CATEGORIES.slice(
  CHUNK_INDEX * chunkSize,
  (CHUNK_INDEX + 1) * chunkSize,
);
runTest262Categories(categories);
