const isTTY = typeof process !== "undefined" && process.stdout?.isTTY === true;

const colors = {
  reset: isTTY ? "\x1b[0m" : "",
  red: isTTY ? "\x1b[31m" : "",
  green: isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  blue: isTTY ? "\x1b[34m" : "",
  dim: isTTY ? "\x1b[2m" : "",
};

export const CHECK = "✓";
export const CROSS = "✗";
export const WARN_MARK = "⚠";

export function info(msg: string): void {
  console.log(`${colors.blue}==>${colors.reset} ${msg}`);
}

export function success(msg: string): void {
  console.log(`${colors.green}==>${colors.reset} ${msg}`);
}

export function warn(msg: string): void {
  console.error(`${colors.yellow}Warning:${colors.reset} ${msg}`);
}

export function error(msg: string): void {
  console.error(`${colors.red}Error:${colors.reset} ${msg}`);
}

export function dim(msg: string): string {
  return `${colors.dim}${msg}${colors.reset}`;
}
