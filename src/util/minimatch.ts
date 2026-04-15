/**
 * Minimal glob matcher — supports * (any chars except /) and ** (any chars).
 * Sufficient for the exclude-patterns feature.
 */
export function minimatch(path: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex special chars
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__GLOBSTAR__/g, ".*");
  return new RegExp(`^${regexStr}$`).test(path);
}
