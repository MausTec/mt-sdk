import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ScaffoldResult } from "./types.js";

export interface WriteReport {
  written: string[];
  skipped: string[];
  errors: Array<{ path: string; message: string }>;
}

/**
 * Write scaffold files to disk.
 *
 * Files with `overwrite: false` are skipped when the target already exists,
 * allowing safe re-application of overlays onto existing projects without
 * clobbering user-edited files.
 */
export function writeScaffold(result: ScaffoldResult): WriteReport {
  const report: WriteReport = { written: [], skipped: [], errors: [] };

  for (const file of result.files) {
    const abs = join(result.targetDir, file.path);

    if (existsSync(abs) && !file.overwrite) {
      report.skipped.push(file.path);
      continue;
    }

    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.content, "utf-8");
      report.written.push(file.path);
    } catch (e) {
      report.errors.push({
        path: file.path,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return report;
}
