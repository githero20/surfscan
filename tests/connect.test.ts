import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildChildEnv, connectToServers, listServerTools } from '../src/cli/connect.js';
import type { McpServer } from '../src/scanners/mcp/config.js';
import { runCli } from './helpers.js';

/**
 * A stand-in MCP server driven by its first argument:
 *   normal    one page of tools
 *   paginate  three pages, linked by nextCursor
 *   error     answers initialize with a JSON-RPC error
 *   exit      exits with code 7 before answering
 *   noise     prints junk and blank lines between valid replies
 *   huge      floods stdout with more than 16 MiB and no newline
 *   env       one tool whose description lists the environment it received
 *   empty     no tools
 *   scalars   prints valid JSON that is not a message (null, 42) before answering
 *   stubborn  keeps running after stdin closes; its one tool's description is its pid
 *   args      one tool whose description lists the arguments it received
 *   bad-tools a tool list with entries that are not tools
 */
const STUB = String.raw`
const mode = process.argv[2];
if (mode === 'exit') process.exit(7);
if (mode === 'huge') {
  process.stdout.write('x'.repeat(17 * 1024 * 1024));
  setTimeout(() => {}, 60000);
} else {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.method === 'initialize') {
        if (mode === 'error') return send({ id: m.id, error: { code: -32600, message: 'unsupported client' } });
        if (mode === 'noise') { process.stdout.write('not json\n\n{"half":\n'); }
        if (mode === 'scalars') { process.stdout.write('null\n42\n"text"\ntrue\n'); }
        if (mode === 'stubborn') { setInterval(() => {}, 1000); }
        return send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {} } });
      }
      if (m.method === 'tools/list') {
        const cursor = m.params && m.params.cursor;
        if (mode === 'paginate') {
          const page = cursor ? Number(cursor) : 1;
          const result = { tools: [{ name: 'tool' + page, description: 'page ' + page }] };
          if (page < 3) result.nextCursor = String(page + 1);
          return send({ id: m.id, result });
        }
        if (mode === 'empty') return send({ id: m.id, result: { tools: [] } });
        if (mode === 'stubborn') return send({ id: m.id, result: { tools: [{ name: 'pid', description: String(process.pid) }] } });
        if (mode === 'args') return send({ id: m.id, result: { tools: [{ name: 'args', description: JSON.stringify(process.argv.slice(3)) }] } });
        if (mode === 'bad-tools') return send({ id: m.id, result: { tools: [null, 5, 'x', { name: 'ok' }] } });
        if (mode === 'env') {
          const names = Object.keys(process.env).sort().join(',');
          return send({ id: m.id, result: { tools: [{ name: 'env', description: names + '|FOO=' + (process.env.FOO || 'unset') }] } });
        }
        return send({ id: m.id, result: { tools: [{ name: 'alpha', description: 'First tool', inputSchema: { type: 'object' } }, { name: 'beta', description: 'Second tool' }] } });
      }
    }
  });
}
`;

let script: string;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'surfscan-stub-'));
  script = join(dir, 'stub.cjs');
  await writeFile(script, STUB);
});

const server = (mode: string, env: Record<string, string> = {}, name = mode): McpServer => ({
  name,
  file: '.mcp.json',
  line: 1,
  command: process.execPath,
  args: [script, mode],
  env,
  lineOf: () => 1,
});

const shell = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...process.env, ...extra });

