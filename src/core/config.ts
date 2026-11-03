import type { SurfscanConfig } from './types.js';

export const CONFIG_FILE_NAME = 'surfscan.json';

export const DEFAULT_CONFIG: SurfscanConfig = {
  ignore: [],
  ignorePaths: [],
  deps: { minAgeDays: 30 },
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const TOP_LEVEL_KEYS = ['ignore', 'ignorePaths', 'deps'];
const DEPS_KEYS = ['minAgeDays'];
const RULE_ID = /^[A-Z]+-\d{3}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkKeys(obj: Record<string, unknown>, allowed: string[], where: string, source: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(
        `${source}: unknown key "${where}${key}". Allowed keys: ${allowed.map((k) => where + k).join(', ')}`,
      );
    }
  }
}

function stringArray(value: unknown, name: string, source: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new ConfigError(`${source}: "${name}" must be an array of strings`);
  }
  return value as string[];
}

/** Validate a parsed config object and merge it over the defaults. */
export function validateConfig(raw: unknown, source = CONFIG_FILE_NAME): SurfscanConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${source}: config must be a JSON object`);
  }
  checkKeys(raw, TOP_LEVEL_KEYS, '', source);

  const config: SurfscanConfig = {
    ignore: [...DEFAULT_CONFIG.ignore],
    ignorePaths: [...DEFAULT_CONFIG.ignorePaths],
    deps: { ...DEFAULT_CONFIG.deps },
  };

  if (raw.ignore !== undefined) {
    config.ignore = stringArray(raw.ignore, 'ignore', source);
    for (const id of config.ignore) {
      if (!RULE_ID.test(id)) {
        throw new ConfigError(`${source}: "ignore" entry "${id}" is not a rule ID (expected something like RULES-001)`);
      }
    }
  }

  if (raw.ignorePaths !== undefined) {
    config.ignorePaths = stringArray(raw.ignorePaths, 'ignorePaths', source);
  }

  if (raw.deps !== undefined) {
    if (!isPlainObject(raw.deps)) {
      throw new ConfigError(`${source}: "deps" must be an object`);
    }
    checkKeys(raw.deps, DEPS_KEYS, 'deps.', source);
    const { minAgeDays } = raw.deps;
    if (minAgeDays !== undefined) {
      if (typeof minAgeDays !== 'number' || !Number.isInteger(minAgeDays) || minAgeDays < 0) {
        throw new ConfigError(`${source}: "deps.minAgeDays" must be a non-negative integer`);
      }
      config.deps.minAgeDays = minAgeDays;
    }
  }

  return config;
}

/** Parse and validate the text of a surfscan.json file. */
export function parseConfig(text: string, source = CONFIG_FILE_NAME): SurfscanConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${source}: invalid JSON (${(err as Error).message})`);
  }
  return validateConfig(raw, source);
}

/**
 * Load a config file through the given reader. Resolves to the defaults when
 * the file does not exist and `required` is false.
 */
export async function loadConfig(
  read: (path: string) => Promise<string | undefined>,
  path: string,
  required: boolean,
): Promise<SurfscanConfig> {
  const text = await read(path);
  if (text === undefined) {
    if (required) throw new ConfigError(`config file not found: ${path}`);
    return validateConfig({});
  }
  return parseConfig(text, path);
}
