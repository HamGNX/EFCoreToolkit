import * as path from "node:path";
import { access } from "node:fs/promises";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "suite", "index");
  const installedMacExecutable = "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
  let vscodeExecutablePath: string | undefined;
  if (process.platform === "darwin") {
    try {
      await access(installedMacExecutable);
      vscodeExecutablePath = installedMacExecutable;
    } catch {
      // Test library downloads a matching VS Code build when no local app exists.
    }
  }
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    vscodeExecutablePath,
    launchArgs: ["--disable-extensions"],
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown integration-test failure";
  console.error(message);
  process.exitCode = 1;
});
