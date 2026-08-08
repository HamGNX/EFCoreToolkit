import assert from "node:assert/strict";
import test from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  ConfigService,
  configuredGenerationMajor,
  configuredHelperVersion,
  createSelectedConfig,
  legacyGenerationMajor,
  parseConfigJson,
  prepareRegenerationConfig,
  selectedObjectNames,
  suggestDbContextName,
  validateConfigForMajor,
  type EfcptConfig,
} from "../../services/configService";
import {
  ProcessRunner,
  type ProcessRunOptions,
  type ProcessRunResult,
} from "../../services/processRunner";

const discovered: EfcptConfig = {
  connectionString: "Server=localhost;Password=secret;",
  tables: [{ name: "`orders`.`customers`" }, { name: "`orders`.`invoices`" }],
  views: [{ name: "`orders`.`open_invoices`" }],
  "code-generation": {
    "enable-on-configuring": true,
    "soft-delete-obsolete-files": true,
    "refresh-object-lists": true,
    "use-t4": true,
    "use-t4-split": true,
    "t4-template-path": "/outside/templates",
  },
  names: {},
  "file-layout": { "output-path": "Models" },
};

test("creates secret-free selected-table config", () => {
  const config = createSelectedConfig(
    discovered,
    new Set(["`orders`.`customers`"]),
    new Set(["`orders`.`open_invoices`"]),
    "OrdersContext",
    "Company.Orders",
  );

  assert.equal(JSON.stringify(config).includes("Password=secret"), false);
  assert.deepEqual(config.tables, [
    { name: "`orders`.`customers`", exclude: false },
    { name: "`orders`.`invoices`", exclude: true },
  ]);
  assert.deepEqual(config.views, [{ name: "`orders`.`open_invoices`", exclude: false }]);
  assert.equal(config["code-generation"]?.["enable-on-configuring"], false);
  assert.equal(config["code-generation"]?.["soft-delete-obsolete-files"], false);
  assert.equal(config["code-generation"]?.["refresh-object-lists"], false);
  assert.equal(config["code-generation"]?.["use-t4"], false);
  assert.equal(config["code-generation"]?.["use-t4-split"], false);
  assert.equal(config["code-generation"]?.["t4-template-path"], null);
  assert.equal(config.names?.["dbcontext-name"], "OrdersContext");
  assert.equal(config["file-layout"]?.["output-path"], "Models");
});

test("forces safe regeneration settings", () => {
  const config = prepareRegenerationConfig(discovered);

  assert.equal(config["code-generation"]?.["enable-on-configuring"], false);
  assert.equal(config["code-generation"]?.["soft-delete-obsolete-files"], false);
  assert.equal(config["code-generation"]?.["use-t4"], false);
  assert.equal(config["code-generation"]?.["use-t4-split"], false);
  assert.equal(config["code-generation"]?.["t4-template-path"], null);
  assert.equal(config["file-layout"]?.["output-path"], "Models");
});

test("derives Windows-style DbContext name without parsing fields inside a quoted password", () => {
  assert.equal(
    suggestDbContextName(
      'Server=localhost;Password="safe;Database=wrong";Database=orders_db;User Id=app;',
    ),
    "orders_dbContext",
  );
});

test("reads effective selected objects with an upstream exclusion wildcard", () => {
  assert.deepEqual(
    [...selectedObjectNames([
      { exclusionWildcard: "*" },
      { name: "customers", exclude: false },
      { name: "invoices" },
    ])],
    ["customers"],
  );
});

test("rejects Windows options silently ignored by legacy helpers", () => {
  assert.throws(
    () =>
      validateConfigForMajor(
        { replacements: { "irregular-words": [{ singular: "person", plural: "people" }] } },
        6,
      ),
    /cannot apply irregular-words/,
  );
  assert.throws(
    () =>
      validateConfigForMajor(
        { tables: [{ name: "orders", excludedIndexes: ["IX_orders"] }] },
        7,
      ),
    /cannot apply excluded indexes/,
  );
});

