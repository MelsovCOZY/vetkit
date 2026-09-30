## --version

```json
{
  "version": "0.1.0"
}
```

| field | type | required |
| --- | --- | --- |
| `version` | string | yes |

## doctor

```json
{
  "checks": [
    {
      "name": "node",
      "status": "pass",
      "detail": "v22.23.2 satisfies ^22.18 || >=24.11"
    }
  ],
  "exitCode": 0
}
```

| field | type | required |
| --- | --- | --- |
| `checks` | array | yes |
| `exitCode` | any | yes |
| `config` | object | no |

## init

```json
{
  "files": [
    "vetkit.config.ts",
    "evals/criteria.yaml"
  ]
}
```

| field | type | required |
| --- | --- | --- |
| `files` | array | yes |

## init --source

```json
{
  "criteria": [],
  "cases": [],
  "report": {
    "status": "ok",
    "issues": []
  },
  "generator": {
    "calls": 2,
    "inputTokens": null,
    "outputTokens": null,
    "estimatedUsd": null
  }
}
```

| field | type | required |
| --- | --- | --- |
| `criteria` | array | yes |
| `cases` | array | yes |
| `report` | object | yes |
| `generator` | object | yes |
| `summary` | object | no |
| `reason` | string | no |

## init --source otlp

```json
{
  "criteria": [],
  "cases": [],
  "report": {
    "status": "ok",
    "issues": []
  },
  "generator": {
    "calls": 2,
    "inputTokens": null,
    "outputTokens": null,
    "estimatedUsd": null
  },
  "summary": {
    "cases": 1,
    "excluded": {},
    "dialects": {
      "gen_ai": 1
    },
    "tokens": 165
  }
}
```

| field | type | required |
| --- | --- | --- |
| `criteria` | array | yes |
| `cases` | array | yes |
| `report` | object | yes |
| `generator` | object | yes |
| `summary` | object | yes |
| `reason` | string | no |

## label

```json
{
  "imported": 120,
  "files": [
    "evals/labels/tone.csv"
  ]
}
```

| field | type | required |
| --- | --- | --- |
| `imported` | integer | yes |
| `files` | array | yes |

## run

```json
{
  "results": [
    {
      "caseId": "case-1",
      "criterionId": "tone",
      "status": "ok",
      "pass": true,
      "borderline": false
    }
  ],
  "summary": {
    "total": 1,
    "passed": 1,
    "failed": 0,
    "unscored": 0,
    "aborted": false,
    "byCriterion": {}
  },
  "model": {
    "requested": "jev",
    "resolved": "jev-2026",
    "transport": "gateway",
    "pinned": false
  },
  "exitCode": 0,
  "gateReasons": []
}
```

| field | type | required |
| --- | --- | --- |
| `results` | array | yes |
| `summary` | object | yes |
| `model` | object | yes |
| `exitCode` | integer | yes |
| `gateReasons` | array | yes |

## rerun

```json
{
  "results": [
    {
      "caseId": "case-1",
      "criterionId": "tone",
      "status": "ok",
      "pass": true,
      "borderline": false
    }
  ],
  "summary": {
    "total": 1,
    "passed": 1,
    "failed": 0,
    "unscored": 0,
    "aborted": false,
    "byCriterion": {}
  },
  "model": {
    "requested": "jev",
    "resolved": "jev-2026",
    "transport": "gateway",
    "pinned": false
  },
  "exitCode": 0,
  "gateReasons": [],
  "criteriaPath": "evals/criteria.yaml",
  "casesPath": "evals/cases",
  "startedAt": "2026-09-30T08:00:00.000Z",
  "comparison": {
    "tone": {
      "meanDiff": 0,
      "se": 0,
      "ci95": [
        0,
        0
      ],
      "nPairs": 1,
      "nClusters": 1
    }
  }
}
```

| field | type | required |
| --- | --- | --- |
| `results` | array | yes |
| `summary` | object | yes |
| `model` | object | yes |
| `exitCode` | integer | yes |
| `gateReasons` | array | yes |
| `criteriaPath` | string | yes |
| `casesPath` | string | yes |
| `startedAt` | string | yes |
| `comparison` | object | yes |

## validate

```json
{
  "criteria": [
    {
      "id": "tone",
      "status": "calibrated"
    }
  ],
  "model": {
    "requested": "jev",
    "resolved": "jev-2026",
    "transport": "gateway",
    "pinned": false
  },
  "datasetHash": "abc123",
  "lockPath": "criteria.lock.json"
}
```

| field | type | required |
| --- | --- | --- |
| `criteria` | array | yes |
| `model` | object | yes |
| `datasetHash` | string | yes |
| `lockPath` | string | yes |

## estimate

```json
{
  "for": "run",
  "cases": 1,
  "criteria": 1,
  "cacheHits": 0,
  "calls": 1,
  "inputTokens": 131,
  "cost": "unknown",
  "minutes": 0.04,
  "callsPerMinute": 25,
  "warnings": []
}
```

**estimate for run**

