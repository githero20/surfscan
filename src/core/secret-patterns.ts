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
  { name: 'Anthropic API key', regex: /\bsk-ant-[0-9A-Za-z_-]{20,}/g },
  { name: 'OpenAI API key', regex: /\bsk-(?:proj|svcacct|admin)-[0-9A-Za-z_-]{20,}|\bsk-[0-9A-Za-z]{32,}\b/g },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { name: 'npm token', regex: /\bnpm_[0-9A-Za-z]{36}\b/g },
  { name: 'GitLab token', regex: /\bglpat-[0-9A-Za-z_-]{20,}/g },
  { name: 'Hugging Face token', regex: /\bhf_[0-9A-Za-z]{30,}\b/g },
  { name: 'SendGrid API key', regex: /\bSG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}(?![0-9A-Za-z_-])/g },
  { name: 'JSON Web Token', regex: /\beyJ[0-9A-Za-z_-]{8,}\.eyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}/g },
  {
    name: 'PEM private key',
    regex: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g,
  },
];

const HIDDEN = '[redacted]';

/** Values that name a secret rather than hold one, or are already masked. */
const NOT_A_VALUE = /^(?:\$|<|\{|%)|\.\.\.$|^\[redacted\]$/;

/**
 * Secrets found by what surrounds them. Each pattern captures the text to keep
 * and the value to hide. These only shape what is printed, so masking a harmless
 * word ("password is required") costs nothing, unlike printing a real password.
 */
const SECRET_IN_CONTEXT: readonly RegExp[] = [
  // Authorization: Bearer x. First, or the next pattern would take "Bearer" for the value.
  /(\b(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{8,})/g,
  // password=x  "api_key": "x"  the token is x
  /(\b[\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|credential|auth)[\w-]*["']?\s*(?:=|:|\s(?:is|was)\s)\s*["']?)([^\s"',;)]{4,})/gi,
  // --token x  --password=x
  /(--[\w-]*(?:password|passwd|token|api-?key|secret|auth)[\w-]*[= ]+["']?)([^\s"',;)]{4,})/gi,
  // curl -u user:password
  /((?:^|\s)(?:-u|--user)[ =]+["']?[^\s:"']+:)([^\s"']+)/g,
  // https://user:password@host
  /(:\/\/[^\s:/@]+:)([^\s@/]+)(?=@)/g,
];

/** A long token mixing upper case, lower case and digits. Next to a slash it is a path segment, so it stays. */
const OPAQUE_TOKEN = /(?<![\w+/-])[A-Za-z0-9_+-]{32,}(?![\w+/-])/g;

function hideOpaqueToken(token: string): string {
  return /[A-Z]/.test(token) && /[a-z]/.test(token) && /\d/.test(token) ? maskSecret(token) : token;
}

/** Mask a secret value: first 4 characters, then "...". */
export function maskSecret(value: string): string {
  return `${value.slice(0, 4)}...`;
}

/** Replace anything that looks like a secret in text about to be printed. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { regex } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(regex.source, regex.flags), (m) => maskSecret(m));
  }
  for (const regex of SECRET_IN_CONTEXT) {
    out = out.replace(new RegExp(regex.source, regex.flags), (whole, keep: string, value: string) =>
      NOT_A_VALUE.test(value) ? whole : `${keep}${HIDDEN}`,
    );
  }
  return out.replace(OPAQUE_TOKEN, hideOpaqueToken);
}
