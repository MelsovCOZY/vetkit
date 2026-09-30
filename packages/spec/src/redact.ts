// The one env-secret sanitizer every writer routes its output through. Pure text
// substitution, no I/O. The contract, which action/comment.mjs's own redactor mirrors:
//   - secrets come from env vars whose name contains KEY, TOKEN, SECRET, PASSWORD or
//     CREDENTIAL (case-insensitive) plus explicit extras;
//   - a value shorter than MIN_SECRET_LENGTH is never a secret: substituting a 3-char value
//     would mangle unrelated output ('e1t' inside 'edit');
//   - the set is de-duplicated and matched longest-first in a single alternation, so one
//     secret held in several env vars is substituted once and a secret containing another
//     is masked whole;
//   - matching is on token boundaries of the secret's own edges: a lookaround is added only
//     on an edge whose character is a word char. 'abcdefgh' inside 'xabcdefghx' is left
//     alone, but a secret with a non-word edge (e.g. a trailing '=') is masked even when
//     glued to a longer token, because the boundary rule never looks past the secret itself.

export const MIN_SECRET_LENGTH = 8;

const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
const WORD_CHAR = /\w/;
const REGEX_META = /[.*+?^${}()|[\]\\]/g;

export type SecretMask = (secret: string) => string;

const defaultMask: SecretMask = () => '[redacted]';

/** Secret values to redact: env values by name rule, plus `extra`; length-floored, longest first. */
export function secretsFrom(
  env: Record<string, string | undefined>,
  extra: readonly string[] = [],
): string[] {
  const values = [
    ...Object.entries(env)
      .filter(([name]) => SECRET_ENV_NAME.test(name))
      .map(([, value]) => value),
    ...extra,
  ].filter((value): value is string => typeof value === 'string');
  return [...new Set(values)]
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    .toSorted((a, b) => b.length - a.length);
}

function alternative(secret: string): string {
  const body = secret.replace(REGEX_META, String.raw`\$&`);
  const first = secret.charAt(0);
  const last = secret.charAt(secret.length - 1);
  const before = WORD_CHAR.test(first) ? String.raw`(?<!\w)` : '';
  const after = WORD_CHAR.test(last) ? String.raw`(?!\w)` : '';
  return `${before}${body}${after}`;
}

/** Masks every secret in `text`. `secrets` must come from `secretsFrom`. */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
  mask: SecretMask = defaultMask,
): string {
  if (secrets.length === 0) return text;
  const pattern = new RegExp(secrets.map(alternative).join('|'), 'g');
  return text.replace(pattern, mask);
}

/** Applies `redactSecrets` to every string in a JSON-like value; cycles become '[circular]'. */
export function redactSecretsDeep(
  value: unknown,
  secrets: readonly string[],
  mask: SecretMask = defaultMask,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') return redactSecrets(value, secrets, mask);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item, secrets, mask, seen));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactSecretsDeep(item, secrets, mask, seen)]),
  );
}
