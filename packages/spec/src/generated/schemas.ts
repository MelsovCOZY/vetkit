// generated — do not edit

/* oxlint-disable unicorn/no-thenable */

import type { JsonSchema } from '../json.ts';

export const caseSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://vetkit.dev/schemas/case.schema.json',
  title: 'Case',
  type: 'object',
  properties: {
    id: {
      type: 'string',
    },
    input: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
        },
        answer: {
          type: 'string',
        },
      },
      required: ['state'],
      additionalProperties: false,
    },
    traceId: {
      type: 'string',
    },
    provenance: {},
    tags: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
    expected: {
      type: 'object',
      properties: {
        value: {},
        source: {
          enum: ['user', 'code_verified'],
        },
      },
      required: ['value', 'source'],
      additionalProperties: false,
    },
    language: {
      type: 'string',
      pattern: '^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$',
    },
    cluster: {
      type: 'string',
    },
  },
  required: ['id', 'input', 'provenance', 'tags'],
  additionalProperties: false,
} as const;

export const criterionSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://vetkit.dev/schemas/criterion.schema.json',
  title: 'Criterion',
  type: 'object',
  properties: {
    id: {
      type: 'string',
    },
    type: {
      enum: ['boolean', 'choice', 'score'],
    },
    instructions: {
      type: 'string',
    },
    criteria: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
        {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      ],
    },
    escape: {
      type: 'string',
    },
    passWhen: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
    escapeThreshold: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
    polarity: {
      enum: ['pass_when_true', 'pass_when_false'],
    },
    channel: {
      enum: ['outcome', 'safety', 'quality'],
    },
    provenance: {
      type: 'object',
      properties: {
        traceIds: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        generator: {
          type: 'string',
        },
      },
      required: ['traceIds'],
      additionalProperties: false,
    },
    wordingHash: {
      type: 'string',
      pattern: '^[0-9a-f]{64}$',
    },
    checkable: {
      enum: ['factual', 'math', 'code'],
    },
    grader: {
      oneOf: [
        {
          type: 'object',
          properties: {
            kind: {
              const: 'judge',
            },
          },
          required: ['kind'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            kind: {
              const: 'reference',
            },
          },
          required: ['kind'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            kind: {
              const: 'code',
            },
            check: {
              enum: ['exact', 'normalized', 'numeric'],
            },
          },
          required: ['kind', 'check'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['id', 'type', 'instructions', 'polarity', 'channel', 'provenance', 'wordingHash'],
  additionalProperties: false,
  oneOf: [
    {
      properties: {
        type: {
          const: 'boolean',
        },
        escape: true,
      },
      required: ['type', 'escape'],
      not: {
        anyOf: [
          {
            properties: {
              criteria: true,
            },
            required: ['criteria'],
          },
          {
            properties: {
              passWhen: true,
            },
            required: ['passWhen'],
          },
        ],
      },
    },
    {
      properties: {
        type: {
          const: 'choice',
        },
        escape: true,
        criteria: {
          type: 'object',
          minProperties: 2,
          maxProperties: 255,
          additionalProperties: {
            type: 'string',
          },
        },
        passWhen: true,
      },
      required: ['type', 'escape', 'criteria'],
    },
    {
      properties: {
        type: {
          const: 'score',
        },
        criteria: {
          type: 'array',
          minItems: 2,
          maxItems: 10,
          items: {
            type: 'string',
          },
        },
      },
      required: ['type', 'criteria'],
      not: {
        anyOf: [
          {
            properties: {
              escape: true,
            },
            required: ['escape'],
          },
          {
            properties: {
              passWhen: true,
            },
            required: ['passWhen'],
          },
        ],
      },
    },
  ],
  if: {
    properties: {
      grader: {
        type: 'object',
        properties: {
          kind: {
            const: 'code',
          },
        },
        required: ['kind'],
      },
    },
    required: ['grader'],
  },
  then: {
    properties: {
      type: {
        const: 'boolean',
      },
    },
    required: ['type'],
  },
} as const;

export const lockSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://vetkit.dev/schemas/lock.schema.json',
  title: 'Lock',
  type: 'object',
  $defs: {
    LockModel: {
      title: 'LockModel',
      type: 'object',
      properties: {
        requested: {
          type: 'string',
        },
        resolved: {
          type: 'string',
        },
        transport: {
          type: 'string',
        },
        pinned: {
          type: 'boolean',
        },
        releaseDate: {
          type: 'string',
        },
      },
      required: ['requested', 'resolved', 'transport', 'pinned'],
      additionalProperties: false,
    },
    GauntletOutcome: {
      title: 'GauntletOutcome',
      enum: ['pass', 'fail', 'skipped'],
    },
    GauntletResult: {
      title: 'GauntletResult',
      type: 'object',
      properties: {
        paraphrase: {
          $ref: '#/$defs/GauntletOutcome',
        },
        polarity: {
          $ref: '#/$defs/GauntletOutcome',
        },
        injection: {
          $ref: '#/$defs/GauntletOutcome',
        },
        master_key: {
          $ref: '#/$defs/GauntletOutcome',
        },
        label_permutation: {
          $ref: '#/$defs/GauntletOutcome',
        },
        constant_output: {
          $ref: '#/$defs/GauntletOutcome',
        },
        position_swap: {
          $ref: '#/$defs/GauntletOutcome',
        },
        length: {
          $ref: '#/$defs/GauntletOutcome',
        },
      },
      required: [
        'paraphrase',
        'polarity',
        'injection',
        'master_key',
        'label_permutation',
        'constant_output',
        'position_swap',
        'length',
      ],
      additionalProperties: false,
    },
    LockReason: {
      title: 'LockReason',
      enum: [
        'too_few_labels',
        'single_class',
        'single_class_heldout',
        'class_too_small',
        'unstable',
        'language_limited',
        'score_not_gateable',
        'reference_missing',
        'paraphrase',
        'polarity',
        'injection',
        'master_key',
        'label_permutation',
        'constant_output',
        'position_swap',
        'length',
      ],
    },
    LockCriterion: {
      title: 'LockCriterion',
      type: 'object',
      properties: {
        wordingHash: {
          type: 'string',
          pattern: '^[0-9a-f]{64}$',
        },
        status: {
          enum: ['calibrated', 'uncalibrated', 'floating'],
        },
        threshold: {
          type: 'number',
        },
        tpr: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        tnr: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        ece: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        tolerance: {
          type: 'number',
          minimum: 0,
        },
        gauntlet: {
          $ref: '#/$defs/GauntletResult',
        },
        reasons: {
          type: 'array',
          items: {
            $ref: '#/$defs/LockReason',
          },
        },
        languages: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        labelCount: {
          type: 'integer',
          minimum: 0,
        },
      },
      required: ['wordingHash', 'status', 'gauntlet', 'reasons', 'labelCount'],
      additionalProperties: false,
    },
  },
  properties: {
    lockVersion: {
      const: 1,
    },
    model: {
      $ref: '#/$defs/LockModel',
    },
    criteria: {
      type: 'object',
      additionalProperties: {
        $ref: '#/$defs/LockCriterion',
      },
    },
    datasetHash: {
      type: 'string',
      pattern: '^[0-9a-f]{64}$',
    },
  },
  required: ['lockVersion', 'model', 'criteria', 'datasetHash'],
  additionalProperties: false,
} as const;

export const verdictSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://vetkit.dev/schemas/verdict.schema.json',
  title: 'Verdict',
  type: 'object',
  $defs: {
    Answer: {
      type: 'object',
      properties: {
        type: {
          enum: ['boolean', 'choice', 'score'],
        },
        probability: {
          type: 'number',
        },
        choice: {
          type: 'string',
        },
        confidence: {
          type: 'number',
        },
        probabilities: {
          type: 'object',
          additionalProperties: {
            type: 'number',
          },
        },
        score: {
          type: 'number',
        },
        legend: {
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
      required: ['type'],
      additionalProperties: false,
      oneOf: [
        {
          properties: {
            type: {
              const: 'boolean',
            },
            probability: {
              type: 'number',
            },
          },
          required: ['type', 'probability'],
        },
        {
          properties: {
            type: {
              const: 'choice',
            },
            choice: {
              type: 'string',
            },
            confidence: {
              type: 'number',
            },
            probabilities: {
              type: 'object',
              additionalProperties: {
                type: 'number',
              },
            },
          },
          required: ['type', 'choice', 'confidence', 'probabilities'],
        },
        {
          properties: {
            type: {
              const: 'score',
            },
            score: {
              type: 'number',
            },
            confidence: {
              type: 'number',
            },
            legend: {
              type: 'object',
              additionalProperties: {
                type: 'string',
              },
            },
            probabilities: {
              type: 'object',
              additionalProperties: {
                type: 'number',
              },
            },
          },
          required: ['type', 'score', 'confidence', 'legend', 'probabilities'],
        },
      ],
    },
    Model: {
      type: 'object',
      properties: {
        requested: {
          type: 'string',
        },
        resolved: {
          type: 'string',
        },
        transport: {
          type: 'string',
        },
        pinned: {
          type: 'boolean',
        },
        provider: {
          type: 'string',
        },
        releaseDate: {
          type: 'string',
        },
      },
      required: ['requested', 'resolved', 'transport', 'pinned'],
      additionalProperties: false,
    },
  },
  properties: {
    caseId: {
      type: 'string',
    },
    criterionId: {
      type: 'string',
    },
    status: {
      enum: [
        'ok',
        'unscored',
        'error',
        'incomplete_trace',
        'truncated',
        'content_not_captured',
        'not_applicable',
        'infra_failure',
        'simulator_error',
      ],
    },
    answer: {
      $ref: '#/$defs/Answer',
    },
    pass: {
      type: 'boolean',
    },
    threshold: {
      type: 'number',
    },
    model: {
      $ref: '#/$defs/Model',
    },
    cacheHit: {
      type: 'boolean',
    },
    cause: {},
    explanation: {
      type: 'string',
    },
    gated: {
      type: 'boolean',
    },
    gateReason: {
      enum: ['score_not_gateable', 'language_not_calibrated'],
    },
  },
  required: ['caseId', 'criterionId', 'status', 'model', 'cacheHit'],
  additionalProperties: false,
  if: {
    properties: {
      status: {
        const: 'ok',
      },
    },
    required: ['status'],
  },
  else: {
    not: {
      properties: {
        answer: true,
      },
      required: ['answer'],
    },
  },
} as const;

export const specVersionSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://vetkit.dev/schemas/version.schema.json',
  title: 'SpecVersionDoc',
  type: 'object',
  properties: {
    specVersion: {
      const: 'v1',
    },
  },
  required: ['specVersion'],
  additionalProperties: false,
} as const;
