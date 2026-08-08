import * as vscode from "vscode";
import type { EfCoreMajor, ProjectInfo } from "../types";
import { SafeUserError, UserCancelledError } from "../services/errors";
import { findProjects } from "../services/projectService";
import {
  isDefinitelyBelowNet6,
  isDefinitelyBelowRequiredDotnet,
  requiredDotnetMajorForEfCore,
} from "../services/projectParser";
import { resolvePathPolicy } from "../services/pathPolicy";
import { ExtensionOutput } from "../services/output";
import { HelperService } from "../services/helperService";
import {
  chooseExistingHelper,
  selectEfCoreMajor,
  selectProject,
} from "../ui/nativeUi";

export function validateWorkspace(workspaceFolder: vscode.WorkspaceFolder): void {
  if (!vscode.workspace.isTrusted) {
    throw new SafeUserError("Trust this workspace before running database reverse engineering.");
  }
  if (workspaceFolder.uri.scheme !== "file") {
    throw new SafeUserError("Only file-backed folder workspaces are supported.");
  }
}

export async function selectProjectAndMajor(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<{ project: ProjectInfo; major: EfCoreMajor }> {
  const project = await selectProject(await findProjects(workspaceFolder), workspaceFolder);
  if (project.packageConflicts?.length) {
    throw new SafeUserError(
      `${project.packageConflicts.join(" ")} Align project and central package versions before generation.`,
    );
  }
  if (isDefinitelyBelowNet6(project.targetFrameworks)) {
    throw new SafeUserError("Selected project must target .NET 6 or newer.");
  }
  const major = await selectEfCoreMajor(project);
  if (isDefinitelyBelowRequiredDotnet(project.targetFrameworks, major)) {
    const required = requiredDotnetMajorForEfCore(major);
    throw new SafeUserError(
      `EF Core ${major} generation requires the selected project to target .NET ${required} or newer.`,
    );
  }
  if (project.mysqlProvider && project.mysqlProvider.major !== major) {
    throw new SafeUserError(
      `${project.mysqlProvider.packageName} major ${project.mysqlProvider.major} does not match EF Core ${major}.`,
    );
  }
  const expectedProvider = major === 10 ? "Microting" : "Pomelo";
  if (project.mysqlProviderFamily && project.mysqlProviderFamily !== expectedProvider) {
    throw new SafeUserError(
      `EF Core ${major} generation requires the ${expectedProvider} MySQL provider family, but the project references ${project.mysqlProviderFamily}.`,
    );
  }
  if (
    project.mysqlProvider &&
    !project.mysqlProvider.packageName
      .toLowerCase()
      .startsWith(`${expectedProvider.toLowerCase()}.`)
  ) {
    throw new SafeUserError(
      `EF Core ${major} generation requires the ${expectedProvider} MySQL provider family used by upstream Power Tools.`,
    );
  }
  return { project, major };
}

export async function confirmMySqlProvider(
  project: ProjectInfo,
  major: EfCoreMajor,
  requiresSpatial = false,
): Promise<void> {
  const mainPackage =
    major === 10
      ? "Microting.EntityFrameworkCore.MySql"
      : "Pomelo.EntityFrameworkCore.MySql";
  const spatialPackage = `${mainPackage}.NetTopologySuite`;
  if (
    requiresSpatial &&
    project.mysqlSpatialProvider &&
    (project.mysqlSpatialProvider.major !== major ||
      project.mysqlSpatialProvider.packageName.toLowerCase() !== spatialPackage.toLowerCase())
  ) {
    throw new SafeUserError(
      `${project.mysqlSpatialProvider.packageName} does not match the EF Core ${major} upstream MySQL spatial provider.`,
    );
  }
  const missing = [
    ...(!project.mysqlProvider ? [`${mainPackage} ${major}.x`] : []),
    ...(requiresSpatial && !project.mysqlSpatialProvider
      ? [`${spatialPackage} ${major}.x`]
      : []),
  ];
  if (missing.length === 0) return;
  const choice = await vscode.window.showWarningMessage(
    `Direct package reference(s) not detected: ${missing.join(", ")}. Generated MySQL code may not compile.`,
    { modal: true },
    "Continue Generation",
  );
  if (choice !== "Continue Generation") {
    throw new UserCancelledError();
  }
}

export async function resolveHelper(
  helperService: HelperService,
  major: EfCoreMajor,
): Promise<string> {
  await helperService.validateDotnetAndRuntime(major);
  const existing = await helperService.findExisting(major);
  if (existing) {
    return existing;
  }

  const installLabel = major === 10 ? "Install experimental helper" : "Install helper";
  const helperDetail =
    major === 10
      ? "MySQL support for EF Core 10 currently requires pinned upstream nightly 10.1.1440-nightly. Installation writes only to extension storage."
      : `A matching EF Core ${major} helper is needed. Installation writes only to extension storage.`;
  const choice = await vscode.window.showInformationMessage(
    "EF Core Power Tools helper is required.",
    { modal: true, detail: helperDetail },
    installLabel,
    "Choose existing helper path",
  );
  if (choice === "Choose existing helper path") {
    const selected = await chooseExistingHelper();
    await helperService.rememberExisting(major, selected);
    return selected;
  }
  if (choice !== installLabel) {
    throw new UserCancelledError();
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Installing EF Core ${major} Power Tools helper`,
      cancellable: true,
    },
    (_progress, token) => helperService.install(major, token),
  );
}

export async function confirmOutputPath(
  workspaceFolder: vscode.WorkspaceFolder,
  outputFolder: string,
): Promise<string> {
  let policy;
  try {
    policy = await resolvePathPolicy(workspaceFolder.uri.fsPath, outputFolder);
  } catch {
    throw new SafeUserError("Output folder could not be resolved. Select an existing accessible folder.");
  }
  if (policy.isInsideWorkspace) {
    return policy.candidatePath;
  }

  const confirmation = await vscode.window.showWarningMessage(
    "Output folder is outside the opened workspace.",
    { modal: true, detail: policy.candidatePath },
    "Use Outside Folder",
  );
  if (confirmation !== "Use Outside Folder") {
    throw new UserCancelledError();
  }
  return policy.candidatePath;
}

export async function confirmCollisions(relativeFiles: readonly string[]): Promise<void> {
  if (relativeFiles.length === 0) {
    return;
  }
  const confirmation = await vscode.window.showWarningMessage(
    `${relativeFiles.length} existing generated file(s) will be overwritten.`,
    { modal: true, detail: relativeFiles.join("\n") },
    "Overwrite Files",
  );
  if (confirmation !== "Overwrite Files") {
    throw new UserCancelledError();
  }
}

export async function runCommandSafely(
  output: ExtensionOutput,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof UserCancelledError) {
      return;
    }
    const message =
      error instanceof SafeUserError || (error instanceof Error && isAllowListedError(error.message))
        ? error.message
        : "Operation failed safely. No connection details were logged.";
    output.appendLine(message);
    const action = await vscode.window.showErrorMessage(message, "Show Output");
    if (action === "Show Output") {
      output.show();
    }
  }
}

function isAllowListedError(message: string): boolean {
  return (
    message === "A folder workspace must be open." ||
    message === "No .csproj file was found in the selected workspace folder." ||
    message === "Select at least one table or view."
  );
}
