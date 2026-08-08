import assert from "node:assert/strict";
import test from "node:test";
import {
  detectEfCoreMajorFromXml,
  isDefinitelyBelowNet6,
  isDefinitelyBelowRequiredDotnet,
  isValidCSharpIdentifier,
  isValidCSharpNamespace,
  parseProjectXml,
  requiredDotnetMajorForEfCore,
} from "../../services/projectParser";

test("detects inline EF Core package major", () => {
  const xml = `<Project><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="8.0.5" /></ItemGroup></Project>`;
  assert.equal(detectEfCoreMajorFromXml(xml), 8);
});

test("ignores commented project metadata and package references", () => {
  const project = parseProjectXml(
    "/repo/Orders.csproj",
    `<Project><!-- <TargetFramework>net5.0</TargetFramework><RootNamespace>Wrong</RootNamespace><PackageReference Include="Microsoft.EntityFrameworkCore" Version="9.0.0" /> --><PropertyGroup><TargetFramework>net8.0</TargetFramework><RootNamespace>Orders</RootNamespace></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" /></ItemGroup></Project>`,
  );

  assert.deepEqual(project.targetFrameworks, ["net8.0"]);
  assert.equal(project.rootNamespace, "Orders");
  assert.equal(project.detectedEfCoreMajor, 8);
  assert.equal(project.packageConflicts, undefined);
});

test("detects EF Core major from MySQL provider packages", () => {
  assert.equal(
    detectEfCoreMajorFromXml(
      `<Project><ItemGroup><PackageReference Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" /></ItemGroup></Project>`,
    ),
    9,
  );
  assert.equal(
    detectEfCoreMajorFromXml(
      `<Project><ItemGroup><PackageReference Include="Microting.EntityFrameworkCore.MySql" Version="10.0.10" /></ItemGroup></Project>`,
    ),
    10,
  );
});

test("detects central package major and project properties", () => {
  const project = parseProjectXml(
    "/repo/Orders.csproj",
    `<Project><PropertyGroup><TargetFrameworks>net6.0;net8.0</TargetFrameworks><RootNamespace>Company.Orders</RootNamespace></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore" /></ItemGroup></Project>`,
    `<Project><ItemGroup><PackageVersion Include="Microsoft.EntityFrameworkCore" Version="6.0.36" /></ItemGroup></Project>`,
  );

  assert.equal(project.detectedEfCoreMajor, 6);
  assert.deepEqual(project.targetFrameworks, ["net6.0", "net8.0"]);
  assert.equal(project.rootNamespace, "Company.Orders");
});

test("uses central MySQL version only when the project references that provider", () => {
  const central = `<Project><ItemGroup><PackageVersion Include="Pomelo.EntityFrameworkCore.MySql" Version="8.0.3" /><PackageVersion Include="Pomelo.EntityFrameworkCore.MySql.NetTopologySuite" Version="8.0.3" /></ItemGroup></Project>`;
  const referenced = parseProjectXml(
    "/repo/Orders.csproj",
    `<Project><ItemGroup><PackageReference Include="Pomelo.EntityFrameworkCore.MySql" /><PackageReference Include="Pomelo.EntityFrameworkCore.MySql.NetTopologySuite" /></ItemGroup></Project>`,
    central,
  );
  const unrelated = parseProjectXml(
    "/repo/Other.csproj",
    `<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`,
    central,
  );

  assert.equal(referenced.mysqlProvider?.major, 8);
  assert.equal(referenced.mysqlSpatialProvider?.major, 8);
  assert.equal(unrelated.mysqlProvider, undefined);
  assert.equal(unrelated.detectedEfCoreMajor, undefined);
});

test("reports conflicting direct EF and provider package majors", () => {
  const project = parseProjectXml(
    "/repo/Orders.csproj",
    `<Project><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="8.0.5" /><PackageReference Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" /></ItemGroup></Project>`,
  );

  assert.equal(project.detectedEfCoreMajor, undefined);
  assert.deepEqual(project.packageConflicts, [
    "Conflicting EF Core package majors detected: 8, 9.",
  ]);
});

test("reports correlated central package and provider-family conflicts", () => {
  const project = parseProjectXml(
    "/repo/Orders.csproj",
    `<Project><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore.Design" /><PackageReference Include="Pomelo.EntityFrameworkCore.MySql" /><PackageReference Include="Microting.EntityFrameworkCore.MySql.NetTopologySuite" /></ItemGroup></Project>`,
    `<Project><ItemGroup><PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="8.0.5" /><PackageVersion Include="Pomelo.EntityFrameworkCore.MySql" Version="8.0.3" /><PackageVersion Include="Microting.EntityFrameworkCore.MySql.NetTopologySuite" Version="10.0.10" /></ItemGroup></Project>`,
  );

  assert.equal(project.detectedEfCoreMajor, undefined);
  assert.deepEqual(project.packageConflicts, [
    "Conflicting EF Core package majors detected: 8, 10.",
    "Conflicting MySQL provider families detected: Microting, Pomelo.",
  ]);
});

