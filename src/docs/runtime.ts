/**
 * Runtime documentation renderer.
 *
 * Converts mt-runtimes API descriptors into DocEntry objects and Starlight-
 * compatible markdown. This is the bridge between the runtime data and
 * every documentation consumer.
 */

import type {
  ApiDescriptor,
  HostFunctionDescriptor,
  EventDescriptor,
  ArgDescriptor,
} from "@maustec/mt-runtimes";

/**
 * Render a host function descriptor as a markdown section.
 */
export function renderFunctionDoc(fn: HostFunctionDescriptor): string {
  const lines: string[] = [];

  // Signature line
  const args = (fn.args ?? []).map(formatArg).join(", ");
  const ret = fn.returns ? ` → ${fn.returns.type}` : "";
  lines.push(`\`\`\`\n${fn.name}(${args})${ret}\n\`\`\``);
  lines.push("");

  if (fn.description) {
    lines.push(fn.description);
    lines.push("");
  }

  // Permission badge
  if (fn.permission) {
    lines.push(`:::note[Permission required]`);
    lines.push(`\`${fn.permission}\``);
    lines.push(`:::`);
    lines.push("");
  }

  // Arguments table
  if (fn.args && fn.args.length > 0) {
    lines.push("**Arguments**");
    lines.push("");
    lines.push("| Name | Type | Required | Description |");
    lines.push("|------|------|----------|-------------|");
    for (const arg of fn.args) {
      const req = arg.optional ? "no" : "yes";
      lines.push(`| \`${arg.name}\` | \`${arg.type}\` | ${req} | ${arg.description ?? "—"} |`);
    }
    lines.push("");
  }

  // Return value
  if (fn.returns) {
    lines.push("**Returns**");
    lines.push("");
    lines.push(`\`${fn.returns.type}\`${fn.returns.description ? ` — ${fn.returns.description}` : ""}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Render an event descriptor as a markdown section.
 */
export function renderEventDoc(event: EventDescriptor): string {
  const lines: string[] = [];

  lines.push(`### ${event.name}`);
  lines.push("");

  if (event.description) {
    lines.push(event.description);
    lines.push("");
  }

  if (event.module) {
    lines.push(`**Module:** \`${event.module}\``);
    lines.push("");
  }

  if (event.permission) {
    lines.push(`:::note[Permission required]`);
    lines.push(`\`${event.permission}\``);
    lines.push(`:::`);
    lines.push("");
  }

  if (event.payload && event.payload.length > 0) {
    lines.push("**Payload**");
    lines.push("");
    lines.push("| Field | Type | Description |");
    lines.push("|-------|------|-------------|");
    for (const field of event.payload) {
      lines.push(`| \`${field.name}\` | \`${field.type}\` | ${field.description ?? "—"} |`);
    }
    lines.push("");
  }

  // MTP usage hint
  lines.push("**MTP usage**");
  lines.push("");
  lines.push("```mtp");
  lines.push(`on :${event.name} do`);
  if (event.payload && event.payload.length > 0) {
    lines.push(`  # Available in $_ : ${event.payload.map((p) => p.name).join(", ")}`);
  }
  lines.push(`  log "${event.name} fired"`);
  lines.push("end");
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

/**
 * Render a full API descriptor as a complete markdown page body.
 */
export function renderApiPage(api: ApiDescriptor): string {
  const lines: string[] = [];

  lines.push(`API version **${api.version}** for \`${api.sku}\`.`);
  lines.push("");

  // Group functions by module
  const fnByModule = groupByModule(api.functions);
  if (api.functions.length > 0) {
    lines.push("## Host Functions");
    lines.push("");
    for (const [mod, fns] of fnByModule) {
      if (mod) {
        lines.push(`### ${mod}`);
        lines.push("");
      }
      for (const fn of fns) {
        lines.push(renderFunctionDoc(fn));
      }
    }
  }

  // Group events by module
  const evByModule = groupByModule(api.events);
  if (api.events.length > 0) {
    lines.push("## Events");
    lines.push("");
    for (const [mod, events] of evByModule) {
      if (mod) {
        lines.push(`### ${mod} events`);
        lines.push("");
      }
      for (const ev of events) {
        lines.push(renderEventDoc(ev));
      }
    }
  }

  return lines.join("\n");
}

/**
 * Generate Starlight-compatible frontmatter + body for a device API page.
 */
export function renderDevicePage(
  api: ApiDescriptor,
  productName: string,
): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push(`title: "${productName} (${api.sku}) v${api.version}"`);
  lines.push(`description: "API reference for ${productName} firmware ${api.version}"`);
  lines.push("---");
  lines.push("");
  lines.push(renderApiPage(api));

  return lines.join("\n");
}

/**
 * Generate Starlight-compatible frontmatter + body for the builtins page.
 */
export function renderBuiltinsPage(api: ApiDescriptor): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push(`title: "mt-actions Builtins v${api.version}"`);
  lines.push(`description: "Core builtin operations available on all platforms running mt-actions ${api.version}+"`);
  lines.push("---");
  lines.push("");
  lines.push(`These operations are available on **every** platform that ships mt-actions ${api.version} or later.`);
  lines.push("");
  lines.push(renderApiPage(api));

  return lines.join("\n");
}

// --- Helpers -----------------------------------------------------------------

function formatArg(arg: ArgDescriptor): string {
  const opt = arg.optional ? "?" : "";
  return `${arg.name}${opt}: ${arg.type}`;
}

function groupByModule<T extends { module?: string }>(
  items: T[],
): [string | undefined, T[]][] {
  const groups = new Map<string | undefined, T[]>();
  for (const item of items) {
    const key = item.module;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.entries()];
}
