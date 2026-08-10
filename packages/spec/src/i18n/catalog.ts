/**
 * @responsibility Declares the full v2 message catalog generated from the frozen bash catalogs.
 */
/**
 * The full v2 message catalog, mechanically generated from the frozen bash
 * catalogs by scripts/gen-catalog.mjs (oracle: tag v2-freeze-2026-06-04).
 * Do not edit the JSON by hand; new v3 messages get their own catalog module.
 */
import generated from "./catalog.generated.json" with { type: "json" };
import type { Catalog } from "./index.js";

export const v2Catalog: Catalog = generated as Catalog;
