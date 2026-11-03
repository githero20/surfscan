/**
 * Decides whether a shell allow pattern lets an agent run destructive or
 * arbitrary commands. Agent-neutral: patterns use `*` as "any text".
 */

/** Representative destructive commands. A pattern that matches one of these allows it. */
export const DESTRUCTIVE_SAMPLES: ReadonlyArray<{ command: string; label: string }> = [
  { command: 'rm -rf /', label: 'recursive delete' },
  { command: 'rm -rf ~', label: 'recursive delete' },
  { command: 'rm -fr ./build', label: 'recursive delete' },
  { command: 'git push --force origin main', label: 'force push' },
  { command: 'git push -f origin main', label: 'force push' },
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
  { re: /\bgit\s+push\b.*(?:--force\b|--force-with-lease\b|\s-f\b|\s\+\S)/, label: 'force push' },
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

/** Launchers that run any command given to them. */
const LAUNCHERS =
  /^(?:sudo|doas|sh|bash|zsh|fish|dash|ksh|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?|eval|exec|env|xargs|nohup|command|builtin|nice|timeout|watch)(?:\s+(?:-c|\/c|-Command|-e))?\s*(?::\*|\*|\s\*)$/i;

/** True when the pattern allows any command: `*`, a leading `*`, or a shell launcher with a wildcard. */
export function isWildcardShell(command: string | undefined): boolean {
  if (command === undefined) return true;
  const c = command.trim();
  return /^[\s*:]*$/.test(c) || c.startsWith('*') || LAUNCHERS.test(c);
}

/** Returns why the pattern allows a destructive command, or undefined. */
export function destructiveMatch(command: string): string | undefined {
  for (const { re, label } of DESTRUCTIVE_TEXT) {
    if (re.test(command)) return label;
  }
  const regex = patternToRegex(command);
  for (const sample of DESTRUCTIVE_SAMPLES) {
    if (regex.test(sample.command)) return `${sample.label}, for example \`${sample.command}\``;
  }
  return undefined;
}
