// Shared by the built-in dialects: reports a message role the dialect does not know and maps
// to a fallback. The diag names the role (capped) and the span, and never any message content.

import type { Message } from '@vetkit/spec';
import type { OtlpDiag } from '../normalize/dialect.ts';

const MAX_ROLE_CHARS = 64;

const KNOWN_ROLES: readonly string[] = ['user', 'assistant', 'system', 'tool'];

export function isKnownRole(role: string): role is Message['role'] {
  return KNOWN_ROLES.includes(role);
}

// Only a non-empty string role is reported: an absent or non-string role is not an "unknown
// role", it is no role at all.
export function reportUnknownRole(
  onDiag: ((d: OtlpDiag) => void) | undefined,
  spanId: string,
  role: unknown,
  mappedTo: Message['role'],
): void {
  if (onDiag === undefined || typeof role !== 'string' || role === '' || isKnownRole(role)) return;
  const shown = role.length > MAX_ROLE_CHARS ? `${role.slice(0, MAX_ROLE_CHARS)}...` : role;
  onDiag({
    code: 'unknown_role',
    level: 'warn',
    detail: `span ${spanId}: unknown role ${JSON.stringify(shown)} mapped to ${mappedTo}`,
  });
}
