import type { JudgeV1 } from '@vetkit/spec';
import { createJevJudge } from '@vetkit/judge-jev';
import { demoJudge } from 'vetkit';

// The one place that picks the judge: the offline demo judge (placeholder verdicts labelled
// 'demo') unless OPENROUTER_API_KEY is set, then Jev through OpenRouter.
export function pickJudge(): JudgeV1 {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (apiKey === undefined || apiKey === '') return demoJudge;
  return createJevJudge({ preset: 'openrouter', apiKey });
}
