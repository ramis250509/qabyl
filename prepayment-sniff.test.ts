// What a receipt file actually is, decided from its bytes.
//
// This exists because of a live failure: a client sent a perfectly good MBANK
// screenshot over Instagram and got "Файл такого типа не поддерживается". Meta's
// CDN had served the photo as application/octet-stream, that type was stored on
// the media object, and the allow-list rejected it. The picture was never the
// problem — the label was.
//
// Run: bun test prepayment-sniff.test.ts
import { test, expect } from "bun:test";
import { sniffMime } from "@/lib/prepayment/process.server";

function withHeader(header: number[], totalLen = 64): Uint8Array {
  const out = new Uint8Array(totalLen);
  out.set(header, 0);
  return out;
}

function ascii(s: string, at: number, totalLen = 64): Uint8Array {
  const out = new Uint8Array(totalLen);
  for (let i = 0; i < s.length; i += 1) out[at + i] = s.charCodeAt(i);
  return out;
}

test("recognises a JPEG regardless of what the CDN called it", () => {
  expect(sniffMime(withHeader([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
});

test("recognises a PNG", () => {
  expect(sniffMime(withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
});

test("recognises a PDF", () => {
  expect(sniffMime(withHeader([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe("application/pdf");
});

test("recognises a WEBP by its RIFF container", () => {
  const b = ascii("RIFF", 0);
  b.set(ascii("WEBP", 8).subarray(8, 12), 8);
  expect(sniffMime(b)).toBe("image/webp");
});

test("recognises HEIC from an iPhone", () => {
  expect(sniffMime(ascii("ftypheic", 4))).toBe("image/heic");
});

test("rejects content that is not an accepted file at all", () => {
  // An HTML page renamed to .png — the case the old plausibility check existed
  // for. Sniffing covers it for free: nothing but a real PNG has a PNG header.
  expect(sniffMime(ascii("<!doctype html><html>", 0))).toBeNull();
});

test("rejects a truncated file instead of guessing", () => {
  expect(sniffMime(new Uint8Array([0xff, 0xd8]))).toBeNull();
});
