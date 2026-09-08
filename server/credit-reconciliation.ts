import { and, asc, eq } from "drizzle-orm";
import { db } from "./db";
import {
  auraReadings,
  creditGrants,
  creditTransactions,
  numerologyReadings,
  objectAnalyses,
  users,
  vibeReadings,
} from "../shared/schema";
import { consumeCreditGrants } from "./credit-grants";
import { BILLABLE_SERVICE_TYPES, CREDIT_COSTS, type BillableServiceType } from "./credit-policy";

type CreditRow = typeof creditTransactions.$inferSelect;
type UserRow = typeof users.$inferSelect;

export type CreditUserReport = {
  userId: number;
  username: string;
  credits: number;
  transactionCount: number;
  creditsIssued: number;
  creditsUsed: number;
  lastTransactionBalance: number | null;
  lastTransactionAt: Date | null;
  chainMismatches: number;
  usernameMismatches: number;
  grantRemaining: number;
  grantMismatch: boolean;
  serviceActivity: Record<BillableServiceType, number>;
  serviceTransactions: Record<BillableServiceType, number>;
  serviceExpected: number;
  serviceRecorded: number;
  serviceDifference: number;
  negativeBalance: boolean;
};

export type CreditIntegrityReport = {
  generatedAt: string;
  totalUsers: number;
  usersWithCreditData: number;
  totalTransactions: number;
  totalCreditsIssued: number;
  totalCreditsUsed: number;
  chainMismatches: number;
  balanceMismatches: number;
  usernameMismatches: number;
  grantMismatches: number;
  usersWithoutLedger: number;
  negativeBalances: number;
  serviceMismatches: number;
  totalServiceExpected: number;
  totalServiceRecorded: number;
  users: CreditUserReport[];
};

function asNumber(value: unknown) {
  return Number(value || 0);
}

function correctionType(type: string) {
  return type === "ledger_opening" || type === "ledger_reconciliation";
}

type ServiceUsage = {
  activity: Record<BillableServiceType, number>;
  transactions: Record<BillableServiceType, number>;
  recorded: number;
};

function emptyServiceCounts(): Record<BillableServiceType, number> {
  return {
    aura_analysis: 0,
    object_analysis: 0,
    numerology: 0,
    vibe_check: 0,
  };
}

function addActivity(
  map: Map<number, Record<BillableServiceType, number>>,
  service: BillableServiceType,
  userId: number,
  performedBy?: number | null,
) {
  const add = (actorId: number) => {
    const counts = map.get(actorId) || emptyServiceCounts();
    counts[service] += 1;
    map.set(actorId, counts);
  };
  add(userId);
  if (performedBy && performedBy !== userId) add(performedBy);
}

async function getServiceUsage(): Promise<Map<number, ServiceUsage>> {
  const [aura, object, numerology, vibes, transactions] = await Promise.all([
    db.select({ userId: auraReadings.userId, performedBy: auraReadings.performedBy }).from(auraReadings),
    db.select({ userId: objectAnalyses.userId, performedBy: objectAnalyses.performedBy }).from(objectAnalyses),
    db.select({ userId: numerologyReadings.userId, performedBy: numerologyReadings.performedBy }).from(numerologyReadings),
    db.select({ userId: vibeReadings.userId }).from(vibeReadings),
    db.select().from(creditTransactions),
  ]);

  const activity = new Map<number, Record<BillableServiceType, number>>();
  aura.forEach((row) => addActivity(activity, "aura_analysis", row.userId, row.performedBy));
  object.forEach((row) => addActivity(activity, "object_analysis", row.userId, row.performedBy));
  numerology.forEach((row) => addActivity(activity, "numerology", row.userId, row.performedBy));
  vibes.forEach((row) => addActivity(activity, "vibe_check", row.userId));

  const result = new Map<number, ServiceUsage>();
  activity.forEach((counts, userId) => {
    result.set(userId, {
      activity: counts,
      transactions: emptyServiceCounts(),
      recorded: 0,
    });
  });
  for (const transaction of transactions) {
    if (transaction.amount >= 0) continue;
    const service = transaction.transactionType as BillableServiceType;
    if (!BILLABLE_SERVICE_TYPES.includes(service)) continue;
    const usage = result.get(transaction.userId) || {
      activity: emptyServiceCounts(),
      transactions: emptyServiceCounts(),
      recorded: 0,
    };
    usage.transactions[service] += 1;
    usage.recorded += Math.abs(transaction.amount);
    result.set(transaction.userId, usage);
  }
  return result;
}

