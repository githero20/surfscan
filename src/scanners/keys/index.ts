import { listTargets } from '../../core/runner.js';
import { maskSecret, SECRET_PATTERNS } from '../../core/secret-patterns.js';
import { LineIndex, stripBom } from '../../core/text.js';
import type { Finding, Rule, ScanContext, Scanner, SourceFile, SourceProvider, SurfscanConfig } from '../../core/types.js';
import { findingsFromMatches, matchAll, type TextMatch } from '../shared.js';
import { GitignoreChecker } from './gitignore.js';

export const KEYS_TARGETS = [
  // Env files
  '**/.env',
  '**/.env.*',
  '**/*.env',
  // Agent configs
  '**/.mcp.json',
  '**/.cursor/mcp.json',
  '**/.vscode/mcp.json',
  '**/.claude/settings.json',
  '**/.claude/settings.local.json',
  '**/.codex/config.toml',
  // Credential and config files
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/.git-credentials',
  '**/*.{json,jsonc,yaml,yml,toml,ini,cfg,conf,properties,xml,tf,tfvars}',
  '**/*.{pem,key}',
  '**/id_{rsa,dsa,ecdsa,ed25519}',
];

/** Large generated files that never hold hand-written secrets. */
const KEYS_EXCLUDE = ['**/package-lock.json', '**/npm-shrinkwrap.json', '**/pnpm-lock.yaml', '**/composer.lock'];

