import type { OverlayDescriptor } from "../types.js";
import {
  gitignoreOverlay,
  githubCiOverlay,
  githubCiReleaseOverlay,
  licenseOverlay,
  readmeOverlay,
} from "./builtins.js";

/**
 * Registry of all built-in overlays, in the order they should appear in
 * interactive prompts.
 */
const BUILT_IN_OVERLAYS: OverlayDescriptor[] = [
  gitignoreOverlay,
  readmeOverlay,
  licenseOverlay,
  githubCiOverlay,
  githubCiReleaseOverlay,
];

/** Overlay registry. */
const registry: Map<string, OverlayDescriptor> = new Map(
  BUILT_IN_OVERLAYS.map((o) => [o.id, o]),
);

/** Register a custom overlay. Throws if an overlay with that ID already exists. */
export function registerOverlay(overlay: OverlayDescriptor): void {
  if (registry.has(overlay.id)) {
    throw new Error(`Overlay "${overlay.id}" is already registered.`);
  }
  registry.set(overlay.id, overlay);
}

/** Return the overlay with the given ID, or undefined. */
export function getOverlay(id: string): OverlayDescriptor | undefined {
  return registry.get(id);
}

/** Return all registered overlays in insertion order. */
export function getAllOverlays(): OverlayDescriptor[] {
  return [...registry.values()];
}

export type { OverlayDescriptor };
