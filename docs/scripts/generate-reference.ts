/**
 * Generate Starlight reference pages from mt-runtimes descriptors.
 *
 * Reads the runtime catalog, resolves API descriptors for every device SKU
 * with published versions, and writes Starlight-compatible markdown files
 * to docs/src/content/docs/reference/.
 *
 * Usage: tsx scripts/generate-reference.ts
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Import from the SDK source (parent directory)
import { renderDevicePage, renderBuiltinsPage } from "../../src/docs/runtime.js";

// Import from mt-runtimes (resolved via the SDK's node_modules)
import {
  allSkus,
  allProducts,
  getProductCatalog,
  getSkuEntry,
  getApiDescriptor,
  getMtActionsDescriptor,
} from "@maustec/mt-runtimes";

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsContentRoot = resolve(__dirname, "..", "src", "content", "docs", "reference");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writePage(relativePath: string, content: string): void {
  const fullPath = resolve(docsContentRoot, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
  console.log(`  wrote ${relativePath}`);
}

function cleanGeneratedDir(dir: string): void {
  const fullPath = resolve(docsContentRoot, dir);
  if (existsSync(fullPath)) {
    // Only remove .md files that have the generated marker, preserve .gitkeep
    // For simplicity in v0, just remove and re-create the directory's generated files
    rmSync(fullPath, { recursive: true });
  }
  mkdirSync(fullPath, { recursive: true });
}

// ---------------------------------------------------------------------------
// Device reference pages
// ---------------------------------------------------------------------------

function generateDevicePages(): void {
  console.log("Generating device reference pages...");
  cleanGeneratedDir("devices");

  // Write the index page
  const skus = allSkus();
  const indexLines: string[] = [
    "---",
    'title: "Supported Devices"',
    'description: "Per-device API reference for MTP plugin development"',
    "---",
    "",
    "API reference pages are generated from [mt-runtimes](https://github.com/maustec/mt-runtimes) descriptors.",
    "",
    "## Devices",
    "",
  ];

  for (const product of allProducts()) {
    const catalog = getProductCatalog(product);
    const productTitle = product.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    indexLines.push(`### ${productTitle}`);
    indexLines.push("");

    for (const sku of Object.keys(catalog.skus)) {
      const entry = getSkuEntry(sku);

      if (entry.versions.length === 0) {
        indexLines.push(`- **${sku}** — No published firmware versions yet`);
        continue;
      }

      for (const ver of entry.versions) {
        const slug = `${sku.toLowerCase()}-${ver.version.replace(/\./g, "-")}`;
        indexLines.push(`- [**${sku}** v${ver.version}](/reference/devices/${slug}/) (${ver.status})`);

        // Generate the per-version page
        const api = getApiDescriptor(sku, ver.version);
        writePage(`devices/${slug}.md`, renderDevicePage(api, productTitle));
      }
    }

    indexLines.push("");
  }

  writePage("devices/index.md", indexLines.join("\n"));
}

// ---------------------------------------------------------------------------
// Builtins reference pages
// ---------------------------------------------------------------------------

function generateBuiltinsPages(): void {
  console.log("Generating builtins reference pages...");
  cleanGeneratedDir("builtins");

  try {
    const builtins = getMtActionsDescriptor();
    writePage("builtins/index.md", renderBuiltinsPage(builtins));
  } catch (e) {
    console.warn(`  Warning: Could not load Plugin Runtime descriptor: ${e}`);

    // Write a placeholder
    writePage(
      "builtins/index.md",
      [
        "---",
        'title: "Plugin Runtime Builtins"',
        'description: "Core builtin operations"',
        "---",
        "",
        ":::caution",
        "Could not load Plugin Runtime runtime descriptor. Ensure @maustec/mt-runtimes is installed.",
        ":::",
      ].join("\n"),
    );
  }
}

// ---------------------------------------------------------------------------
// Language reference stub (placeholder for registry-driven content)
// ---------------------------------------------------------------------------

function generateLanguagePages(): void {
  console.log("Generating language reference stubs...");
  cleanGeneratedDir("language");

  // These will eventually be populated from the doc registry.
  // For now, write a single index that explains the structure.
  writePage(
    "language/index.md",
    [
      "---",
      'title: "MTP Language Reference"',
      'description: "Syntax and semantics of the MTP plugin language"',
      "---",
      "",
      "The MTP (Maus-Tec Plugin) language compiles to JSON for the Plugin Runtime.",
      "",
      ":::note",
      "Language reference topics will be generated from the SDK doc registry.",
      ":::",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  console.log(`Output: ${docsContentRoot}\n`);

  generateLanguagePages();
  generateBuiltinsPages();
  generateDevicePages();

  console.log("\nDone.");
}

main();
