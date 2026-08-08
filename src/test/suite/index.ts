import assert from "node:assert/strict";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("efcore-toolkit.efcore-power-tools-vscode");
  assert.ok(extension);
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  assert.equal(commands.includes("efcorePowerTools.reverseEngineer"), true);
  assert.equal(commands.includes("efcorePowerTools.regenerate"), true);
  assert.equal(commands.includes("efcorePowerTools.manageProfiles"), true);
  assert.equal(commands.includes("efcorePowerTools.showOutput"), true);
  await vscode.commands.executeCommand("efcorePowerTools.showOutput");
  console.log("Extension activation and command registration passed.");
}
