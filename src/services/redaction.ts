const CONNECTION_KEYS = [
  "certificate password",
  "certificatepassword",
  "password",
  "pwd",
  "user id",
  "user name",
  "username",
  "user",
  "userid",
  "uid",
  "server",
  "host",
  "data source",
  "datasource",
  "address",
  "addr",
  "network address",
  "database",
  "initial catalog",
] as const;

const KEY_PATTERN = CONNECTION_KEYS.map((key) => key.replace(/\s+/g, "\\s+")).join("|");
const CONNECTION_VALUE_PATTERN = String.raw`(?:"(?:[^"]|"")*"|'(?:[^']|'')*'|\{(?:[^}]|}})*\}|[^;\r\n]*)`;
const CONNECTION_PART_PATTERN = new RegExp(
  String.raw`\b(${KEY_PATTERN})\s*=\s*(${CONNECTION_VALUE_PATTERN})`,
  "gi",
);
const MYSQL_URI_PATTERN = /\b(mysqlx?(?:\+[a-z0-9._-]+)?:\/\/)[^\s]+/gi;
const PASSWORD_VALUE_PATTERN = /\b(?:certificate\s*password|password|pwd)\s*=\s*(?:"((?:[^"]|"")*)"|'((?:[^']|'')*)'|\{((?:[^}]|}})*)\}|([^;\r\n]*))/gi;

export function extractConnectionSecrets(connectionString: string): string[] {
  const secrets = new Set<string>([connectionString]);
  for (const match of connectionString.matchAll(PASSWORD_VALUE_PATTERN)) {
    const valueIndex = match.slice(1).findIndex((candidate) => candidate !== undefined);
    const value = valueIndex >= 0 ? match[valueIndex + 1].trim() : undefined;
    if (value) {
      secrets.add(value);
      const decoded = valueIndex === 0
        ? value.replaceAll('""', '"')
        : valueIndex === 1
          ? value.replaceAll("''", "'")
          : valueIndex === 2
            ? value.replaceAll("}}", "}")
            : value;
      if (decoded) secrets.add(decoded);
    }
  }
  const uriMatch = /^mysqlx?:\/\/[^:@/\s]+:([^@/\s]+)@/i.exec(connectionString);
  if (uriMatch?.[1]) {
    secrets.add(uriMatch[1]);
  }
  return [...secrets];
}

export function redactText(value: string, secrets: readonly string[] = []): string {
  let redacted = value;

  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("[REDACTED CONNECTION STRING]");
    }
  }

  redacted = redacted.replace(CONNECTION_PART_PATTERN, (_match, key: string) => {
    return `${key}=[REDACTED]`;
  });

  return redacted.replace(
    MYSQL_URI_PATTERN,
    (_match, scheme: string) => `${scheme}[REDACTED]`,
  );
}

export class LineRedactor {
  private pending = "";
  private discardingLongLine = false;
  private readonly maximumLineLength = 16_384;

  public constructor(
    private readonly writeLine: (value: string) => void,
    private readonly secrets: readonly string[] = [],
    private readonly inspectRawLine?: (value: string) => void,
  ) {}

  public accept(chunk: string): void {
    if (this.discardingLongLine) {
      const newlineIndex = chunk.search(/\r?\n/);
      if (newlineIndex < 0) {
        return;
      }
      chunk = chunk.slice(newlineIndex + (chunk[newlineIndex] === "\r" ? 2 : 1));
      this.discardingLongLine = false;
    }

    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";

    for (const line of lines) {
      this.emitLine(line);
    }

    if (this.pending.length > this.maximumLineLength) {
      this.inspectRawLine?.(this.pending);
      this.pending = "";
      this.discardingLongLine = true;
      this.writeLine("[Long helper output line omitted safely.]");
    }
  }

  public flush(): void {
    if (this.pending.length > 0) {
      this.emitLine(this.pending);
      this.pending = "";
    }
    this.discardingLongLine = false;
  }

  private emitLine(line: string): void {
    this.inspectRawLine?.(line);
    if (line.length > this.maximumLineLength) {
      this.writeLine("[Long helper output line omitted safely.]");
      return;
    }
    const redacted = redactText(line, this.secrets);
    this.writeLine(
      redacted.length <= this.maximumLineLength
        ? redacted
        : "[Expanded redacted helper output line omitted safely.]",
    );
  }
}
