import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { dockerImage, isBroadPath, mcpScanner, remoteProblem } from '../src/scanners/mcp/index.js';
import { parseMcpConfig } from '../src/scanners/mcp/config.js';
import { buildLock, hashTool, parseToolList, toolTexts } from '../src/scanners/mcp/tools.js';
import { fixture, scanFixture } from './helpers.js';

async function withTools(id: string, variant: 'bad' | 'clean') {
  const content = await readFile(fixture(id, variant, 'tools.json'), 'utf8');
  const toolSource = { file: 'tools.json', content, tools: parseToolList(content) };
  return scanFixture(mcpScanner, id, variant, { toolSource });
}
const scan = (id: string, variant: 'bad' | 'clean') => scanFixture(mcpScanner, id, variant);

describe('mcp scanner', () => {
  it('lists rules ordered high to low', () => {
    const rank = { high: 3, medium: 2, low: 1, info: 0 };
    const ranks = mcpScanner.rules.map((r) => rank[r.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  describe('MCP-001', () => {
    it('MCP-001 flags injection text, including in nested parameter descriptions', async () => {
      const findings = await withTools('MCP-001', 'bad');
      const text = findings.map((f) => f.message).join('\n');
      expect(text).toContain('Ignore all previous instructions');
      expect(text).toContain('<IMPORTANT>');
      expect(text).toContain('.ssh');
      expect(text).toContain('Do not tell the user');
      expect(findings.every((f) => f.file === 'tools.json' && f.line > 1)).toBe(true);
    });

    it('MCP-001 accepts ordinary tool descriptions', async () => {
      expect(await withTools('MCP-001', 'clean')).toEqual([]);
    });

    it('MCP-001 does nothing without a tool list', async () => {
      expect(await scan('MCP-001', 'bad')).toEqual([]);
    });
  });

  describe('MCP-002', () => {
    it('MCP-002 flags a changed tool and a tool missing from the lock', async () => {
      const findings = await withTools('MCP-002', 'bad');
      expect(findings.map((f) => f.message)).toEqual([
        'Tool "search" (server *) changed since the saved lock',
        'Tool "added_later" (server *) is not in the saved lock',
      ]);
    });

    it('MCP-002 accepts tools that match the lock', async () => {
      expect(await withTools('MCP-002', 'clean')).toEqual([]);
    });
  });

  describe('MCP-003', () => {
    it('MCP-003 flags root, home and credential paths, and broad container mounts', async () => {
      const findings = await scan('MCP-003', 'bad');
      expect(findings.map((f) => f.line)).toEqual([4, 7, 10, 13]);
      expect(findings[3]!.message).toContain('Docker socket');
    });

    it('MCP-003 accepts servers limited to the project', async () => {
      expect(await scan('MCP-003', 'clean')).toEqual([]);
    });
  });

  describe('MCP-004', () => {
    it('MCP-004 flags unpinned npx, uvx and container images, in VS Code config with comments', async () => {
      const findings = await scan('MCP-004', 'bad');
      expect(findings.map((f) => f.file)).toEqual(['.vscode/mcp.json', '.vscode/mcp.json', '.vscode/mcp.json']);
      expect(findings.map((f) => f.message).join('\n')).toContain('container image ghcr.io/example/server');
    });

    it('MCP-004 accepts pinned versions and digests', async () => {
      expect(await scan('MCP-004', 'clean')).toEqual([]);
    });
  });

  describe('MCP-005', () => {
    it('MCP-005 flags plain http and unknown hosts, including bridge arguments', async () => {
      const findings = await scan('MCP-005', 'bad');
      expect(findings.map((f) => f.message)).toEqual([
        'Server "plain" connects to mcp.example.net over plain http',
        'Server "unknown" connects to mcp.example.net, which is not on the known host list',
        'Server "bridge" connects to bridge.example.net over plain http',
      ]);
    });

    it('MCP-005 accepts known hosts and loopback', async () => {
      expect(await scan('MCP-005', 'clean')).toEqual([]);
    });
  });

  describe('MCP-006', () => {
    it('MCP-006 reports a missing lock file as info', async () => {
      const findings = await scan('MCP-006', 'bad');
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: 'info', file: '.surfscan/mcp.lock.json', line: 0 });
    });

    it('MCP-006 accepts a project with a lock file', async () => {
      expect(await scan('MCP-006', 'clean')).toEqual([]);
    });
  });

  describe('helpers', () => {
    it('reads the key each config file uses', () => {
      const body = JSON.stringify({ mcpServers: { a: { command: 'x' } }, servers: { b: { command: 'y' } } });
      expect(parseMcpConfig({ path: '.mcp.json', content: body }).map((s) => s.name)).toEqual(['a']);
      expect(parseMcpConfig({ path: '.cursor/mcp.json', content: body }).map((s) => s.name)).toEqual(['a']);
      expect(parseMcpConfig({ path: '.vscode/mcp.json', content: body }).map((s) => s.name)).toEqual(['b']);
    });

    it('accepts each tool list shape', () => {
      const tools = [{ name: 't', description: 'd' }];
      for (const shape of [tools, { tools }, { result: { tools } }]) {
        expect(parseToolList(JSON.stringify(shape))['*']!.map((t) => t.name)).toEqual(['t']);
      }
      expect(parseToolList(JSON.stringify({ servers: { s: { tools } } })).s!.map((t) => t.name)).toEqual(['t']);
      expect(() => parseToolList('{"name":"x"}')).toThrow();
    });

    it('hashes ignore key order but see nested description changes', async () => {
      const schema = (d: string) => ({ type: 'object', properties: { q: { description: d } } });
      const a = { name: 't', definition: { description: 'd', inputSchema: schema('x') } };
      const reordered = { name: 't', definition: { inputSchema: { properties: { q: { description: 'x' } }, type: 'object' }, description: 'd' } };
      const changed = { name: 't', definition: { description: 'd', inputSchema: schema('y') } };
      expect(await hashTool(a)).toBe(await hashTool(reordered));
      expect(await hashTool(a)).not.toBe(await hashTool(changed));
      expect((await buildLock({ s: [a] })).servers.s!.t).toBe(await hashTool(a));
      expect(toolTexts(a.definition)).toEqual(['d', 'x']);
    });

    it('classifies paths, images and hosts', () => {
      for (const p of ['/', '~', '~/', '$HOME', 'C:\\', '/home/ana', '/Users/ana/', 'C:\\Users\\ana', '~/.ssh']) {
        expect(isBroadPath(p), p).toBe(true);
      }
      for (const p of ['.', './src', '/home/ana/project', '${workspaceFolder}']) expect(isBroadPath(p), p).toBe(false);
      expect(dockerImage(['run', '-i', '--rm', '-e', 'A=b', 'image:1'])).toBe('image:1');
      expect(remoteProblem('https://mcp.github.com/x')).toBeUndefined();
      expect(remoteProblem('https://github.com.evil.example/x')).toContain('not on the known host list');
      expect(remoteProblem('http://localhost:3000')).toBeUndefined();
    });
  });
});
