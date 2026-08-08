import * as path from "node:path";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import type { ProjectInfo } from "../types";
import { parseProjectXml } from "./projectParser";

async function readCentralPackages(projectPath: string, workspacePath: string): Promise<string | undefined> {
  let current = path.dirname(projectPath);
  const resolvedWorkspace = path.resolve(workspacePath);

  while (current === resolvedWorkspace || current.startsWith(`${resolvedWorkspace}${path.sep}`)) {
    try {
      return await readFile(path.join(current, "Directory.Packages.props"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (current === resolvedWorkspace) {
      break;
    }
    current = path.dirname(current);
  }

  return undefined;
}

export async function findProjects(workspaceFolder: vscode.WorkspaceFolder): Promise<ProjectInfo[]> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceFolder, "**/*.csproj"),
    new vscode.RelativePattern(workspaceFolder, "**/{bin,obj,node_modules}/**"),
  );

  const projects = await Promise.all(
    uris.map(async (uri) => {
      const xml = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      const centralPackages = await readCentralPackages(uri.fsPath, workspaceFolder.uri.fsPath);
      return parseProjectXml(uri.fsPath, xml, centralPackages);
    }),
  );

  return projects.sort((left, right) => left.filePath.localeCompare(right.filePath));
}
