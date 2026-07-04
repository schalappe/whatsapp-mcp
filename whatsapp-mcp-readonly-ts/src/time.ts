/**
 * @module time
 * Collector stores second-precision RFC 3339 UTC ("2026-07-04T12:34:56Z") -> string sort == time sort.
 * User dates normalized to same shape before SQL comparison.
 */
export function normalizeTimestamp(input: string, param: string): string {
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) {
    throw new Error(
      `invalid ${param}: ${JSON.stringify(input)} is not a parseable date`,
    );
  }
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
