import * as path from "node:path";
import { realpath } from "node:fs/promises";
import * as vscode from "vscode";
import {
  ConfigService,
  configuredGenerationMajor,
  configuredHelperVersion,
  prepareRegenerationConfig,
  validateConfigForMajor,
} from "../services/configService";
import { SafeUserError } from "../services/errors";
import { helperVersionSpec } from "../services/commandBuilder";
import { HelperService } from "../services/helperService";
import { ExtensionOutput } from "../services/output";
import { ProfileStore } from "../services/profileStore";
import { selectProfile, selectWorkspaceFolder } from "../ui/nativeUi";
import {
  confirmMySqlProvider,
  confirmOutputPath,
  resolveHelper,
  runCommandSafely,
  selectProjectAndMajor,
  validateWorkspace,
} from "./common";
import { generateAndCommit, openGeneratedOutput } from "./generation";

export interface RegenerateDependencies {
  context: vscode.ExtensionContext;
  output: ExtensionOutput;
  helperService: HelperService;
  configService: ConfigService;
}

export function createRegenerateCommand(dependencies: RegenerateDependencies): () => Promise<void> {
  return () => runCommandSafely(dependencies.output, () => regenerate(dependencies));
}

async function regenerate(dependencies: RegenerateDependencies): Promise<void> {
  const workspaceFolder = await selectWorkspaceFolder();
  validateWorkspace(workspaceFolder);
  const store = new ProfileStore(
    dependencies.context.workspaceState,
    dependencies.context.secrets,
    workspaceFolder.uri.toString(),
  );
  const profiles = store.list();
  if (profiles.length === 0) {
    throw new SafeUserError("No saved connection profiles exist for this workspace.");
  }

  const metadata = await selectProfile(profiles);
  const profile = await store.load(metadata);
  if (!profile) {
    throw new SafeUserError("Connection is no longer available. Delete profile and create it again.");
  }
  const outputFolder = await confirmOutputPath(workspaceFolder, profile.outputFolder);
  const { project, major } = await selectProjectAndMajor(workspaceFolder);
  if ((await realpath(path.dirname(project.filePath))) !== outputFolder) {
    throw new SafeUserError(
      "Select the project that owns this saved profile; its .csproj folder must match the saved output root.",
    );
  }
  const savedConfig = await dependencies.configService.readOutputConfig(outputFolder);
  const savedMajor = configuredGenerationMajor(savedConfig);
  if (!savedMajor) {
    throw new SafeUserError(
      "Saved generation config is not bound to an EF Core version. Run Reverse Engineer Database once before regenerating.",
    );
  }
  if (savedMajor !== major) {
    throw new SafeUserError(
      `Saved generation config targets EF Core ${savedMajor}, but the selected project uses EF Core ${major}. Run Reverse Engineer Database to review the version change.`,
    );
  }
  const savedHelperVersion = configuredHelperVersion(savedConfig);
  const expectedHelperVersion = helperVersionSpec(major);
  if (!savedHelperVersion) {
    throw new SafeUserError(
      "Saved generation config is not bound to an EF Core Power Tools helper build. Run Reverse Engineer Database once before regenerating.",
    );
  }
  if (savedHelperVersion !== expectedHelperVersion) {
    throw new SafeUserError(
      `Saved generation config used helper ${savedHelperVersion}, but this extension uses ${expectedHelperVersion}. Run Reverse Engineer Database to review the engine change.`,
    );
  }
  const config = prepareRegenerationConfig(savedConfig);
  validateConfigForMajor(config, major);
  await confirmMySqlProvider(
    project,
    major,
    config["type-mappings"]?.["use-spatial"] === true,
  );
  const renamingPath = await dependencies.configService.findRenamingConfig(outputFolder, config);
  await dependencies.configService.verifyRenamingConfig(config, renamingPath);
  const helperPath = await resolveHelper(dependencies.helperService, major);

  dependencies.output.appendLine(`Regenerating profile "${profile.name}" with EF Core ${major}.`);
  const copiedFiles = await generateAndCommit(
    dependencies.configService,
    dependencies.output,
    helperPath,
    profile.connectionString,
    config,
    major,
    outputFolder,
    renamingPath,
  );
  const configuredContextName = config.names?.["dbcontext-name"];
  const dbContextName = typeof configuredContextName === "string"
    ? configuredContextName
    : profile.dbContextName;
  await openGeneratedOutput(copiedFiles, outputFolder, dbContextName);
  await vscode.window.showInformationMessage(`Regenerated ${dbContextName} successfully.`);
}