test("maps persisted Windows generation modes to EF Core majors", () => {
  assert.deepEqual(
    [2, 3, 4, 5, 6].map(legacyGenerationMajor),
    [6, 7, 8, 9, 10],
  );
  assert.equal(legacyGenerationMajor(1), undefined);
});

test("reads the EF Core major bound into generated config metadata", () => {
  assert.equal(
    configuredGenerationMajor({
      "x-efcore-power-tools-vscode": { "ef-core-major": 9 },
    }),
    9,
  );
  assert.equal(configuredGenerationMajor({}), undefined);
  assert.equal(
    configuredHelperVersion({
      "x-efcore-power-tools-vscode": { "helper-version": "9.1.1386" },
    }),
    "9.1.1386",
  );
});

test("translates standard Windows Power Tools settings for CLI-compatible generation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "efcpt-windows-config-test-"));
  await writeFile(
    path.join(root, "efpt.config.json"),
    JSON.stringify({
      CodeGenerationMode: 4,
      ContextClassName: "OrdersContext",
      ProjectRootNamespace: "Company.Orders",
      OutputPath: "Generated\\Models",
      OutputContextPath: null,
      Tables: [
        { Name: "customers", ObjectType: 0, ExcludedColumns: ["InternalCode"] },
        { Name: "open_invoices", ObjectType: 3 },
      ],
      UseFluentApiOnly: true,
      UseInflector: true,
      UseNullableReferences: false,
      SelectedToBeGenerated: 0,
    }),
  );
  await writeFile(path.join(root, "efpt.renaming.json"), "[]\n");

  const service = new ConfigService(new ProcessRunner(), { appendLine: () => undefined });
  const loaded = await service.loadProjectGenerationConfig(root);

  assert.equal(loaded?.source, "windows");
  assert.equal(loaded?.efCoreMajor, 8);
  assert.equal(loaded?.config["file-layout"]?.["output-path"], "Generated/Models");
  assert.equal(
    loaded?.config["code-generation"]?.["use-nullable-reference-types"],
    false,
  );
  assert.deepEqual([...selectedObjectNames(loaded?.config.tables)], ["customers"]);
  assert.deepEqual([...selectedObjectNames(loaded?.config.views)], ["open_invoices"]);
  assert.equal(path.basename(loaded?.renamingPath ?? ""), "efpt.renaming.json");
  await writeFile(path.join(root, "efpt.renaming.json"), "[{}]\n");
  await assert.rejects(
    () => service.verifyRenamingConfig(loaded!.config, loaded!.renamingPath),
    /changed since the profile was created/,
  );
  await rm(root, { recursive: true, force: true });
});

test("rejects Windows config output that would escape staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "efcpt-windows-path-test-"));
  await writeFile(
    path.join(root, "efpt.config.json"),
    JSON.stringify({
      OutputPath: "..\\Shared",
      SelectedToBeGenerated: 0,
      Tables: [{ Name: "customers", ObjectType: 0 }],
    }),
  );

  const service = new ConfigService(new ProcessRunner(), { appendLine: () => undefined });
  await assert.rejects(
    () => service.loadProjectGenerationConfig(root),
    /must stay relative to the selected project root/,
  );
  await rm(root, { recursive: true, force: true });
});

test("rejects reserved C# names in compatibility config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "efcpt-invalid-name-test-"));
  await writeFile(
    path.join(root, "efcpt-config.json"),
    JSON.stringify({
      names: { "dbcontext-name": "class", "root-namespace": "Company.namespace" },
      "code-generation": { type: "all", "enable-on-configuring": false },
    }),
  );
  const service = new ConfigService(new ProcessRunner(), { appendLine: () => undefined });

  await assert.rejects(
    () => service.loadProjectGenerationConfig(root),
    /not a valid C# identifier/,
  );
  await rm(root, { recursive: true, force: true });
});

