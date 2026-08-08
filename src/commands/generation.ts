import * as path from "node:path";
import * as vscode from "vscode";
import type { EfcptConfig } from "../services/configService";
import { ConfigService } from "../services/configService";
import { ExtensionOutput } from "../services/output";
import type { EfCoreMajor } from "../types";
import { confirmCollisions } from "./common";

export async function generateAndCommit(
  configService: ConfigService,
  output: ExtensionOutput,
  helperPath: string,
  connectionString: string,
  config: EfcptConfig,
  major: EfCoreMajor,
  outputFolder: string,
  renamingPath?: string,
): Promise<string[]> {
  const staged = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Generating EF Core DbContext and entities",
      cancellable: true,
    },
    (_progress, token) =>
      configService.stage(helperPath, connectionString, config, major, token, renamingPath),
  );

  let operationFailed = false;
  try {
    const collisions = await configService.findCollisions(staged, outputFolder);
    await confirmCollisions(collisions.map((collision) => collision.relativeFile));
    const copied = await configService.commit(
      staged,
      outputFolder,
      new Map(collisions.map((collision) => [collision.relativeFile, collision.sha256])),
    );
    output.appendLine(`Generated ${copied.length} file(s).`);
    return copied;
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await configService.discard(staged);
    } catch {
      const message = operationFailed
        ? "Temporary staging cleanup also failed; the original generation error is preserved."
        : "Files were generated, but temporary staging cleanup failed. Restart VS Code before retrying.";
      output.appendLine(message);
      if (!operationFailed) {
        await vscode.window.showWarningMessage(message);
      }
    }
  }
}

export async function openGeneratedOutput(
  copiedFiles: readonly string[],
  outputFolder: string,
  dbContextName: string,
): Promise<void> {
  const contextFile = copiedFiles.find(
    (file) => path.basename(file).toLowerCase() === `${dbContextName}.cs`.toLowerCase(),
  );
  if (contextFile) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(contextFile));
    await vscode.window.showTextDocument(document);
    return;
  }
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outputFolder));
}
