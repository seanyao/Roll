/**
 * @responsibility Redacts secrets and PII from captured evidence.
 */
/**
 * US-ATTEST-012 — secret / PII redaction red line.
 *
 * Acceptance evidence is human-authored command output: it can carry a token,
 * an `Authorization` header, a private key, or a personal email. Once such a
 * string is inlined into `report.html` it is archived forever (the run dir is
 * never overwritten). So the report layer scrubs evidence text BEFORE it lands,
 * and screenshot lanes REFUSE a capture whose command embeds a secret (you
 * cannot un-bake a token baked into pixels — redact the command and reshoot).
 *
 * Contract: NEVER silent. {@link redactSecrets} returns the masked text AND the
 * list of pattern labels it hit, so the caller can WARN (留痕). Patterns are a
 * pragmatic common-case set, not a guarantee — defense in depth, not a vault.
 */

const MASK = "«REDACTED";

interface Pattern {
  label: string;
  re: RegExp;
}

// Order matters: structural blocks (PEM) before line-level tokens so a key
// body isn't double-masked. Each regex is global + multiline where needed.
const PATTERNS: readonly Pattern[] = [
  // PEM private key block (any flavour) — mask the whole armored body.
  {
    label: "private-key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  // Authorization / Bearer header values (token after the scheme word).
  { label: "authorization", re: /\b(Authorization|Bearer)\b[:\s]+[A-Za-z0-9._~+/=-]{12,}/g },
  // GitHub tokens: ghp_ / gho_ / ghs_ / ghr_ / github_pat_…
  { label: "github-token", re: /\b(?:gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  // AWS access key id.
  { label: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // OpenAI / Anthropic-style secret keys (`sk-…`).
  { label: "api-key", re: /\bsk-[A-Za-z0-9]{16,}\b/g },
  // Email addresses (PII).
  { label: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

export interface RedactResult {
  redacted: string;
  /** Deduped, source-order pattern labels that matched (empty = clean). */
  hits: string[];
}

/** Mask every known secret/PII pattern; report which patterns fired. */
export function redactSecrets(text: string): RedactResult {
  let out = text;
  const hits: string[] = [];
  for (const p of PATTERNS) {
    if (p.re.test(out)) {
      hits.push(p.label);
      out = out.replace(p.re, `${MASK}:${p.label}»`);
    }
    p.re.lastIndex = 0; // global regexes carry state — reset between inputs
  }
  return { redacted: out, hits };
}

/** Fast boolean: does this string carry a secret/PII? (screenshot reject gate). */
export function containsSecret(text: string): boolean {
  for (const p of PATTERNS) {
    const hit = p.re.test(text);
    p.re.lastIndex = 0;
    if (hit) return true;
  }
  return false;
}
