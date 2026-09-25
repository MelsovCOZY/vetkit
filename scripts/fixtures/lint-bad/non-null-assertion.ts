// Fixture: noNonNullAssertion is an error, not a warning.
export function unwrap(value: string | undefined): string {
  return value!;
}
