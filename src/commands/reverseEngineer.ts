import * as path from "node:path";
import { realpath } from "node:fs/promises";
import * as vscode from "vscode";
import {
  ConfigService,
  WINDOWS_CONFIG_FILE,
  createSelectedConfig,
  selectedObjectNames,
  suggestDbContextName,
  validateConfigForMajor,
} from "../services/configService";
import { SafeUserError } from "../services/errors";
import { HelperService } from "../services/helperService";
import { ExtensionOutput } from "../services/output";
import { ProfileStore } from "../services/profileStore";
import { isValidCSharpNamespace } from "../services/projectParser";
import {
  askConnectionString,
  askDbContextName,
  maybeAskProfileName,
  selectOutputFolder,
  selectProvider,
  selectDatabaseObjects,
  selectWorkspaceFolder,
} from "../ui/nativeUi";
import {
  confirmMySqlProvider,
  confirmOutputPath,
  resolveHelper,
  runCommandSafely,
  selectProjectAndMajor,
  validateWorkspace,
} from "./common";
import { generateAndCommit, openGeneratedOutput } from "./generation";

export interface ReverseEngineerDependencies {
  context: vscode.ExtensionContext;
  output: ExtensionOutput;
  helperService: HelperService;
  configService: ConfigService;
}

export function createReverseEngineerCommand(dependencies: ReverseEngineerDependencies): () => Promise<void> {
  return () => runCommandSafely(dependencies.output, () => reverseEngineer(dependencies));
}

async function reverseEngineer(dependencies: ReverseEngineerDependencies): Promise<void> {
  const workspaceFolder = await selectWorkspaceFolder();
  validateWorkspace(workspaceFolder);
  const { project, major } = await selectProjectAndMajor(workspaceFolder);
  const projectFolder = path.dirname(project.filePath);
  const projectConfig = await dependencies.configService.loadProjectGenerationConfig(projectFolder);
  if (projectConfig?.efCoreMajor && projectConfig.efCoreMajor !== major) {
    throw new SafeUserError(
      `${WINDOWS_CONFIG_FILE} targets EF Core ${projectConfig.efCoreMajor}, but the project uses EF Core ${major}.`,
    );
  }
  if (projectConfig) validateConfigForMajor(projectConfig.config, major);
  const configuredRootNamespace = projectConfig?.config.names?.["root-namespace"];
  const rootNamespace = typeof configuredRootNamespace === "string"
    ? configuredRootNamespace
    : project.rootNamespace;
  if (!isValidCSharpNamespace(rootNamespace)) {
    throw new SafeUserError(
      "Project root namespace could not be resolved to a valid C# namespace. Add an explicit RootNamespace to the .csproj, then retry.",
    );
  }
  if (projectConfig) {
    dependencies.output.appendLine(
      projectConfig.source === "windows"
        ? "Using compatible settings from efpt.config.json."
        : "Using existing efcpt-config.json settings.",
    );
  }
  await confirmMySqlProvider(
    project,
    major,
    projectConfig?.config["type-mappings"]?.["use-spatial"] === true,
  );
  const helperPath = await resolveHelper(dependencies.helperService, major);
  const provider = await selectProvider();
  const connectionString = await askConnectionString();
  const selectedOutputFolder = await selectOutputFolder(project);
  const outputFolder = await confirmOutputPath(workspaceFolder, selectedOutputFolder);
  if (outputFolder !== (await realpath(projectFolder))) {
    throw new SafeUserError(
      "Select the .csproj folder as output root to preserve Windows-compatible paths and namespaces.",
    );
  }
  const configuredContextName = projectConfig?.config.names?.["dbcontext-name"];
  const defaultContextName =
    typeof configuredContextName === "string"
      ? configuredContextName
      : suggestDbContextName(connectionString);
  const dbContextName = await askDbContextName(defaultContextName);

  dependencies.output.appendLine(`Starting MySQL reverse engineering for EF Core ${major}.`);
  const discovery = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Discovering MySQL tables",
      cancellable: true,
    },
    (_progress, token) =>
      dependencies.configService.discoverTables(
        helperPath,
        connectionString,
        token,
        projectConfig?.config,
        major,
      ),
  );
  if (discovery.tables.length + discovery.views.length === 0) {
    throw new SafeUserError(
      "No MySQL tables or views were discovered. Check connection permissions and database name.",
    );
  }
  const preselected = projectConfig
    ? {
        tables: selectedObjectNames(projectConfig.config.tables),
        views: selectedObjectNames(projectConfig.config.views),
      }
    : undefined;
  const selectedObjects = await selectDatabaseObjects(
    discovery.tables,
    discovery.views,
    preselected,
  );
  const config = createSelectedConfig(
    discovery.config,
    new Set(selectedObjects.tables),
    new Set(selectedObjects.views),
    dbContextName,
    rootNamespace,
  );
  const copiedFiles = await generateAndCommit(
    dependencies.configService,
    dependencies.output,
    helperPath,
    connectionString,
    config,
    major,
    outputFolder,
    projectConfig?.renamingPath,
  );

  const profileName = await maybeAskProfileName(`${dbContextName} MySQL`);
  if (profileName?.trim()) {
    const profileStore = new ProfileStore(
      dependencies.context.workspaceState,
      dependencies.context.secrets,
      workspaceFolder.uri.toString(),
    );
    await profileStore.save({
      name: profileName.trim(),
      provider,
      outputFolder,
      dbContextName,
      connectionString,
    });
    dependencies.output.appendLine(`Saved connection profile "${profileName.trim()}" securely.`);
  }

  await openGeneratedOutput(copiedFiles, outputFolder, dbContextName);
  await vscode.window.showInformationMessage(
    `Generated ${dbContextName} and selected MySQL entities successfully.`,
  );
}
