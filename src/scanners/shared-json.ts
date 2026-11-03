import { LineIndex, stripBom } from '../core/text.js';

/** Parse JSON that may contain comments and trailing commas, as VS Code's mcp.json may. */
export function parseJsonc(raw: string): unknown {
  const text = stripBom(raw);
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end - 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (ch === '}' || ch === ']') {
      let tail = out.length;
      while (tail > 0 && /\s/.test(out[tail - 1]!)) tail--;
      if (out[tail - 1] === ',') out = out.slice(0, tail - 1);
      out += ch;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out);
}

/**
 * Best-effort line lookup for values in a JSON file, so findings can point at
 * the line that set them. Falls back to line 1.
 */
export class JsonLocator {
  private readonly index: LineIndex;

  constructor(private readonly text: string) {
    this.index = new LineIndex(text);
  }

  private lineAt(offset: number): number {
    return offset < 0 ? 1 : this.index.positionOf(offset).line;
  }

  /** Line of `"key"` (first occurrence at or after `from`). */
  key(key: string, from = 0): number {
    return this.lineAt(this.text.indexOf(JSON.stringify(key), from));
  }

  /** Offset of `"key"`, or -1. */
  keyOffset(key: string, from = 0): number {
    return this.text.indexOf(JSON.stringify(key), from);
  }

  /** Line of a string value, searching after the given key when present. */
  stringValue(value: string, afterKey?: string): number {
    const from = afterKey ? Math.max(0, this.text.indexOf(JSON.stringify(afterKey))) : 0;
    const literal = JSON.stringify(value);
    let at = this.text.indexOf(literal, from);
    if (at === -1) at = this.text.indexOf(literal);
    return this.lineAt(at);
  }
}
