// File / perceptual hashes for anti-reuse of prepayment receipts.
// Runs on the server (Cloudflare Worker) using Web Crypto — no Node deps.

// sha256 of the raw uploaded bytes. Renames, extension changes and metadata
// edits do NOT change this; re-encoding, re-compressing or cropping DO change
// it, which is why we ALSO compute a perceptual hash for image receipts.
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  // Web Crypto wants a BufferSource. Uint8Array's underlying buffer may be a
  // SharedArrayBuffer in some runtimes — copy into a plain Uint8Array first.
  const view: Uint8Array = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view as unknown as BufferSource);
  return bufferToHex(new Uint8Array(digest));
}

function bufferToHex(buf: Uint8Array): string {
  const parts = new Array<string>(buf.length);
  for (let i = 0; i < buf.length; i += 1) parts[i] = buf[i].toString(16).padStart(2, "0");
  return parts.join("");
}

// Very small perceptual-hash approximation of aHash: shrink the image to 8×8
// grayscale, then bit-encode "pixel > mean" for each pixel. Same-looking crops,
// re-saves and JPEG re-encodes produce hashes within ~5 bits Hamming distance,
// so the DB check uses phash prefix match + Hamming distance comparison in JS.
//
// We accept a pre-decoded pixel matrix; the decoding itself needs an image
// codec that isn't available in a Cloudflare Worker. See extract-vision.ts for
// how we get the pixels (via canvas in the isolated OffscreenCanvas path, or
// via Gemini's returned bounding-box preview as a fallback).
export function aHash8(gray8x8: Uint8Array): string {
  if (gray8x8.length !== 64) throw new Error("aHash8 expects 64 grayscale bytes");
  let sum = 0;
  for (let i = 0; i < 64; i += 1) sum += gray8x8[i];
  const mean = sum / 64;
  let bits = 0n;
  for (let i = 0; i < 64; i += 1) {
    if (gray8x8[i] >= mean) bits |= 1n << BigInt(63 - i);
  }
  return bits.toString(16).padStart(16, "0");
}

// Hamming distance between two 16-hex-char aHashes. Two receipts photographed
// from slightly different angles or JPEG-re-encoded still produce distance ≤ 5.
export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) {
    const na = parseInt(a[i], 16);
    const nb = parseInt(b[i], 16);
    let xor = (na ^ nb) & 0xf;
    while (xor) {
      d += xor & 1;
      xor >>= 1;
    }
  }
  return d;
}
