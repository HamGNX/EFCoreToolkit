import assert from "node:assert/strict";
import test from "node:test";
import type { CancellationLike, DisposableLike } from "../../types";
import {
  ProcessRunner,
  proxyEnvironmentSecrets,
  safeChildEnvironment,
} from "../../services/processRunner";

class CancellationToken implements CancellationLike {
  public isCancellationRequested = false;
  private listeners = new Set<() => void>();

  public onCancellationRequested(listener: () => void): DisposableLike {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public cancel(): void {
    this.isCancellationRequested = true;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

test("already-cancelled operation never starts", async () => {
  const token = new CancellationToken();
  token.cancel();
  let spawned = false;
  const runner = new ProcessRunner(() => {
    spawned = true;
    throw new Error("must not spawn");
  });

  const result = await runner.run({
    executable: process.execPath,
    args: ["--version"],
    cwd: process.cwd(),
    cancellation: token,
  });

  assert.equal(spawned, false);
  assert.equal(result.cancelled, true);
});

test("cancellation terminates a running child and settles after close", async () => {
  const token = new CancellationToken();
  const runner = new ProcessRunner();
  const running = runner.run({
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    cancellation: token,
  });

  setTimeout(() => token.cancel(), 30);
  const result = await running;

  assert.equal(result.cancelled, true);
  assert.notEqual(result.code, 0);
});

test("child environment omits unrelated secrets and enables dotnet privacy", () => {
  const environment = safeChildEnvironment({
    PATH: "/bin",
    HOME: "/home/user",
    AWS_SECRET_ACCESS_KEY: "secret",
    HTTPS_PROXY: "http://proxy",
  });

  assert.equal(environment.PATH, "/bin");
  assert.equal(environment.HOME, "/home/user");
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.HTTPS_PROXY, undefined);
  assert.equal(environment.DOTNET_CLI_TELEMETRY_OPTOUT, "1");

  const installEnvironment = safeChildEnvironment(
    { HTTPS_PROXY: "http://proxy" },
    true,
  );
  assert.equal(installEnvironment.HTTPS_PROXY, "http://proxy");
  assert.deepEqual(
    proxyEnvironmentSecrets({
      HTTPS_PROXY: "https://alice:proxy%2Dsecret@proxy.internal:8443",
      NO_PROXY: "private.internal",
    }),
    [
      "https://alice:proxy%2Dsecret@proxy.internal:8443",
      "alice",
      "proxy%2Dsecret",
      "proxy-secret",
      "private.internal",
    ],
  );
});

test("detects error markers before redaction or long-line omission", async () => {
  const runner = new ProcessRunner();
  const redacted = await runner.run({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('Error: failed\\n')"],
    cwd: process.cwd(),
    secrets: ["Error"],
  });
  const long = await runner.run({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('Error:' + 'x'.repeat(20000) + '\\n')"],
    cwd: process.cwd(),
  });

  assert.equal(redacted.hasErrorMarker, true);
  assert.equal(redacted.stdout[0].includes("Error"), false);
  assert.equal(long.hasErrorMarker, true);
  assert.deepEqual(long.stdout, ["[Long helper output line omitted safely.]"]);
});
