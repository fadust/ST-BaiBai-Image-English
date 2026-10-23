/**
 * Byte count → human-readable size. The gallery's per-group sizes and grand total share this one rule.
 *
 * Uses base 1024 with KB/MB units (not KiB/MiB), matching Explorer/Finder,
 * so the gallery figures line up when users compare them with what the OS shows.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Formats a short string such as `624 KB` / `1.5 MB` / `11 MB`.
 *
 * Decimals depend on magnitude: below 10 keeps one decimal (1.5 MB says more than 2 MB); 10 and above drops it
 * (the .2 in 11.2 MB is just noise in a badge). Plain bytes get no decimals.
 *
 * Non-finite or negative values return an empty string, leaving the caller to decide what to show. Inventing `0 B` here
 * would disguise "not computed yet" as "computed as empty".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const decimals = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}