describe('connect: listing tools from a server', () => {
  it('starts the server, lists its tools and returns them with their full definitions', async () => {
    const tools = await listServerTools(server('normal'), shell());
    expect(tools.map((t) => t.name)).toEqual(['alpha', 'beta']);
    expect(tools[0]!.definition).toEqual({ name: 'alpha', description: 'First tool', inputSchema: { type: 'object' } });
  }, 30_000);

  it('follows nextCursor until the last page', async () => {
    const tools = await listServerTools(server('paginate'), shell());
    expect(tools.map((t) => t.name)).toEqual(['tool1', 'tool2', 'tool3']);
  }, 30_000);

  it('returns an empty list for a server with no tools', async () => {
    expect(await listServerTools(server('empty'), shell())).toEqual([]);
  }, 30_000);

  it('rejects with the server\'s own message when it answers with an error', async () => {
    await expect(listServerTools(server('error'), shell())).rejects.toThrow('unsupported client');
  }, 30_000);

  it('rejects, naming the exit code, when the server exits before answering', async () => {
    await expect(listServerTools(server('exit'), shell())).rejects.toThrow('server exited early with code 7');
  }, 30_000);

  it('rejects when the command cannot be started at all', async () => {
    const missing = { ...server('normal'), command: 'surfscan-no-such-program-xyz', args: [] };
    await expect(listServerTools(missing, shell())).rejects.toThrow();
  }, 30_000);

  it('ignores lines that are not valid JSON', async () => {
    const tools = await listServerTools(server('noise'), shell());
    expect(tools.map((t) => t.name)).toEqual(['alpha', 'beta']);
  }, 30_000);

  it('stops reading and rejects when the server sends more than 16 MiB', async () => {
    await expect(listServerTools(server('huge'), shell())).rejects.toThrow('server sent too much output');
  }, 30_000);

  it('ignores valid JSON that is not a message, such as null', async () => {
    const tools = await listServerTools(server('scalars'), shell());
    expect(tools.map((t) => t.name)).toEqual(['alpha', 'beta']);
  }, 30_000);

  it('keeps the valid tools from a list with entries that are not tools', async () => {
    const tools = await listServerTools(server('bad-tools'), shell());
    expect(tools.map((t) => t.name)).toEqual(['ok']);
  }, 30_000);

  it('stops a server that ignores stdin closing, including when a shell started it', async () => {
    const [tool] = await listServerTools(server('stubborn'), shell());
    const pid = Number(tool!.definition.description);
    const running = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && running(); i++) await new Promise((done) => setTimeout(done, 100));
    expect(running()).toBe(false);
  }, 30_000);
});

describe('connect: what reaches the command line', () => {
  it('does not expand shell variables in arguments', async () => {
    const withArg = { ...server('args'), args: [script, 'args', '--token=${SURFSCAN_TEST_VALUE}'] };
    const [tool] = await listServerTools(withArg, shell({ SURFSCAN_TEST_VALUE: 'from-shell' }));
    expect(JSON.parse(tool!.definition.description as string)).toEqual(['--token=${SURFSCAN_TEST_VALUE}']);
  }, 30_000);

  it.runIf(process.platform === 'win32')('refuses %VAR% on Windows, where cmd.exe would expand it', async () => {
    const withArg = { ...server('args'), args: [script, 'args', '%PATH%'] };
    await expect(listServerTools(withArg, shell())).rejects.toThrow('cannot be passed safely');
  });
});

describe('connect: --strict', () => {
  const project = async (servers: Record<string, unknown>): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'surfscan-connect-'));
    await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
    return root;
  };
  const connect = (root: string, ...extra: string[]) =>
    runCli(['mcp', root, '--connect', '--yes', '--strict', '--format', 'json', ...extra], root, { env: { ...process.env } });

  it('exits 2 and says why when a server cannot be listed', async () => {
    const r = await connect(await project({ broken: { command: process.execPath, args: [script, 'exit'] } }));
    expect(r.code).toBe(2);
    const report = JSON.parse(r.stdout);
    expect(report.complete).toBe(false);
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining('broken: could not list tools')]));
  }, 30_000);

  it('exits 2 when --yes skipped a server for not being pinned', async () => {
    const r = await connect(await project({
      good: { command: process.execPath, args: [script, 'empty'] },
      unpinned: { command: 'npx', args: ['-y', 'some-server'] },
    }));
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).warnings).toEqual(expect.arrayContaining([expect.stringContaining('unpinned: skipped')]));
  }, 30_000);

  it('passes when every server was listed', async () => {
    const r = await connect(await project({ good: { command: process.execPath, args: [script, 'empty'] } }));
    expect(JSON.parse(r.stdout).complete).toBe(true);
    expect(r.code).toBe(0);
  }, 30_000);

  it.each([
    ['a GitHub shorthand', ['-y', 'github:acme/server']],
    ['a tarball URL', ['-y', 'https://example.test/server-1.0.0.tgz']],
    ['a git URL', ['-y', 'git+https://example.test/server.git']],
  ])('does not launch %s under --yes without --allow-unpinned', async (_, args) => {
    const r = await connect(await project({ remote: { command: 'npx', args } }));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--connect: no servers were launched');
  }, 30_000);
});

