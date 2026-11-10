import { normalizeBranch } from '../../core/text.js';

/**
 * Decides whether a shell allow pattern lets an agent run destructive or
 * arbitrary commands. Agent-neutral: patterns use `*` as "any text".
 */

/** Representative destructive commands. A pattern that matches one of these allows it. */
export const DESTRUCTIVE_SAMPLES: ReadonlyArray<{ command: string; label: string }> = [
  { command: 'rm -rf /', label: 'recursive delete' },
  { command: 'rm -rf ~', label: 'recursive delete' },
  { command: 'rm -fr ./build', label: 'recursive delete' },
  { command: 'git reset --hard origin/main', label: 'discard local work' },
  { command: 'git clean -fdx', label: 'discard local work' },
  { command: 'aws s3 rb s3://bucket --force', label: 'cloud resource deletion' },
  { command: 'aws s3 rm s3://bucket --recursive', label: 'cloud resource deletion' },
  { command: 'aws ec2 terminate-instances --instance-ids i-0', label: 'cloud resource deletion' },
  { command: 'aws rds delete-db-instance --db-instance-identifier db', label: 'cloud resource deletion' },
  { command: 'aws cloudformation delete-stack --stack-name app', label: 'cloud resource deletion' },
  { command: 'gcloud projects delete my-project', label: 'cloud resource deletion' },
  { command: 'gcloud compute instances delete vm-1', label: 'cloud resource deletion' },
  { command: 'gcloud sql instances delete db', label: 'cloud resource deletion' },
  { command: 'az group delete --name rg --yes', label: 'cloud resource deletion' },
  { command: 'kubectl delete namespace prod', label: 'cloud resource deletion' },
  { command: 'terraform destroy -auto-approve', label: 'cloud resource deletion' },
  { command: 'pulumi destroy --yes', label: 'cloud resource deletion' },
  { command: 'psql -c "DROP DATABASE app"', label: 'database drop' },
  { command: 'mysql -e "DROP DATABASE app"', label: 'database drop' },
  { command: 'dropdb app', label: 'database drop' },
  { command: 'mongosh --eval "db.dropDatabase()"', label: 'database drop' },
  { command: 'redis-cli FLUSHALL', label: 'database drop' },
  { command: 'Remove-Item -Recurse -Force C:\\', label: 'recursive delete' },
];

/** Destructive commands written directly into the pattern. */
const DESTRUCTIVE_TEXT: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|-r\s+-f|-f\s+-r)\b|\brm\b.*--recursive/i, label: 'recursive delete' },
  { re: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f)/, label: 'discard local work' },
  { re: /\b(?:drop\s+(?:database|table|schema)|truncate\s+table|dropdb|dropdatabase|flushall|flushdb)\b/i, label: 'database drop' },
  {
    re: /\b(?:aws|gcloud|az|kubectl|terraform|pulumi|doctl|heroku|flyctl|vercel)\b.*\b(?:delete|destroy|terminate|rb|rm|remove|purge)\b/i,
    label: 'cloud resource deletion',
  },
  { re: /\bRemove-Item\b.*-Recurse/i, label: 'recursive delete' },
];

/**
 * Convert an allow pattern to a regex. `*` matches any text; a trailing ` *`
 * (or the legacy `:*`) that is the only wildcard also matches the bare command.
 */
export function patternToRegex(pattern: string): RegExp {
  let p = pattern.trim();
  if (p.endsWith(':*')) p = `${p.slice(0, -2)} *`;
  const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const stars = (p.match(/\*/g) ?? []).length;
  if (stars === 1 && p.endsWith(' *')) {
    return new RegExp(`^${escape(p.slice(0, -2))}(?: [\\s\\S]*)?$`);
  }
  return new RegExp(`^${p.split('*').map(escape).join('[\\s\\S]*')}$`);
}

/**
 * Shells, launchers, language runtimes and package runners. Each runs any
 * command or code given to it, so `<launcher> *` allows anything.
 */
const LAUNCHERS =
  /^(?:sudo|doas|sh|bash|zsh|fish|dash|ksh|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?|eval|exec|env|xargs|nohup|command|builtin|nice|timeout|watch|python[0-9.]*|py|node|deno|bun|ruby|perl|php|lua|Rscript|osascript|npx|bunx|uvx|pipx\s+run)(?:\s+(?:-c|\/c|-Command|-e|--eval|run))?\s*(?::\*|\*|\s\*)$/i;

/** True when the pattern allows any command: `*`, a leading `*`, or a launcher with a wildcard. */
export function isWildcardShell(command: string | undefined): boolean {
  if (command === undefined) return true;
  const c = command.trim();
  return /^[\s*:]*$/.test(c) || c.startsWith('*') || LAUNCHERS.test(c);
}

/** Branches that are always protected. `appr.protectedBranches` adds to these. */
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ['main', 'master', 'develop', 'trunk', 'production', 'release/*'];

const globRegex = (glob: string) => new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/** True when two branch globs can match the same name. */
function globsOverlap(a: string, b: string): boolean {
  const ra = globRegex(a);
  const rb = globRegex(b);
  return [b.replace(/\*/g, 'x'), b.replace(/\*/g, '')].some((s) => ra.test(s)) || [a.replace(/\*/g, 'x'), a.replace(/\*/g, '')].some((s) => rb.test(s));
}

