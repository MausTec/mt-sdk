/**
 * TypeScript representation of the mt-actions JSON plugin format.
 * Mirrors the JSON schema at schemas.maus-tec.com/mt-actions/.../plugin.json
 */

// --- Primitives ---------------------------------------------------------------

/** A value in the mt-actions DSL: literal number, string, boolean, or variable reference ($name). */
export type MtpValue = number | string | boolean;

/** Two-argument array used by arithmetic and comparison actions. */
export type MtpPair = [MtpValue, MtpValue];

// --- Plugin metadata ----------------------------------------------------------

/** Artifact type: how the device and Hub handle the package. */
export type MtpArtifactType = "feature" | "ble_driver" | "app";

/** Config field value type. */
export type MtpConfigType = "int" | "bool" | "string";

/** Incomplete list of platform type, this is just here to test the idea of using a type string union instead of unknown strings */
export type MtpPlatformType = "@eom" | "@mercury" | string;

/** Incomplete list of permissions, this varies by loaded SDK and we may not want to keep this as a type */
export type MtpPermissionType = "ble:read" | "ble:write" | "sysconfig:read" | "sysconfig:write" | string;

/** A single user-adjustable configuration field. */
export interface MtpConfigField {
  type: MtpConfigType;
  default: MtpValue;
  label?: string;
  description?: string;
  min?: number;
  max?: number;
}

/** Device matching criteria (BLE or Maus-Bus). */
export interface MtpMatch {
  bleNamePrefix?: string;
  bleName?: string;
  bleServiceUUID?: string;
  vid?: number;
  pid?: number;
  serial?: number | null;
}

/**
 * Variable declarations with initial values.
 * Keys are variable names; array variables use `name[size]` syntax.
 * Values are scalars (number/string/boolean) or empty arrays for byte buffers.
 */
export type MtpVariables = Record<string, MtpValue | number[]>;

// --- Functions ----------------------------------------------------------------

/**
 * Function definition: either a bare action list (shorthand for events)
 * or a full object with optional local vars and metadata.
 */
export type MtpFunctionDef = MtpAction[] | MtpFunctionDefObject;

export interface MtpFunctionDefObject {
  comment?: string;
  vars?: MtpVariables;
  args?: string[];
  actions: MtpAction[];
}

// --- Actions ------------------------------------------------------------------

/**
 * A single action in an mt-actions action list.
 * String form is a bare function call (e.g. "@interpret").
 * Object form covers builtins, control flow, and host/user function calls.
 */
export type MtpAction = string | MtpActionObject;

/**
 * Object-form action. Known builtin keys are typed explicitly;
 * host function calls and @user calls use the index signature.
 */
export interface MtpActionObject {
  // --- Variable operations ---
  set?: Record<string, MtpValue> | [string, MtpValue];
  return?: MtpValue;
  inc?: string;
  dec?: string;

  // --- Arithmetic ---
  add?: MtpPair;
  sub?: MtpPair;
  mul?: MtpPair;
  div?: MtpPair;
  mod?: MtpPair;

  // --- Comparison ---
  eq?: MtpPair;
  neq?: MtpPair;
  lt?: MtpPair;
  gt?: MtpPair;
  lte?: MtpPair;
  gte?: MtpPair;

  // --- String operations ---
  strcmp?: MtpPair;
  strlen?: MtpValue;
  charat?: MtpPair;
  concat?: MtpValue[];
  chr?: MtpValue;
  toString?: MtpValue;
  substr?: [MtpValue, MtpValue, MtpValue];

  // --- Byte array operations ---
  getbyte?: MtpPair;
  setbyte?: [MtpValue, MtpValue, MtpValue];

  // --- Rounding ---
  round?: MtpValue;

  // --- Control flow ---
  if?: MtpConditional;
  while?: MtpConditional;

  // --- Result target ---
  to?: string;

  // --- Host/user function calls (extensible) ---
  [key: string]: unknown;
}

// --- Conditions ---------------------------------------------------------------

/** Condition predicate usable in if/while and combinators. */
export interface MtpCondition {
  eq?: MtpPair;
  neq?: MtpPair;
  lt?: MtpPair;
  gt?: MtpPair;
  lte?: MtpPair;
  gte?: MtpPair;
  all?: MtpCondition[];
  any?: MtpCondition[];
  none?: MtpCondition[];
}

/** Conditional block: condition predicate(s) + then/else branches. */
export interface MtpConditional extends MtpCondition {
  then: MtpAction[];
  else?: MtpAction[];
}

// --- Root plugin document -----------------------------------------------------

/**
 * Root plugin document as stored in plugin.json.
 * Hub metadata fields are optional at the type level — structural
 * validation enforces which are required for distribution.
 */
export interface MtpPlugin {
  $schema?: string;

  // Hub metadata
  name?: string;
  version?: string;
  sdkVersion?: string;
  displayName?: string;
  description?: string;
  author?: string;
  license?: string;
  repository?: string;
  signature?: string;

  // Device configuration
  type?: MtpArtifactType;
  platforms?: MtpPlatformType | MtpPlatformType[];
  permissions?: MtpPermissionType | MtpPermissionType[];

  // Device matching
  match?: MtpMatch;

  // Plugin config schema
  config?: Record<string, MtpConfigField>;

  // Global variables
  variables?: MtpVariables;

  // Functions and event handlers
  functions?: Record<string, MtpFunctionDef>;
  events?: Record<string, MtpFunctionDef>;
}