export async function getCreditIntegrityReport(): Promise<CreditIntegrityReport> {
  const [allUsers, allTransactions, allGrants] = await Promise.all([
    db.select().from(users).orderBy(asc(users.id)),
    db.select().from(creditTransactions).orderBy(asc(creditTransactions.createdAt), asc(creditTransactions.id)),
    db.select().from(creditGrants).orderBy(asc(creditGrants.userId), asc(creditGrants.createdAt), asc(creditGrants.id)),
  ]);
  const serviceUsage = await getServiceUsage();

  const txByUser = new Map<number, CreditRow[]>();
  for (const tx of allTransactions) {
    const rows = txByUser.get(tx.userId) || [];
    rows.push(tx);
    txByUser.set(tx.userId, rows);
  }

  const grantsByUser = new Map<number, typeof allGrants>();
  for (const grant of allGrants) {
    const rows = grantsByUser.get(grant.userId) || [];
    rows.push(grant);
    grantsByUser.set(grant.userId, rows);
  }

  const now = Date.now();
  let chainMismatches = 0;
  let balanceMismatches = 0;
  let usernameMismatches = 0;
  let grantMismatches = 0;
  let usersWithoutLedger = 0;
  let totalCreditsIssued = 0;
  let totalCreditsUsed = 0;
  let negativeBalances = 0;
  let serviceMismatches = 0;
  let totalServiceExpected = 0;
  let totalServiceRecorded = 0;

  const userReports = allUsers.map((user: UserRow): CreditUserReport => {
    const transactions = txByUser.get(user.id) || [];
    const grants = grantsByUser.get(user.id) || [];
    let previousBalance: number | null = null;
    let userChainMismatches = 0;
    let userUsernameMismatches = 0;
    let creditsIssued = 0;
    let creditsUsed = 0;

    for (const transaction of transactions) {
      const amount = asNumber(transaction.amount);
      if (amount > 0) creditsIssued += amount;
      if (amount < 0) creditsUsed += Math.abs(amount);
      if (
        previousBalance !== null &&
        asNumber(transaction.balanceAfter) !== previousBalance + amount
      ) {
        userChainMismatches += 1;
      }
      if (transaction.username !== user.username) userUsernameMismatches += 1;
      previousBalance = asNumber(transaction.balanceAfter);
    }

    const grantRemaining = grants
      .filter((grant) => grant.remaining > 0 && (!grant.expiresAt || new Date(grant.expiresAt).getTime() > now))
      .reduce((sum, grant) => sum + asNumber(grant.remaining), 0);

    const currentCredits = asNumber(user.credits);
    const usage = serviceUsage.get(user.id) || {
      activity: emptyServiceCounts(),
      transactions: emptyServiceCounts(),
      recorded: 0,
    };
    const serviceExpected = BILLABLE_SERVICE_TYPES.reduce(
      (sum, service) => sum + usage.activity[service] * CREDIT_COSTS[service],
      0,
    );
    const serviceDifference = usage.recorded - serviceExpected;
    totalServiceExpected += serviceExpected;
    totalServiceRecorded += usage.recorded;
    if (serviceDifference !== 0 || BILLABLE_SERVICE_TYPES.some((service) => usage.activity[service] !== usage.transactions[service])) {
      serviceMismatches += 1;
    }
    if (currentCredits < 0) negativeBalances += 1;
    // A negative balance is a debt, not an unrepresented positive grant.
    const grantMismatch = currentCredits >= 0
      ? grantRemaining !== currentCredits
      : grantRemaining !== 0;
    if (transactions.length === 0 && currentCredits !== 0) usersWithoutLedger += 1;
    if (previousBalance !== null && previousBalance !== currentCredits) balanceMismatches += 1;
    if (userChainMismatches) chainMismatches += userChainMismatches;
    if (userUsernameMismatches) usernameMismatches += userUsernameMismatches;
    if (grantMismatch) grantMismatches += 1;
    totalCreditsIssued += creditsIssued;
    totalCreditsUsed += creditsUsed;

    return {
      userId: user.id,
      username: user.username,
      credits: currentCredits,
      transactionCount: transactions.length,
      creditsIssued,
      creditsUsed,
      lastTransactionBalance: previousBalance,
      lastTransactionAt: transactions[transactions.length - 1]?.createdAt || null,
      chainMismatches: userChainMismatches,
      usernameMismatches: userUsernameMismatches,
      grantRemaining,
      grantMismatch,
      serviceActivity: usage.activity,
      serviceTransactions: usage.transactions,
      serviceExpected,
      serviceRecorded: usage.recorded,
      serviceDifference,
      negativeBalance: currentCredits < 0,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    totalUsers: allUsers.length,
    usersWithCreditData: userReports.filter((user) => user.transactionCount > 0 || user.credits !== 0).length,
    totalTransactions: allTransactions.length,
    totalCreditsIssued,
    totalCreditsUsed,
    chainMismatches,
    balanceMismatches,
    usernameMismatches,
    grantMismatches,
    usersWithoutLedger,
    negativeBalances,
    serviceMismatches,
    totalServiceExpected,
    totalServiceRecorded,
    users: userReports,
  };
}

export type ServiceCreditCorrectionResult = {
  usersProcessed: number;
  usersChanged: number;
  missingServiceTransactions: number;
  policyAdjustments: number;
  creditsAddedBack: number;
  creditsDebited: number;
  changedUsers: Array<{ userId: number; username: string; balanceBefore: number; balanceAfter: number }>;
};

/**
 * Corrects the one-time historical mismatch found by the production audit.
 *
 * Missing service uses are written as normal service transactions so the
 * activity and ledger counts agree. Price changes are then represented by one
 * explicit positive/negative policy adjustment. Existing transaction amounts
 * are never rewritten. The marker transaction makes this safe to repeat.
 */
export async function reconcileHistoricalServiceCredits(): Promise<ServiceCreditCorrectionResult> {
  const [allUsers, usageByUser] = await Promise.all([
    db.select().from(users).orderBy(asc(users.id)),
    getServiceUsage(),
  ]);
  let usersChanged = 0;
  let missingServiceTransactions = 0;
  let policyAdjustments = 0;
  let creditsAddedBack = 0;
  let creditsDebited = 0;
  const changedUsers: ServiceCreditCorrectionResult["changedUsers"] = [];

  for (const user of allUsers) {
    const usage = usageByUser.get(user.id);
    if (!usage) continue;
    const markers = await db
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.userId, user.id),
          eq(creditTransactions.transactionType, "credit_policy_reconciliation"),
        ),
      );
    if (markers.length > 0) continue;

    const missingByService = emptyServiceCounts();
    let missingCharge = 0;
    for (const service of BILLABLE_SERVICE_TYPES) {
      missingByService[service] = Math.max(0, usage.activity[service] - usage.transactions[service]);
      missingCharge += missingByService[service] * CREDIT_COSTS[service];
    }
    const expected = BILLABLE_SERVICE_TYPES.reduce(
      (sum, service) => sum + usage.activity[service] * CREDIT_COSTS[service],
      0,
    );
    const policyAdjustment = usage.recorded + missingCharge - expected;
    if (missingCharge === 0 && policyAdjustment === 0) continue;

    const change = await db.transaction(async (tx) => {
      const [lockedUser] = await tx.select().from(users).where(eq(users.id, user.id)).for("update");
      if (!lockedUser) return null;
      let balance = asNumber(lockedUser.credits);
      let missingRows = 0;

      for (const service of BILLABLE_SERVICE_TYPES) {
        for (let i = 0; i < missingByService[service]; i += 1) {
          const amount = -CREDIT_COSTS[service];
          balance += amount;
          await consumeCreditGrants(user.id, -amount, tx);
          await tx.insert(creditTransactions).values({
            userId: user.id,
            username: lockedUser.username,
            amount,
            transactionType: service,
            description: `Historical reconciliation: missing ${service} usage ${i + 1}/${missingByService[service]}`,
            balanceAfter: balance,
          });
          missingRows += 1;
        }
      }

      if (policyAdjustment !== 0) {
        balance += policyAdjustment;
        if (policyAdjustment > 0) {
          await tx.insert(creditGrants).values({
            userId: user.id,
            amount: policyAdjustment,
            remaining: policyAdjustment,
            expiresAt: null,
            source: "credit_policy_reconciliation",
            note: "Refund for historical service pricing difference",
            createdByUserId: null,
          });
        } else {
          await consumeCreditGrants(user.id, Math.abs(policyAdjustment), tx);
        }
      }

      await tx.update(users).set({ credits: balance }).where(eq(users.id, user.id));
      await tx.insert(creditTransactions).values({
        userId: user.id,
        username: lockedUser.username,
        amount: policyAdjustment,
        transactionType: "credit_policy_reconciliation",
        description: `Historical service policy correction: expected ${expected}, recorded ${usage.recorded}, missing-service charges ${missingCharge}`,
        balanceAfter: balance,
      });
      return { before: asNumber(lockedUser.credits), after: balance, missingRows };
    });

    if (change) {
      usersChanged += 1;
      missingServiceTransactions += change.missingRows;
      if (policyAdjustment > 0) creditsAddedBack += policyAdjustment;
      if (policyAdjustment < 0) creditsDebited += Math.abs(policyAdjustment);
      policyAdjustments += 1;
      changedUsers.push({
        userId: user.id,
        username: user.username,
        balanceBefore: change.before,
        balanceAfter: change.after,
      });
    }
  }

  return {
    usersProcessed: allUsers.length,
    usersChanged,
    missingServiceTransactions,
    policyAdjustments,
    creditsAddedBack,
    creditsDebited,
    changedUsers,
  };
}