| field | type | required |
| --- | --- | --- |
| `for` | "run" | yes |
| `cases` | integer | yes |
| `criteria` | integer | yes |
| `cacheHits` | integer | yes |
| `calls` | integer | yes |
| `inputTokens` | integer | yes |
| `cost` | any | yes |
| `minutes` | number | yes |
| `callsPerMinute` | number | yes |
| `warnings` | array | yes |

**estimate --for validate**

| field | type | required |
| --- | --- | --- |
| `for` | "validate" | yes |
| `base` | object | yes |
| `parts` | array | yes |
| `total` | object | yes |
| `warnings` | array | yes |

## check

```json
{
  "stale": false,
  "reasons": [],
  "criteria": [],
  "releaseDate": "unknown",
  "staleCriteria": [],
  "lockPath": "criteria.lock.json"
}
```

**lock check (default)**

| field | type | required |
| --- | --- | --- |
| `stale` | boolean | yes |
| `reasons` | array | yes |
| `criteria` | array | yes |
| `releaseDate` | string | yes |
| `staleCriteria` | array | yes |
| `lockPath` | string | yes |

**outbox reconcile (--outbox alone)**

| field | type | required |
| --- | --- | --- |
| `produced` | integer | yes |
| `acknowledged` | integer | yes |
| `skipped` | integer | yes |
| `dead` | integer | yes |

**both (--lock and --outbox)**

| field | type | required |
| --- | --- | --- |
| `lock` | object | yes |
| `outbox` | object | yes |

## lock refresh

```json
{
  "refreshed": [
    "tone"
  ],
  "refreshedWhitespace": [],
  "stale": [],
  "lockPath": "criteria.lock.json"
}
```

| field | type | required |
| --- | --- | --- |
| `refreshed` | array | yes |
| `refreshedWhitespace` | array | yes |
| `stale` | array | yes |
| `lockPath` | string | yes |

## criteria disable

```json
{
  "disabled": "tone",
  "files": [
    "evals/criteria.yaml"
  ]
}
```

| field | type | required |
| --- | --- | --- |
| `disabled` | string | yes |
| `files` | array | yes |

## criteria enable

```json
{
  "enabled": "tone",
  "files": [
    "evals/criteria.yaml"
  ]
}
```

| field | type | required |
| --- | --- | --- |
| `enabled` | string | yes |
| `files` | array | yes |

## criteria delete

```json
{
  "removed": "tone",
  "files": [
    "evals/criteria.yaml"
  ]
}
```

| field | type | required |
| --- | --- | --- |
| `removed` | string | yes |
| `files` | array | yes |

## criteria revalidate

```json
{
  "revalidate": "tone",
  "files": [
    "criteria.lock.json"
  ]
}
```

| field | type | required |
| --- | --- | --- |
| `revalidate` | string | yes |
| `files` | array | yes |

## cases dedupe

```json
{
  "duplicates": [],
  "nearDuplicates": [],
  "written": false
}
```

| field | type | required |
| --- | --- | --- |
| `duplicates` | array | yes |
| `nearDuplicates` | array | yes |
| `written` | boolean | yes |

## cases quarantine

```json
{
  "id": "case-2",
  "status": "quarantined"
}
```

| field | type | required |
| --- | --- | --- |
| `id` | string | yes |
| `status` | string | yes |

## cases promote

```json
{
  "promoted": {
    "id": "promoted-t1-tone",
    "input": {
      "state": "User: hi"
    },
    "tags": []
  }
}
```

| field | type | required |
| --- | --- | --- |
| `promoted` | object | yes |

## cases review

```json
{
  "remaining": 0
}
```

| field | type | required |
| --- | --- | --- |
| `remaining` | integer | yes |

## lint

```json
{
  "issues": []
}
```

| field | type | required |
| --- | --- | --- |
| `issues` | array | yes |

## migrate

```json
{
  "files": [
    {
      "path": "evals/criteria.yaml",
      "format": "criteria",
      "from": null,
      "to": 1,
      "action": "stamped"
    }
  ],
  "migrated": 1
}
```

| field | type | required |
| --- | --- | --- |
| `files` | array | yes |
| `migrated` | integer | yes |

## export

```json
{
  "files": [
    "evals/vitest/criteria.yaml.evals.test.ts"
  ],
  "include": "evals/vitest/**/*.evals.test.ts"
}
```

| field | type | required |
| --- | --- | --- |
| `files` | array | yes |
| `include` | string | yes |

## watch

```json
{
  "seen": 0,
  "sampled": 0,
  "judged": 0,
  "unscored": 0,
  "unscoredCauses": [],
  "promoted": 0,
  "produced": 0,
  "acknowledged": 0,
  "excluded": {
    "content_not_captured": 0,
    "truncated": 0,
    "incomplete_trace": 0
  },
  "promotedSkipped": 0
}
```

| field | type | required |
| --- | --- | --- |
| `seen` | integer | yes |
| `sampled` | integer | yes |
| `judged` | integer | yes |
| `unscored` | integer | yes |
| `unscoredCauses` | array | yes |
| `promoted` | integer | yes |
| `produced` | integer | yes |
| `acknowledged` | integer | yes |
| `excluded` | object | yes |
| `promotedSkipped` | integer | yes |
