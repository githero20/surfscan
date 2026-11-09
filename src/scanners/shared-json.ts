import { LineIndex, stripBom } from '../core/text.js';

/** Parse JSON that may contain comments and trailing commas, as VS Code's mcp.json may. */
export function parseJsonc(raw: string): unknown {
  const text = stripBom(raw);
  const out: string[] = [];
  let inString = false;
  // Where in `out` a comma waits to see whether a closing bracket makes it a trailing one.
  let pendingComma = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out.push(ch);
      if (ch === '\\') out.push(text[++i] ?? '');
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      pendingComma = -1;
      out.push(ch);
    } else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end - 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (ch === '}' || ch === ']') {
      if (pendingComma !== -1) out[pendingComma] = '';
      pendingComma = -1;
      out.push(ch);
    } else {
      if (ch === ',') pendingComma = out.length;
      else if (!/\s/.test(ch)) pendingComma = -1;
      out.push(ch);
    }
  }
  return JSON.parse(out.join(''));
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
    return this.lineAt(this.stringValueOffset(value, afterKey ? this.keyOffset(afterKey) : 0));
  }

  /** Offset of a string value at or after `from`, or anywhere if not found there; -1 if absent. */
  stringValueOffset(value: string, from = 0): number {
    const literal = JSON.stringify(value);
    const at = this.text.indexOf(literal, Math.max(0, from));
    return at === -1 ? this.text.indexOf(literal) : at;
  }

  /** Line of a known offset. */
  lineOfOffset(offset: number): number {
    return this.lineAt(offset);
  }
}
