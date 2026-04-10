import { allSkus as runtimeAllSkus, getProductCatalog } from "@maustec/mt-runtimes";

/**
 * Maps @family shorthand aliases to their mt-runtimes product key.
 * The product key is what mt-runtimes uses internally in catalog.json.
 * TODO: Migrate this to mt-runtimes so that the SDK no longer maintains a
 * separate mapping of @family aliases to product keys.
 */
const FAMILY_ALIASES: Readonly<Record<string, string>> = {
  "@eom": "edge-o-matic",
  "@mercury": "mercury",
};

/**
 * Resolve a single platform reference - either a concrete SKU ("EOM3K")
 * or a @family shorthand ("@eom") - to the list of concrete SKUs it covers.
 *
 * SKU matching is case-insensitive; the returned values are always uppercase.
 */
export function resolvePlatformRef(ref: string): string[] {
  if (ref.startsWith("@")) {
    const productKey = FAMILY_ALIASES[ref.toLowerCase()];
    if (!productKey) {
      throw new Error(
        `Unknown platform family: "${ref}". Known families: ${Object.keys(FAMILY_ALIASES).join(", ")}`,
      );
    }
    return Object.keys(getProductCatalog(productKey).skus);
  }

  const upper = ref.toUpperCase();
  if (!runtimeAllSkus().includes(upper)) {
    throw new Error(
      `Unknown SKU: "${ref}". Known SKUs: ${runtimeAllSkus().join(", ")}`,
    );
  }
  return [upper];
}

/**
 * Resolve a platforms list (mix of SKUs and @family shorthands) to a
 * deduplicated list of concrete SKUs, preserving order of first appearance.
 */
export function resolvePlatforms(platforms: string[]): string[] {
  const seen = new Set<string>();
  for (const ref of platforms) {
    for (const sku of resolvePlatformRef(ref)) {
      seen.add(sku);
    }
  }
  return [...seen];
}

/**
 * Returns true if the given SKU is covered by the platforms list.
 * An absent or empty platforms array means "unspecified" - matches any SKU.
 */
export function platformMatches(
  platforms: string[] | undefined,
  sku: string,
): boolean {
  if (!platforms || platforms.length === 0) return true;
  return resolvePlatforms(platforms).includes(sku.toUpperCase());
}

/** All SKUs known to the mt-runtimes catalog. */
export function allKnownSkus(): string[] {
  return runtimeAllSkus();
}

/** All registered @family shorthand aliases (e.g. ["@eom", "@mercury"]). */
export function allFamilyAliases(): string[] {
  return Object.keys(FAMILY_ALIASES);
}

/**
 * Return the @family alias whose SKU list includes the given SKU, if any.
 * For example, familyForSku("EOM3K") returns "@eom".
 */
export function familyForSku(sku: string): string | undefined {
  const upper = sku.toUpperCase();
  for (const [alias, productKey] of Object.entries(FAMILY_ALIASES)) {
    if (upper in getProductCatalog(productKey).skus) return alias;
  }
  return undefined;
}
