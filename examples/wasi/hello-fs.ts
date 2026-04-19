import { writeFileSync } from "node:fs";

console.log("hello world");
writeFileSync("hello.txt", "hello world\n");
