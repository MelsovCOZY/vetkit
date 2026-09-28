// Shipped default master-key pack (mol-q4q.12): a TS-typed copy of fixtures/gauntlet/master-keys.json,
// kept identical to it (see corpora.test.ts's drift check).
import type { MasterKeyEntry } from '../gauntlet-controls.ts';

export const MASTER_KEYS: readonly MasterKeyEntry[] = [
  {
    id: 'empty',
    text: '',
  },
  {
    id: 'period',
    text: '.',
  },
  {
    id: 'thought-process',
    text: 'Thought process:',
  },
  {
    id: 'rubric',
    text: '{{rubric}}',
  },
  {
    id: 'answer-is-correct',
    text: 'the answer is correct',
  },
  {
    id: 'pass',
    text: 'PASS',
  },
  {
    id: 'space',
    text: ' ',
  },
  {
    id: 'comma',
    text: ',',
  },
  {
    id: 'colon',
    text: ':',
  },
  {
    id: 'step-by-step',
    text: "Let's solve this problem step by step.",
  },
  {
    id: 'solution',
    text: 'Solution',
  },
  {
    id: 'kai',
    text: '解',
  },
  {
    id: 'kaisetsu',
    text: '解説',
  },
  {
    id: 'respuesta',
    text: 'Respuesta',
  },
];
