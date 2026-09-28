const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD)$/;

// Known-prefix / header-shaped secrets: always redacted, regardless of surrounding context.
const KNOWN_PREFIX_PATTERN = new RegExp(
  ['sk-[A-Za-z0-9_-]{6,}', 'pk-lf-[A-Za-z0-9_-]{6,}', 'Bearer [A-Za-z0-9._-]{6,}'].join('|'),
  'g',
);

// Generic high-entropy runs. '/' is deliberately excluded so a match can never span a
// filesystem path separator (a bare path can otherwise look like base64). A 64-hex run is
// excluded below because that is this codebase's case-id shape, not a secret.
const HIGH_ENTROPY_PATTERN = new RegExp(
  ['[A-Za-z0-9+]{32,}={0,2}', '[0-9a-fA-F]{32,}'].join('|'),
  'g',
);

const mask = (value: string): string => `<redacted:${value.length} chars>`;

const HEX_ONLY = /^[0-9a-fA-F]+$/;

// A match immediately touching a '/' is a single path segment (a directory name or
// filename), not a secret: e.g. a uuid-shaped or random-suffix temp-dir segment.
function isPathSegment(str: string, index: number, length: number): boolean {
  return str[index - 1] === '/' || str[index + length] === '/';
}

// This codebase's case ids are 64-hex (sha256); never mask them as secrets.
function isCaseId(match: string): boolean {
  return match.length === 64 && HEX_ONLY.test(match);
}

function secretEnvValues(env: Record<string, string | undefined>): readonly string[] {
  return Object.entries(env)
    .filter(
      (entry): entry is [string, string] =>
        SECRET_ENV_NAME.test(entry[0]) && typeof entry[1] === 'string' && entry[1].length > 0,
    )
    .map(([, value]) => value)
    .toSorted((a, b) => b.length - a.length);
}

function redactString(value: string, secrets: readonly string[]): string {
  const withoutEnvSecrets = secrets.reduce(
    (acc, secret) => acc.split(secret).join(mask(secret)),
    value,
  );
  const withoutKnownPrefixes = withoutEnvSecrets.replace(KNOWN_PREFIX_PATTERN, mask);
  return withoutKnownPrefixes.replace(
    HIGH_ENTROPY_PATTERN,
    (match, offset: number, str: string) => {
      if (isPathSegment(str, offset, match.length)) return match;
      if (isCaseId(match)) return match;
      return mask(match);
    },
  );
}

function walk(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, secrets, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, walk(item, secrets, seen)]),
  );
}

export function redact(value: string, env?: Record<string, string | undefined>): string;
export function redact(
  value: Record<string, unknown>,
  env?: Record<string, string | undefined>,
): Record<string, unknown>;
export function redact(value: unknown, env?: Record<string, string | undefined>): unknown;
export function redact(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): unknown {
  return walk(value, secretEnvValues(env), new WeakSet());
}
