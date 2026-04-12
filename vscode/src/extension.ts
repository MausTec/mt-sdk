import * as path from "path";
import type { ExtensionContext } from "vscode";
import {
  LanguageClient,
  TransportKind,
} from "vscode-languageclient/node";
import type { LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
  // Resolve the bundled LSP server entry point relative to the extension root.
  // esbuild bundles it to dist/lsp-server.js so this path works both in
  // development (loaded from vscode/) and when installed from a .vsix.
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
      // Re-send diagnostics when files matching this glob change on disk.
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
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
