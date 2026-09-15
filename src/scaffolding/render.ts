import type { TemplateVars } from "./types.js";

/**
 * Render a template string by substituting `{{ var_name }}` tokens with
 * values from `vars`. Token names are trimmed of surrounding whitespace.
 *
 * Unknown tokens are left unchanged so templates remain forward-compatible
 * and can be updated without breaking older scaffolder calls.
 */
export function render(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    return key in vars ? (vars[key] ?? _match) : _match;
  });
}
