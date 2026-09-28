// generated — do not edit

export type MessagePart =
  | {
      type: 'text';
      content: string;
    }
  | {
      type: 'tool_call';
      id?: string;
      name: string;
      arguments?: unknown;
    }
  | {
      type: 'tool_call_response';
      id?: string;
      response: unknown;
    }
  | {
      type: 'parse_error';
      detail: string;
    };

export interface NormalizedTrace {
  traceId: string;
  spans: Span[];
  messages: Message[];
  dialect: string;
  dialectVersion?: string;
  schemaUrl?: string;
  completeness: {
    contentCaptured: boolean;
    truncated: boolean;
    missingParents: boolean;
  };
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
  };
}
export interface Span {
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: 'llm' | 'tool' | 'other';
  /**
   * @minItems 2
   * @maxItems 2
   */
  messageRange?: [number, number];
  startTime?: string;
  endTime?: string;
  attributes?: {
    [k: string]: unknown;
  };
}
export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  parts: MessagePart[];
}
