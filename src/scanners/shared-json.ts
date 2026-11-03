import { LineIndex } from '../core/text.js';

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