export function findKeysTargets(provider: SourceProvider, config: SurfscanConfig): Promise<string[]> {
  return listTargets(provider, config, KEYS_TARGETS, KEYS_EXCLUDE);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `.env`, `.env.local`, `prod.env`, but not templates meant to be committed. */
export function isEnvFile(path: string): boolean {
  const name = basename(path);
  return /^\.env(?:\..+)?$/.test(name) || /\.env$/.test(name);
}

export function isEnvTemplate(path: string): boolean {
  return /(?:^|[.-])(?:example|sample|template|dist|defaults?|schema)(?:$|[.-])/i.test(basename(path));
}

const SECRET_NAME_PARTS = new Set([
  'KEY',
  'APIKEY',
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PASSWD',
  'PASS',
  'PWD',
  'CREDENTIAL',
  'CREDENTIALS',
  'AUTH',
  'PRIVATE',
  'DSN',
]);

function nameParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

export function isSecretName(name: string): boolean {
  return nameParts(name).some(
    (p) => SECRET_NAME_PARTS.has(p) || /(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(p),
  );
}

function isProdName(name: string): boolean {
  return nameParts(name).some((p) => p === 'PROD' || p === 'PRODUCTION');
}

const PLACEHOLDER =
  /^(?:|x+|\*+|\.+|-+|changeme|change[-_]me|replace[-_]?me|todo|tbd|placeholder|null|none|nil|undefined|true|false|dummy|redacted|secret|password)$|^<.*>$|^\$\{.*\}$|^\$[A-Za-z_]\w*$|^\{\{.*\}\}$|^%\w+%$|^your[-_]|example/i;

/** A value that plausibly is a real credential rather than a placeholder. */
export function isRealValue(value: string): boolean {
  return value.length >= 8 && !PLACEHOLDER.test(value);
}

const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:([^@/\s]+)@/i;

export interface Assignment {
  name: string;
  value: string;
  /** Offset of the value in the file. */
  index: number;
}

// NAME=value, NAME: value, "NAME": "value", name = "value" (env, YAML, JSON, TOML, INI, HCL)
const ASSIGNMENT =
  /(?:^|[\s{,])(?:export\s+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*[:=][ \t]*(?:"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'|([^\s,#;}\]]+))/gm;

export function findAssignments(text: string): Assignment[] {
  const out: Assignment[] = [];
  for (const m of matchAll(ASSIGNMENT, text)) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    const valueIndex = m.index + m[0].length - value.length - (m[4] === undefined ? 1 : 0);
    out.push({ name: m[1]!, value, index: Math.max(m.index, valueIndex) });
  }
  return out;
}

function hasSecret(file: SourceFile): Assignment | TextMatch | undefined {
  for (const a of findAssignments(file.content)) {
    if (isSecretName(a.name) && isRealValue(a.value)) return a;
    if (URL_WITH_PASSWORD.test(a.value)) return a;
  }
  for (const { regex } of SECRET_PATTERNS) {
    const m = new RegExp(regex.source, regex.flags.replace('g', '')).exec(file.content);
    if (m && !/example/i.test(m[0])) return { index: m.index, detail: '' };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// KEYS-001: live or production keys
// ---------------------------------------------------------------------------

export function findLiveKeys(text: string): TextMatch[] {
  const out: TextMatch[] = [];
  for (const { name, regex } of SECRET_PATTERNS) {
    for (const m of matchAll(regex, text)) {
      // AWS and others publish example keys (AKIAIOSFODNN7EXAMPLE) for docs.
      if (/example/i.test(m[0])) continue;
      const shown = name === 'PEM private key' ? 'BEGIN ... PRIVATE KEY' : maskSecret(m[0]);
      out.push({ index: m.index, detail: `${name} ${shown}` });
    }
  }
  for (const a of findAssignments(text)) {
    if (!isProdName(a.name)) continue;
    const credentialUrl = URL_WITH_PASSWORD.exec(a.value);
    if ((isSecretName(a.name) && isRealValue(a.value)) || credentialUrl) {
      out.push({ index: a.index, detail: `production credential ${a.name}=${maskSecret(a.value)}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// KEYS-003: wildcard or admin cloud policies
// ---------------------------------------------------------------------------

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

/** Walk parsed JSON for IAM-style statements that allow every action on every resource. */
function findWildcardStatements(node: unknown, found: object[] = []): object[] {
  if (Array.isArray(node)) {
    for (const item of node) findWildcardStatements(item, found);
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const effect = obj.Effect ?? obj.effect;
    const actions = asList(obj.Action ?? obj.action ?? obj.actions);
    const resources = asList(obj.Resource ?? obj.resource ?? obj.resources);
    if ((effect === undefined || effect === 'Allow') && actions.includes('*') && resources.includes('*')) {
      found.push(obj);
    }
    for (const value of Object.values(obj)) findWildcardStatements(value, found);
  }
  return found;
}

const ACTION_STAR = /["']?\b(?:Action|actions)\b["']?\s*[:=]\s*\[?\s*(?:-\s*)?["']\*["']/gi;
const RESOURCE_STAR = /["']?\b(?:Resource|resources)\b["']?\s*[:=]\s*\[?\s*(?:-\s*)?["']\*["']/i;
const ADMIN_POLICY = /\barn:aws:iam::aws:policy\/AdministratorAccess\b|["'\s/]AdministratorAccess["'\s]|\broles\/(?:owner|editor)\b/g;

export function findAdminPolicies(path: string, text: string): TextMatch[] {
  const out: TextMatch[] = [];
  let parsedJson = false;
  if (/\.json$/i.test(path)) {
    try {
      const data: unknown = JSON.parse(stripBom(text));
      parsedJson = true;
      if (findWildcardStatements(data).length > 0) {
        for (const m of matchAll(ACTION_STAR, text)) {
          out.push({ index: m.index, detail: 'statement allows Action "*" on Resource "*"' });
        }
        if (out.length === 0) out.push({ index: 0, detail: 'statement allows Action "*" on Resource "*"' });
      }
    } catch {
      // Not valid JSON; fall through to the text check below.
    }
  }
  if (!parsedJson) {
    // YAML, HCL, or invalid JSON: Action "*" with Resource "*" within the next 300 characters.
    for (const m of matchAll(ACTION_STAR, text)) {
      const window = text.slice(Math.max(0, m.index - 300), m.index + 300);
      if (RESOURCE_STAR.test(window)) out.push({ index: m.index, detail: 'statement allows Action "*" on Resource "*"' });
    }
  }
  for (const m of matchAll(ADMIN_POLICY, text)) {
    const what = /roles\//.test(m[0]) ? `GCP basic role ${m[0].trim()}` : 'AWS AdministratorAccess policy';
    out.push({ index: m.index + (/^["'\s/]/.test(m[0]) ? 1 : 0), detail: what });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const rules: Rule[] = [
  {
    id: 'KEYS-001',
    severity: 'high',
    title: 'Live or production key in a file the agent can read',
    check(context: ScanContext): Finding[] {
      const out: Finding[] = [];
      for (const file of context.files) {
        const matches = findLiveKeys(file.content);
        out.push(
          ...findingsFromMatches(
            this,
            file,
            matches,
            (d) => `Live key the agent can read: ${d}`,
            'move the key to a secret manager or a file outside the project, rotate it, and give agents a scoped test key instead',
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'KEYS-002',
    severity: 'high',
    title: 'Env file with secrets not covered by .gitignore',
    async check(context: ScanContext): Promise<Finding[]> {
      const checker = new GitignoreChecker(context.provider);
      const out: Finding[] = [];
      for (const file of context.files) {
        if (!isEnvFile(file.path) || isEnvTemplate(file.path)) continue;
        const secret = hasSecret(file);
        if (!secret) continue;
        if (await checker.isIgnored(file.path)) continue;
        const pos = new LineIndex(file.content).positionOf(secret.index);
        out.push({
          ruleId: this.id,
          severity: this.severity,
          message: 'Env file with secrets is not covered by .gitignore',
          file: file.path,
          line: pos.line,
          fix: `add ${basename(file.path)} (or .env*) to .gitignore; if it was ever committed, rotate the secrets`,
        });
      }
      return out;
    },
  },
  {
    id: 'KEYS-003',
    severity: 'medium',
    title: 'Wildcard or admin scope in cloud policy',
    check(context: ScanContext): Finding[] {
      const out: Finding[] = [];
      for (const file of context.files) {
        const matches = findAdminPolicies(file.path, file.content);
        out.push(
          ...findingsFromMatches(
            this,
            file,
            matches,
            (d) => `Over-scoped cloud permission: ${d}`,
            'grant only the actions and resources the task needs; keep admin roles away from keys agents can use',
          ),
        );
      }
      return out;
    },
  },
];

export const keysScanner: Scanner = {
  name: 'keys',
  rules,
  findTargets: findKeysTargets,
};