const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
const PUSH_LONG = ['force', 'force-with-lease', 'force-if-includes', 'delete', 'all', 'mirror', 'tags', 'repo', 'receive-pack', 'exec', 'push-option', 'dry-run', 'set-upstream', 'verbose', 'quiet', 'follow-tags', 'no-verify', 'atomic', 'prune', 'thin', 'progress'];
const PUSH_LONG_WITH_VALUE = new Set(['repo', 'receive-pack', 'exec', 'push-option']);
const BRANCH_LONG = ['delete', 'remotes', 'force', 'list', 'move', 'copy', 'all', 'verbose', 'quiet'];

/** Resolve a long option name, allowing git's unique-prefix abbreviations. */
function resolveLong(name: string, known: string[]): string | undefined {
  if (known.includes(name)) return name;
  const matches = known.filter((k) => k.startsWith(name));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 && matches.every((m) => m.startsWith('force'))) return 'force';
  return undefined;
}

interface GitArgs {
  /** Long options and short option letters seen, long ones resolved. */
  flags: Set<string>;
  positionals: string[];
}

function parseGitArgs(tokens: string[], long: string[], longWithValue: Set<string>, shortWithValue: string): GitArgs {
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith('--') && t.length > 2) {
      const [rawName] = t.slice(2).split('=', 1);
      const name = resolveLong(rawName!, long) ?? rawName!;
      flags.add(name);
      if (longWithValue.has(name) && !t.includes('=')) i++;
    } else if (t.startsWith('-') && t.length > 1) {
      for (let c = 1; c < t.length; c++) {
        const ch = t[c]!;
        flags.add(`-${ch}`);
        if (shortWithValue.includes(ch)) {
          if (c === t.length - 1) i++;
          break;
        }
      }
    } else {
      positionals.push(t);
    }
  }
  return { flags, positionals };
}

/** The branch a push refspec writes to, or undefined for non-branch refs. */
function refspecTarget(spec: string): string | undefined {
  const dst = normalizeBranch(spec.replace(/^\+/, '').split(':').pop() ?? '');
  if (dst.startsWith('refs/') || dst.startsWith('tags/')) return undefined;
  return dst;
}

function reachesProtected(targets: Array<string | undefined>, protectedBranches: readonly string[]): boolean {
  return targets.some(
    (t) => t !== undefined && (t === '' || t === 'head' || protectedBranches.some((p) => globsOverlap(t, normalizeBranch(p)))),
  );
}

function gitSegmentMatch(tokens: string[], protectedBranches: readonly string[]): string | undefined {
  let i = tokens.findIndex((t) => /(?:^|[\\/])git(?:\.exe)?$/i.test(t));
  if (i < 0) return undefined;
  for (i++; i < tokens.length && tokens[i]!.startsWith('-'); i++) {
    if (GIT_GLOBAL_WITH_VALUE.has(tokens[i]!)) i++;
  }
  const sub = tokens[i];
  const rest = tokens.slice(i + 1);

  if (sub === 'push') {
    const { flags, positionals } = parseGitArgs(rest, PUSH_LONG, PUSH_LONG_WITH_VALUE, 'o');
    const refs = flags.has('repo') ? positionals : positionals.slice(1);
    const hasDelete = flags.has('delete') || flags.has('-d') || refs.some((r) => r.startsWith(':'));
    const hasForce =
      flags.has('force') || flags.has('force-with-lease') || flags.has('mirror') || flags.has('-f') || refs.some((r) => r.startsWith('+'));
    if (!hasDelete && !hasForce) return undefined;
    if (flags.has('tags') && refs.length === 0) return undefined;
    const risky = refs.length === 0 || reachesProtected(refs.map(refspecTarget), protectedBranches);
    return risky ? (hasDelete ? 'protected branch deletion' : 'force push') : undefined;
  }

  if (sub === 'branch') {
    const { flags, positionals } = parseGitArgs(rest, BRANCH_LONG, new Set(), '');
    if (!flags.has('delete') && !flags.has('-d') && !flags.has('-D')) return undefined;
    const names = positionals.map((p) => (flags.has('remotes') || flags.has('-r') ? p.replace(/^[^/]*\//, '') : p)).map(normalizeBranch);
    return names.length === 0 || reachesProtected(names, protectedBranches) ? 'protected branch deletion' : undefined;
  }
  return undefined;
}

/**
 * Force pushes and branch deletions are only a problem on protected branches.
 * A rule is flagged when it contains a force or delete form and can reach one.
 */
export function protectedBranchMatch(command: string, protectedBranches: readonly string[] = DEFAULT_PROTECTED_BRANCHES): string | undefined {
  const c = command.trim().replace(/:\*$/, ' *');
  for (const segment of c.split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']+|["']+$/g, ''));
    const why = gitSegmentMatch(tokens, protectedBranches);
    if (why) return why;
  }
  return undefined;
}

/** Returns why the pattern allows a destructive command, or undefined. */
export function destructiveMatch(command: string, protectedBranches: readonly string[] = DEFAULT_PROTECTED_BRANCHES): string | undefined {
  for (const { re, label } of DESTRUCTIVE_TEXT) {
    if (re.test(command)) return label;
  }
  const protectedWhy = protectedBranchMatch(command, protectedBranches);
  if (protectedWhy) return protectedWhy;
  const regex = patternToRegex(command);
  for (const sample of DESTRUCTIVE_SAMPLES) {
    if (regex.test(sample.command)) return `${sample.label}, for example \`${sample.command}\``;
  }
  return undefined;
}
