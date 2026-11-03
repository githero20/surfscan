/** Small text helpers shared by scanners. No Node or CLI dependencies. */

export interface Position {
  line: number;
  column: number;
}

/** Maps string offsets to 1-based line and column numbers. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(private readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
  }

  positionOf(offset: number): Position {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - this.starts[lo]! + 1 };
  }

  get lineCount(): number {
    return this.starts.length;
  }

  /** Line text without the trailing newline (or \r\n). */
  lineText(line: number): string {
    const start = this.starts[line - 1];
    if (start === undefined) return '';
    const next = this.starts[line];
    let end = next === undefined ? this.text.length : next - 1;
    if (end > start && this.text.charCodeAt(end - 1) === 13) end--;
    return this.text.slice(start, end);
  }

  lineStart(line: number): number {
    return this.starts[line - 1] ?? this.text.length;
  }
}

/** Drop a leading UTF-8 byte order mark, which JSON.parse rejects. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Shorten text for display in a finding message. */
export function excerpt(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

export function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}
