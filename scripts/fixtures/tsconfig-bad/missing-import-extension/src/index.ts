// Fixture for scripts/tsconfig.test.ts: a relative import without a file extension must
// fail (TS2835) under module "node20" resolution.
import { helper } from "./x";

export function useHelper(): number {
  return helper();
}
