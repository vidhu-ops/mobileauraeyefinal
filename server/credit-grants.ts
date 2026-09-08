import { and, asc, eq, gt, isNotNull, lt, or, sql } from "drizzle-orm";
import { db } from "./db";
import { creditGrants, creditTransactions, users } from "../shared/schema";

export function daysFromNow(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

/** Zero out expired grant remainings and deduct from the user's credit balance. */
export async function expireCreditsForUser(userId: number): Promise<number> {
  try {
    return await db.transaction(async (tx) => {
      const now = new Date();
      const expired = await tx
        .select()
        .from(creditGrants)
        .where(
          and(
            eq(creditGrants.userId, userId),
            gt(creditGrants.remaining, 0),
            isNotNull(creditGrants.expiresAt),
            lt(creditGrants.expiresAt, now)
          )
        );

      if (!expired.length) return 0;

      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
      if (!user) return 0;

      let totalExpired = 0;
      for (const grant of expired) {
        totalExpired += grant.remaining;
        await tx
          .update(creditGrants)
          .set({ remaining: 0, expiredAt: now })
          .where(eq(creditGrants.id, grant.id));
      }

      // Preserve a negative balance. Expiry must not erase an existing debt.
      const newCredits = Number(user.credits ?? 0) - totalExpired;
      await tx.update(users).set({ credits: newCredits }).where(eq(users.id, userId));
      await tx.insert(creditTransactions).values({
        userId,
        username: user.username,
        amount: -totalExpired,
        transactionType: "expire",
        description: `Credits expired (${expired.length} grant${expired.length === 1 ? "" : "s"})`,
        balanceAfter: newCredits,
      });
      return totalExpired;
    });
  } catch (error) {
    // Table may not exist yet on older DBs — fail soft
    console.error("expireCreditsForUser failed:", error);
    return 0;
  }
}

/** Create a grant and optionally bump users.credits. */
export async function addCreditGrant(params: {
  userId: number;
  amount: number;
  expiresAt?: Date | null;
  source?: string;
  note?: string;
  createdByUserId?: number | null;
  updateBalance?: boolean;
  transactionType?: string;
}): Promise<{ grantId: number; creditsAfter: number } | null> {
  const amount = Math.floor(Number(params.amount));
  if (!amount || amount <= 0) return null;

  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, params.userId)).for("update");
      if (!user) return null;

      const updateBalance = params.updateBalance !== false;
      const creditsAfter = updateBalance ? Number(user.credits || 0) + amount : Number(user.credits || 0);

      if (updateBalance) {
        await tx.update(users).set({ credits: creditsAfter }).where(eq(users.id, params.userId));
        await tx.insert(creditTransactions).values({
          userId: params.userId,
          username: user.username,
          amount,
          transactionType: params.transactionType || params.source || "admin_add",
          description:
            params.note ||
            (params.expiresAt
              ? `Credit grant expires ${params.expiresAt.toISOString().slice(0, 10)}`
              : "Credit grant (no expiry)"),
          balanceAfter: creditsAfter,
        });
      }

      const [grant] = await tx
        .insert(creditGrants)
        .values({
          userId: params.userId,
          amount,
          remaining: amount,
          expiresAt: params.expiresAt ?? null,
          source: params.source || "manual",
          note: params.note || null,
          createdByUserId: params.createdByUserId ?? null,
        })
        .returning();

      return { grantId: grant.id, creditsAfter };
    });
  } catch (error) {
    console.error("addCreditGrant failed:", error);
    return null;
  }
}

/** FIFO consume remaining from active (non-expired) grants. */
export async function consumeCreditGrants(userId: number, amount: number, tx?: any): Promise<void> {
  const runner = tx ?? db;
  const run = async (client: any) => {
    const now = new Date();
    const grants = await client
      .select()
      .from(creditGrants)
      .where(
        and(
          eq(creditGrants.userId, userId),
          gt(creditGrants.remaining, 0),
          or(sql`${creditGrants.expiresAt} IS NULL`, gt(creditGrants.expiresAt, now))
        )
      )
      .orderBy(asc(sql`coalesce(${creditGrants.expiresAt}, '9999-12-31')`), asc(creditGrants.id));

    let left = amount;
    for (const grant of grants) {
      if (left <= 0) break;
      const take = Math.min(grant.remaining, left);
      await client
        .update(creditGrants)
        .set({ remaining: grant.remaining - take })
        .where(eq(creditGrants.id, grant.id));
      left -= take;
    }
  };

  try {
    if (tx) {
      await run(tx);
    } else {
      await db.transaction(async (client) => run(client));
    }
  } catch (error) {
    console.error("consumeCreditGrants failed:", error);
  }
}

export async function listCreditGrants(userId: number) {
  try {
    await expireCreditsForUser(userId);
    return await db
      .select()
      .from(creditGrants)
      .where(eq(creditGrants.userId, userId))
      .orderBy(asc(sql`coalesce(${creditGrants.expiresAt}, '9999-12-31')`), asc(creditGrants.id));
  } catch (error) {
    console.error("listCreditGrants failed:", error);
    return [];
  }
}

/** Replace active grants when CRM "sets" an absolute credit balance. */
export async function replaceCreditBalance(params: {
  userId: number;
  newCredits: number;
  expiresAt?: Date | null;
  createdByUserId?: number | null;
  note?: string;
}): Promise<number> {
  const newCredits = Math.floor(Number(params.newCredits));
  return await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, params.userId)).for("update");
    if (!user) throw new Error("User not found");

    const before = Number(user.credits || 0);
    // Zero remaining on all existing grants (balance is being replaced)
    await tx
      .update(creditGrants)
      .set({ remaining: 0 })
      .where(and(eq(creditGrants.userId, params.userId), gt(creditGrants.remaining, 0)));

    await tx.update(users).set({ credits: newCredits }).where(eq(users.id, params.userId));
    await tx.insert(creditTransactions).values({
      userId: params.userId,
      username: user.username,
      amount: newCredits - before,
      transactionType: "admin_set",
      description: params.note || "CRM credit set",
      balanceAfter: newCredits,
    });

    if (newCredits > 0) {
      await tx.insert(creditGrants).values({
        userId: params.userId,
        amount: newCredits,
        remaining: newCredits,
        expiresAt: params.expiresAt ?? null,
        source: "admin_set",
        note: params.note || null,
        createdByUserId: params.createdByUserId ?? null,
      });
    }

    return newCredits;
  });
}
