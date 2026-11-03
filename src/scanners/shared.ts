import { LineIndex } from '../core/text.js';
import type { Finding, Rule, SourceFile } from '../core/types.js';

/** A match inside some text, before it is mapped to a file position. */
export interface TextMatch {
  index: number;
  /** Short human-readable description of what matched. */
  detail: string;
}

/** Build findings for a rule from matches in one file. One finding per line. */
export function findingsFromMatches(
  rule: Pick<Rule, 'id' | 'severity'>,
  file: SourceFile,
  matches: TextMatch[],
  message: (detail: string) => string,
  fix: string,
  index = new LineIndex(file.content),
): Finding[] {
  const seenLines = new Set<number>();
  const out: Finding[] = [];
  for (const m of [...matches].sort((a, b) => a.index - b.index)) {
    const pos = index.positionOf(m.index);
    if (seenLines.has(pos.line)) continue;
    seenLines.add(pos.line);
    out.push({
      ruleId: rule.id,
      severity: rule.severity,
      message: message(m.detail),
      file: file.path,
      line: pos.line,
      column: pos.column,
      fix,
    });
  }
  return out;
}

/** All matches of a regex (forced global), as [index, match] pairs. */
export function* matchAll(regex: RegExp, text: string): Generator<RegExpExecArray> {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    yield m;
    if (m[0].length === 0) re.lastIndex++;
  }
}