export type ReconciliationResult = {
  generatedAt: string;
  usersProcessed: number;
  usersChanged: number;
  changedUsers: Array<{ userId: number; username: string }>;
  transactionsRepaired: number;
  openingTransactionsAdded: number;
  grantsAdded: number;
  usernamesRepaired: number;
  report: CreditIntegrityReport;
};

/**
 * Rebuilds running balance snapshots without changing the current users.credits
 * value. Existing usage amounts are preserved. A transparent opening entry is
 * added when legacy history lacks the original starting balance.
 */
export async function reconcileAllCreditLedgers(): Promise<ReconciliationResult> {
  const allUsers = await db.select().from(users).orderBy(asc(users.id));
  let usersChanged = 0;
  let transactionsRepaired = 0;
  let openingTransactionsAdded = 0;
  let grantsAdded = 0;
  let usernamesRepaired = 0;
  const changedUsers: Array<{ userId: number; username: string }> = [];

  for (const user of allUsers) {
    const changed = await db.transaction(async (tx) => {
      const [lockedUser] = await tx.select().from(users).where(eq(users.id, user.id)).for("update");
      if (!lockedUser) return false;
      let didChange = false;

      const transactions = await tx
        .select()
        .from(creditTransactions)
        .where(eq(creditTransactions.userId, user.id))
        .orderBy(asc(creditTransactions.createdAt), asc(creditTransactions.id));
      const sourceTransactions = transactions.filter((row) => !correctionType(row.transactionType));
      const currentCredits = asNumber(lockedUser.credits);
      const netAmount = sourceTransactions.reduce((sum, row) => sum + asNumber(row.amount), 0);
      const openingAmount = currentCredits - netAmount;
      const firstSourceAt = sourceTransactions[0]?.createdAt
        ? new Date(sourceTransactions[0].createdAt).getTime() - 1
        : new Date(lockedUser.createdAt).getTime();

      let opening = transactions.find((row) => row.transactionType === "ledger_opening");
      if (opening) {
        if (
          asNumber(opening.amount) !== openingAmount ||
          asNumber(opening.balanceAfter) !== openingAmount ||
          opening.username !== lockedUser.username ||
          new Date(opening.createdAt).getTime() !== firstSourceAt
        ) {
          await tx
            .update(creditTransactions)
            .set({
              username: lockedUser.username,
              amount: openingAmount,
              description: "Opening balance reconstructed from the current balance and recorded history",
              balanceAfter: openingAmount,
              createdAt: new Date(firstSourceAt),
            })
            .where(eq(creditTransactions.id, opening.id));
          didChange = true;
        }
      } else if (openingAmount !== 0 || (sourceTransactions.length === 0 && currentCredits !== 0)) {
        const [created] = await tx
          .insert(creditTransactions)
          .values({
            userId: user.id,
            username: lockedUser.username,
            amount: openingAmount,
            transactionType: "ledger_opening",
            description: "Opening balance reconstructed from the current balance and recorded history",
            balanceAfter: openingAmount,
            createdAt: new Date(firstSourceAt),
          })
          .returning();
        opening = created;
        openingTransactionsAdded += 1;
        didChange = true;
      }

      let runningBalance = opening ? asNumber(openingAmount) : 0;
      for (const row of sourceTransactions) {
        const nextBalance = runningBalance + asNumber(row.amount);
        if (row.username !== lockedUser.username) usernamesRepaired += 1;
        if (asNumber(row.balanceAfter) !== nextBalance || row.username !== lockedUser.username) {
          await tx
            .update(creditTransactions)
            .set({
              username: lockedUser.username,
              balanceAfter: nextBalance,
            })
            .where(eq(creditTransactions.id, row.id));
          transactionsRepaired += 1;
          didChange = true;
        }
        runningBalance = nextBalance;
      }

      // A prior reconciliation entry is kept in the history but normalized to
      // the final balance so repeated runs remain idempotent.
      for (const row of transactions.filter((item) => item.transactionType === "ledger_reconciliation")) {
        if (row.username !== lockedUser.username || asNumber(row.balanceAfter) !== currentCredits) {
          await tx
            .update(creditTransactions)
            .set({ username: lockedUser.username, balanceAfter: currentCredits })
            .where(eq(creditTransactions.id, row.id));
          transactionsRepaired += 1;
          didChange = true;
        }
      }

      const grants = await tx
        .select()
        .from(creditGrants)
        .where(eq(creditGrants.userId, user.id))
        .orderBy(asc(creditGrants.createdAt), asc(creditGrants.id));
      const activeRemaining = grants
        .filter((grant) => grant.remaining > 0 && (!grant.expiresAt || new Date(grant.expiresAt).getTime() > Date.now()))
        .reduce((sum, grant) => sum + asNumber(grant.remaining), 0);

      if (grants.length === 0 && currentCredits > 0) {
        await tx.insert(creditGrants).values({
          userId: user.id,
          amount: currentCredits,
          remaining: currentCredits,
          expiresAt: null,
          source: "legacy_reconciliation",
          note: "Legacy balance migrated without changing the current balance",
          createdByUserId: null,
        });
        grantsAdded += 1;
        didChange = true;
      } else if (activeRemaining < currentCredits) {
        await tx.insert(creditGrants).values({
          userId: user.id,
          amount: currentCredits - activeRemaining,
          remaining: currentCredits - activeRemaining,
          expiresAt: null,
          source: "legacy_reconciliation",
          note: "Grant balance completed to match the current user balance",
          createdByUserId: null,
        });
        grantsAdded += 1;
        didChange = true;
      }

      return didChange;
    });
    if (changed) {
      usersChanged += 1;
      changedUsers.push({ userId: user.id, username: user.username });
    }
  }

  const report = await getCreditIntegrityReport();
  return {
    generatedAt: new Date().toISOString(),
    usersProcessed: allUsers.length,
    usersChanged,
    changedUsers,
    transactionsRepaired,
    openingTransactionsAdded,
    grantsAdded,
    usernamesRepaired,
    report,
  };
}