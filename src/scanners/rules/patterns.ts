/**
 * Text detectors for agent instruction content. They work on any string, so
 * the MCP scanner reuses them on tool descriptions (MCP-001).
 */
import { codePointLabel, excerpt } from '../../core/text.js';
import { matchAll, type TextMatch } from '../shared.js';

// ---------------------------------------------------------------------------
// Clause helpers
// ---------------------------------------------------------------------------

const CLAUSE_BOUNDARY = /[.!?;\n]/;

/** Up to 60 characters before `index`, stopping at the start of its clause. */
function clauseBefore(text: string, index: number): string {
  let start = index;
  while (start > 0 && index - start < 60 && !CLAUSE_BOUNDARY.test(text[start - 1]!)) start--;
  return text.slice(start, index);
}

const NEGATION = /\b(?:never|not|no|avoid|refuse|forbidden|prohibited)\b|n't\b/i;

function isNegated(text: string, index: number): boolean {
  return NEGATION.test(clauseBefore(text, index));
}

// ---------------------------------------------------------------------------
// RULES-001: invisible and bidirectional characters
// ---------------------------------------------------------------------------

const INVISIBLE_NAMES: Record<number, string> = {
  0x200b: 'ZERO WIDTH SPACE',
  0x200c: 'ZERO WIDTH NON-JOINER',
  0x200d: 'ZERO WIDTH JOINER',
  0x200e: 'LEFT-TO-RIGHT MARK',
  0x200f: 'RIGHT-TO-LEFT MARK',
  0x2060: 'WORD JOINER',
  0xfeff: 'ZERO WIDTH NO-BREAK SPACE',
  0x202a: 'LEFT-TO-RIGHT EMBEDDING',
  0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING',
  0x202d: 'LEFT-TO-RIGHT OVERRIDE',
  0x202e: 'RIGHT-TO-LEFT OVERRIDE',
  0x2066: 'LEFT-TO-RIGHT ISOLATE',
  0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE',
  0x2069: 'POP DIRECTIONAL ISOLATE',
};

// Unicode tag characters (U+E0000 to U+E007F) are also invisible and can
// spell out a full hidden ASCII message ("ASCII smuggling").
const INVISIBLE = /[\u200B-\u200F\u2060\uFEFF\u202A-\u202E\u2066-\u2069]|[\u{E0000}-\u{E007F}]/gu;
const TAG_RUN = /[\u{E0000}-\u{E007F}]+/gu;

export interface InvisibleMatch extends TextMatch {
  codePoints: number[];
}

/** One match per line, listing the distinct invisible characters found on it. */
export function findInvisibleChars(text: string): InvisibleMatch[] {
  const byLine = new Map<number, InvisibleMatch>();
  let lineNo = 0;
  let lastScanned = 0;
  for (const m of matchAll(INVISIBLE, text)) {
    // A UTF-8 byte order mark at the very start of a file is an encoding
    // artefact (common from Windows editors), not hidden content.
    if (m.index === 0 && m[0] === '\uFEFF') continue;
    for (let i = lastScanned; i < m.index; i++) if (text.charCodeAt(i) === 10) lineNo++;
    lastScanned = m.index;
    const cp = m[0].codePointAt(0)!;
    const existing = byLine.get(lineNo);
    if (existing) {
      if (!existing.codePoints.includes(cp)) existing.codePoints.push(cp);
    } else {
      byLine.set(lineNo, { index: m.index, detail: '', codePoints: [cp] });
    }
  }

  const out = [...byLine.values()];
  for (const match of out) {
    const tags = match.codePoints.filter((cp) => cp >= 0xe0000);
    const named = match.codePoints
      .filter((cp) => cp < 0xe0000)
      .map((cp) => `${codePointLabel(cp)} ${INVISIBLE_NAMES[cp] ?? ''}`.trim());
    const parts = [...named];
    if (tags.length > 0) {
      const lineEnd = text.indexOf('\n', match.index);
      const lineText = text.slice(match.index, lineEnd === -1 ? undefined : lineEnd);
      const decoded = [...lineText.matchAll(TAG_RUN)]
        .map((r) => [...r[0]].map((ch) => decodeTag(ch.codePointAt(0)!)).join(''))
        .join(' ');
      parts.push(`Unicode tag characters decoding to "${excerpt(decoded, 60)}"`);
    }
    match.detail = parts.join(', ');
  }
  return out;
}

