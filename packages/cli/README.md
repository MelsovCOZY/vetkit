<p align="center">
  <img src="https://raw.githubusercontent.com/MelsovCOZY/vetkit/master/assets/logo.png" alt="vetkit" width="192" height="192">
</p>

vetkit generates, validates and runs LLM evals from the command line. This package installs the `vet` binary.

```
npm i -D vetkit
```

Node >=22.12.

```
npx vet --help
npx vet doctor
```

`vet doctor` checks the environment, judge credentials and judge endpoint health. Other commands
include `init`, `label`, `validate`, `estimate`, `run`, `rerun`, `check`, `lint`, `export` and
`watch`. Run `vet --help` for the full list and the exit codes.

The judge is Jev, reached through a configurable transport. Nothing is tied to one model,
provider or gateway.

Source, the package list and contributing notes are in the vetkit repository (see README.md and CONTRIBUTING.md there).
