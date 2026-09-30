// vetkit.config.ts uses ESM syntax and Node's own import() loads it. In a project whose
// package.json has no "type" field (the `npm init -y` default) Node reparses it as ESM and
// prints MODULE_TYPELESS_PACKAGE_JSON on every command. Nothing in vet can act on that, so the
// bin drops exactly that code and hands every other warning to Node's own printer unchanged.
// Node registers its printer as the only 'warning' listener at startup (none under
// --no-warnings), so wrapping the listeners found keeps the output format byte-identical.

const DROPPED_WARNING_CODE = 'MODULE_TYPELESS_PACKAGE_JSON';

function isDropped(warning: Error): boolean {
  return 'code' in warning && warning.code === DROPPED_WARNING_CODE;
}

/** Wraps every 'warning' listener on `proc` (default: this process) so the dropped code never reaches it. */
export function installWarningFilter(proc: NodeJS.EventEmitter = process): void {
  const printers = proc.listeners('warning');
  proc.removeAllListeners('warning');
  for (const print of printers) {
    proc.on('warning', (warning: Error) => {
      if (!isDropped(warning)) Reflect.apply(print, proc, [warning]);
    });
  }
}
