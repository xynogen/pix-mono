import assert from "node:assert/strict";
import xxhash from "xxhash-wasm";

const { h32, h32Raw } = await xxhash();
// Official xxHash v0.8.3 tests/sanity_test_vectors.h, empty-input vectors.
assert.equal(h32("", 0), 0x02cc5d05);
assert.equal(h32("", 0x9e3779b1), 0x36b78ae7);
for (const text of ["", "hello", "中文🙂", " a ", "\tconst x = 1;  "]) {
	assert.equal(h32(text, 0), h32Raw(new TextEncoder().encode(text), 0));
	console.log(`${(h32(text, 0) & 0xfff).toString(16).toUpperCase().padStart(3, "0")}|${text}`);
}
