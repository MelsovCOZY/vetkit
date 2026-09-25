// Spec-version literal and the adapter kind union, kept in their own module so
// version.test-d.ts can typecheck them without importing the registry mechanics.

export const SPEC_VERSION = 'v1' as const;
export type SpecVersion = typeof SPEC_VERSION;

export const ADAPTER_KINDS = ['source', 'generator', 'judge', 'sink', 'exporter'] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];
