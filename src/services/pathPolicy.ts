import * as path from "node:path";
import { realpath } from "node:fs/promises";

export function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function resolvePathPolicy(
  workspacePath: string,
  candidatePath: string,
): Promise<{ workspacePath: string; candidatePath: string; isInsideWorkspace: boolean }> {
  const [resolvedWorkspace, resolvedCandidate] = await Promise.all([
    realpath(workspacePath),
    realpath(candidatePath),
  ]);

  return {
    workspacePath: resolvedWorkspace,
    candidatePath: resolvedCandidate,
    isInsideWorkspace: isPathInside(resolvedWorkspace, resolvedCandidate),
  };
}

export function assertPathInside(parentPath: string, candidatePath: string): void {
  if (!isPathInside(parentPath, candidatePath)) {
    throw new Error("Resolved path is outside its allowed parent directory.");
  }
}
