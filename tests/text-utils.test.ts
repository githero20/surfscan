import { describe, expect, it } from 'vitest';
import { codePointLabel, excerpt, LineIndex, stripBom } from '../src/core/text.js';
import { JsonLocator, parseJsonc } from '../src/scanners/shared-json.js';
import { findingsFromMatches, matchAll } from '../src/scanners/shared.js';

describe('LineIndex', () => {
  it('maps offset 0 to line 1, column 1', () => {
    expect(new LineIndex('abc').positionOf(0)).toEqual({ line: 1, column: 1 });
  });

  it('maps offsets on later lines', () => {
    const index = new LineIndex('ab\ncd\nef');
    expect(index.positionOf(3)).toEqual({ line: 2, column: 1 });
    expect(index.positionOf(4)).toEqual({ line: 2, column: 2 });
    expect(index.positionOf(6)).toEqual({ line: 3, column: 1 });
    expect(index.positionOf(7)).toEqual({ line: 3, column: 2 });
  });

  it('puts the newline character itself at the end of its own line', () => {
    expect(new LineIndex('ab\ncd').positionOf(2)).toEqual({ line: 1, column: 3 });
  });

  it('maps an offset at the very end of the text', () => {
    expect(new LineIndex('ab\n').positionOf(3)).toEqual({ line: 2, column: 1 });
  });

  it('counts a CRLF file by lines, not by characters', () => {
    const index = new LineIndex('ab\r\ncd\r\n');
    expect(index.positionOf(4)).toEqual({ line: 2, column: 1 });
    expect(index.lineCount).toBe(3);
  });

  it('handles empty text', () => {
    const index = new LineIndex('');
    expect(index.lineCount).toBe(1);
    expect(index.positionOf(0)).toEqual({ line: 1, column: 1 });
    expect(index.lineText(1)).toBe('');
  });

  it('lineText returns a line without its line ending', () => {
    const index = new LineIndex('one\r\ntwo\nthree');
    expect(index.lineText(1)).toBe('one');
    expect(index.lineText(2)).toBe('two');
    expect(index.lineText(3)).toBe('three');
  });

  it('lineText returns an empty string for a line that does not exist', () => {
    expect(new LineIndex('one').lineText(5)).toBe('');
    expect(new LineIndex('one').lineText(0)).toBe('');
  });

  it('lineText keeps blank lines', () => {
    expect(new LineIndex('a\n\nb').lineText(2)).toBe('');
  });

  it('lineStart gives the offset where a line begins', () => {
    const index = new LineIndex('ab\ncd\nef');
    expect([1, 2, 3].map((line) => index.lineStart(line))).toEqual([0, 3, 6]);
    expect(index.lineStart(99)).toBe(8);
  });

  it('finds positions in a long text', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const index = new LineIndex(lines.join('\n'));
    expect(index.lineCount).toBe(5000);
    const offset = lines.slice(0, 4321).join('\n').length + 1 + 3;
    expect(index.positionOf(offset)).toEqual({ line: 4322, column: 4 });
  });
});

describe('stripBom', () => {
  it('removes a leading byte order mark', () => {
    expect(stripBom('﻿{"a":1}')).toBe('{"a":1}');
  });

  it('removes only one, and only at the start', () => {
    expect(stripBom('﻿﻿x')).toBe('﻿x');
    expect(stripBom('x﻿')).toBe('x﻿');
  });

  it('leaves text without one alone, including the empty string', () => {
    expect(stripBom('plain')).toBe('plain');
    expect(stripBom('')).toBe('');
  });
});

describe('excerpt', () => {
  it('collapses runs of whitespace, including newlines, into single spaces', () => {
    expect(excerpt('a \n\t b   c')).toBe('a b c');
  });

  it('trims the ends', () => {
    expect(excerpt('  hi  ')).toBe('hi');
  });

  it('leaves text at exactly the limit alone', () => {
    expect(excerpt('abcde', 5)).toBe('abcde');
  });

  it('cuts longer text to the limit, ending in "..."', () => {
    expect(excerpt('abcdef', 5)).toBe('ab...');
    expect(excerpt('abcdef', 5)).toHaveLength(5);
  });

  it('defaults to 80 characters', () => {
    expect(excerpt('x'.repeat(80))).toHaveLength(80);
    expect(excerpt('x'.repeat(81))).toHaveLength(80);
    expect(excerpt('x'.repeat(81)).endsWith('...')).toBe(true);
  });

  it('measures after collapsing whitespace', () => {
    expect(excerpt(`${'a '.repeat(3)}`, 5)).toBe('a a a');
  });
});

describe('codePointLabel', () => {
  it('formats as U+ with at least four uppercase hex digits', () => {
    expect(codePointLabel(0x200b)).toBe('U+200B');
    expect(codePointLabel(0x41)).toBe('U+0041');
    expect(codePointLabel(0xe0041)).toBe('U+E0041');
  });
});

describe('matchAll', () => {
  it('finds every match even when the regex is not global', () => {
    expect([...matchAll(/a/, 'banana')].map((m) => m.index)).toEqual([1, 3, 5]);
  });

  it('keeps the flags of a global regex', () => {
    expect([...matchAll(/A/gi, 'aA')].map((m) => m.index)).toEqual([0, 1]);
  });

  it('is not affected by the lastIndex of the regex passed in', () => {
    const re = /a/g;
    re.lastIndex = 4;
    expect([...matchAll(re, 'aaa')]).toHaveLength(3);
  });

  it('does not loop forever on a pattern that matches the empty string', () => {
    expect([...matchAll(/x*/, 'ab')].map((m) => m.index)).toEqual([0, 1, 2]);
  });

  it('yields nothing when there is no match', () => {
    expect([...matchAll(/z/, 'abc')]).toEqual([]);
  });
});

