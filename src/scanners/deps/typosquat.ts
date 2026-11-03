import popular from './popular-packages.json' with { type: 'json' };

const POPULAR_PACKAGES: readonly string[] = popular;
const POPULAR = new Set(POPULAR_PACKAGES);
/** Below this length one edit changes too much of the name to mean anything. */
const MIN_LENGTH = 5;

/** Levenshtein distance of at most 1, counting an adjacent swap as one edit. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  const restA = a.slice(start);
  const restB = b.slice(start);
  if (restA === restB) return true;
  if (restA.slice(1) === restB.slice(1)) return true;
  if (restA.slice(1) === restB || restA === restB.slice(1)) return true;
  return restA.length >= 2 && restA[0] === restB[1] && restA[1] === restB[0] && restA.slice(2) === restB.slice(2);
}

const withoutSeparators = (name: string): string => name.replace(/[-_.]/g, '');

/** The popular package this name looks like a misspelling of, if any. */
export function typosquatTarget(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (POPULAR.has(lower)) return undefined;
  return POPULAR_PACKAGES.find(
    (target) =>
      target.length >= MIN_LENGTH && (withinOneEdit(lower, target) || withoutSeparators(lower) === withoutSeparators(target)),
  );
}
