import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  lstat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  SUPPORTED_EF_CORE_MAJORS,
  type CancellationLike,
  type EfCoreMajor,
  type OutputSink,
} from "../types";
import {
  buildScaffoldArguments,
  helperVersionSpec,
  supportsRenamingArgument,
} from "./commandBuilder";
import { SafeUserError, UserCancelledError } from "./errors";
import { assertPathInside } from "./pathPolicy";
import { ProcessRunner, safeProcessFailureMessage, type ProcessRunResult } from "./processRunner";
import { isValidCSharpIdentifier, isValidCSharpNamespace } from "./projectParser";
import { extractConnectionSecrets } from "./redaction";

export const EFCPT_CONFIG_FILE = "efcpt-config.json";
export const WINDOWS_CONFIG_FILE = "efpt.config.json";
export const RENAMING_CONFIG_FILE = "efpt.renaming.json";
const TEMP_PREFIX = "efcore-power-tools-vscode-";
const EXTENSION_CONFIG_KEY = "x-efcore-power-tools-vscode";

interface DatabaseObjectEntry {
  name?: unknown;
  exclude?: boolean;
  [key: string]: unknown;
}

export interface EfcptConfig {
  tables?: DatabaseObjectEntry[];
  views?: DatabaseObjectEntry[];
  "stored-procedures"?: DatabaseObjectEntry[];
  functions?: DatabaseObjectEntry[];
  "code-generation"?: Record<string, unknown>;
  names?: Record<string, unknown>;
  "file-layout"?: Record<string, unknown>;
  "type-mappings"?: Record<string, unknown>;
  replacements?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DiscoveryResult {
  config: EfcptConfig;
  tables: string[];
  views: string[];
}

export interface ProjectGenerationConfig {
  config: EfcptConfig;
  source: "cli" | "windows";
  renamingPath?: string;
  efCoreMajor?: EfCoreMajor;
}

export interface StagedGeneration {
  directory: string;
  relativeFiles: string[];
}

export interface CollisionSnapshot {
  relativeFile: string;
  sha256: string;
}

type RenameFile = (oldPath: string, newPath: string) => Promise<void>;

export function createSelectedConfig(
  discovered: EfcptConfig,
  selectedTables: ReadonlySet<string>,
  selectedViews: ReadonlySet<string>,
  dbContextName: string,
  rootNamespace: string,
): EfcptConfig {
  const config = structuredClone(discovered);
  config.tables = markExcluded(config.tables, (name) => !selectedTables.has(name));
  config.views = markExcluded(config.views, (name) => !selectedViews.has(name));
  config["stored-procedures"] = markExcluded(config["stored-procedures"], () => true);
  config.functions = markExcluded(config.functions, () => true);
  config["code-generation"] = {
    type: "all",
    ...(config["code-generation"] ?? {}),
    "enable-on-configuring": false,
    "use-t4": false,
    "use-t4-split": false,
    "t4-template-path": null,
    "soft-delete-obsolete-files": false,
    "refresh-object-lists": false,
  };
  config.names = {
    ...(config.names ?? {}),
    "root-namespace": rootNamespace,
    "dbcontext-name": dbContextName,
  };
  config["file-layout"] = {
    "output-path": "Models",
    "output-dbcontext-path": null,
    ...(config["file-layout"] ?? {}),
  };
  removeSensitiveProperties(config);
  return config;
}

export function prepareRegenerationConfig(config: EfcptConfig): EfcptConfig {
  const prepared = structuredClone(config);
  prepared["code-generation"] = {
    ...(prepared["code-generation"] ?? {}),
    "enable-on-configuring": false,
    "use-t4": false,
    "use-t4-split": false,
    "t4-template-path": null,
    "soft-delete-obsolete-files": false,
    "refresh-object-lists": false,
  };
  removeSensitiveProperties(prepared);
  return prepared;
}

export function selectedObjectNames(entries: DatabaseObjectEntry[] | undefined): Set<string> {
  const allEntries = entries ?? [];
  const excludeAll = allEntries.some((entry) => entry.exclusionWildcard === "*");
  const wildcardFilters = allEntries
    .map((entry) => entry.exclusionWildcard)
    .filter(
      (wildcard): wildcard is string =>
        typeof wildcard === "string" && wildcard !== "*" && wildcard.includes("*"),
    );
  return new Set(
    allEntries
      .filter((entry) => {
        if (typeof entry.name !== "string" || entry.exclude === true) return false;
        if (entry.exclude === false) return true;
        if (excludeAll) return false;
        return !wildcardFilters.some((wildcard) => wildcardMatches(entry.name as string, wildcard));
      })
      .map((entry) => entry.name as string),
  );
}

export function suggestDbContextName(connectionString: string): string {
  const values = parseConnectionString(connectionString);
  const basis =
    values.get("initial catalog") ??
    values.get("database") ??
    "Mysql";
  const identifier = basis.replace(/[^A-Za-z0-9_]/g, "");
  const safeBasis = /^[A-Za-z_]/.test(identifier) ? identifier : `_${identifier}`;
  return `${safeBasis || "Mysql"}Context`;
}

export function validateConfigForMajor(config: EfcptConfig, major: EfCoreMajor): void {
  const replacements = isRecord(config.replacements) ? config.replacements : {};
  const unsupportedReplacementKeys = [
    "irregular-words",
    "plural-rules",
    "singular-rules",
  ].filter((key) => Array.isArray(replacements[key]) && replacements[key].length > 0);
  if (major <= 7 && unsupportedReplacementKeys.length > 0) {
    throw new SafeUserError(
      `The EF Core ${major} helper cannot apply ${unsupportedReplacementKeys.join(", ")} from the Windows config.`,
    );
  }
  if (
    major === 7 &&
    (config.tables ?? []).some(
      (entry) => Array.isArray(entry.excludedIndexes) && entry.excludedIndexes.length > 0,
    )
  ) {
    throw new SafeUserError(
      "The EF Core 7 helper cannot apply excluded indexes from the Windows config.",
    );
  }
}

export function configuredGenerationMajor(config: EfcptConfig): EfCoreMajor | undefined {
  const metadata = isRecord(config[EXTENSION_CONFIG_KEY])
    ? config[EXTENSION_CONFIG_KEY]
    : undefined;
  const value = metadata?.["ef-core-major"];
  return SUPPORTED_EF_CORE_MAJORS.includes(value as EfCoreMajor)
    ? (value as EfCoreMajor)
    : undefined;
}

export function configuredHelperVersion(config: EfcptConfig): string | undefined {
  const metadata = isRecord(config[EXTENSION_CONFIG_KEY])
    ? config[EXTENSION_CONFIG_KEY]
    : undefined;
  const value = metadata?.["helper-version"];
  return typeof value === "string" ? value : undefined;
}

export class ConfigService {
  public constructor(
    private readonly processRunner: ProcessRunner,
    private readonly output: OutputSink,
    private readonly renameFile: RenameFile = rename,
  ) {}

