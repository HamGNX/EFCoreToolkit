import * as path from "node:path";
import * as os from "node:os";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import * as vscode from "vscode";
import type { CancellationLike, EfCoreMajor, OutputSink } from "../types";
import {
  buildInstallArguments,
  helperVersionSpec,
  managedHelperDirectory,
  managedHelperExecutable,
  reportsExpectedHelperVersion,
  requiredRuntimeMajor,
} from "./commandBuilder";
import { SafeUserError, UserCancelledError } from "./errors";
import { ProcessRunner, safeProcessFailureMessage } from "./processRunner";

const HELPER_PATH_STATE_KEY = "helperPaths";

export class HelperService {
  private dotnetExecutable: string | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly processRunner: ProcessRunner,
    private readonly output: OutputSink,
  ) {}

  public async validateDotnetAndRuntime(major: EfCoreMajor): Promise<void> {
    await mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
    const dotnet = await this.resolveDotnet();
    const sdks = await this.processRunner.run({
      executable: dotnet,
      args: ["--list-sdks"],
      cwd: this.context.globalStorageUri.fsPath,
    });
    if (sdks.code !== 0 || sdks.stdout.length === 0) {
      throw new SafeUserError(".NET SDK was not found. Install a supported .NET SDK, then retry.");
    }

    const runtimes = await this.processRunner.run({
      executable: dotnet,
      args: ["--list-runtimes"],
      cwd: this.context.globalStorageUri.fsPath,
    });
    const runtimeMajors = new Set(
      runtimes.stdout
        .map((line) => /^Microsoft\.NETCore\.App\s+(\d+)\./.exec(line)?.[1])
        .filter((value): value is string => value !== undefined)
        .map(Number),
    );
    const required = requiredRuntimeMajor(major);
    if (!runtimeMajors.has(required)) {
      throw new SafeUserError(
        `.NET ${required} runtime is required for the EF Core ${major} helper. Install it, then retry.`,
      );
    }
  }

  public async findExisting(major: EfCoreMajor): Promise<string | undefined> {
    const configured = vscode.workspace
      .getConfiguration("efcorePowerTools")
      .get<Record<string, string>>("helperPaths", {})[String(major)];
    const saved = this.context.globalState.get<Record<string, string>>(HELPER_PATH_STATE_KEY, {})[
      String(major)
    ];
    const managed = managedHelperExecutable(this.context.globalStorageUri.fsPath, major);
    const globalExecutable = path.join(
      os.homedir(),
      ".dotnet",
      "tools",
      process.platform === "win32" ? "efcpt.exe" : "efcpt",
    );

    for (const candidate of [configured, saved]) {
      if (candidate && (await isExecutable(candidate)) && (await this.isExpectedVersion(candidate, major))) {
        return candidate;
      }
    }
    if ((await isExecutable(managed)) && (await this.isExpectedVersion(managed, major))) {
      return managed;
    }
    if (
      (await isExecutable(globalExecutable)) &&
      (await this.isExpectedVersion(globalExecutable, major))
    ) {
      return globalExecutable;
    }

    return undefined;
  }

  public async rememberExisting(major: EfCoreMajor, executablePath: string): Promise<void> {
    if (!(await this.isExpectedVersion(executablePath, major))) {
      throw new SafeUserError(
        `Selected helper does not report expected version ${helperVersionSpec(major)}.`,
      );
    }
    const existing = this.context.globalState.get<Record<string, string>>(HELPER_PATH_STATE_KEY, {});
    await this.context.globalState.update(HELPER_PATH_STATE_KEY, {
      ...existing,
      [String(major)]: executablePath,
    });
  }

  public async install(major: EfCoreMajor, cancellation: CancellationLike): Promise<string> {
    const toolPath = managedHelperDirectory(this.context.globalStorageUri.fsPath, major);
    await mkdir(toolPath, { recursive: true });
    this.output.appendLine(`Installing EF Core ${major} helper in extension storage...`);
    const result = await this.processRunner.run({
      executable: this.requireDotnet(),
      args: buildInstallArguments(toolPath, major),
      cwd: path.dirname(toolPath),
      cancellation,
      output: this.output,
      includeProxyEnvironment: true,
    });
    if (result.cancelled) {
      throw new UserCancelledError();
    }
    if (result.code !== 0) {
      throw new SafeUserError(`${safeProcessFailureMessage(result)} Open output for installation details.`);
    }

    const executable = managedHelperExecutable(this.context.globalStorageUri.fsPath, major);
    if (!(await isExecutable(executable)) || !(await this.isExpectedVersion(executable, major))) {
      throw new SafeUserError("Helper installation completed, but efcpt executable was not found.");
    }
    return executable;
  }

  private async resolveDotnet(): Promise<string> {
    if (this.dotnetExecutable) {
      return this.dotnetExecutable;
    }

    const configured = vscode.workspace
      .getConfiguration("efcorePowerTools")
      .get<string>("dotnetPath", "")
      .trim();
    const candidates = [
      configured,
      "dotnet",
      "/usr/local/share/dotnet/dotnet",
      "/usr/local/bin/dotnet",
      "/opt/homebrew/bin/dotnet",
      "/usr/local/share/dotnet/x64/dotnet",
    ].filter((candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index);

    for (const candidate of candidates) {
      try {
        const result = await this.processRunner.run({
          executable: candidate,
          args: ["--list-runtimes"],
          cwd: this.context.globalStorageUri.fsPath,
        });
        if (result.code === 0) {
          this.dotnetExecutable = candidate;
          return candidate;
        }
      } catch {
        // Try next known location without exposing process details.
      }
    }

    throw new SafeUserError(
      ".NET was not found. Install it or set EF Core Power Tools: Dotnet Path, then retry.",
    );
  }

  private requireDotnet(): string {
    if (!this.dotnetExecutable) {
      throw new SafeUserError(".NET validation must complete before helper resolution.");
    }
    return this.dotnetExecutable;
  }

  private async isExpectedVersion(executablePath: string, major: EfCoreMajor): Promise<boolean> {
    try {
      const result = await this.processRunner.run({
        executable: executablePath,
        args: ["--version"],
        cwd: this.context.globalStorageUri.fsPath,
      });
      return reportsExpectedHelperVersion([...result.stdout, ...result.stderr], major);
    } catch {
      return false;
    }
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(path.resolve(filePath), process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
