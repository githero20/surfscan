/**
 * Patterns for well-known secret formats. Used by the report layer as a last
 * line of defence against printing a secret, and by the keys scanner.
 */
export interface SecretPattern {
  name: string;
  regex: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'AWS access key ID', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'Stripe live key', regex: /\b(?:sk|rk)_live_[0-9A-Za-z]{10,}\b/g },
  { name: 'GitHub token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{30,}\b/g },
  { name: 'GitHub fine-grained token', regex: /\bgithub_pat_[0-9A-Za-z_]{30,}\b/g },
  { name: 'Slack token', regex: /\bxox[abposr]-[0-9A-Za-z-]{10,}\b/g },
  {
    name: 'PEM private key',
    regex: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g,
  },
];

/** Mask a secret value: first 4 characters, then "...". */
export function maskSecret(value: string): string {
  return `${value.slice(0, 4)}...`;
}

/** Replace any known secret format in the text with its masked form. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { regex } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(regex.source, regex.flags), (m) => maskSecret(m));
  }
  return out;
}
