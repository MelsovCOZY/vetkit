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

export const configSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://vetkit.dev/schemas/config.schema.json',
  title: 'ConfigDoc',
  description:
    'Declarative shape of vetkit.config.ts. Adapter objects are checked as {specVersion, id, capabilities} projections; their methods are checked structurally in core.',
  type: 'object',
  properties: {
    generator: {
      description:
        'Generator LLM: a registry name, an endpoint, or a generator adapter object. Optional; no implicit default.',
      anyOf: [
        {
          type: 'string',
          minLength: 1,
        },
        {
          $ref: '#/$defs/generatorEndpoint',
        },
        {
          $ref: '#/$defs/adapterRef',
        },
      ],
    },
    judge: {
      description:
        'Judge: a registry name, an endpoint, or a JudgeV1 adapter object. Required; never defaulted.',
      anyOf: [
        {
          type: 'string',
          minLength: 1,
        },
        {
          $ref: '#/$defs/judgeEndpoint',
        },
        {
          $ref: '#/$defs/adapterRef',
        },
      ],
    },
    registry: {
      description:
        'User-declared map from name to endpoint or adapter object; the only way a string judge/generator resolves.',
      type: 'object',
      additionalProperties: {
        anyOf: [
          {
            $ref: '#/$defs/judgeEndpoint',
          },
          {
            $ref: '#/$defs/generatorEndpoint',
          },
          {
            $ref: '#/$defs/adapterRef',
          },
        ],
      },
    },
    sources: {
      description: 'Trace sources: opaque names or source adapter objects.',
      type: 'array',
      items: {
        $ref: '#/$defs/pluginRef',
      },
    },
    sinks: {
      description:
        'Result sinks: opaque names, sink adapter objects, or {kind,*Env} descriptors resolved by the CLI.',
      type: 'array',
      items: {
        $ref: '#/$defs/sinkRef',
      },
    },
    thresholds: {
      title: 'ThresholdsPolicy',
      type: 'object',
      properties: {
        default: {
          description:
            'Pass threshold for every criterion; defaults to 0.5, a placeholder until calibrated.',
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        perCriterion: {
          description: 'Per-criterion overrides keyed by criterion id.',
          type: 'object',
          additionalProperties: {
            type: 'number',
            minimum: 0,
            maximum: 1,
          },
        },
      },
      additionalProperties: false,
    },
    watch: {
      title: 'WatchConfig',
      description: 'Sampling for watch mode.',
      type: 'object',
      properties: {
        sampleRate: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        upstreamSampleRate: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        maxInFlight: {
          description: 'Concurrent judge calls in watch mode; defaults to 4.',
          type: 'integer',
          minimum: 1,
        },
      },
      additionalProperties: false,
    },
    gate: {
      title: 'GateConfig',
      type: 'object',
      properties: {
        minPass: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        requireCalibrated: {
          description: 'Refuse to gate on uncalibrated criteria; defaults to true.',
          type: 'boolean',
        },
        allowUnpinned: {
          description: 'Allow gating on an unpinned judge model; defaults to false.',
          type: 'boolean',
        },
      },
      additionalProperties: false,
    },
    cacheDir: {
      description: "Verdict cache directory; defaults to '.vet'.",
      type: 'string',
      minLength: 1,
    },
  },
  required: ['judge'],
  additionalProperties: false,
  $defs: {
    judgeEndpoint: {
      title: 'JudgeEndpoint',
      description:
        'Either preset, or baseURL and model, is required; core enforces this (a schema anyOf would degrade the generated type).',
      type: 'object',
      properties: {
        kind: {
          description: 'Transport kind, validated by the adapter.',
          type: 'string',
        },
        preset: {
          description:
            'Opaque preset name; the adapter validates it and supplies baseURL and model defaults.',
          type: 'string',
          minLength: 1,
        },
        accountId: {
          description: 'Account id some presets need in their URL.',
          type: 'string',
          minLength: 1,
        },
        baseURL: {
          type: 'string',
        },
        apiKeyEnv: {
          description: 'Name of the env var holding the key.',
          type: 'string',
        },
        model: {
          type: 'string',
        },
        providerOptions: {
          type: 'object',
          additionalProperties: {},
        },
      },
      required: ['kind', 'apiKeyEnv'],
      additionalProperties: false,
    },
    generatorEndpoint: {
      title: 'GeneratorEndpoint',
      type: 'object',
      properties: {
        kind: {
          description: 'Transport kind, validated by the adapter.',
          type: 'string',
        },
        baseURL: {
          type: 'string',
        },
        apiKeyEnv: {
          description: 'Name of the env var holding the key.',
          type: 'string',
        },
        model: {
          type: 'string',
        },
        structured: {
          description: 'Structured-output strategy; missing means json_schema.',
          type: 'string',
          enum: ['json_schema', 'json_object', 'prompt'],
        },
      },
      required: ['kind', 'baseURL', 'apiKeyEnv', 'model'],
      additionalProperties: false,
    },
    adapterRef: {
      title: 'AdapterRef',
      type: 'object',
      properties: {
        specVersion: {
          const: 'v1',
        },
        id: {
          type: 'string',
        },
        capabilities: {
          type: 'object',
          additionalProperties: {},
        },
      },
      required: ['specVersion', 'id', 'capabilities'],
      additionalProperties: false,
    },
    pluginRef: {
      anyOf: [
        {
          type: 'string',
          minLength: 1,
        },
        {
          type: 'object',
          properties: {
            specVersion: {
              const: 'v1',
            },
            id: {
              type: 'string',
            },
          },
          required: ['specVersion', 'id'],
        },
      ],
    },
    otelSinkDescriptor: {
      title: 'OtelSinkDescriptor',
      type: 'object',
      properties: {
        kind: {
          const: 'otel',
        },
        endpoint: {
          type: 'string',
          minLength: 1,
        },
        headersEnv: {
          description:
            'Name of the env var holding the OTLP headers (OTEL_EXPORTER_OTLP_HEADERS syntax: k=v,k2=v2).',
          type: 'string',
          minLength: 1,
        },
      },
      required: ['kind', 'endpoint'],
      additionalProperties: false,
    },
    langfuseSinkDescriptor: {
      title: 'LangfuseSinkDescriptor',
      type: 'object',
      properties: {
        kind: {
          const: 'langfuse',
        },
        baseUrlEnv: {
          description: 'Name of the env var holding the Langfuse base URL.',
          type: 'string',
          minLength: 1,
        },
        publicKeyEnv: {
          description: 'Name of the env var holding the Langfuse public key.',
          type: 'string',
          minLength: 1,
        },
        secretKeyEnv: {
          description: 'Name of the env var holding the Langfuse secret key.',
          type: 'string',
          minLength: 1,
        },
      },
      required: ['kind', 'baseUrlEnv', 'publicKeyEnv', 'secretKeyEnv'],
      additionalProperties: false,
    },
    sinkRef: {
      title: 'SinkRef',
      anyOf: [
        {
          $ref: '#/$defs/pluginRef',
        },
        {
          $ref: '#/$defs/otelSinkDescriptor',
        },
        {
          $ref: '#/$defs/langfuseSinkDescriptor',
        },
      ],
    },
  },
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
    enabled: {
      type: 'boolean',
    },
    contentDependent: {
      type: 'boolean',
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
        passWhen: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'string',
          },
        },
      },
      required: ['type', 'escape', 'criteria', 'passWhen'],
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
    GauntletDetail: {
      title: 'GauntletDetail',
      type: 'object',
      properties: {
        masterKeyFailed: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
              },
              caseId: {
                type: 'string',
              },
            },
            required: ['kind', 'caseId'],
            additionalProperties: false,
          },
        },
        injectionFlips: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              family: {
                type: 'string',
              },
              flips: {
                type: 'integer',
                minimum: 0,
              },
              trials: {
                type: 'integer',
                minimum: 0,
              },
            },
            required: ['family', 'flips', 'trials'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
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
        'too_few_repeats',
        'language_limited',
        'score_not_gateable',
        'reference_missing',
        'judge_unavailable',
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
        normalizedWordingHash: {
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
        gauntletDetail: {
          $ref: '#/$defs/GauntletDetail',
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
        unscored: {
          type: 'integer',
          minimum: 0,
        },
        unscoredCauses: {
          type: 'array',
          items: {
            type: 'string',
          },
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

export const traceSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://vetkit.dev/schemas/trace.schema.json',
  title: 'NormalizedTrace',
  type: 'object',
  $defs: {
    MessagePart: {
      title: 'MessagePart',
      oneOf: [
        {
          type: 'object',
          properties: {
            type: {
              const: 'text',
            },
            content: {
              type: 'string',
            },
          },
          required: ['type', 'content'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            type: {
              const: 'tool_call',
            },
            id: {
              type: 'string',
            },
            name: {
              type: 'string',
            },
            arguments: {},
          },
          required: ['type', 'name'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            type: {
              const: 'tool_call_response',
            },
            id: {
              type: 'string',
            },
            response: {},
          },
          required: ['type', 'response'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            type: {
              const: 'parse_error',
            },
            detail: {
              type: 'string',
            },
          },
          required: ['type', 'detail'],
          additionalProperties: false,
        },
      ],
    },
    Message: {
      title: 'Message',
      type: 'object',
      properties: {
        role: {
          enum: ['user', 'assistant', 'system', 'tool'],
        },
        parts: {
          type: 'array',
          items: {
            $ref: '#/$defs/MessagePart',
          },
        },
      },
      required: ['role', 'parts'],
      additionalProperties: false,
    },
    Span: {
      title: 'Span',
      type: 'object',
      properties: {
        spanId: {
          type: 'string',
        },
        parentSpanId: {
          type: 'string',
        },
        name: {
          type: 'string',
        },
        kind: {
          enum: ['llm', 'tool', 'other'],
        },
        messageRange: {
          type: 'array',
          prefixItems: [
            {
              type: 'integer',
              minimum: 0,
            },
            {
              type: 'integer',
              minimum: 0,
            },
          ],
          items: {
            type: 'integer',
            minimum: 0,
          },
          minItems: 2,
          maxItems: 2,
        },
        startTime: {
          type: 'string',
        },
        endTime: {
          type: 'string',
        },
        attributes: {
          type: 'object',
          additionalProperties: true,
        },
      },
      required: ['spanId', 'name'],
      additionalProperties: false,
    },
  },
  properties: {
    traceId: {
      type: 'string',
    },
    spans: {
      type: 'array',
      items: {
        $ref: '#/$defs/Span',
      },
    },
    messages: {
      type: 'array',
      items: {
        $ref: '#/$defs/Message',
      },
    },
    dialect: {
      type: 'string',
    },
    dialectVersion: {
      type: 'string',
    },
    schemaUrl: {
      type: 'string',
    },
    completeness: {
      type: 'object',
      properties: {
        contentCaptured: {
          type: 'boolean',
        },
        truncated: {
          type: 'boolean',
        },
        missingParents: {
          type: 'boolean',
        },
      },
      required: ['contentCaptured', 'truncated', 'missingParents'],
      additionalProperties: false,
    },
    tokens: {
      type: 'object',
      properties: {
        input: {
          type: 'integer',
          minimum: 0,
        },
        output: {
          type: 'integer',
          minimum: 0,
        },
        total: {
          type: 'integer',
          minimum: 0,
        },
      },
      additionalProperties: false,
    },
  },
  required: ['traceId', 'spans', 'messages', 'dialect', 'completeness'],
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
    id: {
      type: 'string',
    },
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
    borderline: {
      type: 'boolean',
    },
    calibrated: {
      type: 'boolean',
    },
    provenance: {
      type: 'object',
      properties: {
        traceId: {
          type: 'string',
        },
        spanId: {
          type: 'string',
        },
        responseId: {
          type: 'string',
        },
        observationId: {
          type: 'string',
        },
        dialect: {
          type: 'string',
        },
        schemaUrl: {
          type: 'string',
        },
      },
      required: [],
      additionalProperties: false,
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
