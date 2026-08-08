import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInstallArguments,
  buildScaffoldArguments,
  helperVersionSpec,
  managedHelperDirectory,
  reportsExpectedHelperVersion,
  requiredRuntimeMajor,
  supportsRenamingArgument,
} from "../../services/commandBuilder";

test("builds MySQL scaffold arguments without shell quoting", () => {
  const connection = "Server=localhost;Password=$(touch nope);Pwd=`id`;";
  const args = buildScaffoldArguments(
    connection,
    "/tmp/staging",
    "/tmp/staging/efcpt-config.json",
    "/repo/efpt.renaming.json",
  );

  assert.deepEqual(args, [
    connection,
    "mysql",
    "-o",
    "/tmp/staging",
    "-i",
    "/tmp/staging/efcpt-config.json",
    "-r",
    "/repo/efpt.renaming.json",
  ]);
  assert.equal(args[0], connection);
});

test("builds isolated exact-version install arguments", () => {
  const toolPath = managedHelperDirectory("/extension", 8);
  const args = buildInstallArguments(toolPath, 8);

  assert.deepEqual(args, [
    "tool",
    "install",
    "ErikEJ.EFCorePowerTools.Cli",
    "--tool-path",
    toolPath,
    "--version",
    "8.1.1386",
    "--source",
    "https://api.nuget.org/v3/index.json",
  ]);
  assert.equal(args.includes("-g"), false);
  assert.equal(args.includes("--global"), false);
});

test("pins supported helper lines and runtime requirements", () => {
  assert.equal(helperVersionSpec(6), "6.1.463");
  assert.equal(helperVersionSpec(7), "7.1.343");
  assert.equal(helperVersionSpec(9), "9.1.1386");
  assert.equal(helperVersionSpec(10), "10.1.1440-nightly");
  assert.equal(requiredRuntimeMajor(6), 6);
  assert.equal(requiredRuntimeMajor(7), 6);
  assert.equal(requiredRuntimeMajor(8), 8);
  assert.equal(requiredRuntimeMajor(9), 8);
  assert.equal(requiredRuntimeMajor(10), 10);
  assert.equal(supportsRenamingArgument(6), false);
  assert.equal(supportsRenamingArgument(7), false);
  assert.equal(supportsRenamingArgument(8), true);
});

test("accepts only the exact pinned helper version token", () => {
  assert.equal(reportsExpectedHelperVersion(["efcpt.8 8.1.1386+abcdef"], 8), true);
  assert.equal(reportsExpectedHelperVersion(["efcpt.8 18.1.1386+abcdef"], 8), false);
  assert.equal(reportsExpectedHelperVersion(["efcpt.10 10.1.1440-nightly"], 10), true);
});
