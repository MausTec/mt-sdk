import * as path from "path";
import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
} from "vscode-languageclient/node";
import type { LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // --- LSP Client ---

  const serverModule = context.asAbsolutePath(
    path.join("dist", "lsp-server.js"),
  );

  const serverOptions: ServerOptions = {
    run: {
      command: process.execPath,
      args: [serverModule],
      transport: TransportKind.stdio,
    },
    debug: {
      command: process.execPath,
      args: ["--inspect=6009", "--nolazy", serverModule],
      transport: TransportKind.stdio,
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "mtp" }],
    synchronize: {
      fileEvents: [],
    },
  };

  client = new LanguageClient(
    "mt-sdk-lsp",
    "Maus-Tec Plugin Language Server",
    serverOptions,
    clientOptions,
  );

  client.start();

  // --- MCP Server ---

  const mcpServerPath = context.asAbsolutePath(
    path.join("dist", "mcp-server.js"),
  );

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider("mt-sdk-mcp", {
      provideMcpServerDefinitions: async () => [
        new vscode.McpStdioServerDefinition(
          "Maus-Tec Plugin SDK",
          process.execPath,
          [mcpServerPath],
        ),
      ],
    }),
  );
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