describe('connect: the environment a server receives', () => {
  const ENV_NAMES = (description: string): string[] => description.split('|')[0]!.split(',');

  it('gets the variables it was configured with', async () => {
    const [tool] = await listServerTools(server('env', { FOO: 'bar' }), shell());
    expect(tool!.definition.description).toContain('|FOO=bar');
  }, 30_000);

  it('does not get shell variables it was not configured with', async () => {
    const [tool] = await listServerTools(server('env'), shell({ SURFSCAN_TEST_TOKEN: 'ghp_do_not_leak', GITHUB_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'y' }));
    const names = ENV_NAMES(tool!.definition.description as string);
    expect(names).not.toContain('SURFSCAN_TEST_TOKEN');
    expect(names).not.toContain('GITHUB_TOKEN');
    expect(names).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(tool!.definition.description).toContain('|FOO=unset');
  }, 30_000);

  it('does pass a shell variable that the config references with ${VAR}', async () => {
    const [tool] = await listServerTools(server('env', { FOO: '${SURFSCAN_TEST_VALUE}' }), shell({ SURFSCAN_TEST_VALUE: 'from-shell' }));
    expect(tool!.definition.description).toContain('|FOO=from-shell');
  }, 30_000);

  describe('buildChildEnv', () => {
    const cfg = (env: Record<string, string> = {}): McpServer => ({ name: 's', file: '', line: 1, args: [], env, lineOf: () => 1 });

    it.each(['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'])(
      'passes %s through',
      (name) => {
        expect(buildChildEnv(cfg(), { [name]: 'v' })).toEqual({ [name]: 'v' });
      },
    );

    it.each(['GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'SSH_AUTH_SOCK', 'NODE_OPTIONS'])(
      'does not pass %s through',
      (name) => {
        expect(buildChildEnv(cfg(), { [name]: 'v', PATH: '/bin' })).toEqual({ PATH: '/bin' });
      },
    );

    it('matches names regardless of case, keeping the original spelling', () => {
      expect(buildChildEnv(cfg(), { Path: 'C:\\bin', path: 'x', systemroot: 'C:\\Windows' })).toEqual({ Path: 'C:\\bin', path: 'x', systemroot: 'C:\\Windows' });
    });

    it('skips variables whose value is undefined', () => {
      expect(buildChildEnv(cfg(), { PATH: undefined, HOME: '/h' })).toEqual({ HOME: '/h' });
    });

    it('adds the config env on top, and the config wins over the shell', () => {
      expect(buildChildEnv(cfg({ PATH: '/custom', X: '1' }), { PATH: '/bin' })).toEqual({ PATH: '/custom', X: '1' });
    });

    it('expands ${VAR} and ${env:VAR} from the shell, and leaves unknown references as written', () => {
      const env = buildChildEnv(cfg({ A: '${TOKEN}', B: '${env:TOKEN}', C: 'x-${MISSING}-y', D: 'plain' }), { TOKEN: 't0k' });
      expect(env).toEqual({ A: 't0k', B: 't0k', C: 'x-${MISSING}-y', D: 'plain' });
    });

    it('does not modify the shell environment it was given', () => {
      const original = { PATH: '/bin', SECRET: 's' };
      buildChildEnv(cfg({ X: '1' }), original);
      expect(original).toEqual({ PATH: '/bin', SECRET: 's' });
    });
  });
});

describe('connect: several servers', () => {
  it('returns each server\'s tools under its name', async () => {
    const warnings: string[] = [];
    const tools = await connectToServers([server('normal', {}, 'one'), server('paginate', {}, 'two')], shell(), (w) => warnings.push(w));
    expect(Object.keys(tools)).toEqual(['one', 'two']);
    expect(tools.one!.map((t) => t.name)).toEqual(['alpha', 'beta']);
    expect(tools.two).toHaveLength(3);
    expect(warnings).toEqual([]);
  }, 60_000);

  it('skips a remote server with a warning that says why', async () => {
    const warnings: string[] = [];
    const remote: McpServer = { name: 'cloud', file: '', line: 1, args: [], env: {}, url: 'https://mcp.example.com', lineOf: () => 1 };
    const tools = await connectToServers([remote], shell(), (w) => warnings.push(w));
    expect(tools).toEqual({});
    expect(warnings).toEqual(['cloud: skipped, --connect only launches local servers, not remote URLs']);
  });

  it('reports a server that fails and still lists the others', async () => {
    const warnings: string[] = [];
    const tools = await connectToServers([server('exit', {}, 'broken'), server('normal', {}, 'good')], shell(), (w) => warnings.push(w));
    expect(Object.keys(tools)).toEqual(['good']);
    expect(warnings).toEqual(['broken: could not list tools (server exited early with code 7)']);
  }, 60_000);

  it('returns nothing for no servers', async () => {
    expect(await connectToServers([], shell(), () => undefined)).toEqual({});
  });
});
