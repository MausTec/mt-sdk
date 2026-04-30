import { Command } from "commander";
import { version } from "./version.js";
import { validateCommand } from "./commands/validate.js";
import { buildCommand } from "./commands/build.js";
import { simulateCommand } from "./commands/simulate.js";
import { testCommand } from "./commands/test.js";

/**
 * Entry point for the mt-sdk CLI.
 * Parses process.argv and dispatches to the appropriate command.
 */
export async function run(): Promise<void> {
  const program = new Command()
    .name("mt-sdk")
    .description("Maus-Tec Plugin Development Toolkit")
    .version(version, "-V, --version");

  program
    .addCommand(validateCommand)
    .addCommand(buildCommand)
    .addCommand(simulateCommand)
    .addCommand(testCommand);

  await program.parseAsync();
}

