import * as path from "node:path";
import { SUPPORTED_EF_CORE_MAJORS, type EfCoreMajor, type ProjectInfo } from "../types";

function attributeValue(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag);
  return match?.[1];
}

function stripXmlComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

function packageTags(xml: string): string[] {
  return (
    stripXmlComments(xml).match(
      /<Package(?:Reference|Version)\b[^>]*(?:\/>|>[\s\S]*?<\/Package(?:Reference|Version)>)/gi,
    ) ?? []
  );
}

interface PackageVersion {
  packageName: string;
  major: number;
}

function packageVersionValue(tag: string): string | undefined {
  return (
    attributeValue(tag, "VersionOverride") ??
    /<VersionOverride>\s*([^<]+)\s*<\/VersionOverride>/i.exec(tag)?.[1] ??
    attributeValue(tag, "Version") ??
    /<Version>\s*([^<]+)\s*<\/Version>/i.exec(tag)?.[1]
  );
}

function efPackageVersions(
  xml: string,
  expectedPackageNames?: readonly string[],
): PackageVersion[] {
  const expectedNames = expectedPackageNames?.map((name) => name.toLowerCase());
  return packageTags(xml)
    .map((tag): PackageVersion | undefined => {
      const packageName = attributeValue(tag, "Include") ?? attributeValue(tag, "Update");
      if (
        !packageName?.match(
          /^(?:Microsoft\.EntityFrameworkCore(?:\.|$)|Pomelo\.EntityFrameworkCore\.MySql(?:\.|$)|Microting\.EntityFrameworkCore\.MySql(?:\.|$))/i,
        ) ||
        (expectedNames && !expectedNames.includes(packageName.toLowerCase()))
      ) {
        return undefined;
      }

      const version = packageVersionValue(tag);
      const major = version ? Number.parseInt(version, 10) : Number.NaN;
      return Number.isFinite(major) ? { packageName, major } : undefined;
    })
    .filter((entry): entry is PackageVersion => entry !== undefined);
}

function distinctPackageNames(names: readonly string[]): string[] {
  const distinct = new Map<string, string>();
  for (const name of names) {
    distinct.set(name.toLowerCase(), name);
  }
  return [...distinct.values()];
}

export function detectEfCoreMajorFromXml(
  xml: string,
  expectedPackageNames?: readonly string[],
): EfCoreMajor | undefined {
  const majors = new Set<EfCoreMajor>();
  for (const { major } of efPackageVersions(xml, expectedPackageNames)) {
    if (SUPPORTED_EF_CORE_MAJORS.includes(major as EfCoreMajor)) {
      majors.add(major as EfCoreMajor);
    }
  }

  return majors.size === 1 ? [...majors][0] : undefined;
}

function referencedEfPackageNames(xml: string): string[] {
  return distinctPackageNames(
    packageTags(xml)
      .map((tag) => attributeValue(tag, "Include") ?? attributeValue(tag, "Update"))
      .filter(
        (name): name is string =>
          typeof name === "string" &&
          /^(?:Microsoft\.EntityFrameworkCore(?:\.|$)|Pomelo\.EntityFrameworkCore\.MySql(?:\.|$)|Microting\.EntityFrameworkCore\.MySql(?:\.|$))/i.test(
            name,
          ),
      ),
  );
}

function explicitlyVersionedEfPackageNames(xml: string): string[] {
  return distinctPackageNames(
    packageTags(xml)
      .filter((tag) => packageVersionValue(tag) !== undefined)
      .map((tag) => attributeValue(tag, "Include") ?? attributeValue(tag, "Update"))
      .filter(
        (name): name is string =>
          typeof name === "string" &&
          /^(?:Microsoft\.EntityFrameworkCore(?:\.|$)|Pomelo\.EntityFrameworkCore\.MySql(?:\.|$)|Microting\.EntityFrameworkCore\.MySql(?:\.|$))/i.test(
            name,
          ),
      ),
  );
}

export function detectMySqlProviderFromXml(
  xml: string,
  expectedPackageName?: string,
): ProjectInfo["mysqlProvider"] | undefined {
  const providers = packageTags(xml)
    .map((tag) => {
      const packageName = attributeValue(tag, "Include") ?? attributeValue(tag, "Update");
      if (!packageName?.match(/^(?:Pomelo|Microting)\.EntityFrameworkCore\.MySql$/i)) {
        return undefined;
      }
      if (expectedPackageName && packageName.toLowerCase() !== expectedPackageName.toLowerCase()) {
        return undefined;
      }
      const version = packageVersionValue(tag);
      const major = version ? Number.parseInt(version, 10) : Number.NaN;
      return Number.isFinite(major) ? { packageName, major } : undefined;
    })
    .filter((provider): provider is NonNullable<typeof provider> => provider !== undefined);
  const distinct = new Map(
    providers.map((provider) => [
      `${provider.packageName.toLowerCase()}@${provider.major}`,
      provider,
    ]),
  );
  return distinct.size === 1 ? [...distinct.values()][0] : undefined;
}

