// The Node floor for the CLI: native type stripping (vetkit.config.ts) needs ^22.18 or >=24.11.
// Checked by run() only, never by the library entry, so importing 'vetkit' cannot exit a host.
export const NODE_FLOOR_RANGE = '^22.18 || >=24.11';

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)/;

/** A one-line message when `version` is below the floor (or unparseable), else undefined. */
export function nodeFloorError(version: string): string | undefined {
  const match = VERSION_PATTERN.exec(version);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  const ok =
    match !== null &&
    ((major === 22 && minor >= 18) || (major === 24 && minor >= 11) || major > 24);
  return ok ? undefined : `vetkit needs Node ${NODE_FLOOR_RANGE} (found ${version})`;
}
