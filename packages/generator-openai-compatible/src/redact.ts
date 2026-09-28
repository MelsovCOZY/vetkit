// Local copy of judge-jev's redactDeep: adapters import only @vetkit/spec, so the helper
// cannot be shared. Deep-redacts the literal API key out of any diagnostic value before it
// is attached to a thrown VetError (message, details or cause chain), including a
// server-echoed body or a network error's message.

export function redactApiKeyString(value: string, apiKey: string): string {
  return apiKey === '' ? value : value.split(apiKey).join('[REDACTED]');
}

export function redactDeep(
  value: unknown,
  apiKey: string,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') return redactApiKeyString(value, apiKey);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (value instanceof Error) {
    const cause = value.cause;
    return new Error(
      redactApiKeyString(value.message, apiKey),
      cause !== undefined ? { cause: redactDeep(cause, apiKey, seen) } : undefined,
    );
  }
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, apiKey, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactDeep(item, apiKey, seen)]),
  );
}