function detectMySqlSpatialProviderFromXml(
  xml: string,
  expectedPackageName?: string,
): ProjectInfo["mysqlSpatialProvider"] | undefined {
  const providers = packageTags(xml)
    .map((tag) => {
      const packageName = attributeValue(tag, "Include") ?? attributeValue(tag, "Update");
      if (
        !packageName?.match(
          /^(?:Pomelo|Microting)\.EntityFrameworkCore\.MySql\.NetTopologySuite$/i,
        )
      ) {
        return undefined;
      }
      if (expectedPackageName && packageName.toLowerCase() !== expectedPackageName.toLowerCase()) {
        return undefined;
      }
      const version = packageVersionValue(tag);
      const major = version ? Number.parseInt(version, 10) : Number.NaN;
      return Number.isFinite(major) ? { packageName, major } : undefined;
    })
    .filter((provider): provider is NonNullable<typeof provider> => provider !== undefined);
  const distinct = new Map(
    providers.map((provider) => [
      `${provider.packageName.toLowerCase()}@${provider.major}`,
      provider,
    ]),
  );
  return distinct.size === 1 ? [...distinct.values()][0] : undefined;
}

function referencedMySqlProviderName(xml: string): string | undefined {
  const names = distinctPackageNames(
    packageTags(xml)
      .map((tag) => attributeValue(tag, "Include") ?? attributeValue(tag, "Update"))
      .filter(
        (name): name is string =>
          typeof name === "string" &&
          /^(?:Pomelo|Microting)\.EntityFrameworkCore\.MySql$/i.test(name),
      ),
  );
  return names.length === 1 ? names[0] : undefined;
}

function referencedMySqlSpatialProviderName(xml: string): string | undefined {
  const names = distinctPackageNames(
    packageTags(xml)
      .map((tag) => attributeValue(tag, "Include") ?? attributeValue(tag, "Update"))
      .filter(
        (name): name is string =>
          typeof name === "string" &&
          /^(?:Pomelo|Microting)\.EntityFrameworkCore\.MySql\.NetTopologySuite$/i.test(name),
      ),
  );
  return names.length === 1 ? names[0] : undefined;
}

