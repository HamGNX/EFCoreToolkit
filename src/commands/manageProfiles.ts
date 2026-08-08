import * as vscode from "vscode";
import { SafeUserError, UserCancelledError } from "../services/errors";
import { ExtensionOutput } from "../services/output";
import { ProfileStore } from "../services/profileStore";
import { selectProfile, selectWorkspaceFolder } from "../ui/nativeUi";
import { runCommandSafely, validateWorkspace } from "./common";

export function createManageProfilesCommand(
  context: vscode.ExtensionContext,
  output: ExtensionOutput,
): () => Promise<void> {
  return () => runCommandSafely(output, () => manageProfiles(context, output));
}

async function manageProfiles(context: vscode.ExtensionContext, output: ExtensionOutput): Promise<void> {
  const workspaceFolder = await selectWorkspaceFolder();
  validateWorkspace(workspaceFolder);
  const store = new ProfileStore(
    context.workspaceState,
    context.secrets,
    workspaceFolder.uri.toString(),
  );
  const profiles = store.list();
  if (profiles.length === 0) {
    throw new SafeUserError("No saved connection profiles exist for this workspace.");
  }

  const profile = await selectProfile(profiles);
  const action = await vscode.window.showQuickPick(["Delete Profile", "Cancel"], {
    placeHolder: `Manage ${profile.name}`,
  });
  if (action !== "Delete Profile") {
    throw new UserCancelledError();
  }
  const confirmation = await vscode.window.showWarningMessage(
    `Delete connection profile "${profile.name}"?`,
    { modal: true, detail: `Secret and metadata will be removed.\n${profile.outputFolder}` },
    "Delete Profile",
  );
  if (confirmation !== "Delete Profile") {
    throw new UserCancelledError();
  }

  await store.delete(profile);
  output.appendLine(`Deleted connection profile "${profile.name}".`);
  await vscode.window.showInformationMessage(`Deleted profile "${profile.name}".`);
}
