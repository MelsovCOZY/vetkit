# vetkit

## 0.1.0

### Minor Changes

- 41def8c: First public release.

### Patch Changes

- 7502a7c: The judge cache key now includes the judge transport, the core version and the repeat index, so every existing `.vet` cache entry misses once and is re-judged.
- Updated dependencies [7502a7c]
- Updated dependencies [41def8c]
  - @vetkit/core@0.1.0
  - @vetkit/spec@0.1.0
  - @vetkit/judge-jev@0.1.0
  - @vetkit/generator-openai-compatible@0.1.0
  - @vetkit/export-vitest@0.1.0
  - @vetkit/source-jsonl@0.1.0
  - @vetkit/source-otlp@0.1.0
  - @vetkit/sink-langfuse@0.1.0
  - @vetkit/sink-otel@0.1.0
