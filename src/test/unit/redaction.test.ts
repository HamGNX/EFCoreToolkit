import assert from "node:assert/strict";
import test from "node:test";
import { extractConnectionSecrets, LineRedactor, redactText } from "../../services/redaction";

test("redacts an exact connection string and common MySQL fields", () => {
  const connection = "Server=db.internal;Database=orders;User Id=app;Password=p$&ss;";
  const result = redactText(`Failed: ${connection}`, [connection]);

  assert.equal(result.includes(connection), false);
  assert.equal(result.includes("p$&ss"), false);
  assert.match(result, /REDACTED/);
});

test("redacts connection fields case-insensitively", () => {
  const result = redactText(
    "Data Source=mysql;User Name=alice;PWD='secret';Database=main;Network Address=private",
  );

  assert.equal(result.includes("mysql"), false);
  assert.equal(result.includes("alice"), false);
  assert.equal(result.includes("secret"), false);
  assert.equal(result.includes("main"), false);
  assert.equal(result.includes("private"), false);
});

test("redacts complete MySQL URI including query", () => {
  const result = redactText("mysql://alice:secret@mysql.internal/orders?token=query-secret");

  assert.equal(result.includes("alice"), false);
  assert.equal(result.includes("secret"), false);
  assert.equal(result.includes("mysql.internal"), false);
  assert.equal(result.includes("orders"), false);
  assert.equal(result.includes("query-secret"), false);
});

test("buffers split stream secrets until a complete line", () => {
  const lines: string[] = [];
  const redactor = new LineRedactor((line) => lines.push(line), ["Password=split-secret;"]);

  redactor.accept("Failure Password=split-");
  redactor.accept("secret;\nDone");
  redactor.flush();

  assert.deepEqual(lines, ["Failure [REDACTED CONNECTION STRING]", "Done"]);
  assert.equal(lines.join("\n").includes("split-secret"), false);
});

test("leaves benign output unchanged", () => {
  assert.equal(redactText("Generated 12 entity files."), "Generated 12 entity files.");
});

test("extracts password values for reformatted-error redaction", () => {
  assert.deepEqual(
    extractConnectionSecrets("Server=db;Password={semi;secret};User=app"),
    ["Server=db;Password={semi;secret};User=app", "semi;secret"],
  );
});

test("redacts MySQL certificate passwords", () => {
  const connection = "Server=db;CertificatePassword=cert-secret;";
  const secrets = extractConnectionSecrets(connection);
  const result = redactText("Certificate Password=cert-secret", secrets);

  assert.equal(secrets.includes("cert-secret"), true);
  assert.equal(result.includes("cert-secret"), false);
});

test("redacts escaped quoted and braced connection values completely", () => {
  const braced = redactText("Failure Password={part}}secret};Server=db");
  const quoted = redactText('Failure Password="part""secret";Server=db');

  assert.equal(braced.includes("secret"), false);
  assert.equal(braced.includes("}"), false);
  assert.equal(quoted.includes("secret"), false);
  assert.deepEqual(
    extractConnectionSecrets('Password="part""secret";Certificate Password={cert}}secret}'),
    [
      'Password="part""secret";Certificate Password={cert}}secret}',
      'part""secret',
      'part"secret',
      'cert}}secret',
      'cert}secret',
    ],
  );
});

test("caps output that expands during redaction", () => {
  const lines: string[] = [];
  const redactor = new LineRedactor((line) => lines.push(line), ["a"]);
  redactor.accept(`${"a".repeat(1_000)}\n`);

  assert.deepEqual(lines, ["[Expanded redacted helper output line omitted safely.]"]);
});
