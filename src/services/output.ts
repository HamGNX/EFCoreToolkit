import * as vscode from "vscode";
import { redactText } from "./redaction";

export class ExtensionOutput implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel("EF Core Power Tools");

  public appendLine(value: string, secrets: readonly string[] = []): void {
    this.channel.appendLine(redactText(value, secrets));
  }

  public show(): void {
    this.channel.show(true);
  }

  public clear(): void {
    this.channel.clear();
  }

  public dispose(): void {
    this.channel.dispose();
  }
}
