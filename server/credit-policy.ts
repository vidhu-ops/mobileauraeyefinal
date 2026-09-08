/**
 * Single source of truth for billable service pricing.
 *
 * Keep this module free of database access so middleware, storage adapters,
 * reconciliation, and tests all use the same values.
 */
export const CREDIT_COSTS = {
  aura_analysis: 5,
  object_analysis: 1,
  numerology: 1,
  vibe_check: 1,
} as const;

export type BillableServiceType = keyof typeof CREDIT_COSTS;

export function getCreditCostForService(serviceType: string): number {
  return CREDIT_COSTS[serviceType as BillableServiceType] ?? 1;
}

export const BILLABLE_SERVICE_TYPES = Object.keys(CREDIT_COSTS) as BillableServiceType[];