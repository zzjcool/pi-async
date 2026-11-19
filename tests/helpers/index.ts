import type { TaskSnapshot, TaskStatus, TaskMode } from "../../src/core/task.ts";

/**
 * Hermetic defaults for the product switches (0.5.0).
 *
 * `async_wait` exposure and the headless backstop are read from the process env, so a developer
 * shell that exports `PI_ASYNC_EXPOSE_WAIT=1` (or `PI_ASYNC_PRINT_WAIT=0`) would silently change
 * what the "default face" tests observe — `PI_ASYNC_EXPOSE_WAIT=1 npm test` used to fail 9 cases.
 * Every test file that asserts default behaviour imports this module, and a module body runs before
 * any test in that file, so clearing the switches here is enough; tests that need a switch set use
 * `withExposedWait` / `withExposedWaitAsync` or their own `withEnv`.
 */
for (const name of [
  "PI_ASYNC_EXPOSE_WAIT",
  "PI_ASYNC_PRINT_WAIT",
  "PI_ASYNC_PRINT_WAIT_MS",
  "PI_ASYNC_PRINT_POLL_MS",
  "PI_ASYNC_PRINT_MAX_CONTINUATIONS",
]) {
  delete process.env[name];
}

/**
 * Run `fn` with `PI_ASYNC_EXPOSE_WAIT=1` so `registerTools` also registers `async_wait` (D4, 0.5.0:
 * the wait tool is opt-in). Restores the previous value afterwards. Synchronous on purpose — see
 * `withExposedWaitAsync` for test bodies that await.
 */
export function withExposedWait<T>(fn: () => T): T {
  const previous = process.env.PI_ASYNC_EXPOSE_WAIT;
  process.env.PI_ASYNC_EXPOSE_WAIT = "1";
  try { return fn(); } finally { if (previous === undefined) delete process.env.PI_ASYNC_EXPOSE_WAIT; else process.env.PI_ASYNC_EXPOSE_WAIT = previous; }
}

/**
 * Awaiting variant of `withExposedWait`: the env stays set until the promise settles.
 *
 * The gate is read per call (registration *and* execute), so a test that both registers and calls
 * `async_wait` must hold the switch for the whole body — restoring it right after `registerTools`
 * would leave the calls degrading to the `available: false` payload.
 */
export async function withExposedWaitAsync<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PI_ASYNC_EXPOSE_WAIT;
  process.env.PI_ASYNC_EXPOSE_WAIT = "1";
  try { return await fn(); } finally { if (previous === undefined) delete process.env.PI_ASYNC_EXPOSE_WAIT; else process.env.PI_ASYNC_EXPOSE_WAIT = previous; }
}

export function makeSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: "task-1",
    name: "example",
    command: "echo example",
    mode: "background" satisfies TaskMode,
    status: "running" satisfies TaskStatus,
    createdAt: 0,
    notified: false,
    outputConsumed: false,
    metadata: {},
    ...overrides,
  };
}
