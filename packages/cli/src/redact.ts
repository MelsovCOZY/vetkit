const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD)$/;

const PATTERN = new RegExp(
  [
    'sk-[A-Za-z0-9_-]{6,}',
    'pk-lf-[A-Za-z0-9_-]{6,}',
    'Bearer [A-Za-z0-9._-]{6,}',
    '[A-Za-z0-9+/]{32,}={0,2}',
    '[0-9a-fA-F]{32,}',
  ].join('|'),
  'g',
);

const mask = (value: string): string => `<redacted:${value.length} chars>`;

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
  return withoutEnvSecrets.replace(PATTERN, mask);
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
