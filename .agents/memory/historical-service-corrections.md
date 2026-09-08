---
name: Historical service credit corrections
description: Durable accounting rules for repairing activity and credit-transaction mismatches.
---

Historical service repairs must preserve original transactions. Missing billable activity should be represented by new service transaction rows at the current canonical cost; old pricing differences should then be represented by a separate positive or negative policy-adjustment transaction. Use a stable per-user marker so the correction cannot run twice. Non-billable services must be explicit zero-cost policy entries and must not create zero-value deductions or provider credit grants.

**Why:** Rewriting old amounts hides the audit trail, while a single net adjustment leaves activity counts and service usage history inconsistent.

**How to apply:** Run the correction only through an explicit owner-controlled reconciliation action, then run ledger-chain reconciliation so balances, grants, and transaction snapshots agree. Paid activity routes should charge before persistence and compensate with a refund if persistence fails. Negative balances are valid debt and must remain visible rather than being clamped to zero.