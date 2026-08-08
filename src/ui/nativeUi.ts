import * as path from "node:path";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import * as vscode from "vscode";
import { SUPPORTED_EF_CORE_MAJORS, type EfCoreMajor, type ProfileMetadata, type ProjectInfo } from "../types";
import { UserCancelledError } from "../services/errors";
import { isValidCSharpIdentifier } from "../services/projectParser";

export async function selectWorkspaceFolder(): Promise<vscode.WorkspaceFolder> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    throw new Error("A folder workspace must be open.");
  }
  if (folders.length === 1) {
    return folders[0];
  }

  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { placeHolder: "Select workspace folder" },
  );
  if (!selected) {
    throw new UserCancelledError();
  }
  return selected.folder;
}

export async function selectProject(
  projects: readonly ProjectInfo[],
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<ProjectInfo> {
  if (projects.length === 0) {
    throw new Error("No .csproj file was found in the selected workspace folder.");
  }
  if (projects.length === 1) {
    return projects[0];
  }

  const selected = await vscode.window.showQuickPick(
    projects.map((project) => ({
      label: project.name,
      description: path.relative(workspaceFolder.uri.fsPath, project.filePath),
      detail: project.targetFrameworks.join(", ") || "Target framework not detected",
      project,
    })),
    { placeHolder: "Select target .NET project" },
  );
  if (!selected) {
    throw new UserCancelledError();
  }
  return selected.project;
}

export async function selectEfCoreMajor(project: ProjectInfo): Promise<EfCoreMajor> {
  if (project.detectedEfCoreMajor) {
    return project.detectedEfCoreMajor;
  }

  const selected = await vscode.window.showQuickPick(
    SUPPORTED_EF_CORE_MAJORS.map((major) => ({ label: `EF Core ${major}`, major })),
    {
      placeHolder: "EF Core package version was not detected. Select generated-code version.",
      ignoreFocusOut: true,
    },
  );
  if (!selected) {
    throw new UserCancelledError();
  }
  return selected.major;
}

export async function selectProvider(): Promise<"mysql"> {
  const selected = await vscode.window.showQuickPick(
    [{ label: "MySQL", description: "MVP provider", provider: "mysql" as const }],
    { placeHolder: "Select database provider" },
  );
  if (!selected) {
    throw new UserCancelledError();
  }
  return selected.provider;
}

export async function askConnectionString(): Promise<string> {
  const connectionString = await vscode.window.showInputBox({
    prompt: "Enter full MySQL connection string. It will never be logged.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "Connection string is required."),
  });
  if (connectionString === undefined) {
    throw new UserCancelledError();
  }
  return connectionString;
}

export async function selectOutputFolder(project: ProjectInfo): Promise<string> {
  const selected = await vscode.window.showOpenDialog({
    title: "Select project/output root (Models will be generated inside)",
    openLabel: "Use Project Root",
    defaultUri: vscode.Uri.file(path.dirname(project.filePath)),
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  if (!selected?.[0]) {
    throw new UserCancelledError();
  }
  return selected[0].fsPath;
}

export async function askDbContextName(defaultName: string): Promise<string> {
  const value = await vscode.window.showInputBox({
    title: "DbContext name",
    value: defaultName,
    ignoreFocusOut: true,
    validateInput: (candidate) =>
      isValidCSharpIdentifier(candidate)
        ? undefined
        : "Use a valid C# identifier without namespace separators.",
  });
  if (value === undefined) {
    throw new UserCancelledError();
  }
  return value;
}

export interface SelectedDatabaseObjects {
  tables: string[];
  views: string[];
}

export async function selectDatabaseObjects(
  tables: readonly string[],
  views: readonly string[],
  preselected?: Readonly<{ tables: ReadonlySet<string>; views: ReadonlySet<string> }>,
): Promise<SelectedDatabaseObjects> {
  const selected = await vscode.window.showQuickPick(
    [
      ...tables.map((name) => ({
        label: name,
        description: "Table",
        objectType: "table" as const,
        picked: preselected ? preselected.tables.has(name) : true,
      })),
      ...views.map((name) => ({
        label: name,
        description: "View",
        objectType: "view" as const,
        picked: preselected?.views.has(name) ?? false,
      })),
    ],
    {
      title: "Select MySQL tables and views",
      placeHolder: "Choose one or more database objects",
      canPickMany: true,
      ignoreFocusOut: true,
    },
  );
  if (selected === undefined) {
    throw new UserCancelledError();
  }
  if (selected.length === 0) {
    throw new Error("Select at least one table or view.");
  }
  return {
    tables: selected.filter((item) => item.objectType === "table").map((item) => item.label),
    views: selected.filter((item) => item.objectType === "view").map((item) => item.label),
  };
}

export async function selectProfile(profiles: readonly ProfileMetadata[]): Promise<ProfileMetadata> {
  const selected = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.name,
      description: profile.dbContextName,
      detail: profile.outputFolder,
      profile,
    })),
    { placeHolder: "Select saved connection profile" },
  );
  if (!selected) {
    throw new UserCancelledError();
  }
  return selected.profile;
}

export async function maybeAskProfileName(defaultName: string): Promise<string | undefined> {
  const save = await vscode.window.showQuickPick(["Save connection", "Do not save"], {
    placeHolder: "Save connection securely for this workspace?",
    ignoreFocusOut: true,
  });
  if (save !== "Save connection") {
    return undefined;
  }

  return vscode.window.showInputBox({
    title: "Connection profile name",
    value: defaultName,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "Profile name is required."),
  });
}

export async function chooseExistingHelper(): Promise<string> {
  const selected = await vscode.window.showOpenDialog({
    title: "Choose efcpt executable",
    openLabel: "Use Helper",
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
  });
  if (!selected?.[0]) {
    throw new UserCancelledError();
  }

  const filePath = selected[0].fsPath;
  await access(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  return filePath;
}
