import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertSafeEnvKeys, buildChildEnv, type EnvPolicy } from "../src/core/env.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { resolveEnvPolicy, spawnDetached } from "../src/core/spawn.ts";

/** REV-16: `safe` env inheritance by default, dangerous overrides rejected, explicit escape hatches. */

const INTERNAL = "PI_ASYNC_INTERNAL_MAX_OUTPUT_BYTES";

/** Spawn `env` and parse the child's actual environment (end-to-end proof of the policy). */
async function spawnAndReadEnv(opts: { env?: Record<string, string>; envPolicy?: EnvPolicy } = {}): Promise<{ code: number; env: Record<string, string> }> {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-env-"));
  const outputFile = join(dir, "task.output");
  try {
    const handle = spawnDetached("env", { outputFile, ...opts });
    const { code } = await handle.exit;
    const env: Record<string, string> = {};
    for (const line of readFileSync(outputFile, "utf8").split("\n")) {
      const separator = line.indexOf("=");
      if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return { code, env };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SENSITIVE_MARKERS = {
  PI_ASYNC_TEST_API_KEY: "sk-test",
  PI_ASYNC_TEST_TOKEN: "token-test",
  PI_ASYNC_TEST_SECRET: "secret-test",
  PI_ASYNC_TEST_PASSWORD: "password-test",
  PI_ASYNC_TEST_CREDENTIALS: "credentials-test",
  GITHUB_TOKEN: "gh-test",
};

test("safe (default) inherits ordinary env but strips credential-ish keys", async () => {
  const previous = { ...process.env };
  Object.assign(process.env, SENSITIVE_MARKERS);
  process.env.PI_ASYNC_TEST_PLAIN = "plain";
  process.env[INTERNAL] = "4096";
  try {
    const { code, env } = await spawnAndReadEnv({ envPolicy: "safe" });
    assert.equal(code, 0);
    assert.equal(env.PI_ASYNC_TEST_PLAIN, "plain");
    assert.equal(env.PATH, process.env.PATH);
    for (const key of Object.keys(SENSITIVE_MARKERS)) {
      assert.equal(env[key], undefined, `${key} must not be inherited under the safe policy`);
    }
    assert.equal(env[INTERNAL], undefined, "the internal output-cap knob must never reach a child");
    // Explicit ordinary overrides still win.
    const overridden = await spawnAndReadEnv({ envPolicy: "safe", env: { PI_ASYNC_TEST_PLAIN: "override" } });
    assert.equal(overridden.env.PI_ASYNC_TEST_PLAIN, "override");
  } finally {
    for (const key of [...Object.keys(SENSITIVE_MARKERS), "PI_ASYNC_TEST_PLAIN", INTERNAL]) delete process.env[key];
    for (const [key, value] of Object.entries(previous)) if (process.env[key] !== value) process.env[key] = value;
  }
});

test("explicit dangerous keys are rejected instead of silently ignored", async () => {
  for (const key of ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "BASH_ENV", "PYTHONPATH", "GIT_SSH_COMMAND"]) {
    assert.throws(() => buildChildEnv({ PATH: "/usr/bin" }, { [key]: "/evil" }, "safe"), new RegExp(`dangerous environment variable ${key}`));
  }
  // Every policy rejects them (all/none are not a bypass).
  assert.throws(() => buildChildEnv({}, { LD_PRELOAD: "/tmp/x.so" }, "all"), /dangerous environment variable LD_PRELOAD/);
  assert.throws(() => buildChildEnv({}, { NODE_OPTIONS: "--require /tmp/x.js" }, "none"), /dangerous environment variable NODE_OPTIONS/);

  const dir = mkdtempSync(join(tmpdir(), "pi-async-env-"));
  try {
    assert.throws(
      () => spawnDetached("true", { outputFile: join(dir, "task.output"), env: { PATH: "/evil" } }),
      /dangerous environment variable PATH/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // The exported guard is what submission paths call to fail fast (delayed tasks spawn later).
  assert.throws(() => assertSafeEnvKeys({ LD_PRELOAD: "/tmp/x.so" }), /dangerous environment variable LD_PRELOAD/);
  assert.doesNotThrow(() => assertSafeEnvKeys({ PI_ASYNC_TEST_PLAIN: "ok" }));
  assert.doesNotThrow(() => assertSafeEnvKeys(undefined));
});

test("delayed task submission rejects dangerous env keys before scheduling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-env-delayed-"));
  const registry = new TaskRegistry({ dataDir: dir });
  try {
    // Delayed tasks spawn when the timer fires; a dangerous override must not survive until then.
    assert.throws(() => registry.scheduleDelayed({ command: "true", env: { PATH: "/evil" } }, 10), /dangerous environment variable PATH/);
    assert.throws(() => registry.scheduleDelayed({ command: "true", env: { NODE_OPTIONS: "--require /tmp/x.js" } }, 10), /dangerous environment variable NODE_OPTIONS/);
    assert.equal(registry.list({ includeHistory: true }).length, 0, "a rejected delayed submit must not leave a task behind");
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safe strips npm_config_* credentials while keeping ordinary npm settings", () => {
  const env = buildChildEnv({
    PATH: "/usr/bin",
    npm_config_registry: "https://registry.example",
    npm_config_strict_ssl: "true",
    npm_config_username: "someone",
    npm_config__authToken: "npm-token",
    npm_config_password: "hunter2",
  }, undefined, "safe");
  assert.equal(env.npm_config_registry, "https://registry.example");
  assert.equal(env.npm_config_strict_ssl, "true");
  assert.equal(env.npm_config_username, "someone");
  assert.equal(env.npm_config__authToken, undefined, "npm auth token must not be inherited");
  assert.equal(env.npm_config_password, undefined, "npm password must not be inherited");
});

test("none keeps only the shell-essential whitelist", async () => {
  const env = buildChildEnv(
    {
      PATH: "/usr/bin", HOME: "/home/tester", SHELL: "/bin/sh", TERM: "xterm-256color", LANG: "C",
      LC_ALL: "C.UTF-8", TMPDIR: "/tmp", USER: "tester",
      PI_ASYNC_TEST_PLAIN: "plain", PI_ASYNC_TEST_API_KEY: "sk-test",
    },
    undefined,
    "none",
  );
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TERM", "TMPDIR", "USER"].sort());
  // Ordinary extra keys still override inside the minimal environment.
  const withExtra = buildChildEnv({ PATH: "/usr/bin", PI_ASYNC_TEST_PLAIN: "plain" }, { PI_ASYNC_TEST_PLAIN: "override" }, "none");
  assert.equal(withExtra.PI_ASYNC_TEST_PLAIN, "override");
  assert.equal(withExtra.PATH, "/usr/bin");
  // End-to-end: an unrelated inherited variable never reaches the child.
  process.env.PI_ASYNC_TEST_PLAIN = "plain";
  try {
    const spawned = await spawnAndReadEnv({ envPolicy: "none" });
    assert.equal(spawned.env.PI_ASYNC_TEST_PLAIN, undefined);
    assert.equal(spawned.env.PATH, process.env.PATH);
  } finally {
    delete process.env.PI_ASYNC_TEST_PLAIN;
  }
});

test("all reproduces the legacy full inheritance", () => {
  const env = buildChildEnv({ PI_ASYNC_TEST_API_KEY: "sk-test", PATH: "/usr/bin" }, { PI_ASYNC_TEST_PLAIN: "extra" }, "all");
  assert.deepEqual(env, { PI_ASYNC_TEST_API_KEY: "sk-test", PATH: "/usr/bin", PI_ASYNC_TEST_PLAIN: "extra" });
});

test("buildChildEnv is pure: neither input is mutated", () => {
  const base = { PATH: "/usr/bin", PI_ASYNC_TEST_API_KEY: "sk-test", PI_ASYNC_TEST_PLAIN: "plain" };
  const extra = { PI_ASYNC_TEST_PLAIN: "override" };
  const baseCopy = { ...base };
  const extraCopy = { ...extra };
  for (const policy of ["safe", "all", "none"] as const) buildChildEnv(base, extra, policy);
  assert.deepEqual(base, baseCopy);
  assert.deepEqual(extra, extraCopy);
});

test("PI_ASYNC_INTERNAL_MAX_OUTPUT_BYTES is always stripped, from base or extra", () => {
  for (const policy of ["safe", "all", "none"] as const) {
    const env = buildChildEnv({ [INTERNAL]: "1024", PATH: "/usr/bin" }, { [INTERNAL]: "2048" }, policy);
    assert.equal(env[INTERNAL], undefined, `policy ${policy}`);
  }
});

test("spawnDetached resolves the policy from PI_ASYNC_ENV_INHERIT (unknown → safe)", async () => {
  const previousInherit = process.env.PI_ASYNC_ENV_INHERIT;
  process.env.PI_ASYNC_TEST_API_KEY = "sk-test";
  try {
    process.env.PI_ASYNC_ENV_INHERIT = "all";
    const all = await spawnAndReadEnv();
    assert.equal(all.env.PI_ASYNC_TEST_API_KEY, "sk-test");

    process.env.PI_ASYNC_ENV_INHERIT = "none";
    const none = await spawnAndReadEnv();
    assert.equal(none.env.PI_ASYNC_TEST_API_KEY, undefined);
    assert.equal(none.env.USER, process.env.USER);

    process.env.PI_ASYNC_ENV_INHERIT = "bogus";
    const unknown = await spawnAndReadEnv();
    assert.equal(unknown.env.PI_ASYNC_TEST_API_KEY, undefined);

    delete process.env.PI_ASYNC_ENV_INHERIT;
    assert.equal(resolveEnvPolicy(), "safe");
    assert.equal(resolveEnvPolicy("all"), "all");
  } finally {
    if (previousInherit === undefined) delete process.env.PI_ASYNC_ENV_INHERIT;
    else process.env.PI_ASYNC_ENV_INHERIT = previousInherit;
    delete process.env.PI_ASYNC_TEST_API_KEY;
  }
});