function decodeTag(cp: number): string {
  const ascii = cp - 0xe0000;
  return ascii >= 0x20 && ascii < 0x7f ? String.fromCharCode(ascii) : '';
}

// ---------------------------------------------------------------------------
// RULES-002: hidden comments and markup
// ---------------------------------------------------------------------------

/**
 * Words that make hidden text look like an instruction to an agent. Hyphens
 * count as part of a word so tool markers such as `prettier-ignore` or
 * `markdownlint-disable` do not match.
 */
const DIRECTIVE =
  /(?<![-\w])(?:you (?:must|should|are|will|need to|have to)|ignore|disregard|forget|pretend|instructions?|assistant|agents?|ai|llm|claude|copilot|cursor|codex|gemini|system prompt|run|execute|install|download|upload|send|post|fetch|curl|wget|delete|exfiltrate|secrets?|passwords?|tokens?|credentials?|api[ _-]?keys?|ssh|(?:do not|don't|never) (?:tell|mention|reveal|inform))(?![-\w])|\.env\b/i;

const HTML_COMMENT = /<!--([\s\S]*?)(?:-->|$)/g;
// Markdown link reference definitions used as comments: [//]: # (text)
const MD_COMMENT = /^[ \t]*\[(?:\/\/|comment|_)\]:\s*(?:#|<>)\s*(?:\((.*)\)|"(.*)"|'(.*)')[ \t]*$/gim;
const HIDDEN_TAG =
  /<[a-z][a-z0-9-]*\b[^>]*?(?:\shidden(?=[\s/>=])|\sstyle\s*=\s*(["'])[^"']*?(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d]*[1-9])|opacity\s*:\s*0(?![.\d]*[1-9]))[^"']*\1)[^>]*>/gi;

export function findHiddenContent(text: string): TextMatch[] {
  const out: TextMatch[] = [];
  for (const m of matchAll(HTML_COMMENT, text)) {
    const body = m[1] ?? '';
    if (DIRECTIVE.test(body)) {
      out.push({ index: m.index, detail: `HTML comment: "${excerpt(body, 60)}"` });
    }
  }
  for (const m of matchAll(MD_COMMENT, text)) {
    const body = m[1] ?? m[2] ?? m[3] ?? '';
    if (DIRECTIVE.test(body)) {
      out.push({ index: m.index, detail: `Markdown comment: "${excerpt(body, 60)}"` });
    }
  }
  for (const m of matchAll(HIDDEN_TAG, text)) {
    out.push({ index: m.index, detail: `hidden markup: ${excerpt(m[0], 60)}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// RULES-003: download piped into a shell
// ---------------------------------------------------------------------------

const SHELLS = '(?:sudo\\s+)?(?:ba|z|k|da|fi)?sh|python[0-9.]*|node|perl|ruby|pwsh|powershell|iex|invoke-expression';
const PIPE_TO_SHELL = new RegExp(
  [
    // curl ... | sh
    `\\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\\b[^\\n|]*\\|\\s*(?:${SHELLS})\\b`,
    // bash <(curl ...)   sh -c "$(curl ...)"
    `\\b(?:(?:ba|z|k|da)?sh|source)\\s+(?:-c\\s+)?["']?(?:<\\(|\\$\\()\\s*(?:curl|wget)\\b`,
    // iex (iwr ...)   Invoke-Expression (New-Object Net.WebClient).DownloadString(...)
    `\\b(?:iex|invoke-expression)\\s*\\(?\\s*\\(?\\s*(?:iwr|irm|invoke-webrequest|invoke-restmethod|new-object\\s+net\\.webclient)\\b`,
  ].join('|'),
  'gi',
);

export function findPipeToShell(text: string): TextMatch[] {
  return [...matchAll(PIPE_TO_SHELL, text)].map((m) => ({ index: m.index, detail: excerpt(m[0], 70) }));
}

// ---------------------------------------------------------------------------
// RULES-004: reading or sending credentials
// ---------------------------------------------------------------------------

const CRED_VERBS =
  'read|cat|open|print|output|echo|display|show|reveal|include|send|post|upload|exfiltrate|transmit|forward|copy|paste|share|e-?mail|leak|dump|collect|log|attach|embed|base64|curl|submit|report|grab|extract|access';
const CRED_TARGETS = [
  '\\.env(?!\\.(?:example|sample|template|dist)\\b)(?:\\.[\\w-]+)*\\b',
  'env(?:ironment)? files?',
  'environment variables',
  'process\\.env',
  '~?/?\\.ssh\\b',
  'id_(?:rsa|dsa|ecdsa|ed25519)',
  'ssh keys?',
  'private keys?',
  '\\.aws/credentials',
  'aws credentials',
  '\\.npmrc',
  '\\.netrc',
  '\\.pypirc',
  '\\.git-credentials',
  '\\.docker/config\\.json',
  '\\.kube/config',
  'kubeconfig',
  'credentials?',
  'secrets?',
  'api[ _-]?keys?',
  '(?:access|auth|bearer|session|github|npm|api) ?tokens?',
  'passwords?',
].join('|');

const CRED_ACCESS = new RegExp(`\\b(?:${CRED_VERBS})\\b[^.!?;\\n]{0,60}?(?:${CRED_TARGETS})`, 'gi');
const ENV_DUMP = /\b(?:printenv|env|set)\s*\|\s*(?:curl|wget|nc|netcat)\b/gi;

export function findCredentialAccess(text: string): TextMatch[] {
  const out: TextMatch[] = [];
  for (const m of matchAll(CRED_ACCESS, text)) {
    if (isNegated(text, m.index)) continue;
    // "Copy .env.example to .env" sets up a local file; it does not read secrets.
    if (/\.env\.(?:example|sample|template|dist)\b/i.test(m[0])) continue;
    out.push({ index: m.index, detail: excerpt(m[0], 70) });
  }
  for (const m of matchAll(ENV_DUMP, text)) {
    out.push({ index: m.index, detail: excerpt(m[0], 70) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// RULES-005: override earlier instructions, skip confirmation, hide actions
// ---------------------------------------------------------------------------

const OVERRIDE = [
  // ignore previous instructions / disregard the system prompt
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.!?;\n]{0,30}?\b(?:previous|prior|earlier|above|preceding|system|safety|original|your|initial)\b[^.!?;\n]{0,20}?\b(?:instructions?|rules|prompts?|guidelines|directives?|guardrails|polic(?:y|ies)|constraints|restrictions|messages?|context)\b/gi,
  // ignore all instructions
  /\b(?:ignore|disregard|forget)\s+(?:all|any)\s+(?:other\s+)?(?:instructions|prompts|directives|guidelines)\b/gi,
];

const SKIP_CONFIRM_DIRECT = [
  // do not ask for confirmation / no need to ask the user
  /\b(?:do not|don't|dont|never|no need to|stop|avoid)\s+(?:ask(?:ing)?|request(?:ing)?|wait(?:ing)? for|seek(?:ing)?|prompt(?:ing)?)\b[^.!?;\n]{0,30}?\b(?:confirm(?:ation)?s?|approvals?|permission|consent|sign-?off|the user|me|anyone|humans?)\b/gi,
  // skip confirmation / bypass approval
  /\b(?:skip|bypass|disable|turn off)\b[^.!?;\n]{0,20}?\b(?:confirmations?|approvals?|permission (?:checks?|prompts?)|safety checks?|human review|review step)\b/gi,
  // flags and modes that turn off prompts
  /--dangerously-skip-permissions\b|\bbypassPermissions\b|--yolo\b/gi,
  // do not tell the user
  /\b(?:do not|don't|dont|never)\s+(?:tell|inform|notify|alert|mention (?:this |it )?to|reveal (?:this |it )?to)\b[^.!?;\n]{0,15}?\b(?:the user|users?|anyone|the human|humans|the developer)\b/gi,
  /\b(?:do not|don't|dont|never)\s+(?:mention|reveal|disclose)\s+(?:this|these instructions|that you)\b/gi,
];

// "without asking" is only a problem when not already negated:
// "never push without asking" is a safeguard, "push without asking" is not.
const WITHOUT_CONFIRM =
  /\bwithout\s+(?:asking|confirm(?:ation|ing)?|approval|permission|consent|human review|review|prompting|checking with)\b/gi;

export function findInstructionOverride(text: string): TextMatch[] {
  const out: TextMatch[] = [];
  for (const re of [...OVERRIDE, ...SKIP_CONFIRM_DIRECT]) {
    for (const m of matchAll(re, text)) out.push({ index: m.index, detail: excerpt(m[0], 70) });
  }
  for (const m of matchAll(WITHOUT_CONFIRM, text)) {
    if (isNegated(text, m.index)) continue;
    out.push({ index: m.index, detail: excerpt(m[0], 70) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// RULES-006: long encoded blocks
// ---------------------------------------------------------------------------

export const MIN_BASE64_LENGTH = 80;
export const MIN_HEX_LENGTH = 80;

const BASE64_RUN = new RegExp(`[A-Za-z0-9+/_-]{${MIN_BASE64_LENGTH},}={0,2}`, 'g');
const HEX_RUN = new RegExp(`\\b[0-9a-fA-F]{${MIN_HEX_LENGTH},}\\b`, 'g');
const HEX_ESCAPES = /(?:\\x[0-9a-fA-F]{2}){20,}/g;

export function findEncodedBlocks(text: string): TextMatch[] {
  const out: TextMatch[] = [];
  const hexSpans: Array<[number, number]> = [];
  for (const m of matchAll(HEX_RUN, text)) {
    if (!/[a-f]/i.test(m[0]) || !/\d/.test(m[0])) continue;
    hexSpans.push([m.index, m.index + m[0].length]);
    out.push({ index: m.index, detail: `${m[0].length}-character hex block` });
  }
  for (const m of matchAll(HEX_ESCAPES, text)) {
    out.push({ index: m.index, detail: `${m[0].length / 4}-byte \\x escape sequence` });
  }
  for (const m of matchAll(BASE64_RUN, text)) {
    const run = m[0];
    // Require mixed character classes, which plain words and paths rarely have.
    if (!/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/\d/.test(run)) continue;
    if (hexSpans.some(([s, e]) => m.index >= s && m.index < e)) continue;
    // Part of a URL: the token before the run contains "://".
    let tokenStart = m.index;
    while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1]!)) tokenStart--;
    if (text.slice(tokenStart, m.index).includes('://')) continue;
    out.push({ index: m.index, detail: `${run.length}-character base64 block` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// RULES-007: installing unpinned packages
// ---------------------------------------------------------------------------

type Ecosystem = 'npm' | 'npx' | 'pip' | 'uvx' | 'pipx' | 'gem' | 'cargo' | 'go';

const INSTALL_COMMANDS: Array<{ re: RegExp; eco: Ecosystem }> = [
  { re: /\b(?:npm|pnpm|bun)\s+(?:install|i|add)\b/gi, eco: 'npm' },
  { re: /\byarn\s+(?:global\s+)?add\b/gi, eco: 'npm' },
  { re: /\b(?:npx|bunx)\b|\b(?:pnpm|yarn)\s+dlx\b|\bnpm\s+exec\b/gi, eco: 'npx' },
  { re: /\b(?:pip3?|python3?\s+-m\s+pip|uv\s+pip)\s+install\b|\buv\s+add\b|\bpoetry\s+add\b/gi, eco: 'pip' },
  { re: /\buvx\b|\buv\s+tool\s+(?:install|run)\b/gi, eco: 'uvx' },
  { re: /\bpipx\s+(?:install|run)\b/gi, eco: 'pipx' },
  { re: /\bgem\s+install\b/gi, eco: 'gem' },
  { re: /\bcargo\s+install\b/gi, eco: 'cargo' },
  { re: /\bgo\s+(?:install|get)\b/gi, eco: 'go' },
];

/** Flags whose next token is a value, not a package. */
const VALUE_FLAGS: Record<Ecosystem, string[]> = {
  npm: ['--registry', '--prefix', '-w', '--workspace', '--tag', '--cache'],
  npx: ['-c', '--call', '--registry', '--cache'],
  pip: ['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url', '-f', '--find-links', '-t', '--target', '--prefix', '--python', '--group'],
  uvx: ['--python', '--index-url', '--extra-index-url'],
  pipx: ['--python', '--pip-args', '--index-url'],
  gem: ['-v', '--version', '-i', '--install-dir', '--source'],
  cargo: ['--version', '--vers', '--git', '--path', '--root', '--branch', '--tag', '--rev', '--registry'],
  go: [],
};

const EXACT_SEMVER = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function isLocalOrUrl(spec: string): boolean {
  return /^(?:\.|\/|~|[a-z]:\\)|:\/\/|^(?:file|git|github|gitlab|bitbucket|link|workspace):|\.(?:whl|tar\.gz|tgz|zip)$/i.test(spec);
}

function isPlaceholder(spec: string): boolean {
  // <package>, {name}, $PKG, ...
  return /^<.*>$|[{}$]|^\.\.\.$/.test(spec);
}

function npmPinned(spec: string): boolean {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return false;
  return EXACT_SEMVER.test(spec.slice(at + 1));
}

function pipPinned(spec: string): boolean {
  return /^[A-Za-z0-9._-]+(?:\[[^\]]*\])?===?[0-9][0-9A-Za-z.+!-]*$/.test(spec);
}

function stripQuotes(token: string): string {
  return token.replace(/^["']|["']$/g, '');
}

/** Returns the unpinned package names in the arguments of one install command. */
function unpinnedPackages(eco: Ecosystem, args: string[]): string[] {
  const tokens = args.map(stripQuotes).filter((t) => t.length > 0);
  const valueFlags = VALUE_FLAGS[eco];
  const positionals: string[] = [];
  const packageFlagValues: string[] = [];
  let hasVersionFlag = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith('-')) {
      const [flag, inline] = t.split('=', 2) as [string, string | undefined];
      if ((eco === 'gem' && (flag === '-v' || flag === '--version')) || (eco === 'cargo' && (flag === '--version' || flag === '--vers'))) {
        hasVersionFlag = true;
      }
      if ((eco === 'npx' && (flag === '-p' || flag === '--package')) || (eco === 'uvx' && (flag === '--from' || flag === '--with'))) {
        const value = inline ?? tokens[++i];
        if (value) packageFlagValues.push(stripQuotes(value));
        continue;
      }
      // pip: -r/-e take a file or path; nothing to check there.
      if (valueFlags.includes(flag) && inline === undefined) i++;
      continue;
    }
    positionals.push(t);
  }

  let candidates: string[];
  switch (eco) {
    case 'npx':
    case 'uvx':
    case 'pipx':
      // Only the first positional is a package; the rest are its arguments.
      candidates = packageFlagValues.length > 0 ? packageFlagValues : positionals.slice(0, 1);
      break;
    default:
      candidates = positionals;
  }

  const unpinned: string[] = [];
  for (const spec of candidates) {
    if (isPlaceholder(spec) || isLocalOrUrl(spec)) continue;
    let pinned: boolean;
    switch (eco) {
      case 'npm':
      case 'npx':
        pinned = npmPinned(spec);
        break;
      case 'pip':
      case 'pipx':
        pinned = pipPinned(spec);
        break;
      case 'uvx':
        pinned = pipPinned(spec) || npmPinned(spec);
        break;
      case 'gem':
        pinned = hasVersionFlag || /:\d/.test(spec);
        break;
      case 'cargo':
        pinned = hasVersionFlag || npmPinned(spec);
        break;
      case 'go':
        pinned = npmPinned(spec);
        break;
    }
    if (!pinned) unpinned.push(spec);
  }
  return unpinned;
}

const ARG_TERMINATOR = /[;&|`)\n#]|\s(?:and|then)\s/;

export function findUnpinnedInstalls(text: string): TextMatch[] {
  const out: TextMatch[] = [];
  for (const { re, eco } of INSTALL_COMMANDS) {
    for (const m of matchAll(re, text)) {
      const rest = text.slice(m.index + m[0].length);
      const end = rest.search(ARG_TERMINATOR);
      const argText = end === -1 ? rest : rest.slice(0, end);
      const names = unpinnedPackages(eco, argText.split(/\s+/));
      if (names.length > 0) {
        out.push({ index: m.index, detail: `${m[0].replace(/\s+/g, ' ')} ${names.join(' ')}` });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// RULES-008: fetch and follow external URLs
// ---------------------------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s)>\]'"`]+/i;
const FOLLOW_PHRASE = [
  /\b(?:follow|obey|apply|execute|run|carry out|adhere to|comply with|do what)\b[^.!?;\n]{0,40}?\b(?:instructions?|directions|steps|rules|commands?|guidance|it says|they say)\b/i,
  /\b(?:fetch|load|read|retrieve|download|pull|get|import)\b[^.!?;\n]{0,30}?\b(?:instructions?|rules|guidelines|prompts?|directives|polic(?:y|ies))\b[^.!?;\n]{0,10}?\bfrom\b/i,
];

export function findRemoteInstructions(text: string): TextMatch[] {
  const out: TextMatch[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const url = URL_RE.exec(line);
    if (url && FOLLOW_PHRASE.some((re) => re.test(line))) {
      out.push({ index: offset + url.index, detail: excerpt(url[0], 70) });
    }
    offset += line.length + 1;
  }
  return out;
}
