import test from "node:test";
import assert from "node:assert/strict";
import { decodeZstd, protoFields } from "../src/interchange/modern";

// Synthetic headers exercise rejection before decoder frame/window allocation.
test("Anki rejects excessive Zstandard windows before decoding", () => {
  const frame = Uint8Array.from([0x28,0xb5,0x2f,0xfd,0,0xff,1,0,0]);
  assert.throws(() => decodeZstd(frame), /exceeds/);
});
test("Anki bounds total size across concatenated compressed frames", () => {
  const frame = Uint8Array.from([0x28,0xb5,0x2f,0xfd,0xa0,0,0,0,2,1,0,0]);
  const joined = new Uint8Array(frame.length * 2); joined.set(frame); joined.set(frame,frame.length);
  assert.throws(() => decodeZstd(joined), /exceeds/);
});
test("Anki metadata bounds field amplification and malformed wire data", () => {
  const bytes = new Uint8Array(200002);
  for(let i=0;i<bytes.length;i+=2) { bytes[i]=8; bytes[i+1]=0; }
  assert.throws(() => protoFields(bytes), /too many fields/);
  assert.throws(() => protoFields(Uint8Array.from([10,127])), /Truncated/);
  assert.throws(() => protoFields(Uint8Array.from([15])), /Unsupported/);
});
