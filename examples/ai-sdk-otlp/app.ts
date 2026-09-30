import { gateway, generateText } from 'ai';
import { MockLanguageModelV2 } from 'ai/test';
import { sdk } from './otel.ts';

// With AI_GATEWAY_API_KEY set the call goes to a real model; without it a mock model returns a
// fixed reply, so the telemetry wiring runs offline. The spans come from generateText itself.
const model = process.env['AI_GATEWAY_API_KEY']
  ? gateway('openai/gpt-4o-mini')
  : new MockLanguageModelV2({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'Yes. I have issued a full refund to your card.' }],
        finishReason: 'stop',
        usage: { inputTokens: 12, outputTokens: 11, totalTokens: 23 },
        warnings: [],
      }),
    });

try {
  const { text } = await generateText({
    model,
    prompt: 'Can I get a refund for order #4411?',
    experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true },
  });
  console.log(text);
} finally {
  await sdk.shutdown();
}
