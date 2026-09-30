// Adapter over the shared sanitizer in @vetkit/spec: the literal API key is masked out of any
// diagnostic value before it is attached to a thrown VetError (message, details or cause
// chain), including a server-echoed body or a network error's message. Keys shorter than the
// shared length floor are left alone, as everywhere else.
import { redactSecrets, redactSecretsDeep, secretsFrom } from '@vetkit/spec';

const mask = (): string => '[REDACTED]';

export function redactApiKeyString(value: string, apiKey: string): string {
  return redactSecrets(value, secretsFrom({}, [apiKey]), mask);
}

export function redactDeep(
  value: unknown,
  apiKey: string,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value instanceof Error) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const cause = value.cause;
    return new Error(
      redactApiKeyString(value.message, apiKey),
      cause !== undefined ? { cause: redactDeep(cause, apiKey, seen) } : undefined,
    );
  }
  return redactSecretsDeep(value, secretsFrom({}, [apiKey]), mask, seen);
}
