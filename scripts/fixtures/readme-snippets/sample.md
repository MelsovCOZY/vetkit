# Sample README

Plain shell, no directive:

```sh
echo plain
```

<!-- snippet: file=vetkit.config.ts -->
```ts
export default {};
```

<!-- snippet: skip reason="needs a generator key" -->
```bash
vet init --source jsonl:traces
```

<!-- snippet: env GREETING=hello -->
```bash
echo "$GREETING"
```

A TypeScript block without a directive runs under node:

```ts
console.log('ts');
```

A yaml block without a file directive is an error:

```yaml
criteria: []
```

An unknown info string is ignored:

```text
not a snippet
```

<!--
```sh
echo inside-a-comment
```
-->

<!-- snippet: file=../escape.json -->
```json
{}
```
