import * as vscode from "vscode";
import { createManageProfilesCommand } from "./commands/manageProfiles";
import { createRegenerateCommand } from "./commands/regenerate";
import { createReverseEngineerCommand } from "./commands/reverseEngineer";
import { ConfigService } from "./services/configService";
import { HelperService } from "./services/helperService";
import { ExtensionOutput } from "./services/output";
import { ProcessRunner } from "./services/processRunner";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  const output = new ExtensionOutput();
  const processRunner = new ProcessRunner();
  const helperService = new HelperService(context, processRunner, output);
  const configService = new ConfigService(processRunner, output);
  const dependencies = { context, output, helperService, configService };

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand(
      "efcorePowerTools.reverseEngineer",
      createReverseEngineerCommand(dependencies),
    ),
    vscode.commands.registerCommand(
      "efcorePowerTools.regenerate",
      createRegenerateCommand(dependencies),
    ),
    vscode.commands.registerCommand(
      "efcorePowerTools.manageProfiles",
      createManageProfilesCommand(context, output),
    ),
    vscode.commands.registerCommand("efcorePowerTools.showOutput", () => output.show()),
  );
}

export function deactivate(): void {}
