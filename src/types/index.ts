export const SUPPORTED_EF_CORE_MAJORS = [6, 7, 8, 9, 10] as const;

export type EfCoreMajor = (typeof SUPPORTED_EF_CORE_MAJORS)[number];

export interface ProjectInfo {
  filePath: string;
  name: string;
  rootNamespace: string;
  targetFrameworks: string[];
  detectedEfCoreMajor?: EfCoreMajor;
  packageConflicts?: string[];
  mysqlProviderFamily?: "Pomelo" | "Microting";
  mysqlProvider?: {
    packageName: string;
    major: number;
  };
  mysqlSpatialProvider?: {
    packageName: string;
    major: number;
  };
}

export interface ProfileMetadata {
  id: string;
  name: string;
  provider: "mysql";
  outputFolder: string;
  dbContextName: string;
}

export interface ConnectionProfile extends ProfileMetadata {
  connectionString: string;
}

export interface DisposableLike {
  dispose(): void;
}

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): DisposableLike;
}

export interface OutputSink {
  appendLine(value: string): void;
  show?(): void;
}
