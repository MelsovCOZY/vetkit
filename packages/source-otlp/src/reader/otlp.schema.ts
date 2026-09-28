// Runtime form of otlp.schema.json (the authored file, 2020-12). The package tsconfig includes
// only .ts under src, so the JSON cannot be imported without TS6307; otlp.schema.test.ts fails if
// the two ever differ. Edit the JSON first, then mirror it here.

import type { JsonSchema } from '@vetkit/spec';

export const otlpSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://vetkit.dev/schemas/source-otlp/otlp.schema.json',
  title: 'ExportTraceServiceRequest',
  description:
    'Hand-written subset of opentelemetry/proto/collector/trace/v1 ExportTraceServiceRequest in the OTLP/JSON encoding (lowerCamelCase, integer enums, 64-bit integers as strings or numbers).',
  type: 'object',
  required: ['resourceSpans'],
  properties: {
    resourceSpans: {
      type: 'array',
      items: {
        $ref: '#/$defs/resourceSpans',
      },
    },
  },
  $defs: {
    uint64: {
      anyOf: [
        {
          type: 'string',
          pattern: '^[0-9]+$',
        },
        {
          type: 'integer',
          minimum: 0,
        },
      ],
    },
    count: {
      type: 'integer',
      minimum: 0,
    },
    anyValue: {
      type: 'object',
      properties: {
        stringValue: {
          type: 'string',
        },
        boolValue: {
          type: 'boolean',
        },
        intValue: {
          anyOf: [
            {
              type: 'string',
              pattern: '^-?[0-9]+$',
            },
            {
              type: 'integer',
            },
          ],
        },
        doubleValue: {
          anyOf: [
            {
              type: 'number',
            },
            {
              enum: ['NaN', 'Infinity', '-Infinity'],
            },
          ],
        },
        bytesValue: {
          type: 'string',
        },
        arrayValue: {
          type: 'object',
          properties: {
            values: {
              type: 'array',
              items: {
                $ref: '#/$defs/anyValue',
              },
            },
          },
        },
        kvlistValue: {
          type: 'object',
          properties: {
            values: {
              type: 'array',
              items: {
                $ref: '#/$defs/keyValue',
              },
            },
          },
        },
      },
    },
    keyValue: {
      type: 'object',
      required: ['key'],
      properties: {
        key: {
          type: 'string',
        },
        value: {
          $ref: '#/$defs/anyValue',
        },
      },
    },
    attributes: {
      type: 'array',
      items: {
        $ref: '#/$defs/keyValue',
      },
    },
    resourceSpans: {
      type: 'object',
      properties: {
        resource: {
          type: 'object',
          properties: {
            attributes: {
              $ref: '#/$defs/attributes',
            },
            droppedAttributesCount: {
              $ref: '#/$defs/count',
            },
          },
        },
        scopeSpans: {
          type: 'array',
          items: {
            $ref: '#/$defs/scopeSpans',
          },
        },
        schemaUrl: {
          type: 'string',
        },
      },
    },
    scopeSpans: {
      type: 'object',
      properties: {
        scope: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
            },
            version: {
              type: 'string',
            },
            attributes: {
              $ref: '#/$defs/attributes',
            },
          },
        },
        spans: {
          type: 'array',
          items: {
            $ref: '#/$defs/span',
          },
        },
        schemaUrl: {
          type: 'string',
        },
      },
    },
    span: {
      type: 'object',
      required: ['traceId', 'spanId', 'name', 'startTimeUnixNano'],
      properties: {
        traceId: {
          type: 'string',
        },
        spanId: {
          type: 'string',
        },
        parentSpanId: {
          type: 'string',
        },
        traceState: {
          type: 'string',
        },
        flags: {
          type: 'integer',
        },
        name: {
          type: 'string',
        },
        kind: {
          anyOf: [
            {
              type: 'integer',
              minimum: 0,
            },
            {
              enum: [
                'SPAN_KIND_UNSPECIFIED',
                'SPAN_KIND_INTERNAL',
                'SPAN_KIND_SERVER',
                'SPAN_KIND_CLIENT',
                'SPAN_KIND_PRODUCER',
                'SPAN_KIND_CONSUMER',
              ],
            },
          ],
        },
        startTimeUnixNano: {
          $ref: '#/$defs/uint64',
        },
        endTimeUnixNano: {
          $ref: '#/$defs/uint64',
        },
        attributes: {
          $ref: '#/$defs/attributes',
        },
        droppedAttributesCount: {
          $ref: '#/$defs/count',
        },
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              timeUnixNano: {
                $ref: '#/$defs/uint64',
              },
              name: {
                type: 'string',
              },
              attributes: {
                $ref: '#/$defs/attributes',
              },
              droppedAttributesCount: {
                $ref: '#/$defs/count',
              },
            },
          },
        },
        droppedEventsCount: {
          $ref: '#/$defs/count',
        },
        links: {
          type: 'array',
          items: {
            type: 'object',
            required: ['traceId', 'spanId'],
            properties: {
              traceId: {
                type: 'string',
              },
              spanId: {
                type: 'string',
              },
              traceState: {
                type: 'string',
              },
              attributes: {
                $ref: '#/$defs/attributes',
              },
              droppedAttributesCount: {
                $ref: '#/$defs/count',
              },
            },
          },
        },
        droppedLinksCount: {
          $ref: '#/$defs/count',
        },
        status: {
          type: 'object',
          properties: {
            code: {
              anyOf: [
                {
                  type: 'integer',
                  minimum: 0,
                },
                {
                  enum: ['STATUS_CODE_UNSET', 'STATUS_CODE_OK', 'STATUS_CODE_ERROR'],
                },
              ],
            },
            message: {
              type: 'string',
            },
          },
        },
      },
    },
  },
};