  public async loadProjectGenerationConfig(
    projectFolder: string,
  ): Promise<ProjectGenerationConfig | undefined> {
    const cliPath = path.join(projectFolder, EFCPT_CONFIG_FILE);
    let windowsConfigPath: string | undefined;
    if (await isRegularFile(cliPath)) {
      const cliConfig = await readConfig(cliPath);
      const metadata = isRecord(cliConfig[EXTENSION_CONFIG_KEY])
        ? cliConfig[EXTENSION_CONFIG_KEY]
        : undefined;
      const legacySource = metadata?.["legacy-source"];
      if (typeof legacySource !== "string") {
        validateCompatibleConfig(cliConfig);
        const renamingPath = await this.findRenamingConfig(projectFolder, cliConfig, true);
        await bindRenamingConfig(cliConfig, renamingPath, true);
        return {
          config: cliConfig,
          source: "cli",
          renamingPath,
        };
      }
      const safeLegacySource = validateMetadataFileName(legacySource, "config");
      windowsConfigPath = await findRegularFileUnlessIgnored(
        path.join(projectFolder, safeLegacySource),
      );
      if (!windowsConfigPath) {
        throw new SafeUserError(
          `${safeLegacySource} was the compatibility source but is now missing or ignored.`,
        );
      }
    }

    windowsConfigPath ??= await findWindowsConfig(projectFolder);
    if (windowsConfigPath) {
      const windowsConfigName = path.basename(windowsConfigPath);
      const raw = (await readRegularFileBuffer(windowsConfigPath)).toString("utf8");
      const legacy = parseJsonObject(raw, windowsConfigName);
      const config = convertWindowsConfig(legacy);
      const efCoreMajor = legacyGenerationMajor(legacy.CodeGenerationMode);
      config[EXTENSION_CONFIG_KEY] = {
        ...(isRecord(config[EXTENSION_CONFIG_KEY]) ? config[EXTENSION_CONFIG_KEY] : {}),
        "legacy-source": windowsConfigName,
        "legacy-config-sha256": sha256(raw),
        ...(efCoreMajor ? { "ef-core-major": efCoreMajor } : {}),
      };
      validateCompatibleConfig(config);
      const renamingPath = await findRenamingForWindowsConfig(windowsConfigPath);
      await bindRenamingConfig(config, renamingPath, true);
      return {
        config,
        source: "windows",
        renamingPath,
        efCoreMajor,
      };
    }

    return undefined;
  }

  public async findRenamingConfig(
    outputFolder: string,
    config?: EfcptConfig,
    allowUntracked = false,
  ): Promise<string | undefined> {
    const metadata = config && isRecord(config[EXTENSION_CONFIG_KEY])
      ? config[EXTENSION_CONFIG_KEY]
      : undefined;
    const hasTrackedRenamer = typeof metadata?.["renaming-sha256"] === "string";
    if (!hasTrackedRenamer && !allowUntracked) return undefined;
    const sourceName = typeof metadata?.["renaming-source"] === "string"
      ? validateMetadataFileName(metadata["renaming-source"], "renaming")
      : RENAMING_CONFIG_FILE;
    return findRegularFileUnlessIgnored(path.join(outputFolder, sourceName));
  }

  public async verifyRenamingConfig(
    config: EfcptConfig,
    renamingPath: string | undefined,
  ): Promise<void> {
    await bindRenamingConfig(config, renamingPath);
  }

  public async discoverTables(
    helperPath: string,
    connectionString: string,
    cancellation: CancellationLike,
    baseConfig?: EfcptConfig,
    major?: EfCoreMajor,
  ): Promise<DiscoveryResult> {
    const temporaryDirectory = await createTemporaryDirectory();
    try {
      const seedConfig = createDiscoveryConfig(baseConfig);
      const seedConfigPath = path.join(temporaryDirectory, EFCPT_CONFIG_FILE);
      const seedText = `${JSON.stringify(seedConfig, null, 2)}\n`;
      await writeFile(seedConfigPath, seedText, {
        encoding: "utf8",
        mode: 0o600,
      });
      this.output.appendLine("Discovering MySQL database objects...");
      const connectionSecrets = extractConnectionSecrets(connectionString);
      const result = await this.processRunner.run({
        executable: helperPath,
        args: buildScaffoldArguments(connectionString, temporaryDirectory, seedConfigPath),
        cwd: temporaryDirectory,
        cancellation,
        output: this.output,
        secrets: connectionSecrets,
      });
      if (result.cancelled) {
        throw new UserCancelledError();
      }
      let refreshedConfig: EfcptConfig;
      let configurationWasRefreshed = false;
      try {
        const refreshedText = await readFile(
          path.join(temporaryDirectory, EFCPT_CONFIG_FILE),
          "utf8",
        );
        configurationWasRefreshed = refreshedText !== seedText;
        refreshedConfig = parseConfigJson(refreshedText);
      } catch {
        assertSuccessful(result);
        throw new SafeUserError("Helper did not produce a readable database-object configuration.");
      }
      const config = mergeDiscoveredConfig(baseConfig, refreshedConfig, major);
      const tables = (config.tables ?? [])
        .map((entry) => (typeof entry.name === "string" ? entry.name : undefined))
        .filter((name): name is string => name !== undefined);
      const views = (config.views ?? [])
        .map((entry) => (typeof entry.name === "string" ? entry.name : undefined))
        .filter((name): name is string => name !== undefined);
      if (
        (result.code !== 0 || result.hasErrorMarker) &&
        configurationWasRefreshed &&
        tables.length + views.length > 0
      ) {
        this.output.appendLine(
          "Helper reported warnings after object discovery. Select tables to retry focused generation.",
        );
      } else {
        assertSuccessful(result);
      }
      return { config, tables, views };
    } finally {
      await removeTemporaryDirectory(temporaryDirectory);
    }
  }

