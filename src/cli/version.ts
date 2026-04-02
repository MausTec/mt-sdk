import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, "..", "..", "..", "package.json");

let _version = "0.0.0";

try {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
  _version = pkg.version;
} catch {
  // Running from dist; try one more level up
  try {
    const altPath = join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(altPath, "utf-8")) as { version: string };
    _version = pkg.version;
  } catch {
    // Fallback
  }
}

export const version = _version;
