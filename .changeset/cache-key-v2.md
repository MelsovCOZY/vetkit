---
'@vetkit/core': patch
'vetkit': patch
---

The judge cache key now includes the judge transport, the core version and the repeat index, so every existing `.vet` cache entry misses once and is re-judged.
