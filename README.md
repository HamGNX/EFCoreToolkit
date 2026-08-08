# EF Core Power Tools for VS Code (Unofficial)

Native VS Code desktop workflow for reverse engineering MySQL databases into EF Core `DbContext` and entity classes on macOS. End users use VS Code commands and dialogs only; the extension runs `efcpt` as a hidden helper.

This project is independent and unofficial. It is not endorsed by ErikEJ and is not a fork of [EF Core Power Tools](https://github.com/ErikEJ/EFCorePowerTools).

## MVP features

- MySQL table/view discovery and multi-selection.
- EF Core 6, 7, 8, 9, and experimental EF Core 10 generation.
- Windows EF Core Power Tools-compatible `Models` layout, namespaces, and database-derived DbContext names.
- Reuse of project-root `efcpt-config.json`, or tracked translation of one project-root Windows config.
- `efpt*.renaming.json` support across EF Core 6–10 helper lines.
- Native VS Code Quick Pick, Input Box, progress, cancellation, notifications, and output.
- Secure workspace profiles using VS Code `SecretStorage`.
- Safe regeneration from saved profiles.
- Staged generation with exact overwrite confirmation.
- No telemetry, terminal workflow, shell commands, Webviews, or browser extension host.

## Requirements

- macOS with desktop VS Code. Other desktop platforms are not yet smoke-tested.
- Trusted, file-backed folder workspace containing a `.csproj`.
- A .NET SDK plus helper runtime:

  | Target EF Core | Helper version | Required runtime |
  | --- | --- | --- |
  | 6 | `6.1.463` | .NET 6 |
  | 7 | `7.1.343` | .NET 6 |
  | 8 | `8.1.1386` | .NET 8 |
  | 9 | `9.1.1386` | .NET 8 |
  | 10 | `10.1.1440-nightly` | .NET 10 |

EF Core 10 MySQL support is experimental because current stable upstream EF Core 10 CLI packages omit MySQL. Installation requires a separate confirmation naming the pinned nightly.

The extension performs a best-effort preflight from literal values in the project and `Directory.Packages.props`. When a supported version is genuinely absent, it asks for the EF Core major version; explicit unsupported or conflicting package majors are rejected. It does not add or update project NuGet packages. MSBuild property expressions, conditional items, and inherited `Directory.Build.props` values are not evaluated, so projects using them should provide an explicit valid `RootNamespace` in the `.csproj` or Power Tools config.

Every literal target framework in the selected project must be at least .NET 6 for EF Core 6/7, .NET 8 for EF Core 8/9, or .NET 10 for EF Core 10. Conflicting direct or centrally managed EF/MySQL package majors are rejected before generation. Conditional multi-target setups require a separate compatible project because this preflight does not evaluate their conditions.

It also detects `Pomelo.EntityFrameworkCore.MySql` (EF Core 6–9) and `Microting.EntityFrameworkCore.MySql` (EF Core 10), rejects a detected major/family mismatch, and asks before continuing when no direct provider reference is found.

## Use

Install the `.vsix` through **Extensions: Install from VSIX**, open a trusted .NET workspace, then run one of these commands:

- **EF Core Power Tools: Reverse Engineer Database**
- **EF Core Power Tools: Regenerate from Saved Profile**
- **EF Core Power Tools: Manage Connection Profiles**
- **EF Core Power Tools: Show Output**

On first use for each EF Core version, choose either **Install helper** or **Choose existing helper path**. Installation occurs only after confirmation and writes an exact helper version into extension storage. It never installs a global tool or changes `PATH`.

Reverse engineering asks for MySQL connection string, DbContext name, table/view selection, and optional profile storage. The output picker must resolve to the selected `.csproj` directory; other folders are rejected. With the default layout, generated code goes under `Models` and `efcpt-config.json` stays at project root.

Regeneration stages new output, lists every existing destination file, and requires confirmation before overwriting. It never deletes, renames, or soft-deletes obsolete generated files. Files no longer produced by the database therefore remain until reviewed and removed manually; Windows obsolete-file cleanup, when enabled there, is not reproduced.

Committed config records the EF Core major and exact pinned helper build. Regeneration stops after either changes and requires a reviewed **Reverse Engineer Database** run before rebinding the output.

## Windows compatibility

The official Windows runner and `efcpt` CLI both call the same upstream `ReverseEngineerRunner`. This extension therefore delegates code generation to the official CLI instead of reimplementing scaffolding.

For a new configuration, the extension explicitly matches the standard Windows reverse-engineering contract that affects generated C#: `Models` output, `<RootNamespace>.Models` inferred namespace, database-name-based DbContext name, fluent configuration, pluralization enabled, and nullable reference generation disabled. Safety-only differences do not change regenerated current files: connection strings are never embedded and obsolete files are never automatically deleted.

Configuration ownership is explicit:

1. A hand-authored `efcpt-config.json` without this extension's legacy-source marker wins and remains the cross-platform source of truth.
2. A translated `efcpt-config.json` carries its Windows source filename and SHA-256 hash. The referenced Windows config remains authoritative and is translated again on each Reverse Engineer run. Saved-profile regeneration stops if that source changed, requiring a reviewed Reverse Engineer run first.
3. Without `efcpt-config.json`, the extension imports one active project-root `efpt.config.json` or `efpt.<context>.config.json`. Its matching context renamer is preferred. Multiple active Windows configs are rejected; nested configs and multi-context generation are not supported.

EF Core 6 and 7 helpers have no `-r` option. The extension copies the chosen renamer beside the staged `efcpt-config.json`, matching their implicit lookup. EF Core 8–10 helpers receive the renamer through `-r`. Renamer filename and hash are tracked so regeneration stops after an unreviewed change or newly added renamer; run Reverse Engineer to review and adopt it.

Windows separators in relative output paths are normalized for macOS; absolute and parent-traversing paths are rejected. Current upstream CLI schema documentation targets newer helpers: pinned EF Core 6/7 helpers use older schemas. This extension rejects irregular/plural/singular replacement lists for both lines and excluded indexes for EF Core 7 because those helpers would silently ignore them.

Exact output parity requires matching company Windows EF Core Power Tools engine/helper build, EF and MySQL provider versions, config and renamer files, and database schema. T4, T4-split, Handlebars, embedded connection strings, `UseNoDefaultConstructor`, schema-filter/no-object-filter modes, automatic obsolete-file cleanup, nested configs, and multiple contexts remain unsupported. Final verification needs the company’s exact Windows version plus a representative generated fixture; compare against a macOS regeneration after normalizing line endings.

## Table-discovery approach

Upstream CLI has no list-only command. This extension uses a safe two-pass process:

1. Create a verified system-temporary folder and seed `efcpt-config.json` with object refresh enabled, DbContext-only generation, connection embedding disabled, and obsolete-file deletion disabled.
2. Run the matching `efcpt` helper in that temporary folder and read its supported `tables` and `views` lists.
3. Present names unchanged in a native multi-select picker.
4. Generate into a new temporary staging folder using only selected objects and safe, Windows-compatible config settings.
5. Compare staged files with the destination, request exact overwrite confirmation, then copy `.cs` files and `efcpt-config.json` only.
6. Delete staging only after verifying its resolved path remains under the operating-system temporary directory.

See upstream [CLI documentation](https://github.com/ErikEJ/EFCorePowerTools/blob/master/src/Core/efcpt.8/readme.md) and [configuration sample](https://github.com/ErikEJ/EFCorePowerTools/blob/master/samples/efcpt-config.json).

## Security model

- Connection strings are stored only in VS Code `SecretStorage` when requested.
- Workspace state contains profile name, provider, output folder, and DbContext name only.
- Connection strings, common MySQL connection fields, and install-proxy credentials are redacted from complete buffered output lines.
- Process arguments, environments, and raw process errors are never logged.
- `spawn` always receives an argument array with `shell: false`.
- Generated output is rejected if it contains the exact connection string.
- `enable-on-configuring` and `soft-delete-obsolete-files` are always forced to `false`.
- Output outside the current workspace requires confirmation on every run.
- No telemetry exists.

Upstream `efcpt` requires the connection string as a positional process argument. It may therefore be briefly visible to same-machine operating-system process inspection. The extension cannot remove this upstream limitation; it prevents exposure through VS Code output, notifications, saved config, and generated code.

## Development

```bash
npm install
npm test
npm run compile
npm run package
```

Press `F5` in VS Code to launch Extension Development Host. A full manual smoke test requires an accessible sample MySQL database. The repository integration harness runs with `npm run test:integration`.

## Scope

Current MVP intentionally excludes SQL Server, PostgreSQL, MySQL routines, diagrams, model visualization, migrations UI, DacPac tools, Server Explorer, compare tools, templates, and general Visual Studio feature parity. Its focus is compatible MySQL reverse engineering.

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for upstream attribution.
