import type { Reporter, TestModule } from 'vitest/node';

/**
 * Fails the run when a test file did not complete — for example a worker process that
 * crashed (out of memory) — or when there were unhandled errors. Without this, vitest
 * can report such a run as passing and a broken suite would look green.
 */
export default class StrictReporter implements Reporter {
  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<unknown>,
  ): void {
    const incomplete = testModules.filter((m) => !['passed', 'skipped'].includes(m.state()));
    if (unhandledErrors.length === 0 && incomplete.length === 0) return;
    // vitest assigns process.exitCode itself after the reporters run; an exit listener
    // runs last, so the failure cannot be overwritten.
    process.exitCode = 1;
    process.on('exit', () => {
      process.exitCode = 1;
    });
    const lines = [
      `strict-reporter: ${unhandledErrors.length} unhandled error(s), ${incomplete.length} incomplete file(s)`,
      ...incomplete.map((m) => `  ${m.state()}: ${m.moduleId}`),
    ];
    process.stderr.write(`${lines.join('\n')}\n`);
  }
}
