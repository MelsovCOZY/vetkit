import { styleText } from 'node:util';
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly format?: 'pretty' | 'json';
  readonly stream?: NodeJS.WritableStream;
}
export interface Logger {
  readonly debug: (message: string, data?: Record<string, unknown>) => void;
  readonly info: (message: string, data?: Record<string, unknown>) => void;
  readonly warn: (message: string, data?: Record<string, unknown>) => void;
  readonly error: (message: string, data?: Record<string, unknown>) => void;
}
const KEY_PATTERN = /(api[_-]?key|token|secret|authorization)/i;
const VALUE_PATTERN = /^(sk-|vck_|Bearer )/;
const LEVEL_COLOR = { debug: 'gray', info: 'cyan', warn: 'yellow', error: 'red' } as const;
const isLogLevel = (value: string): value is LogLevel =>
  (LOG_LEVELS as readonly string[]).includes(value);
const redactString = (value: string): string => (VALUE_PATTERN.test(value) ? '[redacted]' : value);
const redactValue = (value: unknown): unknown =>
  typeof value === 'string' ? redactString(value) : value;
const redactData = (data: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, KEY_PATTERN.test(k) ? '[redacted]' : redactValue(v)]),
  );
export function createLogger(options: LoggerOptions = {}): Logger {
  const stream = options.stream ?? process.stderr;
  const format = options.format ?? 'pretty';
  const isTty = 'isTTY' in stream && (stream as { isTTY?: boolean }).isTTY === true;
  const color = !process.env.NO_COLOR && isTty;
  const rawLevel = process.env.CEV_LOG_LEVEL;
  const level: LogLevel =
    options.level ?? (rawLevel !== undefined && isLogLevel(rawLevel) ? rawLevel : 'info');
  const invalidRawLevel = rawLevel !== undefined && !isLogLevel(rawLevel);
  const threshold = LOG_LEVELS.indexOf(level);
  const write = (lvl: LogLevel, message: string, data?: Record<string, unknown>): void => {
    if (LOG_LEVELS.indexOf(lvl) < threshold) return;
    const safeMessage = redactString(message);
    const safeData = data ? redactData(data) : undefined;
    if (format === 'json') {
      stream.write(`${JSON.stringify({ level: lvl, message: safeMessage, ...safeData })}\n`);
      return;
    }
    const label = color ? styleText(LEVEL_COLOR[lvl], lvl) : lvl;
    const suffix = safeData ? ` ${JSON.stringify(safeData)}` : '';
    stream.write(`${label} ${safeMessage}${suffix}\n`);
  };
  const logger: Logger = {
    debug: (message, data) => write('debug', message, data),
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
  };
  if (!options.level && invalidRawLevel) {
    logger.warn(`invalid CEV_LOG_LEVEL "${rawLevel}", falling back to "info"`);
  }
  return logger;
}
