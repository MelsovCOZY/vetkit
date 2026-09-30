import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { installWarningFilter } from './node-warnings.ts';

function warning(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'Warning', code });
}

// A stand-in for Node's process: at startup it carries exactly one 'warning' listener,
// Node's own printer, which the filter must keep using for every warning it lets through.
function fakeProcess(): { readonly emitter: EventEmitter; readonly printed: Error[] } {
  const emitter = new EventEmitter();
  const printed: Error[] = [];
  emitter.on('warning', (w: Error) => {
    printed.push(w);
  });
  return { emitter, printed };
}

describe('installWarningFilter', () => {
  test('MODULE_TYPELESS_PACKAGE_JSON is dropped while every other warning code still reaches the printer', () => {
    const { emitter, printed } = fakeProcess();
    installWarningFilter(emitter);
    const typeless = warning(
      'MODULE_TYPELESS_PACKAGE_JSON',
      'Module type of file:///p/vetkit.config.ts is not specified',
    );
    const other = warning('OTHER_CODE', 'something else happened');
    const deprecation = Object.assign(warning('DEP9999', 'old api'), {
      name: 'DeprecationWarning',
    });
    emitter.emit('warning', typeless);
    emitter.emit('warning', other);
    emitter.emit('warning', deprecation);
    expect(printed).toEqual([other, deprecation]);
    expect(printed[0]).toBe(other);
    expect(printed[1]).toBe(deprecation);
  });

  test('a warning without a code still reaches the printer', () => {
    const { emitter, printed } = fakeProcess();
    installWarningFilter(emitter);
    const plain = new Error('no code');
    emitter.emit('warning', plain);
    expect(printed).toEqual([plain]);
  });

  test('with no listener installed (node --no-warnings) it adds none', () => {
    const emitter = new EventEmitter();
    installWarningFilter(emitter);
    expect(emitter.listenerCount('warning')).toBe(0);
  });
});
