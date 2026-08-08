import * as path from "node:path";
import type { EfCoreMajor } from "../types";

export const EFCPT_PACKAGE = "ErikEJ.EFCorePowerTools.Cli";

const VERSION_SPECS: Record<EfCoreMajor, string> = {
  6: "6.1.463",
  7: "7.1.343",
  8: "8.1.1386",
  9: "9.1.1386",
  10: "10.1.1440-nightly",
};

export function helperVersionSpec(major: EfCoreMajor): string {
  return VERSION_SPECS[major];
}

export function reportsExpectedHelperVersion(
  lines: readonly string[],
  major: EfCoreMajor,
): boolean {
  const expected = helperVersionSpec(major);
  return lines.some((line) =>
    line.split(/\s+/).some((token) => token === expected || token.startsWith(`${expected}+`)),
  );
}

export function managedHelperDirectory(storagePath: string, major: EfCoreMajor): string {
  return path.join(storagePath, "helpers", String(major), helperVersionSpec(major));
}

export function managedHelperExecutable(storagePath: string, major: EfCoreMajor): string {
  const executable = process.platform === "win32" ? "efcpt.exe" : "efcpt";
  return path.join(managedHelperDirectory(storagePath, major), executable);
}

export function buildInstallArguments(toolPath: string, major: EfCoreMajor): string[] {
  return [
    "tool",
    "install",
    EFCPT_PACKAGE,
    "--tool-path",
    toolPath,
    "--version",
    helperVersionSpec(major),
    "--source",
    "https://api.nuget.org/v3/index.json",
  ];
}

export function buildScaffoldArguments(
  connectionString: string,
  outputPath: string,
  configPath?: string,
  renamingPath?: string,
): string[] {
  const args = [connectionString, "mysql", "-o", outputPath];
  if (configPath) {
    args.push("-i", configPath);
  }
  if (renamingPath) {
    args.push("-r", renamingPath);
  }
  return args;
}

export function supportsRenamingArgument(major: EfCoreMajor): boolean {
  return major >= 8;
}

export function requiredRuntimeMajor(major: EfCoreMajor): number {
  if (major <= 7) {
    return 6;
  }
  if (major <= 9) {
    return 8;
  }
  return 10;
}