test("uses a project VersionOverride instead of its central package version", () => {
  const project = parseProjectXml(
    "/repo/Orders.csproj",
    `<Project><ItemGroup><PackageReference Include="Pomelo.EntityFrameworkCore.MySql" VersionOverride="8.0.3" /></ItemGroup></Project>`,
    `<Project><ItemGroup><PackageVersion Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" /></ItemGroup></Project>`,
  );

  assert.equal(project.detectedEfCoreMajor, 8);
  assert.equal(project.mysqlProvider?.major, 8);
  assert.equal(project.packageConflicts, undefined);
});

test("uses a nested VersionOverride and reports unsupported package majors", () => {
  const overridden = parseProjectXml(
    "/repo/Orders.csproj",
    `<Project><ItemGroup><PackageReference Include="Pomelo.EntityFrameworkCore.MySql"><VersionOverride>8.0.3</VersionOverride></PackageReference></ItemGroup></Project>`,
    `<Project><ItemGroup><PackageVersion Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" /></ItemGroup></Project>`,
  );
  const unsupported = parseProjectXml(
    "/repo/Old.csproj",
    `<Project><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore" Version="5.0.17" /></ItemGroup></Project>`,
  );

  assert.equal(overridden.detectedEfCoreMajor, 8);
  assert.equal(overridden.packageConflicts, undefined);
  assert.match(unsupported.packageConflicts?.[0] ?? "", /Unsupported.*5/);
});

test("does not replace an unresolved direct VersionOverride with a central version", () => {
  const project = parseProjectXml(
    "/repo/Orders.csproj",
    `<Project><ItemGroup><PackageReference Include="Pomelo.EntityFrameworkCore.MySql"><VersionOverride>$(PomeloVersion)</VersionOverride></PackageReference></ItemGroup></Project>`,
    `<Project><ItemGroup><PackageVersion Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" /></ItemGroup></Project>`,
  );

  assert.equal(project.detectedEfCoreMajor, undefined);
  assert.equal(project.mysqlProvider, undefined);
  assert.equal(project.mysqlProviderFamily, "Pomelo");
});

test("preserves an unversioned referenced MySQL provider family", () => {
  const project = parseProjectXml(
    "/repo/Orders.csproj",
    `<Project><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" /><PackageReference Include="Microting.EntityFrameworkCore.MySql" /></ItemGroup></Project>`,
  );

  assert.equal(project.detectedEfCoreMajor, 8);
  assert.equal(project.mysqlProvider, undefined);
  assert.equal(project.mysqlProviderFamily, "Microting");
});

test("rejects only projects definitely below .NET 6", () => {
  assert.equal(isDefinitelyBelowNet6(["net5.0"]), true);
  assert.equal(isDefinitelyBelowNet6(["net48"]), true);
  assert.equal(isDefinitelyBelowNet6(["netstandard2.1"]), true);
  assert.equal(isDefinitelyBelowNet6(["netcoreapp3.1"]), true);
  assert.equal(isDefinitelyBelowNet6(["$(TargetFramework)"]), false);
  assert.equal(isDefinitelyBelowNet6(["net5.0", "net8.0"]), true);
});

test("checks EF Core major against required .NET runtime", () => {
  assert.equal(requiredDotnetMajorForEfCore(6), 6);
  assert.equal(requiredDotnetMajorForEfCore(7), 6);
  assert.equal(requiredDotnetMajorForEfCore(8), 8);
  assert.equal(requiredDotnetMajorForEfCore(9), 8);
  assert.equal(requiredDotnetMajorForEfCore(10), 10);
  assert.equal(isDefinitelyBelowRequiredDotnet(["net6.0"], 8), true);
  assert.equal(isDefinitelyBelowRequiredDotnet(["net8.0"], 8), false);
  assert.equal(isDefinitelyBelowRequiredDotnet(["net8.0"], 10), true);
  assert.equal(isDefinitelyBelowRequiredDotnet(["net8.0", "net10.0"], 10), true);
  assert.equal(isDefinitelyBelowRequiredDotnet(["$(TargetFramework)"], 10), false);
  assert.equal(isDefinitelyBelowRequiredDotnet(["net6.0", "$(TargetFramework)"], 8), true);
});

test("validates explicit C# root namespaces", () => {
  assert.equal(isValidCSharpNamespace("Company.Orders_2"), true);
  assert.equal(isValidCSharpNamespace("Företag.Orders"), true);
  assert.equal(isValidCSharpNamespace("$(RootNamespace)"), false);
  assert.equal(isValidCSharpNamespace("company-orders"), false);
  assert.equal(isValidCSharpNamespace("Company.class"), false);
  assert.equal(isValidCSharpIdentifier("OrdersContext"), true);
  assert.equal(isValidCSharpIdentifier("namespace"), false);
});
