/**
 * CLI output helpers. ASCII-only text, ANSI escapes on TTY
 */

const isTTY = typeof process !== "undefined" && process.stdout?.isTTY === true;

// --- Low-level ANSI ---------------------------------------------------------

const SGR = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  cyan:    "\x1b[36m",
  gray:    "\x1b[90m",
  bgRed:    "\x1b[41m",
  bgGreen:  "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue:   "\x1b[44m",
  bgCyan:   "\x1b[46m",
} as const;

function wrap(code: string, s: string): string {
  if (!isTTY) return s;
  return `${code}${s}${SGR.reset}`;
}

// --- Color helpers ----------------------------------------------------------

export const bold    = (s: string): string => wrap(SGR.bold,    s);
export const dim     = (s: string): string => wrap(SGR.dim,     s);
export const red     = (s: string): string => wrap(SGR.red,     s);
export const green   = (s: string): string => wrap(SGR.green,   s);
export const yellow  = (s: string): string => wrap(SGR.yellow,  s);
export const blue    = (s: string): string => wrap(SGR.blue,    s);
export const magenta = (s: string): string => wrap(SGR.magenta, s);
export const cyan    = (s: string): string => wrap(SGR.cyan,    s);
export const gray    = (s: string): string => wrap(SGR.gray,    s);

/**
 * Render an inverted "tag" label (e.g. ` PASS `, ` FAIL `, ` RUN  `).
 * Mimics vitest / jest summary tags.
 */
export function tag(text: string, kind: "pass" | "fail" | "warn" | "info" | "skip"): string {
  const padded = ` ${text} `;
  if (!isTTY) return padded;

  switch (kind) {
    case "pass": return `${SGR.bgGreen}${SGR.bold}${padded}${SGR.reset}`;
    case "fail": return `${SGR.bgRed}${SGR.bold}${padded}${SGR.reset}`;
    case "warn": return `${SGR.bgYellow}${SGR.bold}${padded}${SGR.reset}`;
    case "info": return `${SGR.bgCyan}${SGR.bold}${padded}${SGR.reset}`;
    case "skip": return `${SGR.dim}${padded}${SGR.reset}`;
  }
}

// --- ASCII status markers ---------------------------------------------------

/** Pass marker: green plus sign. */
export const CHECK = "+";

/** Fail marker: red lowercase x. */
export const CROSS = "x";

/** Warning marker: yellow exclamation point. */
export const WARN_MARK = "!";

/** Skip / pending marker: dim hyphen. */
export const SKIP_MARK = "-";

/**
 * Coloured pass marker (`+`).
 */
export const passMark = (): string => green(CHECK);

/**
 * Coloured fail marker (`x`).
 */
export const failMark = (): string => red(CROSS);

/**
 * Coloured warn marker (`!`).
 */
export const warnMark = (): string => yellow(WARN_MARK);

// --- Section helpers --------------------------------------------------------

/**
 * Print an informational status line to stdout. Prefix is a cyan `==>`.
 */
export function info(msg: string): void {
  console.log(`${cyan("==>")} ${msg}`);
}

/**
 * Print a success line to stdout. Prefix is a green `==>`.
 */
export function success(msg: string): void {
  console.log(`${green("==>")} ${msg}`);
}

/**
 * Print a warning to stderr.
 */
export function warn(msg: string): void {
  console.error(`${yellow("Warning:")} ${msg}`);
}

/**
 * Print an error to stderr.
 */
export function error(msg: string): void {
  console.error(`${red("Error:")} ${msg}`);
}

/**
 * Format a duration in milliseconds as a short, right-aligned string.
 * Vitest-style: <1s -> `42ms`, >=1s -> `1.23s`.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
