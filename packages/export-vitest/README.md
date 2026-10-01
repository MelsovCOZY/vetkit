# @vetkit/export-vitest

The vitest exporter for vetkit: `vet export --to vitest` turns your criteria, cases and lock into a
scorer module per criterion and a `*.evals.test.ts` file, so the same judged evals run inside your
existing vitest suite. The CLI installs it for you.

```sh
npm i -D vetkit vitest
```

Scaffold a project (no key needed: the demo judge is written into the config) and export it:

```sh
npx vetkit init
npx vetkit export --to vitest
```

The files land under `evals/vitest/`; add `evals/vitest/**/*.evals.test.ts` to `test.include` in
your vitest config and run `npx vitest run`.

---

Part of [vetkit](https://github.com/MelsovCOZY/vetkit): source and issues on GitHub, docs at
[melsovcozy.github.io/vetkit](https://melsovcozy.github.io/vetkit/).
