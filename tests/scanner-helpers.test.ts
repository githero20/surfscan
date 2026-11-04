import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter, parseRule } from '../src/scanners/approvals/adapters/claude-code.js';
import { destructiveMatch, DESTRUCTIVE_SAMPLES, isWildcardShell, patternToRegex } from '../src/scanners/approvals/destructive.js';
import {
  findAdminPolicies,
  findAssignments,
  findLiveKeys,
  isEnvFile,
  isEnvTemplate,
  isRealValue,
  isSecretName,
} from '../src/scanners/keys/index.js';
import { dockerImage, isBroadPath, remoteProblem, unpinnedTarget } from '../src/scanners/mcp/index.js';
import type { McpServer } from '../src/scanners/mcp/config.js';
import { parseMcpConfig } from '../src/scanners/mcp/config.js';
import { FAKE } from './helpers.js';

describe('keys: file classification', () => {
  it.each(['.env', '.env.local', '.env.production', 'apps/web/.env', 'config/prod.env', '.env.development.local'])('%s is an env file', (path) => {
    expect(isEnvFile(path)).toBe(true);
  });

  it.each(['env.ts', 'config.json', 'src/environment.js', '.envrc', 'dotenv', 'README.md'])('%s is not an env file', (path) => {
    expect(isEnvFile(path)).toBe(false);
  });

  it.each(['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults', '.env.schema', 'config/example.env', '.env.local.example'])(
    '%s is a template meant to be committed',
    (path) => {
      expect(isEnvTemplate(path)).toBe(true);
    },
  );

  it.each(['.env', '.env.local', '.env.production', 'prod.env', 'examples/.env'])('%s is not a template', (path) => {
    expect(isEnvTemplate(path)).toBe(false);
  });
});

describe('keys: names and values', () => {
  it.each(['API_KEY', 'apiKey', 'STRIPE_SECRET', 'GITHUB_TOKEN', 'db.password', 'DB_PASS', 'private-key', 'AWS_SECRET_ACCESS_KEY', 'authToken', 'SENTRY_DSN', 'CLIENT_SECRET'])(
    '%s looks like the name of a secret',
    (name) => {
      expect(isSecretName(name)).toBe(true);
    },
  );

  it.each(['PORT', 'NODE_ENV', 'DEBUG', 'LOG_LEVEL', 'HOSTNAME', 'PUBLIC_URL', 'KEYBOARD_LAYOUT'])('%s does not look like the name of a secret', (name) => {
    expect(isSecretName(name)).toBe(false);
  });

  it.each(['s3cr3tV4lue99', 'a'.repeat(20), 'hunter2hunter2', 'xK9#mP2$vL8@nQ4'])('%s is a plausible real value', (value) => {
    expect(isRealValue(value)).toBe(true);
  });

  it.each(['', 'short', 'changeme', 'change-me', 'replace_me', 'xxxxxxxxxx', '********', '<your-key-here>', '${API_KEY}', '$API_KEY', '{{ secret }}', '%SECRET%', 'your-api-key-here', 'example-key-1234', 'placeholder', 'undefined', 'redacted'])(
    '%j is a placeholder, not a real value',
    (value) => {
      expect(isRealValue(value)).toBe(false);
    },
  );
});

describe('keys: reading assignments', () => {
  const read = (text: string) => findAssignments(text).map((a) => [a.name, a.value]);

  it('reads dotenv lines, with and without export and quotes', () => {
    expect(read('A=1\nexport B="two words"\nC=\'three\'\n')).toEqual([['A', '1'], ['B', 'two words'], ['C', 'three']]);
  });

  it('reads JSON properties', () => {
    expect(read('{"apiKey": "abc123", "port": 8080}')).toEqual([['apiKey', 'abc123'], ['port', '8080']]);
  });

  it('reads YAML mappings and TOML/INI assignments', () => {
    expect(read('password: hunter2hunter2\ntoken = "abc"\n')).toEqual([['password', 'hunter2hunter2'], ['token', 'abc']]);
  });

  it('stops an unquoted value at a comment or separator', () => {
    expect(read('A=value # note\nB=x,y')).toEqual([['A', 'value'], ['B', 'x']]);
  });

  it('gives the offset of the value in the file', () => {
    const text = 'FIRST=1\nSECRET=abcdefgh\n';
    const [, second] = findAssignments(text);
    expect(text.slice(second!.index, second!.index + 8)).toBe('abcdefgh');
  });

  it('returns nothing for text with no assignments', () => {
    expect(findAssignments('just words and no pairs')).toEqual([]);
  });
});

