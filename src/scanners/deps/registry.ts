export const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org';
export const DEFAULT_DOWNLOADS_URL = 'https://api.npmjs.org/downloads/point/last-week';

const TIMEOUT_MS = 30_000;
const CONCURRENCY = 8;

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface PackageVersion {
  scripts: Record<string, string>;
  maintainers: string[];
  deprecated?: string;
}

export interface Packument {
  latest?: string;
  created?: string;
  unpublished: boolean;
  versions: Record<string, PackageVersion>;
  /** Publish time of each version. */
  times: Record<string, string>;
}

export type Lookup =
  | { status: 'found'; packument: Packument }
  | { status: 'missing' }
  | { status: 'error'; message: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

function maintainerNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((m) => {
    if (typeof m === 'string') return [m.replace(/\s*<.*$/, '')];
    return isObject(m) && typeof m.name === 'string' ? [m.name] : [];
  });
}

/** Keep only what the rules read; full packuments can be tens of megabytes. */
export function toPackument(raw: unknown): Packument {
  const doc = isObject(raw) ? raw : {};
  const time = isObject(doc.time) ? doc.time : {};
  const versions: Record<string, PackageVersion> = {};
  if (isObject(doc.versions)) {
    for (const [version, data] of Object.entries(doc.versions)) {
      const v = isObject(data) ? data : {};
      versions[version] = {
        scripts: strings(v.scripts),
        maintainers: maintainerNames(v.maintainers),
        ...(typeof v.deprecated === 'string' && v.deprecated ? { deprecated: v.deprecated } : {}),
      };
    }
  }
  return {
    latest: strings(doc['dist-tags']).latest,
    created: typeof time.created === 'string' ? time.created : undefined,
    unpublished: time.unpublished !== undefined,
    versions,
    times: strings(time),
  };
}

/** `@scope/name` is requested as `@scope%2fname`. */
function packagePath(name: string): string {
  return encodeURIComponent(name).replace(/^%40/, '@').replace(/%2F/, '%2f');
}

export async function fetchPackument(fetcher: FetchLike, registryUrl: string, name: string): Promise<Lookup> {
  try {
    const res = await fetcher(`${registryUrl}/${packagePath(name)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return { status: 'missing' };
    if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
    return { status: 'found', packument: toPackument(await res.json()) };
  } catch (err) {
    return { status: 'error', message: (err as Error).message };
  }
}

/** Weekly download count, or undefined when it cannot be determined. */
export async function fetchWeeklyDownloads(fetcher: FetchLike, downloadsUrl: string, name: string): Promise<number | undefined> {
  try {
    const res = await fetcher(`${downloadsUrl}/${packagePath(name)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const body = await res.json();
    return isObject(body) && typeof body.downloads === 'number' ? body.downloads : undefined;
  } catch {
    return undefined;
  }
}

/** Map with a limit on simultaneous requests. */
export async function mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>, limit = CONCURRENCY): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
