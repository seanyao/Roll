/**
 * @responsibility Re-exports the canonical cost and currency resolution from @roll/core.
 */
/**
 * Cost/currency resolution — re-export of the canonical port now living in
 * `@roll/core` (`packages/core/src/cost/prices.ts`).
 *
 * The TS port of lib/model_prices.py (`_resolve` / `_resolve_name` /
 * `compute_list_cost` / `currency_for`) originally lived here (the dashboard
 * batch). US-CORE-007 MOVED it into @roll/core so the core domain owns it and
 * cli no longer holds a private copy. cli depends on core (never the reverse),
 * so this file just re-exports the same surface the dashboard imports
 * (`computeListCost`, `currencyFor`) — keeping all existing imports stable.
 */
export { computeListCost, currencyFor } from "@roll/core";