  public async readOutputConfig(outputFolder: string): Promise<EfcptConfig> {
    try {
      const configPath = path.join(outputFolder, EFCPT_CONFIG_FILE);
      if (!(await isRegularFile(configPath))) {
        throw new SafeUserError(
          `${EFCPT_CONFIG_FILE} is missing from saved output folder. Run Reverse Engineer Database again.`,
        );
      }
      const config = await readConfig(configPath);
      validateCompatibleConfig(config);
      await verifyLegacyConfig(config, outputFolder);
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SafeUserError(
          `${EFCPT_CONFIG_FILE} is missing from saved output folder. Run Reverse Engineer Database again.`,
        );
      }
      throw error;
    }
  }

  public async stage(
    helperPath: string,
    connectionString: string,
    config: EfcptConfig,
    major: EfCoreMajor,
    cancellation: CancellationLike,
    renamingPath?: string,
  ): Promise<StagedGeneration> {
    const temporaryDirectory = await createTemporaryDirectory();
    try {
      const safeConfig = structuredClone(config);
      validateCompatibleConfig(safeConfig);
      safeConfig[EXTENSION_CONFIG_KEY] = {
        ...(isRecord(safeConfig[EXTENSION_CONFIG_KEY])
          ? safeConfig[EXTENSION_CONFIG_KEY]
          : {}),
        "ef-core-major": major,
        "helper-version": helperVersionSpec(major),
      };
      const renamingContent = renamingPath
        ? await readRegularFileBuffer(renamingPath)
        : undefined;
      await bindRenamingConfig(safeConfig, renamingPath, false, renamingContent);
      await writeFile(
        path.join(temporaryDirectory, EFCPT_CONFIG_FILE),
        `${JSON.stringify(safeConfig, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      let renamingArgument: string | undefined;
      if (renamingContent) {
        const stagedRenamingPath = path.join(temporaryDirectory, RENAMING_CONFIG_FILE);
        await writeFile(stagedRenamingPath, renamingContent, {
          flag: "wx",
          mode: 0o600,
        });
        if (supportsRenamingArgument(major)) {
          renamingArgument = stagedRenamingPath;
        }
      }
      this.output.appendLine("Generating EF Core files in secure staging...");
      const connectionSecrets = extractConnectionSecrets(connectionString);
      const result = await this.processRunner.run({
        executable: helperPath,
        args: buildScaffoldArguments(
          connectionString,
          temporaryDirectory,
          path.join(temporaryDirectory, EFCPT_CONFIG_FILE),
          renamingArgument,
        ),
        cwd: temporaryDirectory,
        cancellation,
        output: this.output,
        secrets: connectionSecrets,
      });
      assertSuccessful(result);

      const relativeFiles = await collectGeneratedFiles(temporaryDirectory);
      const expectedContextName = safeConfig.names?.["dbcontext-name"];
      const hasExpectedContext =
        typeof expectedContextName === "string" &&
        relativeFiles.some(
          (file) => path.basename(file).toLowerCase() === `${expectedContextName}.cs`.toLowerCase(),
        );
      if (!relativeFiles.some((file) => file.endsWith(".cs")) || !hasExpectedContext) {
        throw new SafeUserError("Helper completed without generating C# files. Open output for details.");
      }
      await assertFilesDoNotContain(relativeFiles, temporaryDirectory, connectionSecrets);
      return { directory: temporaryDirectory, relativeFiles };
    } catch (error) {
      await removeTemporaryDirectory(temporaryDirectory);
      throw error;
    }
  }

  public async findCollisions(
    staged: StagedGeneration,
    outputFolder: string,
  ): Promise<CollisionSnapshot[]> {
    const collisions: CollisionSnapshot[] = [];
    const resolvedOutputFolder = await assertUnchangedOutputRoot(outputFolder);
    for (const relativeFile of staged.relativeFiles) {
      const destination = safeDestination(resolvedOutputFolder, relativeFile);
      try {
        const status = await lstat(destination);
        assertSafeExistingFile(status);
        collisions.push({
          relativeFile,
          sha256: await fingerprintSafeExistingFile(destination),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    return collisions;
  }

  public async commit(
    staged: StagedGeneration,
    outputFolder: string,
    confirmedCollisions: ReadonlyMap<string, string>,
  ): Promise<string[]> {
    const resolvedOutputFolder = await assertUnchangedOutputRoot(outputFolder);

    for (const relativeFile of staged.relativeFiles) {
      await validateExistingDestination(
        resolvedOutputFolder,
        relativeFile,
        confirmedCollisions.has(relativeFile),
      );
    }

    const prepared: Array<{
      relativeFile: string;
      destination: string;
      temporary: string;
      backup?: string;
      preserveBackup?: boolean;
      existed: boolean;
      generatedSha256: string;
    }> = [];

    try {
      for (const relativeFile of staged.relativeFiles) {
        const source = path.join(staged.directory, relativeFile);
        const destination = await createSafeDestinationParent(
          resolvedOutputFolder,
          relativeFile,
        );
        let existed = false;
        try {
          const destinationStatus = await lstat(destination);
          assertSafeExistingFile(destinationStatus);
          existed = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const wasConfirmed = confirmedCollisions.has(relativeFile);
        if (existed !== wasConfirmed) {
          throw new SafeUserError(
            "Destination changed after overwrite confirmation; no files copied.",
          );
        }
        if (
          existed &&
          (await fingerprintSafeExistingFile(destination)) !==
            confirmedCollisions.get(relativeFile)
        ) {
          throw new SafeUserError(
            "Destination changed after overwrite confirmation; no files copied.",
          );
        }

        const temporary = path.join(
          path.dirname(destination),
          `.efcpt-${randomUUID()}.tmp`,
        );
        await copyFile(source, temporary, constants.COPYFILE_EXCL);
        const item: (typeof prepared)[number] = {
          relativeFile,
          destination,
          temporary,
          existed,
          generatedSha256: "",
        };
        prepared.push(item);
        item.generatedSha256 = await fingerprintSafeExistingFile(temporary);
        if (existed) {
          const backup = path.join(
            path.dirname(destination),
            `.efcpt-${randomUUID()}.backup`,
          );
          item.backup = backup;
          await copyFile(destination, backup, constants.COPYFILE_EXCL);
          if (
            (await fingerprintSafeExistingFile(backup)) !==
            confirmedCollisions.get(relativeFile)
          ) {
            throw new SafeUserError(
              "Destination changed after overwrite confirmation; no files copied.",
            );
          }
        }
      }
    } catch (error) {
      await cleanupPreparedFiles(prepared).catch(() => {
        this.output.appendLine(
          "Destination preparation failed, and temporary copy cleanup was incomplete.",
        );
      });
      throw error;
    }

    const committed: typeof prepared = [];
    try {
      for (const item of prepared) {
        if (item.existed) {
          if (
            (await fingerprintSafeExistingFile(item.destination)) !==
            confirmedCollisions.get(item.relativeFile)
          ) {
            throw new SafeUserError(
              "Destination changed after overwrite confirmation; no files copied.",
            );
          }
          await this.renameFile(item.temporary, item.destination);
          committed.push(item);
        } else {
          try {
            await copyFile(item.temporary, item.destination, constants.COPYFILE_EXCL);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
              await unlinkIfExists(item.destination);
            }
            throw error;
          }
          committed.push(item);
          await unlink(item.temporary);
        }
      }
    } catch (error) {
      let rollbackFailed = false;
      const recoveryBackups: string[] = [];
      for (const item of [...committed].reverse()) {
        try {
          if (
            (await fingerprintSafeExistingFile(item.destination)) !==
            item.generatedSha256
          ) {
            throw new SafeUserError(
              "A generated destination changed before rollback completed.",
            );
          }
          if (item.existed && item.backup) {
            await this.renameFile(item.backup, item.destination);
            item.backup = undefined;
          } else {
            await unlinkIfExists(item.destination);
          }
        } catch {
          rollbackFailed = true;
          if (item.backup) {
            item.preserveBackup = true;
            recoveryBackups.push(item.backup);
          }
        }
      }
      await cleanupPreparedFiles(prepared).catch(() => {
        rollbackFailed = true;
      });
      if (rollbackFailed) {
        const recoveryDetail = recoveryBackups.length > 0
          ? ` Recovery backup(s): ${recoveryBackups.join(", ")}`
          : "";
        throw new SafeUserError(
          `Generation commit failed and rollback was incomplete. Inspect the output before retrying.${recoveryDetail}`,
        );
      }
      throw error;
    }

    await cleanupPreparedFiles(prepared).catch(() => {
      this.output.appendLine(
        "Generated files were committed, but temporary destination backup cleanup was incomplete.",
      );
    });
    return prepared.map((item) => item.destination);
  }

  public async discard(staged: StagedGeneration): Promise<void> {
    await removeTemporaryDirectory(staged.directory);
  }
}

function markExcluded(
  entries: DatabaseObjectEntry[] | undefined,
  shouldExclude: (name: string) => boolean,
): DatabaseObjectEntry[] {
  return (entries ?? []).map((entry) => {
    if (typeof entry.name !== "string") {
      return { ...entry, exclude: true };
    }
    return { ...entry, exclude: shouldExclude(entry.name) };
  });
}

function createDiscoveryConfig(baseConfig?: EfcptConfig): EfcptConfig {
  const seed = structuredClone(baseConfig ?? {});
  seed["code-generation"] = {
    ...(seed["code-generation"] ?? {}),
    type: "dbcontext",
    "enable-on-configuring": false,
    "use-t4": false,
    "use-t4-split": false,
    "t4-template-path": null,
    "soft-delete-obsolete-files": false,
    "refresh-object-lists": true,
  };
  seed["file-layout"] = {
    "output-path": ".",
    "output-dbcontext-path": null,
  };
  removeSensitiveProperties(seed);
  return seed;
}

function mergeDiscoveredConfig(
  baseConfig: EfcptConfig | undefined,
  refreshedConfig: EfcptConfig,
  major?: EfCoreMajor,
): EfcptConfig {
  const merged = structuredClone(baseConfig ?? refreshedConfig);
  merged.tables = refreshedConfig.tables;
  merged.views = refreshedConfig.views;
  merged["stored-procedures"] = refreshedConfig["stored-procedures"];
  merged.functions = refreshedConfig.functions;
  if (!baseConfig) {
    merged["code-generation"] = {
      ...(merged["code-generation"] ?? {}),
      type: "all",
      "use-nullable-reference-types": false,
    };
    merged["file-layout"] = {
      "output-path": "Models",
      "output-dbcontext-path": null,
    };
    merged["type-mappings"] = {
      ...(isRecord(merged["type-mappings"]) ? merged["type-mappings"] : {}),
      "use-DateOnly-TimeOnly": major === 8,
    };
    merged.replacements = {
      ...(isRecord(merged.replacements) ? merged.replacements : {}),
      "preserve-casing-with-regex": true,
    };
  }
  return merged;
}

function wildcardMatches(name: string, wildcard: string): boolean {
  const starts = wildcard.startsWith("*");
  const ends = wildcard.endsWith("*");
  const filter = wildcard.slice(starts ? 1 : 0, ends ? -1 : undefined);
  if (starts && ends) return name.includes(filter);
  if (starts) return name.endsWith(filter);
  if (ends) return name.startsWith(filter);
  return false;
}

function convertWindowsConfig(legacy: Record<string, unknown>): EfcptConfig {
  const unsupported = [
    ["UseHandleBars", "Handlebars templates"],
    ["UseT4", "T4 templates"],
    ["UseT4Split", "split T4 templates"],
    ["UseNoDefaultConstructor", "removing the default DbContext constructor"],
    ["UseNoObjectFilter", "unfiltered object generation"],
    ["FilterSchemas", "schema filtering"],
    ["IncludeConnectionString", "embedding the connection string"],
  ]
    .filter(([key]) => legacy[key] === true)
    .map(([, description]) => description);
  if (unsupported.length > 0) {
    throw new SafeUserError(
      `${WINDOWS_CONFIG_FILE} uses unsupported compatibility option(s): ${unsupported.join(", ")}.`,
    );
  }

  const objects = Array.isArray(legacy.Tables)
    ? legacy.Tables.filter(isRecord)
    : [];
  const objectList = (objectType: number): DatabaseObjectEntry[] => [
    { exclusionWildcard: "*" },
    ...objects
      .filter((entry) => numberValue(entry.ObjectType, 0) === objectType)
      .filter((entry) => typeof entry.Name === "string" && entry.Name.length > 0)
      .map((entry) => ({
        name: entry.Name,
        exclude: false,
        ...(Array.isArray(entry.ExcludedColumns)
          ? { excludedColumns: entry.ExcludedColumns.filter((value) => typeof value === "string") }
          : {}),
        ...(Array.isArray(entry.ExcludedIndexes)
          ? { excludedIndexes: entry.ExcludedIndexes.filter((value) => typeof value === "string") }
          : {}),
        ...(entry.UseLegacyResultSetDiscovery === true
          ? { "use-legacy-resultset-discovery": true }
          : {}),
        ...(typeof entry.MappedType === "string" ? { "mapped-type": entry.MappedType } : {}),
        ...(entry.GenerateEmptyResultType === true ? { "generate-empty-result-type": true } : {}),
      })),
  ];

  const selectedType = numberValue(legacy.SelectedToBeGenerated, 0);
  if (selectedType !== 0) {
    throw new SafeUserError(
      `${WINDOWS_CONFIG_FILE} must generate both DbContext and entity types for this workflow.`,
    );
  }

  const replacements: Record<string, unknown> = {
    "preserve-casing-with-regex": booleanValue(legacy.PreserveCasingWithRegex, true),
  };
  copyStringArray(legacy.UncountableWords, replacements, "uncountable-words");
  copyLegacyPairs(legacy.IrregularWords, replacements, "irregular-words", [
    ["Singular", "singular"],
    ["Plural", "plural"],
    ["MatchEnding", "match-ending"],
  ]);
  copyLegacyPairs(legacy.PluralRules, replacements, "plural-rules", [
    ["Rule", "rule"],
    ["Replacement", "replacement"],
  ]);
  copyLegacyPairs(legacy.SingularRules, replacements, "singular-rules", [
    ["Rule", "rule"],
    ["Replacement", "replacement"],
  ]);

  return {
    "code-generation": {
      "enable-on-configuring": false,
      type: "all",
      "use-data-annotations": !booleanValue(legacy.UseFluentApiOnly, true),
      "use-database-names": booleanValue(legacy.UseDatabaseNames, false),
      "use-database-names-for-routines": booleanValue(
        legacy.UseDatabaseNamesForRoutines,
        true,
      ),
      "use-decimal-data-annotation-for-sproc-results": booleanValue(
        legacy.UseDecimalDataAnnotationForSprocResult,
        true,
      ),
      "use-inflector": booleanValue(legacy.UseInflector, true),
      "use-internal-access-modifiers-for-sprocs-and-functions": booleanValue(
        legacy.UseInternalAccessModifiersForSprocsAndFunctions,
        false,
      ),
      "use-legacy-inflector": booleanValue(legacy.UseLegacyPluralizer, false),
      "use-many-to-many-entity": booleanValue(legacy.UseManyToManyEntity, false),
      "use-no-navigations-preview": booleanValue(legacy.UseNoNavigations, false),
      "use-nullable-reference-types": booleanValue(legacy.UseNullableReferences, false),
      "use-prefix-navigation-naming": booleanValue(legacy.UsePrefixNavigationNaming, false),
      "remove-defaultsql-from-bool-properties": booleanValue(
        legacy.UseBoolPropertiesWithoutDefaultSql,
        false,
      ),
      "use-t4": false,
      "use-t4-split": false,
      "t4-template-path": null,
      "soft-delete-obsolete-files": false,
      "refresh-object-lists": false,
    },
    names: {
      "root-namespace": stringOrNull(legacy.ProjectRootNamespace),
      "dbcontext-name": stringOrNull(legacy.ContextClassName),
      "dbcontext-namespace": stringOrNull(legacy.ContextNamespace),
      "model-namespace": stringOrNull(legacy.ModelNamespace),
    },
    "file-layout": {
      "output-path": normalizeRelativeOutputPath(legacy.OutputPath, "Models"),
      "output-dbcontext-path": normalizeRelativeOutputPath(legacy.OutputContextPath, null),
      "split-dbcontext-preview": booleanValue(legacy.UseDbContextSplitting, false),
      "use-schema-folders-preview": booleanValue(legacy.UseSchemaFolders, false),
      "use-schema-namespaces-preview": booleanValue(legacy.UseSchemaNamespaces, false),
    },
    "type-mappings": {
      "use-DateOnly-TimeOnly": booleanValue(legacy.UseDateOnlyTimeOnly, false),
      "use-HierarchyId": booleanValue(legacy.UseHierarchyId, false),
      "use-NodaTime": booleanValue(legacy.UseNodaTime, false),
      "use-spatial": booleanValue(legacy.UseSpatial, false),
    },
    replacements,
    tables: objectList(0),
    views: objectList(3),
    "stored-procedures": objectList(1),
    functions: objectList(2),
  };
}

function validateCompatibleConfig(config: EfcptConfig): void {
  const codeGeneration = config["code-generation"] ?? {};
  if (
    codeGeneration["use-t4"] === true ||
    codeGeneration["use-t4-split"] === true ||
    codeGeneration["enable-on-configuring"] === true
  ) {
    throw new SafeUserError(
      `${EFCPT_CONFIG_FILE} enables templates or connection-string embedding, which this secure workflow cannot reproduce.`,
    );
  }
  if (typeof codeGeneration.type === "string" && codeGeneration.type.toLowerCase() !== "all") {
    throw new SafeUserError(
      `${EFCPT_CONFIG_FILE} must generate both DbContext and entity types for this workflow.`,
    );
  }

  const fileLayout = config["file-layout"] ?? {};
  fileLayout["output-path"] = normalizeRelativeOutputPath(
    fileLayout["output-path"],
    "Models",
  );
  fileLayout["output-dbcontext-path"] = normalizeRelativeOutputPath(
    fileLayout["output-dbcontext-path"],
    null,
  );
  config["file-layout"] = fileLayout;

  const names = config.names ?? {};
  const contextName = names["dbcontext-name"];
  if (typeof contextName === "string" && !isValidCSharpIdentifier(contextName)) {
    throw new SafeUserError("DbContext name in compatibility config is not a valid C# identifier.");
  }
  for (const key of ["root-namespace", "dbcontext-namespace", "model-namespace"] as const) {
    const value = names[key];
    if (typeof value === "string" && !isValidCSharpNamespace(value)) {
      throw new SafeUserError(`${key} in compatibility config is not a valid C# namespace.`);
    }
  }
}

function normalizeRelativeOutputPath(value: unknown, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new SafeUserError("Generated-code output path in compatibility config is invalid.");
  }
  const normalized = value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized) return "";
  if (
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new SafeUserError(
      "Compatibility config output paths must stay relative to the selected project root.",
    );
  }
  return normalized;
}

