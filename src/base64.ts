/**
 * Shared base64 encoding.
 *
 * Why TextEncoder instead of `btoa(text)`: btoa takes a latin1 binary string and
 * throws InvalidCharacterError for code points > 255. Prompts and character names are full of CJK text,
 * so a direct btoa would crash on image save. Encoding to UTF-8 bytes first, then mapping each byte to latin1, is the safe path.
 *
 * Chunked concatenation prevents stack overflow: String.fromCharCode(...bytes) spreading an array of several MB at once
 * exceeds the argument-count limit.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}
