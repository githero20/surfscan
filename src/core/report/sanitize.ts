import { redactSecrets } from '../secret-patterns.js';
import type { Finding } from '../types.js';

// C0 controls (except tab), DEL, C1 controls, and invisible or bidirectional
// format characters. Printing these raw would let a scanned file rewrite the
// terminal (ANSI escapes) or reorder the report text (bidi overrides).
const UNSAFE = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;

/** Make text safe to print on a terminal: escape control and invisible characters. */
export function escapeUnsafe(text: string): string {
  return text.replace(UNSAFE, (ch) => {
    const cp = ch.codePointAt(0)!;
    return cp > 0xffff ? `\\u{${cp.toString(16).toUpperCase()}}` : `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  });
}

/** Mask secrets in every text field of a finding. Applied to all output formats. */
export function redactFinding(f: Finding): Finding {
  return {
    ...f,
    message: redactSecrets(f.message),
    fix: redactSecrets(f.fix),
    file: redactSecrets(f.file),
  };
}
