/**
 * UUID v4 without Web Crypto: ST often runs in an insecure context (http),
 * where crypto.randomUUID throws outright. The random part of vibe cache keys/file names
 * only prevents collisions and needs no cryptographic strength, so Math.random is enough.
 */
export function randomUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}