describe('keys: live key detection', () => {
  const details = (text: string) => findLiveKeys(text).map((m) => m.detail);

  it.each([
    ['an AWS access key ID', FAKE.__FAKE_AWS_ID__, 'AWS access key ID AKIA...'],
    ['a Stripe live key', FAKE.__FAKE_STRIPE_LIVE__, 'Stripe live key sk_l...'],
    ['a GitHub token', FAKE.__FAKE_GITHUB_TOKEN__, 'GitHub token ghp_...'],
    ['a Slack token', FAKE.__FAKE_SLACK__, 'Slack token xoxb...'],
  ])('finds %s and only shows its first four characters', (_label, key, expected) => {
    expect(details(`value = ${key}`)).toEqual([expected]);
  });

  it('finds a private key block without printing any of it', () => {
    expect(details(FAKE.__FAKE_PEM__!)).toEqual(['PEM private key BEGIN ... PRIVATE KEY']);
  });

  it('finds every key in a file, not just the first', () => {
    expect(findLiveKeys(`${FAKE.__FAKE_AWS_ID__}\n${FAKE.__FAKE_GITHUB_TOKEN__}`)).toHaveLength(2);
  });

  it('ignores published example keys', () => {
    expect(details('AKIAIOSFODNN7EXAMPLE')).toEqual([]);
  });

  it('flags a production credential by its name, masking the value', () => {
    expect(details('PROD_DB_PASSWORD=Sup3rS3cretValue')).toEqual(['production credential PROD_DB_PASSWORD=Sup3...']);
    expect(details('STRIPE_SECRET_PRODUCTION: "Sup3rS3cretValue"')).toEqual(['production credential STRIPE_SECRET_PRODUCTION=Sup3...']);
  });

  it('flags a production database URL that has a password', () => {
    expect(details('PROD_DATABASE_URL=postgres://app:Sup3rS3cret@db.internal/app')).toHaveLength(1);
  });

  it('does not flag a production name with a placeholder, or a non-secret production name', () => {
    expect(details('PROD_API_KEY=changeme')).toEqual([]);
    expect(details('PROD_REGION=eu-west-1')).toEqual([]);
    expect(details('PRODUCT_API_KEY=Sup3rS3cretValue')).toEqual([]);
  });

  it('does not flag an ordinary secret name that is not production', () => {
    expect(details('DEV_API_KEY=Sup3rS3cretValue')).toEqual([]);
  });

  it('reports offsets that point at the key', () => {
    const text = `x = 1\ntoken = ${FAKE.__FAKE_GITHUB_TOKEN__}`;
    expect(findLiveKeys(text)[0]!.index).toBe(text.indexOf('ghp_'));
  });
});