test("preserves explicit project-root Windows output while defaulting a missing path to Models", async () => {
  const rootOutput = await mkdtemp(path.join(os.tmpdir(), "efcpt-root-layout-test-"));
  const defaultOutput = await mkdtemp(path.join(os.tmpdir(), "efcpt-default-layout-test-"));
  const base = { SelectedToBeGenerated: 0, Tables: [{ Name: "customers", ObjectType: 0 }] };
  await writeFile(
    path.join(rootOutput, "efpt.config.json"),
    JSON.stringify({ ...base, OutputPath: null }),
  );
  await writeFile(path.join(defaultOutput, "efpt.config.json"), JSON.stringify(base));

  const service = new ConfigService(new ProcessRunner(), { appendLine: () => undefined });
  assert.equal(
    (await service.loadProjectGenerationConfig(rootOutput))?.config["file-layout"]?.[
      "output-path"
    ],
    null,
  );
  assert.equal(
    (await service.loadProjectGenerationConfig(defaultOutput))?.config["file-layout"]?.[
      "output-path"
    ],
    "Models",
  );
  await Promise.all([
    rm(rootOutput, { recursive: true, force: true }),
    rm(defaultOutput, { recursive: true, force: true }),
  ]);
});

test("keeps Windows config as source of truth after writing translated CLI config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "efcpt-legacy-source-test-"));
  const windowsPath = path.join(root, "efpt.config.json");
  const first = {
    ContextClassName: "OrdersContext",
    SelectedToBeGenerated: 0,
    Tables: [{ Name: "customers", ObjectType: 0 }],
  };
  await writeFile(windowsPath, JSON.stringify(first));
  const service = new ConfigService(new ProcessRunner(), { appendLine: () => undefined });
  const translated = await service.loadProjectGenerationConfig(root);
  await writeFile(
    path.join(root, "efcpt-config.json"),
    JSON.stringify(translated!.config),
  );
  await writeFile(
    windowsPath,
    JSON.stringify({ ...first, ContextClassName: "UpdatedOrdersContext" }),
  );

  await assert.rejects(
    () => service.readOutputConfig(root),
    /changed since this profile was created/,
  );
  const reloaded = await service.loadProjectGenerationConfig(root);
  assert.equal(reloaded?.source, "windows");
  assert.equal(reloaded?.config.names?.["dbcontext-name"], "UpdatedOrdersContext");
  await rm(root, { recursive: true, force: true });
});

test("loads one context-named Windows config and its matching renamer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "efcpt-named-config-test-"));
  await writeFile(
    path.join(root, "efpt.orders.config.json"),
    JSON.stringify({
      ContextClassName: "OrdersContext",
      SelectedToBeGenerated: 0,
      Tables: [{ Name: "customers", ObjectType: 0 }],
    }),
  );
  await writeFile(path.join(root, "efpt.orders.renaming.json"), "[]\n");
  const service = new ConfigService(new ProcessRunner(), { appendLine: () => undefined });
  const loaded = await service.loadProjectGenerationConfig(root);

  assert.equal(loaded?.source, "windows");
  assert.equal(path.basename(loaded?.renamingPath ?? ""), "efpt.orders.renaming.json");
  await rm(root, { recursive: true, force: true });
});

test("finds the standard Windows config case-insensitively", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "efcpt-uppercase-config-test-"));
  await writeFile(
    path.join(root, "EFPT.CONFIG.JSON"),
    JSON.stringify({
      ContextClassName: "OrdersContext",
      SelectedToBeGenerated: 0,
      Tables: [{ Name: "customers", ObjectType: 0 }],
    }),
  );
  await writeFile(path.join(root, "efpt.renaming.json"), "[]\n");
  const service = new ConfigService(new ProcessRunner(), { appendLine: () => undefined });

  const loaded = await service.loadProjectGenerationConfig(root);

  assert.equal(loaded?.source, "windows");
  assert.equal(loaded?.config.names?.["dbcontext-name"], "OrdersContext");
  assert.equal(path.basename(loaded?.renamingPath ?? ""), "efpt.renaming.json");
  await rm(root, { recursive: true, force: true });
});