describe('findingsFromMatches', () => {
  const rule = { id: 'TEST-001', severity: 'medium' as const };
  const file = { path: 'dir/a.md', content: 'one\ntwo three\nfour' };

  it('turns matches into findings with the rule, file, line, column and fix', () => {
    const [f] = findingsFromMatches(rule, file, [{ index: 8, detail: 'three' }], (d) => `found ${d}`, 'fix it');
    expect(f).toEqual({
      ruleId: 'TEST-001',
      severity: 'medium',
      message: 'found three',
      file: 'dir/a.md',
      line: 2,
      column: 5,
      fix: 'fix it',
    });
  });

  it('reports only the first match on a line', () => {
    const out = findingsFromMatches(rule, file, [{ index: 8, detail: 'later' }, { index: 4, detail: 'earlier' }], (d) => d, 'f');
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toBe('earlier');
  });

  it('reports one finding per line, in file order, whatever order the matches came in', () => {
    const out = findingsFromMatches(
      rule,
      file,
      [{ index: 14, detail: 'c' }, { index: 0, detail: 'a' }, { index: 5, detail: 'b' }],
      (d) => d,
      'f',
    );
    expect(out.map((f) => [f.line, f.message])).toEqual([[1, 'a'], [2, 'b'], [3, 'c']]);
  });

  it('returns nothing for no matches', () => {
    expect(findingsFromMatches(rule, file, [], (d) => d, 'f')).toEqual([]);
  });

  it('does not change the order of the array it was given', () => {
    const matches = [{ index: 14, detail: 'c' }, { index: 0, detail: 'a' }];
    findingsFromMatches(rule, file, matches, (d) => d, 'f');
    expect(matches.map((m) => m.detail)).toEqual(['c', 'a']);
  });
});

describe('parseJsonc', () => {
  it('parses plain JSON', () => {
    expect(parseJsonc('{"a":[1,2,{"b":null}]}')).toEqual({ a: [1, 2, { b: null }] });
  });

  it('ignores line comments', () => {
    expect(parseJsonc('{\n// note\n"a": 1 // trailing\n}')).toEqual({ a: 1 });
  });

  it('ignores block comments, including multi-line ones', () => {
    expect(parseJsonc('{ /* one */ "a": /* two\nlines */ 1 }')).toEqual({ a: 1 });
  });

  it('allows trailing commas in objects and arrays', () => {
    expect(parseJsonc('{"a":[1,2,],"b":{"c":1,},}')).toEqual({ a: [1, 2], b: { c: 1 } });
  });

  it('allows a trailing comma followed by whitespace and a comment', () => {
    expect(parseJsonc('{"a":1, // last\n}')).toEqual({ a: 1 });
  });

  it('keeps comment markers that are inside strings', () => {
    expect(parseJsonc('{"url":"https://example.com/a","glob":"/* not a comment */"}')).toEqual({
      url: 'https://example.com/a',
      glob: '/* not a comment */',
    });
  });

  it('keeps commas and brackets inside strings', () => {
    expect(parseJsonc('{"a":"x,}","b":"y,]"}')).toEqual({ a: 'x,}', b: 'y,]' });
  });

  it('handles escaped quotes and backslashes inside strings', () => {
    expect(parseJsonc('{"a":"say \\"hi\\" // no","b":"back\\\\"}')).toEqual({ a: 'say "hi" // no', b: 'back\\' });
  });

  it('accepts a file that starts with a byte order mark', () => {
    expect(parseJsonc('﻿{"a":1}')).toEqual({ a: 1 });
  });

  it('tolerates an unterminated block comment by dropping the rest', () => {
    expect(parseJsonc('{"a":1} /* never closed')).toEqual({ a: 1 });
  });

  it('still rejects genuinely invalid JSON', () => {
    expect(() => parseJsonc('{"a":')).toThrow();
    expect(() => parseJsonc('{a:1}')).toThrow();
  });
});

describe('JsonLocator', () => {
  const text = ['{', '  "name": "x",', '  "deps": {', '    "left-pad": "1.0.0",', '    "other": "2.0.0"', '  },', '  "allow": ["Bash(ls)", "Bash(ls)"]', '}'].join('\n');
  const locator = new JsonLocator(text);

  it('key finds the line of a key', () => {
    expect(locator.key('name')).toBe(2);
    expect(locator.key('other')).toBe(5);
  });

  it('key starts searching at the given offset', () => {
    const from = locator.keyOffset('deps');
    expect(locator.key('left-pad', from)).toBe(4);
  });

  it('key falls back to line 1 when the key is not there', () => {
    expect(locator.key('missing')).toBe(1);
  });

  it('keyOffset gives the offset of the quoted key, or -1', () => {
    expect(locator.keyOffset('name')).toBe(text.indexOf('"name"'));
    expect(locator.keyOffset('missing')).toBe(-1);
  });

  it('stringValue finds the line of a string value', () => {
    expect(locator.stringValue('2.0.0')).toBe(5);
  });

  it('stringValue searches after the given key first', () => {
    expect(locator.stringValue('Bash(ls)', 'allow')).toBe(7);
  });

  it('stringValue falls back to a search from the start, then to line 1', () => {
    expect(locator.stringValue('1.0.0', 'allow')).toBe(4);
    expect(locator.stringValue('absent', 'allow')).toBe(1);
  });
});
