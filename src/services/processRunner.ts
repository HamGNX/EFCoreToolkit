import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { CancellationLike, OutputSink } from "../types";
import { LineRedactor, redactText } from "./redaction";

export interface ProcessRunOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  output?: OutputSink;
  secrets?: readonly string[];
  cancellation?: CancellationLike;
  includeProxyEnvironment?: boolean;
}

export interface ProcessRunResult {
  code: number | null;
  cancelled: boolean;
  stdout: string[];
  stderr: string[];
  hasErrorMarker: boolean;
}

export type SpawnFunction = (
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    shell: false;
    windowsHide: true;
    stdio: ["ignore", "pipe", "pipe"];
    env: NodeJS.ProcessEnv;
  },
) => ChildProcessByStdio<null, Readable, Readable>;

export class ProcessStartError extends Error {
  public constructor(public readonly errorCode?: string) {
    super(errorCode ? `Process could not start (${errorCode}).` : "Process could not start.");
    this.name = "ProcessStartError";
  }
}

export class ProcessRunner {
  public constructor(
    private readonly spawnProcess: SpawnFunction = (executable, args, options) =>
      spawn(executable, [...args], options),
  ) {}

  public run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const { cancellation } = options;
    if (cancellation?.isCancellationRequested) {
      return Promise.resolve({
        code: null,
        cancelled: true,
        stdout: [],
        stderr: [],
        hasErrorMarker: false,
      });
    }

    return new Promise((resolve, reject) => {
      const childEnvironment = safeChildEnvironment(
        process.env,
        options.includeProxyEnvironment,
      );
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = this.spawnProcess(options.executable, options.args, {
          cwd: options.cwd,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: childEnvironment,
        });
      } catch {
        reject(new ProcessStartError());
        return;
      }

      const stdout: string[] = [];
      const stderr: string[] = [];
      const secrets = [
        ...new Set([
          ...(options.secrets ?? []),
          ...proxyEnvironmentSecrets(childEnvironment),
        ]),
      ];
      let hasErrorMarker = false;
      let outputLineCount = 0;
      let outputLimitReported = false;
      const recordLine = (lines: string[], line: string): void => {
        if (lines.length < 1_000) {
          lines.push(line);
        }
        outputLineCount += 1;
        if (outputLineCount <= 10_000) {
          options.output?.appendLine(line);
        } else if (!outputLimitReported) {
          options.output?.appendLine("[Additional helper output omitted safely.]");
          outputLimitReported = true;
        }
      };
      const inspectRawLine = (line: string): void => {
        if (/^error\s*:/i.test(line.replace(/\u001b\[[0-9;]*m/g, "").trimStart())) {
          hasErrorMarker = true;
        }
      };
      const stdoutRedactor = new LineRedactor((line) => {
        recordLine(stdout, line);
      }, secrets, inspectRawLine);
      const stderrRedactor = new LineRedactor((line) => {
        recordLine(stderr, line);
      }, secrets, inspectRawLine);

      let cancelled = false;
      let closed = false;
      let startError: ProcessStartError | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => stdoutRedactor.accept(chunk));
      child.stderr.on("data", (chunk: string) => stderrRedactor.accept(chunk));

      child.once("error", (error: NodeJS.ErrnoException) => {
        startError = new ProcessStartError(error.code);
      });

      const cancellationDisposable = cancellation?.onCancellationRequested(() => {
        if (closed || cancelled) {
          return;
        }
        cancelled = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (!closed) {
            child.kill("SIGKILL");
          }
        }, 2_000);
      });

      child.once("close", (code) => {
        closed = true;
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        cancellationDisposable?.dispose();
        stdoutRedactor.flush();
        stderrRedactor.flush();

        if (startError) {
          reject(startError);
          return;
        }

        resolve({ code, cancelled, stdout, stderr, hasErrorMarker });
      });
    });
  }
}

export function safeChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  includeProxyEnvironment = false,
): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "DOTNET_ROOT",
    "DOTNET_ROOT_X64",
    "DOTNET_CLI_HOME",
    "NUGET_PACKAGES",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
  ];
  const environment: NodeJS.ProcessEnv = {
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
  };
  for (const key of allowedKeys) {
    if (source[key] !== undefined) {
      environment[key] = source[key];
    }
  }
  if (includeProxyEnvironment) {
    for (const key of PROXY_ENVIRONMENT_KEYS) {
      if (source[key] !== undefined) {
        environment[key] = source[key];
      }
    }
  }
  return environment;
}

const PROXY_ENVIRONMENT_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export function proxyEnvironmentSecrets(environment: NodeJS.ProcessEnv): string[] {
  const secrets = new Set<string>();
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (!value) continue;
    secrets.add(value);
    try {
      const url = new URL(value);
      if (url.username) {
        secrets.add(url.username);
        secrets.add(decodeURIComponent(url.username));
      }
      if (url.password) {
        secrets.add(url.password);
        secrets.add(decodeURIComponent(url.password));
      }
    } catch {
      // NO_PROXY and non-URL proxy formats are still redacted as complete values.
    }
  }
  return [...secrets];
}

export function safeProcessFailureMessage(result: ProcessRunResult): string {
  if (result.cancelled) {
    return "Operation cancelled.";
  }
  return `Helper exited with code ${result.code ?? "unknown"}.`;
}

export function redactProcessMessage(message: string, secrets: readonly string[]): string {
  return redactText(message, secrets);
}