test("respects Windows ignore markers case-insensitively", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "efcpt-uppercase-ignore-test-"));
  await writeFile(path.join(root, "EFPT.CONFIG.JSON"), "{}\n");
  await writeFile(path.join(root, "efpt.config.json.ignore"), "\n");
  const service = new ConfigService(new ProcessRunner(), { appendLine: () => undefined });

  assert.equal(await service.loadProjectGenerationConfig(root), undefined);
  await rm(root, { recursive: true, force: true });
});

test("places renaming config beside input for legacy EF6/7 helpers", async () => {
  class LegacyRunner extends ProcessRunner {
    public args: readonly string[] = [];

    public override async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
      this.args = options.args;
      await access(path.join(options.cwd, "efpt.renaming.json"));
      await mkdir(path.join(options.cwd, "Models"));
      await writeFile(
        path.join(options.cwd, "Models", "OrdersContext.cs"),
        "public class OrdersContext {}\n",
      );
      return { code: 0, cancelled: false, stdout: [], stderr: [], hasErrorMarker: false };
    }
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "efcpt-legacy-renamer-test-"));
  const renamingPath = path.join(root, "efpt.renaming.json");
  await writeFile(renamingPath, "[]\n");
  const runner = new LegacyRunner();
  const service = new ConfigService(runner, { appendLine: () => undefined });
  for (const major of [6, 7] as const) {
    const staged = await service.stage(
      "efcpt",
      "Server=localhost;Database=orders;Password=a;",
      {
        names: { "dbcontext-name": "OrdersContext" },
        "file-layout": { "output-path": "Models" },
        "code-generation": { "enable-on-configuring": false, type: "all" },
      },
      major,
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined }),
      },
      renamingPath,
    );

    assert.equal(runner.args.includes("-r"), false);
    await service.discard(staged);
  }
  await rm(root, { recursive: true, force: true });
});

test("passes a verified staged renamer to modern helpers", async () => {
  class ModernRunner extends ProcessRunner {
    public renamingPath: string | undefined;

    public override async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
      const index = options.args.indexOf("-r");
      this.renamingPath = index >= 0 ? options.args[index + 1] : undefined;
      assert.equal(path.dirname(this.renamingPath ?? ""), options.cwd);
      await access(this.renamingPath!);
      await mkdir(path.join(options.cwd, "Models"));
      await writeFile(
        path.join(options.cwd, "Models", "OrdersContext.cs"),
        "public class OrdersContext {}\n",
      );
      return { code: 0, cancelled: false, stdout: [], stderr: [], hasErrorMarker: false };
    }
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "efcpt-modern-renamer-test-"));
  const renamingPath = path.join(root, "efpt.renaming.json");
  await writeFile(renamingPath, "[]\n");
  const runner = new ModernRunner();
  const service = new ConfigService(runner, { appendLine: () => undefined });
  const staged = await service.stage(
    "efcpt",
    "Server=localhost;Database=orders;Password=a;",
    {
      names: { "dbcontext-name": "OrdersContext" },
      "file-layout": { "output-path": "Models" },
      "code-generation": { "enable-on-configuring": false, type: "all" },
    },
    8,
    {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    },
    renamingPath,
  );

  assert.ok(runner.renamingPath?.startsWith(staged.directory));
  const stagedConfig = parseConfigJson(
    await readFile(path.join(staged.directory, "efcpt-config.json"), "utf8"),
  );
  assert.equal(configuredGenerationMajor(stagedConfig), 8);
  assert.equal(configuredHelperVersion(stagedConfig), "8.1.1386");
  await service.discard(staged);
  await rm(root, { recursive: true, force: true });
});

