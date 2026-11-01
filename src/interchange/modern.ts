import { Decompress } from "fzstd";

const LIMIT = 32 * 1024 * 1024;
/** Streaming output is bounded before joining; archives never write outside memory. */
export function decodeZstd(bytes: Uint8Array, limit = LIMIT): Uint8Array {
  if (limit <= 0 || limit > LIMIT) throw new Error("Invalid decompression limit.");
  preflightZstd(bytes, limit);
  const parts: Uint8Array[] = []; let size = 0;
  const stream = new Decompress(chunk => { size += chunk.length; if (size > limit) throw new Error("The decompressed deck exceeds 32 MiB."); parts.push(chunk.slice()); });
  for (let offset = 0; offset < bytes.length; offset += 65536) stream.push(bytes.subarray(offset, offset + 65536), offset + 65536 >= bytes.length);
  const result = new Uint8Array(size); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
/** Only the wire primitives needed for Anki metadata; never executes a template. */
export function protoFields(bytes: Uint8Array): Map<number, Array<number | Uint8Array>> {
  if (bytes.length > LIMIT) throw new Error("Anki metadata is too large.");
  let offset = 0; const result = new Map<number, Array<number | Uint8Array>>();
  const variable = (): number => { let value = 0; let factor = 1; for (let count = 0; count < 10; count++) { const byte = bytes[offset++]; if (byte === undefined) throw new Error("Truncated Anki metadata."); value += (byte & 127) * factor; if (!(byte & 128)) { if (!Number.isSafeInteger(value)) throw new Error("Anki metadata integer is too large."); return value; } factor *= 128; } throw new Error("Invalid Anki metadata integer."); };
  let count = 0;
  while (offset < bytes.length) {
    if (++count > 100000) throw new Error("Anki metadata has too many fields.");
    const key = variable(); const field = Math.floor(key / 8); const wire = key & 7;
    if (!field) throw new Error("Invalid Anki metadata field.");
    let value: number | Uint8Array;
    if (wire === 0) value = variable();
    else if (wire === 2) { const length = variable(); if (length > bytes.length - offset) throw new Error("Truncated Anki metadata field."); value = bytes.slice(offset, offset + length); offset += length; }
    else if (wire === 1 || wire === 5) { offset += wire === 1 ? 8 : 4; if (offset > bytes.length) throw new Error("Truncated Anki metadata field."); continue; }
    else throw new Error("Unsupported Anki metadata encoding.");
    const entries = result.get(field) ?? []; entries.push(value); result.set(field, entries);
  }
  return result;
}

/** Validate every frame before fzstd can allocate its declared window. */
function preflightZstd(bytes: Uint8Array, limit: number): void {
  let offset = 0; let frames = 0; let declaredTotal = 0;
  const read = (length: number): number => { if (length > bytes.length - offset) throw new Error("Truncated compressed deck."); let result = 0; let multiplier = 1; for (let i = 0; i < length; i++) { result += bytes[offset++] * multiplier; multiplier *= 256; } if (!Number.isSafeInteger(result)) throw new Error("Compressed deck declares an excessive size."); return result; };
  while (offset < bytes.length) {
    if (++frames > 100) throw new Error("The deck contains too many compression frames.");
    if (read(4) !== 0xfd2fb528) throw new Error("Unsupported compression frame.");
    const descriptor = read(1); const single = !!(descriptor & 32); const flag = descriptor >>> 6;
    if (descriptor & 8) throw new Error("Invalid compression frame descriptor.");
    let window = 0;
    if (!single) { const encoded = read(1); const base = 2 ** (10 + (encoded >>> 3)); window = base + base / 8 * (encoded & 7); }
    const dictionary = descriptor & 3; read(dictionary === 3 ? 4 : dictionary);
    const sizeBytes = flag ? 2 ** flag : single ? 1 : 0;
    const contentSize = read(sizeBytes) + (flag === 1 ? 256 : 0);
    declaredTotal += contentSize;
    if (window > limit || contentSize > limit || declaredTotal > limit) throw new Error("The decompressed deck exceeds 32 MiB.");
    let last = false;
    while (!last) { const header = read(3); last = !!(header & 1); const type = (header >>> 1) & 3; const length = header >>> 3; if (type === 3) throw new Error("Invalid compressed block."); const stored = type === 1 ? 1 : length; if (stored > bytes.length - offset) throw new Error("Truncated compressed deck."); offset += stored; }
    if (descriptor & 4) read(4);
  }
  if (!frames) throw new Error("The compressed deck is empty.");
}
