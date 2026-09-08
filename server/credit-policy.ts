/**
 * Single source of truth for billable service pricing.
 *
 * Keep this module free of database access so middleware, storage adapters,
 * reconciliation, and tests all use the same values.
 */
export const CREDIT_COSTS = {
  aura_analysis: 5,
  object_analysis: 1,
  numerology: 3,
  vibe_check: 1,
} as const;

export type BillableServiceType = keyof typeof CREDIT_COSTS;

// Increment this when a pricing-policy change requires a fresh historical
// reconciliation pass. Older correction markers remain auditable but do not
// prevent the new policy from being applied.
export const CREDIT_POLICY_VERSION = "numerology-3";
export const CREDIT_POLICY_RECONCILIATION_MARKER =
  `credit_policy_reconciliation_${CREDIT_POLICY_VERSION}`;

export function getCreditCostForService(serviceType: string): number {
  return CREDIT_COSTS[serviceType as BillableServiceType] ?? 1;
}

export const BILLABLE_SERVICE_TYPES = Object.keys(CREDIT_COSTS) as BillableServiceType[];