test("regeneration does not silently adopt a newly added renamer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "efcpt-untracked-renamer-test-"));
  await writeFile(path.join(root, "efpt.renaming.json"), "[]\n");
  const service = new ConfigService(new ProcessRunner(), { appendLine: () => undefined });

  assert.equal(await service.findRenamingConfig(root, {}), undefined);
  assert.equal(
    path.basename((await service.findRenamingConfig(root, {}, true)) ?? ""),
    "efpt.renaming.json",
  );
  await rm(root, { recursive: true, force: true });
});

test("rejects traversal in compatibility-source metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "efcpt-metadata-path-test-"));
  await writeFile(
    path.join(root, "efcpt-config.json"),
    JSON.stringify({
      "code-generation": { type: "all", "enable-on-configuring": false },
      "x-efcore-power-tools-vscode": {
        "legacy-source": "../efpt.config.json",
        "legacy-config-sha256": "not-used",
      },
    }),
  );
  const service = new ConfigService(new ProcessRunner(), { appendLine: () => undefined });

  await assert.rejects(() => service.readOutputConfig(root), /Invalid config source name/);
  await rm(root, { recursive: true, force: true });
});

test("does not treat stale configured tables as successful discovery", async () => {
  class FailedDiscoveryRunner extends ProcessRunner {
    public override async run(): Promise<ProcessRunResult> {
      return { code: 0, cancelled: false, stdout: [], stderr: [], hasErrorMarker: true };
    }
  }

  const service = new ConfigService(new FailedDiscoveryRunner(), {
    appendLine: () => undefined,
  });
  await assert.rejects(
    () =>
      service.discoverTables(
        "efcpt",
        "Server=localhost;Database=orders;",
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose: () => undefined }),
        },
        { tables: [{ name: "stale_table" }] },
        8,
      ),
    /reported a generation error/,
  );
});

test("parses upstream UTF-8 BOM config", () => {
  assert.deepEqual(parseConfigJson("\uFEFF{\"tables\":[{\"name\":\"orders\"}]}"), {
    tables: [{ name: "orders" }],
  });
});

test("refuses destination directories that escape through a symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "efcpt-config-test-"));
  const staging = path.join(root, "staging");
  const output = path.join(root, "output");
  const outside = path.join(root, "outside");
  await Promise.all([mkdir(path.join(staging, "linked", "new"), { recursive: true }), mkdir(output), mkdir(outside)]);
  await writeFile(path.join(staging, "linked", "new", "Entity.cs"), "public class Entity {}\n");
  await symlink(outside, path.join(output, "linked"));

  const service = new ConfigService(new ProcessRunner(), { appendLine: () => undefined });
  const canonicalOutput = await realpath(output);
  await assert.rejects(
    () => service.commit(
      { directory: staging, relativeFiles: ["linked/new/Entity.cs"] },
      canonicalOutput,
      new Map(),
    ),
    /unsafe destination path component/,
  );
  await assert.rejects(() => access(path.join(outside, "new")), { code: "ENOENT" });
  await rm(root, { recursive: true, force: true });
});