export function parseProjectXml(filePath: string, xml: string, centralPackagesXml?: string): ProjectInfo {
  const projectXml = stripXmlComments(xml);
  const centralXml = centralPackagesXml ? stripXmlComments(centralPackagesXml) : undefined;
  const targetFrameworkValue =
    /<TargetFrameworks?>\s*([^<]+)\s*<\/TargetFrameworks?>/i.exec(projectXml)?.[1] ?? "";
  const rootNamespace =
    /<RootNamespace>\s*([^<]+)\s*<\/RootNamespace>/i.exec(projectXml)?.[1]?.trim() ??
    path.basename(filePath, path.extname(filePath));
  const referencedProvider = referencedMySqlProviderName(projectXml);
  const referencedSpatialProvider = referencedMySqlSpatialProviderName(projectXml);
  const referencedEfPackages = referencedEfPackageNames(projectXml);
  const directPackageVersions = efPackageVersions(projectXml);
  const directVersionedNames = new Set(
    explicitlyVersionedEfPackageNames(projectXml).map((name) => name.toLowerCase()),
  );
  const packageVersions = [
    ...directPackageVersions,
    ...(centralXml
      ? efPackageVersions(
          centralXml,
          referencedEfPackages.filter(
            (packageName) => !directVersionedNames.has(packageName.toLowerCase()),
          ),
        )
      : []),
  ];
  const packageMajors = [...new Set(packageVersions.map((entry) => entry.major))].sort(
    (left, right) => left - right,
  );
  const providerFamilies = distinctPackageNames(
    referencedEfPackages
      .filter((name) => /^(?:Pomelo|Microting)\.EntityFrameworkCore\.MySql(?:\.|$)/i.test(name))
      .map((name) => name.split(".", 1)[0]),
  ).sort();
  const packageConflicts: string[] = [];
  if (packageMajors.length > 1) {
    packageConflicts.push(
      `Conflicting EF Core package majors detected: ${packageMajors.join(", ")}.`,
    );
  }
  if (
    packageMajors.length === 1 &&
    !SUPPORTED_EF_CORE_MAJORS.includes(packageMajors[0] as EfCoreMajor)
  ) {
    packageConflicts.push(
      `Unsupported EF Core package major detected: ${packageMajors[0]}. Supported majors are ${SUPPORTED_EF_CORE_MAJORS.join(", ")}.`,
    );
  }
  if (providerFamilies.length > 1) {
    packageConflicts.push(
      `Conflicting MySQL provider families detected: ${providerFamilies.join(", ")}.`,
    );
  }
  const detectedMajor =
    packageMajors.length === 1 &&
    SUPPORTED_EF_CORE_MAJORS.includes(packageMajors[0] as EfCoreMajor)
      ? (packageMajors[0] as EfCoreMajor)
      : undefined;

  return {
    filePath,
    name: path.basename(filePath),
    rootNamespace,
    targetFrameworks: targetFrameworkValue
      .split(";")
      .map((framework) => framework.trim())
      .filter(Boolean),
    detectedEfCoreMajor: detectedMajor,
    packageConflicts: packageConflicts.length > 0 ? packageConflicts : undefined,
    mysqlProviderFamily:
      providerFamilies.length === 1
        ? providerFamilies[0].toLowerCase() === "pomelo"
          ? "Pomelo"
          : "Microting"
        : undefined,
    mysqlProvider:
      detectMySqlProviderFromXml(projectXml) ??
      (centralXml &&
        referencedProvider &&
        !directVersionedNames.has(referencedProvider.toLowerCase())
        ? detectMySqlProviderFromXml(centralXml, referencedProvider)
        : undefined),
    mysqlSpatialProvider:
      detectMySqlSpatialProviderFromXml(projectXml) ??
      (centralXml &&
        referencedSpatialProvider &&
        !directVersionedNames.has(referencedSpatialProvider.toLowerCase())
        ? detectMySqlSpatialProviderFromXml(centralXml, referencedSpatialProvider)
        : undefined),
  };
}

const CSHARP_RESERVED_KEYWORDS = new Set([
  "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char",
  "checked", "class", "const", "continue", "decimal", "default", "delegate", "do",
  "double", "else", "enum", "event", "explicit", "extern", "false", "finally",
  "fixed", "float", "for", "foreach", "goto", "if", "implicit", "in", "int",
  "interface", "internal", "is", "lock", "long", "namespace", "new", "null",
  "object", "operator", "out", "override", "params", "private", "protected",
  "public", "readonly", "ref", "return", "sbyte", "sealed", "short", "sizeof",
  "stackalloc", "static", "string", "struct", "switch", "this", "throw", "true",
  "try", "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort", "using",
  "virtual", "void", "volatile", "while",
]);

export function isValidCSharpIdentifier(value: string): boolean {
  return /^(?:[_\p{L}\p{Nl}])(?:[_\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Cf}])*$/u.test(value) &&
    !CSHARP_RESERVED_KEYWORDS.has(value);
}

export function isValidCSharpNamespace(value: string): boolean {
  return value.length > 0 && value.split(".").every(isValidCSharpIdentifier);
}

function recognizedDotnetMajor(framework: string): number | undefined {
  const modern = /^net(\d+)\.\d+(?:-|$)/i.exec(framework);
  if (modern) return Number(modern[1]);
  if (/^net(?:coreapp|standard)\d+\.\d+(?:-|$)/i.test(framework)) return 0;
  if (/^net\d{2,3}(?:-|$)/i.test(framework)) return 0;
  return undefined;
}

export function requiredDotnetMajorForEfCore(major: EfCoreMajor): 6 | 8 | 10 {
  if (major <= 7) return 6;
  if (major <= 9) return 8;
  return 10;
}

export function isDefinitelyBelowRequiredDotnet(
  targetFrameworks: readonly string[],
  major: EfCoreMajor,
): boolean {
  const parsed = targetFrameworks.map(recognizedDotnetMajor);
  const recognized = parsed.filter((value): value is number => value !== undefined);
  const required = requiredDotnetMajorForEfCore(major);
  return recognized.some((value) => value < required);
}

export function isDefinitelyBelowNet6(targetFrameworks: readonly string[]): boolean {
  return isDefinitelyBelowRequiredDotnet(targetFrameworks, 6);
}
