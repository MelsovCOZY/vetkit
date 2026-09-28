// Typed run events + a diag channel. Library packages never log (root DECISION, OPEN-4):
// they emit here and the host (the CLI, a test, another tool) decides what to render.
// Payloads carry ids, counters and sizes only, never prompt/state/answer text.

/** Event names as an as-const object; the union below is derived from it (no enum). */
export const EVENT_NAMES = {
  RUN_START: 'run:start',
  CASE_START: 'case:start',
  JUDGE_REQUEST: 'judge:request',
  JUDGE_RESPONSE: 'judge:response',
  VERDICT: 'verdict',
  SINK_WRITE: 'sink:write',
  OUTBOX_DRAIN: 'outbox:drain',
  RUN_END: 'run:end',
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

export type DiagLevel = 'debug' | 'info' | 'warn' | 'error';

/** Size/counter data only: no free text rides on a diag. */
export type DiagData = Readonly<Record<string, number | boolean>>;

export interface DiagEvent {
  readonly level: DiagLevel;
  readonly code: string;
  readonly message: string;
  readonly data?: DiagData;
}

export interface EventMap {
  readonly 'run:start': { readonly cases: number; readonly criteria: number };
  readonly 'case:start': {
    readonly caseId: string;
    readonly index: number;
    readonly total: number;
  };
  readonly 'judge:request': {
    readonly caseId: string;
    readonly criterionId: string;
    readonly stateBytes: number;
  };
  readonly 'judge:response': {
    readonly caseId: string;
    readonly criterionId: string;
    readonly status: number;
    readonly durationMs: number;
    readonly inputTokens?: number;
    readonly cacheHit: boolean;
  };
  readonly verdict: {
    readonly caseId: string;
    readonly criterionId: string;
    readonly status: string;
    readonly pass?: boolean;
  };
  readonly 'sink:write': { readonly sink: string; readonly records: number };
  readonly 'outbox:drain': {
    readonly sink: string;
    readonly drained: number;
    readonly pending: number;
  };
  readonly 'run:end': {
    readonly cases: number;
    readonly verdicts: number;
    readonly exitCode: number;
    readonly durationMs: number;
  };
  readonly diag: DiagEvent;
}

export type Listener<K extends keyof EventMap> = (payload: EventMap[K]) => void;

export interface Events {
  /** Subscribes; returns an unsubscribe function. */
  on<K extends keyof EventMap>(name: K, listener: Listener<K>): () => void;
  once<K extends keyof EventMap>(name: K, listener: Listener<K>): () => void;
  off<K extends keyof EventMap>(name: K, listener: Listener<K>): void;
  /** A throwing listener never aborts the emitter; it becomes a diag warn. */
  emit<K extends keyof EventMap>(name: K, payload: EventMap[K]): void;
  diag(level: DiagLevel, code: string, message: string, data?: DiagData): void;
}

type Store = { readonly [K in keyof EventMap]: Set<Listener<K>> };

export function createEvents(): Events {
  const listeners: Store = {
    'run:start': new Set(),
    'case:start': new Set(),
    'judge:request': new Set(),
    'judge:response': new Set(),
    verdict: new Set(),
    'sink:write': new Set(),
    'outbox:drain': new Set(),
    'run:end': new Set(),
    diag: new Set(),
  };

  const off: Events['off'] = (name, listener) => {
    listeners[name].delete(listener);
  };

  const on: Events['on'] = (name, listener) => {
    listeners[name].add(listener);
    return () => off(name, listener);
  };

  const emit: Events['emit'] = (name, payload) => {
    const set: Store[typeof name] = listeners[name];
    if (set.size === 0) return;
    let failures = 0;
    for (const listener of set) {
      try {
        listener(payload);
      } catch {
        failures += 1;
      }
    }
    // A throwing diag listener is swallowed: forwarding it to diag would recurse.
    if (failures > 0 && name !== 'diag') {
      emit('diag', {
        level: 'warn',
        code: 'LISTENER_ERROR',
        message: `a listener for "${name}" threw`,
        data: { listenerErrors: failures },
      });
    }
  };

  return {
    on,
    off,
    emit,
    once(name, listener) {
      const wrapped: typeof listener = (payload) => {
        off(name, wrapped);
        listener(payload);
      };
      return on(name, wrapped);
    },
    diag(level, code, message, data) {
      emit('diag', data === undefined ? { level, code, message } : { level, code, message, data });
    },
  };
}
