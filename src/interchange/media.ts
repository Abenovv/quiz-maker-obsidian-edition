import type { QuestionMedia } from "../core/types";
export interface PackageImage { name: string; bytes: Uint8Array; mimeType: NonNullable<QuestionMedia["mimeType"]>; questionIndices: number[] }
export function imageMime(bytes: Uint8Array): PackageImage["mimeType"] | undefined {
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) return;
  const ascii = (start: number, length: number): string => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length >= 8 && bytes[0] === 137 && ascii(1, 3) === "PNG" && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  return;
}