describe('keys: cloud policy detection', () => {
  const details = (path: string, text: string) => findAdminPolicies(path, text).map((m) => m.detail);

  it('flags Action "*" on Resource "*" in a JSON policy', () => {
    const policy = JSON.stringify({ Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] });
    expect(details('iam.json', policy)).toEqual(['statement allows Action "*" on Resource "*"']);
  });

  it('flags a wildcard in list form', () => {
    const policy = JSON.stringify({ Statement: [{ Effect: 'Allow', Action: ['*'], Resource: ['*'] }] });
    expect(details('iam.json', policy)).toHaveLength(1);
  });

  it('flags a statement with no Effect, since Allow is not required in other formats', () => {
    expect(details('p.json', JSON.stringify({ Action: '*', Resource: '*' }))).toHaveLength(1);
  });

  it('does not flag Deny statements, wildcard actions on one resource, or one action on every resource', () => {
    expect(details('p.json', JSON.stringify({ Statement: [{ Effect: 'Deny', Action: '*', Resource: '*' }] }))).toEqual([]);
    expect(details('p.json', JSON.stringify({ Statement: [{ Effect: 'Allow', Action: '*', Resource: 'arn:aws:s3:::bucket/*' }] }))).toEqual([]);
    expect(details('p.json', JSON.stringify({ Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }] }))).toEqual([]);
  });

  it('flags the same pattern in YAML and Terraform text', () => {
    expect(details('policy.yml', 'Statement:\n  - Effect: Allow\n    Action: "*"\n    Resource: "*"\n')).toHaveLength(1);
    expect(details('main.tf', 'statement {\n  actions   = ["*"]\n  resources = ["*"]\n}\n')).toHaveLength(1);
  });

  it('does not flag Action "*" alone in text formats', () => {
    expect(details('policy.yml', 'Action: "*"\nResource: "arn:aws:s3:::one"\n')).toEqual([]);
  });

  it('flags AdministratorAccess in a policy ARN or a bare name', () => {
    expect(details('main.tf', 'policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"')).toEqual(['AWS AdministratorAccess policy']);
    expect(details('stack.yml', 'ManagedPolicyArns:\n  - AdministratorAccess\n')).toEqual(['AWS AdministratorAccess policy']);
  });

  it('flags GCP basic roles owner and editor, but not narrower roles', () => {
    expect(details('iam.tf', 'role = "roles/owner"')).toEqual(['GCP basic role roles/owner']);
    expect(details('iam.tf', 'role = "roles/editor"')).toEqual(['GCP basic role roles/editor']);
    expect(details('iam.tf', 'role = "roles/storage.objectViewer"')).toEqual([]);
  });

  it('does not match AdministratorAccess inside a longer word', () => {
    expect(details('x.tf', 'name = "NotAdministratorAccessible"')).toEqual([]);
  });
});

describe('mcp: path breadth (MCP-003)', () => {
  it.each(['/', '~', '$HOME', '${HOME}', '${userHome}', '%USERPROFILE%', 'C:', 'C:\\', '/home/alice', '/Users/alice', 'C:\\Users\\alice', 'C:/Users/alice', '/home/alice/'])(
    '%s is the root or a home directory',
    (path) => {
      expect(isBroadPath(path)).toBe(true);
    },
  );

  it.each(['/home/alice/.ssh', '~/.aws', '/Users/alice/.gnupg/', 'C:\\Users\\alice\\.kube', '.ssh'])('%s is a credential folder', (path) => {
    expect(isBroadPath(path)).toBe(true);
  });

  it.each(['.', './src', '/srv/project', '/home/alice/project', 'C:\\work\\project', '/tmp/scratch', '${workspaceFolder}', 'docs'])(
    '%s is not too broad',
    (path) => {
      expect(isBroadPath(path)).toBe(false);
    },
  );
});

describe('mcp: container images (MCP-004)', () => {
  it('finds the image after docker run, skipping flags and their values', () => {
    expect(dockerImage(['run', '-i', '--rm', '-e', 'TOKEN', '-v', '/a:/b', '--name', 'x', 'ghcr.io/org/image:1.2.3', 'arg'])).toBe('ghcr.io/org/image:1.2.3');
  });

  it('finds the image when there are no flags', () => {
    expect(dockerImage(['run', 'alpine'])).toBe('alpine');
  });

  it('returns undefined without a run subcommand or an image', () => {
    expect(dockerImage(['ps'])).toBeUndefined();
    expect(dockerImage(['run', '--rm'])).toBeUndefined();
    expect(dockerImage([])).toBeUndefined();
  });

  const server = (command: string, args: string[]): McpServer => ({ name: 's', file: '', line: 1, command, args, env: {}, lineOf: () => 1 });

  it.each([
    ['npx', ['some-server'], true],
    ['npx', ['-y', 'some-server'], true],
    ['npx', ['-y', 'some-server@latest'], true],
    ['npx', ['-y', 'some-server@1.2.3'], false],
    ['npx', ['-y', '@scope/some-server@2.0.0'], false],
    ['uvx', ['some-server'], true],
    ['uvx', ['some-server==1.2.3'], false],
    ['node', ['server.js'], false],
    ['python', ['-m', 'server'], false],
  ])('%s %j is unpinned: %s', (command, args, unpinned) => {
    expect(unpinnedTarget(server(command, args)) !== undefined).toBe(unpinned);
  });

  it.each([
    [['run', '-i', 'org/image'], true],
    [['run', '-i', 'org/image:latest'], true],
    [['run', '-i', 'org/image:1.2.3'], false],
    [['run', '-i', 'org/image:v2.0'], false],
    [['run', '-i', `org/image@sha256:${'a'.repeat(64)}`], false],
  ])('docker %j is unpinned: %s', (args, unpinned) => {
    expect(unpinnedTarget(server('docker', args)) !== undefined).toBe(unpinned);
  });

  it('treats podman like docker', () => {
    expect(unpinnedTarget(server('podman', ['run', 'org/image']))).toContain('org/image');
  });

  it('recognises docker given as a full path or an .exe', () => {
    expect(unpinnedTarget(server('/usr/bin/docker', ['run', 'org/image']))).toBeDefined();
    expect(unpinnedTarget(server('C:\\Program Files\\Docker\\docker.exe', ['run', 'org/image']))).toBeDefined();
  });
});

