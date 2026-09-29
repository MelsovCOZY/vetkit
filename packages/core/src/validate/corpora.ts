// Shipped gauntlet corpora: bundled TS copies of
// fixtures/gauntlet/*.json so a user project has real corpora out of the box, even though
// packages/core/package.json ships only 'dist' (fixtures/ is repo-only, never published).
// `vet validate --gauntlet` with no directory defaults to these (packages/cli/src/commands/validate.ts).
import type { ConstantEntry, InjectionEntry, MasterKeyEntry } from './gauntlet-controls.ts';
import type { PaddingTemplate } from './gauntlet-bias.ts';
import { CONSTANT_OUTPUTS } from './corpora/constant-outputs.ts';
import { INJECTIONS } from './corpora/injections.ts';
import { MASTER_KEYS } from './corpora/master-keys.ts';
import { PADDINGS } from './corpora/padding.ts';

export interface DefaultCorpora {
  readonly injections: readonly InjectionEntry[];
  readonly masterKeys: readonly MasterKeyEntry[];
  readonly constants: readonly ConstantEntry[];
  readonly paddings: readonly PaddingTemplate[];
}

export const DEFAULT_GAUNTLET_CORPORA: DefaultCorpora = {
  injections: INJECTIONS,
  masterKeys: MASTER_KEYS,
  constants: CONSTANT_OUTPUTS,
  paddings: PADDINGS,
};
