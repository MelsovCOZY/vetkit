// Shipped default padding pack (mol-q4q.12): a TS-typed copy of fixtures/gauntlet/padding.json,
// kept identical to it (see corpora.test.ts's drift check).
import type { PaddingTemplate } from '../gauntlet-bias.ts';

export const PADDINGS: readonly PaddingTemplate[] = [
  {
    id: 'restated-bullets',
    kind: 'restated_bullets',
    text: '\n\nTo summarise the points above:\n- The answer above addresses the request.\n- The answer above covers the request as stated.\n- The answer above responds to what was asked.\n- In short, the request has been addressed above.',
  },
  {
    id: 'mt-bench-repetitive-list',
    kind: 'mt_bench_repetitive_list',
    text: '\n\nHere is the answer again as a list:\n1. The response given above.\n2. The response given above, restated.\n3. The response given above, restated once more.\n4. The response given above, in other words.\n5. The response given above, repeated for completeness.',
  },
  {
    id: 'filler-paragraphs',
    kind: 'filler_paragraphs',
    text: '\n\nIt is worth taking a moment to reflect on the response above. Careful consideration has gone into it, and it has been written with attention and care. Every part of it was considered thoughtfully.\n\nIn conclusion, the response above stands as written. Thank you for reading it, and I hope it is helpful. Please let me know if there is anything else at all I can help with.',
  },
];
