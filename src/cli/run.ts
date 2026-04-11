import { parseArgs } from "node:util";
import { version } from "./version.js";

const COMMANDS = [
    "validate", 
    "init", 
    "simulate", 
    "build", 
    "package", 
    "sign", 
    "verify", 
    "inspect", 
    "version",
] as const;

type Command = (typeof COMMANDS)[number];

/**
 * Parses the first argument as a command and dispatches to the appropriate handler.
 * 
 * @param argv The command-line arguments to parse.
 * @returns A promise that resolves when the command has been executed.
 */
export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
  });

  const command = positionals[0] as Command | undefined;

  if (!command || command === "version") {
    console.log(`mt-sdk ${version}`);
    if (!command) {
      console.log(`\nUsage: mt-sdk <command> [options]\n`);
      console.log(`Commands:`);
      for (const cmd of COMMANDS) {
        console.log(`  ${cmd}`);
      }
    }
    return;
  }

  if (!(COMMANDS as readonly string[]).includes(command)) {
    console.error(`Unknown command: ${command}`);
    console.error(`Run "mt-sdk" for a list of commands.`);
    process.exitCode = 1;
    return;
  }

  // Lazy-load commands to keep startup fast
  switch (command) {
    case "validate": {
      const { validateCommand } = await import("./commands/validate.js");
      await validateCommand(argv.slice(1));
      break;
    }
    case "build": {
      const { buildCommand } = await import("./commands/build.js");
      await buildCommand(argv.slice(1));
      break;
    }
    default:
      console.log(`Command "${command}" is not yet implemented.`);
      process.exitCode = 1;
  }
}