function parseConnectionString(value: string): Map<string, string> {
  const result = new Map<string, string>();
  let index = 0;
  while (index < value.length) {
    while (index < value.length && (value[index] === ";" || /\s/.test(value[index]))) {
      index += 1;
    }
    const keyStart = index;
    while (index < value.length && value[index] !== "=" && value[index] !== ";") {
      index += 1;
    }
    if (value[index] !== "=") {
      while (index < value.length && value[index] !== ";") index += 1;
      continue;
    }
    const key = value.slice(keyStart, index).trim().toLowerCase();
    index += 1;
    while (index < value.length && /\s/.test(value[index])) index += 1;

    let parsed = "";
    const delimiter = value[index];
    if (delimiter === '"' || delimiter === "'") {
      index += 1;
      while (index < value.length) {
        if (value[index] === delimiter) {
          if (value[index + 1] === delimiter) {
            parsed += delimiter;
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        parsed += value[index++];
      }
    } else if (delimiter === "{") {
      index += 1;
      while (index < value.length) {
        if (value[index] === "}") {
          if (value[index + 1] === "}") {
            parsed += "}";
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        parsed += value[index++];
      }
    } else {
      const valueStart = index;
      while (index < value.length && value[index] !== ";") index += 1;
      parsed = value.slice(valueStart, index).trim();
    }
    if (key) result.set(key, parsed);
    while (index < value.length && value[index] !== ";") index += 1;
  }
  return result;
}

function parseJsonObject(raw: string, fileName: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!isRecord(parsed)) {
    throw new SafeUserError(`${fileName} is not a JSON object.`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

export function legacyGenerationMajor(value: unknown): EfCoreMajor | undefined {
  const mapping: Record<number, EfCoreMajor> = { 2: 6, 3: 7, 4: 8, 5: 9, 6: 10 };
  return typeof value === "number" ? mapping[value] : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function copyStringArray(
  source: unknown,
  destination: Record<string, unknown>,
  key: string,
): void {
  if (Array.isArray(source)) {
    destination[key] = source.filter((value) => typeof value === "string");
  }
}

function copyLegacyPairs(
  source: unknown,
  destination: Record<string, unknown>,
  key: string,
  fields: ReadonlyArray<readonly [string, string]>,
): void {
  if (!Array.isArray(source)) return;
  destination[key] = source.filter(isRecord).map((entry) =>
    Object.fromEntries(
      fields
        .filter(([legacyKey]) => entry[legacyKey] !== undefined)
        .map(([legacyKey, cliKey]) => [cliKey, entry[legacyKey]]),
    ),
  );
}

async function bindRenamingConfig(
  config: EfcptConfig,
  renamingPath: string | undefined,
  allowChangedHash = false,
  content?: Buffer,
): Promise<void> {
  const metadata = isRecord(config[EXTENSION_CONFIG_KEY])
    ? config[EXTENSION_CONFIG_KEY]
    : {};
  const expectedHash = metadata["renaming-sha256"];
  const sourceName =
    typeof metadata["renaming-source"] === "string"
      ? validateMetadataFileName(metadata["renaming-source"], "renaming")
      : RENAMING_CONFIG_FILE;
  if (!renamingPath) {
    if (typeof expectedHash === "string") {
      throw new SafeUserError(
        `${sourceName} was used previously but is now missing. Run Reverse Engineer Database again after restoring it.`,
      );
    }
    return;
  }
  if (!(await isRegularFile(renamingPath))) {
    throw new SafeUserError(`${RENAMING_CONFIG_FILE} is no longer available.`);
  }
  const actualHash = sha256(content ?? (await readRegularFileBuffer(renamingPath)));
  if (
    typeof expectedHash === "string" &&
    expectedHash !== actualHash &&
    !allowChangedHash
  ) {
    throw new SafeUserError(
      `${sourceName} changed since the profile was created. Run Reverse Engineer Database to review the new output.`,
    );
  }
  config[EXTENSION_CONFIG_KEY] = {
    ...metadata,
    "renaming-source": path.basename(renamingPath),
    "renaming-sha256": actualHash,
  };
}

async function verifyLegacyConfig(config: EfcptConfig, outputFolder: string): Promise<void> {
  const metadata = isRecord(config[EXTENSION_CONFIG_KEY])
    ? config[EXTENSION_CONFIG_KEY]
    : undefined;
  const expectedHash = metadata?.["legacy-config-sha256"];
  const sourceName = metadata?.["legacy-source"];
  if (typeof expectedHash !== "string" || typeof sourceName !== "string") return;
  const safeSourceName = validateMetadataFileName(sourceName, "config");

  const legacyPath = await findRegularFileUnlessIgnored(
    path.join(outputFolder, safeSourceName),
  );
  if (!legacyPath) {
    throw new SafeUserError(
      `${safeSourceName} was the compatibility source but is now missing or ignored.`,
    );
  }
  const actualHash = sha256(await readRegularFileBuffer(legacyPath));
  if (actualHash !== expectedHash) {
    throw new SafeUserError(
      `${safeSourceName} changed since this profile was created. Run Reverse Engineer Database to review and translate it again.`,
    );
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateMetadataFileName(
  value: string,
  kind: "config" | "renaming",
): string {
  const suffix = kind === "config" ? "config" : "renaming";
  const pattern = new RegExp(`^efpt(?:\\.[^/\\\\]+)*\\.${suffix}\\.json$`, "i");
  if (path.basename(value) !== value || !pattern.test(value)) {
    throw new SafeUserError(`Invalid ${kind} source name in ${EFCPT_CONFIG_FILE}.`);
  }
  return value;
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const status = await lstat(filePath);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink > 1) {
      throw new SafeUserError(`Refused unsafe configuration file: ${path.basename(filePath)}.`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readRegularFileBuffer(filePath: string): Promise<Buffer> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const status = await handle.stat();
    if (!status.isFile() || status.nlink > 1) {
      throw new SafeUserError(`Refused unsafe configuration file: ${path.basename(filePath)}.`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function findRegularFile(filePath: string): Promise<string | undefined> {
  return (await isRegularFile(filePath)) ? filePath : undefined;
}

async function findRegularFileUnlessIgnored(filePath: string): Promise<string | undefined> {
  try {
    await lstat(`${filePath}.ignore`);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const ignoredName = `${path.basename(filePath)}.ignore`.toLowerCase();
  if (
    (await readdir(path.dirname(filePath), { withFileTypes: true })).some(
      (entry) => entry.name.toLowerCase() === ignoredName,
    )
  ) {
    return undefined;
  }
  return findRegularFile(filePath);
}

async function findWindowsConfig(projectFolder: string): Promise<string | undefined> {
  const names = (await readdir(projectFolder, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.toLowerCase() === WINDOWS_CONFIG_FILE ||
          /^efpt\..+\.config\.json$/i.test(entry.name)),
    )
    .map((entry) => entry.name);
  const candidates: string[] = [];
  for (const name of names) {
    const candidate = await findRegularFileUnlessIgnored(path.join(projectFolder, name));
    if (candidate) candidates.push(candidate);
  }
  if (candidates.length > 1) {
    throw new SafeUserError(
      `Multiple Windows Power Tools configs were found: ${candidates
        .map((candidate) => path.basename(candidate))
        .join(", ")}. Keep or un-ignore one before generating.`,
    );
  }
  return candidates[0];
}

async function findRegularSiblingCaseInsensitive(
  directory: string,
  fileName: string,
): Promise<string | undefined> {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.name.toLowerCase() === fileName.toLowerCase())
    .map((entry) => entry.name);
  if (names.length > 1) {
    throw new SafeUserError(`Multiple case variants of ${fileName} were found.`);
  }
  return names[0] ? findRegularFile(path.join(directory, names[0])) : undefined;
}

function renamingNameForWindowsConfig(configPath: string): string {
  return path.basename(configPath).replace(/\.config\.json$/i, ".renaming.json");
}

async function findRenamingForWindowsConfig(
  configPath: string,
): Promise<string | undefined> {
  const directory = path.dirname(configPath);
  const specificName = renamingNameForWindowsConfig(configPath);
  const specificPath = await findRegularSiblingCaseInsensitive(directory, specificName);
  if (specificPath) {
    return findRegularFileUnlessIgnored(specificPath);
  }
  if (specificName.toLowerCase() === RENAMING_CONFIG_FILE) return undefined;
  const defaultPath = await findRegularSiblingCaseInsensitive(directory, RENAMING_CONFIG_FILE);
  return defaultPath ? findRegularFileUnlessIgnored(defaultPath) : undefined;
}

function removeSensitiveProperties(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      removeSensitiveProperties(item);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (/connection(?:-?string)?|password|\bpwd\b|user-?id/i.test(key)) {
      delete record[key];
      continue;
    }
    removeSensitiveProperties(record[key]);
  }
}

async function readConfig(configPath: string): Promise<EfcptConfig> {
  const raw = (await readRegularFileBuffer(configPath)).toString("utf8");
  return parseConfigJson(raw);
}

export function parseConfigJson(raw: string): EfcptConfig {
  const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SafeUserError(`${EFCPT_CONFIG_FILE} is not a JSON object.`);
  }
  return parsed as EfcptConfig;
}

async function createTemporaryDirectory(): Promise<string> {
  const systemTemporaryDirectory = await realpath(os.tmpdir());
  const temporaryDirectory = await mkdtemp(path.join(systemTemporaryDirectory, TEMP_PREFIX));
  const resolvedTemporaryDirectory = await realpath(temporaryDirectory);
  assertPathInside(systemTemporaryDirectory, resolvedTemporaryDirectory);
  return resolvedTemporaryDirectory;
}

async function removeTemporaryDirectory(temporaryDirectory: string): Promise<void> {
  let resolvedTemporaryDirectory: string;
  try {
    resolvedTemporaryDirectory = await realpath(temporaryDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const systemTemporaryDirectory = await realpath(os.tmpdir());
  assertPathInside(systemTemporaryDirectory, resolvedTemporaryDirectory);
  if (!path.basename(resolvedTemporaryDirectory).startsWith(TEMP_PREFIX)) {
    throw new SafeUserError("Refused to clean an unrecognized temporary directory.");
  }
  await rm(resolvedTemporaryDirectory, { recursive: true, force: true });
}

async function collectGeneratedFiles(root: string, relativeDirectory = ""): Promise<string[]> {
  const current = path.join(root, relativeDirectory);
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new SafeUserError("Helper generated an unexpected symbolic link; no files were copied.");
    }
    if (entry.isDirectory()) {
      files.push(...(await collectGeneratedFiles(root, relativePath)));
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith(".cs") || relativePath === EFCPT_CONFIG_FILE)) {
      files.push(relativePath);
    }
  }

  return files.sort();
}

async function assertFilesDoNotContain(
  relativeFiles: readonly string[],
  root: string,
  secrets: readonly string[],
): Promise<void> {
  if (secrets.length === 0) {
    return;
  }
  for (const relativeFile of relativeFiles) {
    const content = await readFile(path.join(root, relativeFile), "utf8");
    if (
      secrets.some(
        (secret) =>
          (secret.includes("=") || secret.includes("://") || secret.length >= 8) &&
          content.includes(secret),
      ) ||
      /\b(?:certificate\s*password|password|pwd)\s*=\s*(?:"[^"]*"|'[^']*'|[^;\r\n]*)/i.test(content) ||
      /\bmysqlx?(?:\+[a-z0-9._-]+)?:\/\/[^\s]+/i.test(content)
    ) {
      throw new SafeUserError(
        "Generated output contained the connection string. No files were copied; open output for details.",
      );
    }
  }
}

function safeDestination(outputFolder: string, relativeFile: string): string {
  const destination = path.resolve(outputFolder, relativeFile);
  assertPathInside(path.resolve(outputFolder), destination);
  return destination;
}

async function cleanupPreparedFiles(
  items: ReadonlyArray<{
    temporary: string;
    backup?: string;
    preserveBackup?: boolean;
  }>,
): Promise<void> {
  for (const item of items) {
    await unlinkIfExists(item.temporary);
    if (item.backup && !item.preserveBackup) await unlinkIfExists(item.backup);
  }
}

async function fingerprintSafeExistingFile(filePath: string): Promise<string> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const status = await handle.stat();
    assertSafeExistingFile(status);
    return sha256(await handle.readFile());
  } finally {
    await handle.close();
  }
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertUnchangedOutputRoot(outputFolder: string): Promise<string> {
  const expectedOutputFolder = path.resolve(outputFolder);
  const resolvedOutputFolder = await realpath(expectedOutputFolder);
  if (resolvedOutputFolder !== expectedOutputFolder) {
    throw new SafeUserError("Output folder changed after confirmation. Select it again and retry.");
  }
  return resolvedOutputFolder;
}

async function validateExistingDestination(
  outputFolder: string,
  relativeFile: string,
  collisionConfirmed: boolean,
): Promise<void> {
  const destination = safeDestination(outputFolder, relativeFile);
  const relativeParent = path.relative(outputFolder, path.dirname(destination));
  let current = outputFolder;

  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    const next = path.join(current, segment);
    try {
      const status = await lstat(next);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new SafeUserError("Refused unsafe destination path component.");
      }
      current = next;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw error;
    }
  }

  try {
    const status = await lstat(destination);
    assertSafeExistingFile(status);
    if (!collisionConfirmed) {
      throw new SafeUserError("Destination changed after overwrite confirmation; no files copied.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function createSafeDestinationParent(
  outputFolder: string,
  relativeFile: string,
): Promise<string> {
  const destination = safeDestination(outputFolder, relativeFile);
  const relativeParent = path.relative(outputFolder, path.dirname(destination));
  let current = outputFolder;

  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    const next = path.join(current, segment);
    try {
      await mkdir(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const status = await lstat(next);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new SafeUserError("Refused unsafe destination path component.");
    }
    const resolved = await realpath(next);
    assertPathInside(outputFolder, resolved);
    current = next;
  }

  return path.join(current, path.basename(destination));
}

function assertSafeExistingFile(status: Awaited<ReturnType<typeof lstat>>): void {
  if (status.isSymbolicLink() || !status.isFile() || status.nlink > 1) {
    throw new SafeUserError("Refused unsafe existing destination file.");
  }
}

function assertSuccessful(result: ProcessRunResult): void {
  if (result.cancelled) {
    throw new UserCancelledError();
  }
  if (result.hasErrorMarker) {
    throw new SafeUserError("Helper reported a generation error. Open output for details.");
  }
  if (result.code !== 0) {
    throw new SafeUserError(`${safeProcessFailureMessage(result)} Open output for details.`);
  }
}