test("refuses to overwrite a file changed after collision confirmation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "efcpt-collision-hash-test-"));
  try {
    const staging = path.join(root, "staging");
    const output = path.join(root, "output");
    await Promise.all([mkdir(staging), mkdir(output)]);
    await writeFile(path.join(staging, "Entity.cs"), "new generated content\n");
    await writeFile(path.join(output, "Entity.cs"), "old generated content\n");

    const service = new ConfigService(new ProcessRunner(), { appendLine: () => undefined });
    const staged = { directory: staging, relativeFiles: ["Entity.cs"] };
    const canonicalOutput = await realpath(output);
    const collisions = await service.findCollisions(staged, canonicalOutput);
    await writeFile(path.join(output, "Entity.cs"), "edited after confirmation\n");

    await assert.rejects(
      () =>
        service.commit(
          staged,
          canonicalOutput,
          new Map(collisions.map((collision) => [collision.relativeFile, collision.sha256])),
        ),
      /changed after overwrite confirmation/,
    );
    assert.equal(
      await readFile(path.join(output, "Entity.cs"), "utf8"),
      "edited after confirmation\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves and reports a backup when rollback cannot restore it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "efcpt-rollback-backup-test-"));
  try {
    const staging = path.join(root, "staging");
    const output = path.join(root, "output");
    await Promise.all([mkdir(staging), mkdir(output)]);
    await Promise.all([
      writeFile(path.join(staging, "A.cs"), "new-a\n"),
      writeFile(path.join(staging, "B.cs"), "new-b\n"),
      writeFile(path.join(output, "A.cs"), "old-a\n"),
      writeFile(path.join(output, "B.cs"), "old-b\n"),
    ]);

    let renameCalls = 0;
    const renameWithFailures = async (oldPath: string, newPath: string): Promise<void> => {
      renameCalls += 1;
      if (renameCalls === 1) {
        await rename(oldPath, newPath);
        return;
      }
      throw new Error("simulated rename failure");
    };
    const service = new ConfigService(
      new ProcessRunner(),
      { appendLine: () => undefined },
      renameWithFailures,
    );
    const staged = { directory: staging, relativeFiles: ["A.cs", "B.cs"] };
    const canonicalOutput = await realpath(output);
    const collisions = await service.findCollisions(staged, canonicalOutput);

    await assert.rejects(
      () =>
        service.commit(
          staged,
          canonicalOutput,
          new Map(collisions.map((collision) => [collision.relativeFile, collision.sha256])),
        ),
      /rollback was incomplete.*Recovery backup\(s\):/,
    );

    const recoveryFiles = (await readdir(output)).filter((name) => name.endsWith(".backup"));
    assert.equal(recoveryFiles.length, 1);
    assert.equal(await readFile(path.join(output, recoveryFiles[0]), "utf8"), "old-a\n");
    assert.equal(await readFile(path.join(output, "A.cs"), "utf8"), "new-a\n");
    assert.equal(await readFile(path.join(output, "B.cs"), "utf8"), "old-b\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback preserves an edit made after a generated file was committed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "efcpt-rollback-edit-test-"));
  try {
    const staging = path.join(root, "staging");
    const output = path.join(root, "output");
    await Promise.all([mkdir(staging), mkdir(output)]);
    await Promise.all([
      writeFile(path.join(staging, "A.cs"), "new-a\n"),
      writeFile(path.join(staging, "B.cs"), "new-b\n"),
      writeFile(path.join(output, "A.cs"), "old-a\n"),
      writeFile(path.join(output, "B.cs"), "old-b\n"),
    ]);

    let renameCalls = 0;
    const renameWithConcurrentEdit = async (
      oldPath: string,
      newPath: string,
    ): Promise<void> => {
      renameCalls += 1;
      if (renameCalls === 1) {
        await rename(oldPath, newPath);
        await writeFile(newPath, "concurrent-edit\n");
        return;
      }
      throw new Error("simulated later commit failure");
    };
    const service = new ConfigService(
      new ProcessRunner(),
      { appendLine: () => undefined },
      renameWithConcurrentEdit,
    );
    const staged = { directory: staging, relativeFiles: ["A.cs", "B.cs"] };
    const canonicalOutput = await realpath(output);
    const collisions = await service.findCollisions(staged, canonicalOutput);

    await assert.rejects(
      () =>
        service.commit(
          staged,
          canonicalOutput,
          new Map(collisions.map((collision) => [collision.relativeFile, collision.sha256])),
        ),
      /rollback was incomplete.*Recovery backup\(s\):/,
    );
    assert.equal(await readFile(path.join(output, "A.cs"), "utf8"), "concurrent-edit\n");
    const recoveryFiles = (await readdir(output)).filter((name) => name.endsWith(".backup"));
    assert.equal(recoveryFiles.length, 1);
    assert.equal(await readFile(path.join(output, recoveryFiles[0]), "utf8"), "old-a\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
