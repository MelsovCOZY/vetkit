// generated — do not edit

export type GauntletOutcome = 'pass' | 'fail' | 'skipped';
export type LockReason =
  | 'too_few_labels'
  | 'single_class'
  | 'single_class_heldout'
  | 'class_too_small'
  | 'unstable'
  | 'too_few_repeats'
  | 'language_limited'
  | 'score_not_gateable'
  | 'reference_missing'
  | 'judge_unavailable'
  | 'paraphrase'
  | 'polarity'
  | 'injection'
  | 'master_key'
  | 'label_permutation'
  | 'constant_output'
  | 'position_swap'
  | 'length';

export interface Lock {
  lockVersion: 1;
  model: LockModel;
  criteria: {
    [k: string]: LockCriterion;
  };
  datasetHash: string;
  /**
   * Judge request format the lock was calibrated with.
   */
  requestFormat?: 'raw' | 'fenced-v1';
}
export interface LockModel {
  requested: string;
  resolved: string;
  transport: string;
  pinned: boolean;
  releaseDate?: string;
}
export interface LockCriterion {
  wordingHash: string;
  normalizedWordingHash?: string;
  status: 'calibrated' | 'uncalibrated' | 'floating';
  threshold?: number;
  tpr?: number;
  tnr?: number;
  ece?: number;
  tolerance?: number;
  gauntlet: GauntletResult;
  gauntletDetail?: GauntletDetail;
  reasons: LockReason[];
  languages?: string[];
  labelCount: number;
  unscored?: number;
  unscoredCauses?: string[];
}
export interface GauntletResult {
  paraphrase: GauntletOutcome;
  polarity: GauntletOutcome;
  injection: GauntletOutcome;
  master_key: GauntletOutcome;
  label_permutation: GauntletOutcome;
  constant_output: GauntletOutcome;
  position_swap: GauntletOutcome;
  length: GauntletOutcome;
}
export interface GauntletDetail {
  masterKeyReason?: 'no_escape';
  masterKeyFailed?: {
    kind: string;
    caseId: string;
  }[];
  injectionFlips?: {
    family: string;
    flips: number;
    trials: number;
  }[];
}