describe('mcp: remote servers (MCP-005)', () => {
  it('flags plain http', () => {
    expect(remoteProblem('http://mcp.example.com/sse')).toBe('connects to mcp.example.com over plain http');
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:8080/mcp', 'http://[::1]:9000', 'https://localhost', 'http://host.docker.internal:3000'])(
    'allows loopback address %s',
    (url) => {
      expect(remoteProblem(url)).toBeUndefined();
    },
  );

  it('flags https to a host that is not on the known list', () => {
    expect(remoteProblem('https://unknown-host.test/mcp')).toBe('connects to unknown-host.test, which is not on the known host list');
  });

  it('allows a known host and its subdomains, but not look-alike hosts', () => {
    expect(remoteProblem('https://api.githubcopilot.com/mcp/')).toBeUndefined();
    expect(remoteProblem('https://evilgithubcopilot.com/mcp')).toContain('not on the known host list');
  });

  it('ignores text that is not a URL and URLs that are not http(s)', () => {
    expect(remoteProblem('not a url')).toBeUndefined();
    expect(remoteProblem('ftp://example.com')).toBeUndefined();
    expect(remoteProblem('stdio')).toBeUndefined();
  });

  it('compares host names without regard to case', () => {
    expect(remoteProblem('HTTP://Example.COM/x')).toBe('connects to example.com over plain http');
  });
});

describe('mcp: reading config files', () => {
  const parse = (path: string, value: unknown) => parseMcpConfig({ path, content: JSON.stringify(value) });

  it('reads command, args, env and url', () => {
    const [s] = parse('.mcp.json', { mcpServers: { a: { command: 'node', args: ['x.js'], env: { K: 'v' } }, b: { url: 'https://h.test' } } });
    expect(s).toMatchObject({ name: 'a', file: '.mcp.json', command: 'node', args: ['x.js'], env: { K: 'v' } });
    expect(parse('.mcp.json', { mcpServers: { b: { url: 'https://h.test' } } })[0]).toMatchObject({ url: 'https://h.test', command: undefined, args: [], env: {} });
  });

  it('uses "mcpServers" for .mcp.json and .cursor/mcp.json, and "servers" for .vscode/mcp.json', () => {
    expect(parse('.mcp.json', { mcpServers: { a: {} } })).toHaveLength(1);
    expect(parse('.cursor/mcp.json', { mcpServers: { a: {} } })).toHaveLength(1);
    expect(parse('.vscode/mcp.json', { servers: { a: {} } })).toHaveLength(1);
    expect(parse('.vscode/mcp.json', { mcpServers: { a: {} } })).toHaveLength(0);
    expect(parse('.mcp.json', { servers: { a: {} } })).toHaveLength(0);
  });

  it('finds config files in subfolders by their ending', () => {
    expect(parse('packages/app/.vscode/mcp.json', { servers: { a: {} } })).toHaveLength(1);
  });

  it('skips entries that are not objects, and drops args and env values of the wrong type', () => {
    const servers = parse('.mcp.json', { mcpServers: { bad: 'text', worse: null, ok: { command: 'x', args: ['a', 1, null], env: { A: 'b', C: 5 } } } });
    expect(servers.map((s) => s.name)).toEqual(['ok']);
    expect(servers[0]).toMatchObject({ args: ['a'], env: { A: 'b' } });
  });

  it('returns nothing for a file that is not an object, or has no servers key', () => {
    expect(parse('.mcp.json', [])).toEqual([]);
    expect(parse('.mcp.json', 'text')).toEqual([]);
    expect(parse('.mcp.json', {})).toEqual([]);
    expect(parse('.mcp.json', { mcpServers: [] })).toEqual([]);
  });

  it('accepts comments and trailing commas, as VS Code does', () => {
    const content = '{\n // servers\n "servers": { "a": { "command": "node", }, },\n}';
    expect(parseMcpConfig({ path: '.vscode/mcp.json', content })).toHaveLength(1);
  });

  it('records the line each server starts on', () => {
    const content = '{\n  "mcpServers": {\n    "first": {},\n    "second": {}\n  }\n}';
    const servers = parseMcpConfig({ path: '.mcp.json', content });
    expect(servers.map((s) => [s.name, s.line])).toEqual([['first', 3], ['second', 4]]);
  });

  it('throws on invalid JSON so the scanner can warn', () => {
    expect(() => parseMcpConfig({ path: '.mcp.json', content: '{ nope' })).toThrow();
  });
});

describe('approvals: command patterns', () => {
  it('a bare pattern matches only that exact command', () => {
    const re = patternToRegex('npm test');
    expect(re.test('npm test')).toBe(true);
    expect(re.test('npm test --watch')).toBe(false);
    expect(re.test('npm testing')).toBe(false);
  });

  it('a trailing " *" matches the command with or without arguments, but not a longer word', () => {
    const re = patternToRegex('npm run *');
    expect(re.test('npm run')).toBe(true);
    expect(re.test('npm run build')).toBe(true);
    expect(re.test('npm run build -- --watch')).toBe(true);
    expect(re.test('npm runner')).toBe(false);
  });

  it('the older ":*" ending behaves like " *"', () => {
    const re = patternToRegex('git status:*');
    expect(re.test('git status')).toBe(true);
    expect(re.test('git status -s')).toBe(true);
  });

  it('a wildcard in the middle matches any text', () => {
    const re = patternToRegex('git * --dry-run');
    expect(re.test('git push --dry-run')).toBe(true);
    expect(re.test('git push')).toBe(false);
  });

  it('treats regex characters in a pattern literally', () => {
    const re = patternToRegex('echo (a|b) [x] $HOME');
    expect(re.test('echo (a|b) [x] $HOME')).toBe(true);
    expect(re.test('echo a [x] $HOME')).toBe(false);
  });

  it('a lone * matches everything, including newlines', () => {
    expect(patternToRegex('*').test('anything\nat all')).toBe(true);
  });
});

describe('approvals: wildcard shell (APPR-003)', () => {
  it.each([undefined, '', '*', ':*', ' * ', '**', '*:*', '* --force', 'sudo *', 'sudo:*', 'bash -c *', 'sh *', 'python *', 'python3 *', 'python3.12 *', 'node *', 'node -e *', 'npx *', 'bunx *', 'env *', 'xargs *', 'eval *', 'powershell *', 'pwsh -Command *', 'cmd /c *', 'uvx *', 'pipx run *'])(
    '%j allows any command',
    (command) => {
      expect(isWildcardShell(command)).toBe(true);
    },
  );

  it.each(['npm test', 'npm run *', 'git status *', 'git diff:*', 'ls *', 'node scripts/build.js', 'python scripts/check.py *', 'node_modules/.bin/jest *', 'cat *.md'])(
    '%j is scoped',
    (command) => {
      expect(isWildcardShell(command)).toBe(false);
    },
  );
});

describe('approvals: destructive commands (APPR-002)', () => {
  it.each([
    'rm -rf /', 'rm -rf *', 'rm -fr build', 'rm -r -f dist', 'rm --recursive --force x', 'rm -rf:*',
    'git push --force', 'git push -f', 'git push --force-with-lease', 'git push origin +main',
    'git reset --hard', 'git clean -fd',
    'DROP DATABASE app', 'drop table users', 'TRUNCATE TABLE logs', 'dropdb app', 'redis-cli FLUSHALL', 'redis-cli flushdb',
    'aws s3 rb *', 'aws ec2 terminate-instances *', 'gcloud projects delete *', 'az group delete *', 'kubectl delete *',
    'terraform destroy *', 'pulumi destroy *', 'heroku apps:destroy *', 'Remove-Item -Recurse -Force *',
  ])('%s is destructive', (command) => {
    expect(destructiveMatch(command), command).toBeDefined();
  });

  it.each([
    'npm test', 'npm run build', 'git status', 'git diff', 'git log *', 'git push origin main', 'git push', 'ls *', 'rm file.txt', 'rm -r build',
    'aws s3 ls *', 'aws sts get-caller-identity', 'kubectl get pods *', 'terraform plan *', 'gcloud projects list', 'cat README.md',
  ])('%s is not destructive', (command) => {
    expect(destructiveMatch(command), command).toBeUndefined();
  });

  it('names what kind of damage it found', () => {
    expect(destructiveMatch('rm -rf build')).toBe('recursive delete');
    expect(destructiveMatch('git push --force')).toBe('force push');
    expect(destructiveMatch('git reset --hard')).toBe('discard local work');
    expect(destructiveMatch('dropdb app')).toBe('database drop');
    expect(destructiveMatch('terraform destroy')).toBe('cloud resource deletion');
  });

  it('flags a broad pattern by giving an example command it would allow', () => {
    expect(destructiveMatch('rm *')).toContain('recursive delete, for example `rm -rf');
    expect(destructiveMatch('git *')).toMatch(/force push|discard local work/);
  });

  it('has a label and a command for every sample, and the samples cover each family of damage', () => {
    const labels = new Set(DESTRUCTIVE_SAMPLES.map((s) => s.label));
    expect([...labels].sort()).toEqual(['cloud resource deletion', 'database drop', 'discard local work', 'force push', 'recursive delete']);
    for (const s of DESTRUCTIVE_SAMPLES) expect(s.command.length).toBeGreaterThan(0);
  });
});

describe('approvals: Claude Code rule syntax', () => {
  it('reads Bash and PowerShell rules as shell commands', () => {
    expect(parseRule('Bash(npm test)', 3)).toEqual({ raw: 'Bash(npm test)', line: 3, kind: 'shell', command: 'npm test' });
    expect(parseRule('PowerShell(Get-ChildItem *)', 1)).toMatchObject({ kind: 'shell', command: 'Get-ChildItem *' });
  });

  it('treats a Bash rule with no specifier or an empty one as every command', () => {
    expect(parseRule('Bash', 1)).toMatchObject({ kind: 'shell', command: undefined });
    expect(parseRule('Bash()', 1)).toMatchObject({ kind: 'shell', command: undefined });
  });

  it('trims the specifier', () => {
    expect(parseRule('Bash(  ls  )', 1)).toMatchObject({ command: 'ls' });
  });

  it('keeps parentheses inside the specifier', () => {
    expect(parseRule('Bash(echo $(date))', 1)).toMatchObject({ command: 'echo $(date)' });
  });

  it('reads MCP rules for a whole server, with or without a wildcard', () => {
    expect(parseRule('mcp__github', 1)).toMatchObject({ kind: 'mcp', mcpServer: 'github', mcpTool: undefined });
    expect(parseRule('mcp__github__*', 1)).toMatchObject({ kind: 'mcp', mcpServer: 'github', mcpTool: undefined });
  });

  it('reads MCP rules for one tool', () => {
    expect(parseRule('mcp__github__get_issue', 1)).toMatchObject({ kind: 'mcp', mcpServer: 'github', mcpTool: 'get_issue' });
  });

  it('ignores unanchored server globs, which Claude Code does not honour as allow rules', () => {
    expect(parseRule('mcp__*', 1).kind).toBe('other');
    expect(parseRule('mcp__*__read', 1).kind).toBe('other');
  });

  it.each(['Read(./src/**)', 'Edit', 'WebFetch(domain:example.com)', 'not a rule!', ''])('treats %j as another kind of rule', (raw) => {
    expect(parseRule(raw, 1).kind).toBe('other');
  });

  describe('settings file', () => {
    const parse = (value: unknown) => claudeCodeAdapter.parse({ path: '.claude/settings.json', content: JSON.stringify(value, null, 2) })!;

    it('matches Claude Code settings files at any depth, and nothing else', () => {
      for (const path of ['.claude/settings.json', '.claude/settings.local.json', 'apps/web/.claude/settings.json']) expect(claudeCodeAdapter.matches(path), path).toBe(true);
      for (const path of ['settings.json', '.claude/other.json', '.claude/settings.json.bak', 'x.claude/settings.json']) expect(claudeCodeAdapter.matches(path), path).toBe(false);
    });

    it('reports bypassPermissions and auto modes', () => {
      expect(parse({ permissions: { defaultMode: 'bypassPermissions' } }).bypass).toHaveLength(1);
      expect(parse({ permissions: { defaultMode: 'auto' } }).bypass).toHaveLength(1);
    });

    it('reports acceptEdits as a partial approval, not a bypass', () => {
      const settings = parse({ permissions: { defaultMode: 'acceptEdits' } });
      expect(settings.bypass).toEqual([]);
      expect(settings.partial).toHaveLength(1);
    });

    it.each(['default', 'plan', 'dontAsk'])('does not report the %s mode', (mode) => {
      const settings = parse({ permissions: { defaultMode: mode } });
      expect([settings.bypass, settings.partial]).toEqual([[], []]);
    });

    it('reports skipDangerousModePermissionPrompt only when true', () => {
      expect(parse({ skipDangerousModePermissionPrompt: true }).bypass).toHaveLength(1);
      expect(parse({ skipDangerousModePermissionPrompt: false }).bypass).toEqual([]);
    });

    it('reports enableAllProjectMcpServers only when true', () => {
      expect(parse({ enableAllProjectMcpServers: true }).allMcpServers).toHaveLength(1);
      expect(parse({ enableAllProjectMcpServers: false }).allMcpServers).toEqual([]);
    });

    it('reads only the allow list, ignoring deny and ask rules', () => {
      const settings = parse({ permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm *)'], ask: ['Bash(git push *)'] } });
      expect(settings.allow.map((a) => a.raw)).toEqual(['Bash(ls)']);
    });

    it('skips allow entries that are not strings', () => {
      expect(parse({ permissions: { allow: ['Bash(ls)', 5, null, {}] } }).allow).toHaveLength(1);
    });

    it('points each setting at its own line', () => {
      const text = '{\n  "permissions": {\n    "defaultMode": "bypassPermissions",\n    "allow": [\n      "Bash(ls)"\n    ]\n  },\n  "enableAllProjectMcpServers": true\n}';
      const settings = claudeCodeAdapter.parse({ path: '.claude/settings.json', content: text })!;
      expect(settings.bypass[0]!.line).toBe(3);
      expect(settings.allow[0]!.line).toBe(5);
      expect(settings.allMcpServers[0]!.line).toBe(8);
    });

    it('returns empty settings for an empty object, and undefined for a file that is not an object', () => {
      expect(parse({})).toMatchObject({ bypass: [], partial: [], allow: [], allMcpServers: [] });
      expect(claudeCodeAdapter.parse({ path: '.claude/settings.json', content: '[]' })).toBeUndefined();
    });

    it('accepts a file that starts with a byte order mark', () => {
      expect(claudeCodeAdapter.parse({ path: '.claude/settings.json', content: '\ufeff{}' })).toBeDefined();
    });

    it('throws on invalid JSON so the scanner can warn', () => {
      expect(() => claudeCodeAdapter.parse({ path: '.claude/settings.json', content: '{ nope' })).toThrow();
    });
  });
});
