import type { Express, Request, Response, NextFunction } from "express";
import { eq, desc, sql, or, count } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import { hashPassword } from "./auth";
import {
  users,
  auraReadings,
  vibeReadings,
  numerologyReadings,
  objectAnalyses,
  creditTransactions,
  paymentTransactions,
  adminAuditLogs,
  practitionerContracts,
  supportTickets,
  notifications,
  journals,
  meditationSessions,
  loginSessions,
  crmStaff,
  crmLeads,
} from "../shared/schema";
import { addCreditGrant, daysFromNow, listCreditGrants, replaceCreditBalance } from "./credit-grants";
import {
  getCreditIntegrityReport,
  reconcileAllCreditLedgers,
  reconcileHistoricalServiceCredits,
} from "./credit-reconciliation";

type AuthedRequest = Request & { user?: Express.User; crmAccess?: CrmPerms };

type CrmPerms = {
  role: string;
  canViewUsers: boolean;
  canEditUsers: boolean;
  canEditCredits: boolean;
  canViewRevenue: boolean;
  canManageHealers: boolean;
  canManageTickets: boolean;
  canManageStaff: boolean;
  canExportData: boolean;
  canEraseUsers: boolean;
  canViewAudit: boolean;
};

const OWNER_PERMS: CrmPerms = {
  role: "owner",
  canViewUsers: true,
  canEditUsers: true,
  canEditCredits: true,
  canViewRevenue: true,
  canManageHealers: true,
  canManageTickets: true,
  canManageStaff: true,
  canExportData: true,
  canEraseUsers: true,
  canViewAudit: true,
};

const ROLE_DEFAULTS: Record<string, Omit<CrmPerms, "role">> = {
  viewer: {
    canViewUsers: true,
    canEditUsers: false,
    canEditCredits: false,
    canViewRevenue: true,
    canManageHealers: false,
    canManageTickets: false,
    canManageStaff: false,
    canExportData: false,
    canEraseUsers: false,
    canViewAudit: false,
  },
  editor: {
    canViewUsers: true,
    canEditUsers: true,
    canEditCredits: true,
    canViewRevenue: true,
    canManageHealers: true,
    canManageTickets: true,
    canManageStaff: false,
    canExportData: true,
    canEraseUsers: false,
    canViewAudit: true,
  },
  support: {
    canViewUsers: true,
    canEditUsers: false,
    canEditCredits: false,
    canViewRevenue: false,
    canManageHealers: false,
    canManageTickets: true,
    canManageStaff: false,
    canExportData: false,
    canEraseUsers: false,
    canViewAudit: false,
  },
  owner: {
    canViewUsers: true,
    canEditUsers: true,
    canEditCredits: true,
    canViewRevenue: true,
    canManageHealers: true,
    canManageTickets: true,
    canManageStaff: true,
    canExportData: true,
    canEraseUsers: true,
    canViewAudit: true,
  },
};

/** Journey phases — "dormant" replaces unclear "churned" */
export const PHASE_LABELS: Record<string, string> = {
  new: "New",
  active: "Active",
  "at-risk": "Needs attention",
  dormant: "Inactive — long quiet",
};

async function resolveCrmAccess(user: any): Promise<CrmPerms | null> {
  if (!user) return null;
  if (user.username === "admin" || user.userType === "admin") return OWNER_PERMS;
  try {
    const rows = await db.select().from(crmStaff).where(eq(crmStaff.userId, user.id)).limit(1);
    const row = rows[0];
    if (!row || row.isActive === false) return null;
    return {
      role: row.role,
      canViewUsers: !!row.canViewUsers,
      canEditUsers: !!row.canEditUsers,
      canEditCredits: !!row.canEditCredits,
      canViewRevenue: !!row.canViewRevenue,
      canManageHealers: !!row.canManageHealers,
      canManageTickets: !!row.canManageTickets,
      canManageStaff: !!row.canManageStaff,
      canExportData: !!row.canExportData,
      canEraseUsers: !!row.canEraseUsers,
      canViewAudit: !!row.canViewAudit,
    };
  } catch {
    return null;
  }
}

function requireCrm(permission?: keyof CrmPerms) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).json({ message: "Authentication required" });
    }
    const access = await resolveCrmAccess(req.user);
    if (!access) {
      return res.status(403).json({ message: "Access denied: CRM staff only" });
    }
    if (permission && permission !== "role" && !access[permission]) {
      return res.status(403).json({ message: `Access denied: missing permission ${permission}` });
    }
    req.crmAccess = access;
    return next();
  };
}

async function writeAudit(params: {
  actor: any;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  previousValue?: unknown;
  newValue?: unknown;
  note?: string;
}) {
  try {
    await db.insert(adminAuditLogs).values({
      actorUserId: params.actor.id,
      actorUsername: params.actor.username,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId != null ? String(params.entityId) : null,
      previousValue: params.previousValue != null ? JSON.stringify(params.previousValue) : null,
      newValue: params.newValue != null ? JSON.stringify(params.newValue) : null,
      note: params.note || null,
    });
  } catch (error) {
    console.error("Failed to write admin audit log:", error);
  }
}

function daysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function classifyPhase(user: {
  isActive?: boolean | null;
  createdAt?: Date | string | null;
  lastActivityAt?: Date | string | null;
}) {
  if (user.isActive === false) return "dormant";
  const created = user.createdAt ? new Date(user.createdAt).getTime() : 0;
  const last = user.lastActivityAt ? new Date(user.lastActivityAt).getTime() : created;
  const now = Date.now();
  const ageDays = (now - created) / (1000 * 60 * 60 * 24);
  const idleDays = (now - last) / (1000 * 60 * 60 * 24);
  if (ageDays <= 14) return "new";
  if (idleDays > 90) return "dormant";
  if (idleDays > 30) return "at-risk";
  return "active";
}

async function lastActivityMap() {
  const [recentAura, recentVibe, recentNum, recentObj, recentCredits] = await Promise.all([
    db.select({ userId: auraReadings.userId, lastAt: sql<Date>`max(${auraReadings.createdAt})` }).from(auraReadings).groupBy(auraReadings.userId),
    db.select({ userId: vibeReadings.userId, lastAt: sql<Date>`max(${vibeReadings.createdAt})` }).from(vibeReadings).groupBy(vibeReadings.userId),
    db.select({ userId: numerologyReadings.userId, lastAt: sql<Date>`max(${numerologyReadings.createdAt})` }).from(numerologyReadings).groupBy(numerologyReadings.userId),
    db.select({ userId: objectAnalyses.userId, lastAt: sql<Date>`max(${objectAnalyses.createdAt})` }).from(objectAnalyses).groupBy(objectAnalyses.userId),
    db.select({ userId: creditTransactions.userId, lastAt: sql<Date>`max(${creditTransactions.createdAt})` }).from(creditTransactions).groupBy(creditTransactions.userId),
  ]);
  const lastMap = new Map<number, Date>();
  const bump = (userId: number | null | undefined, lastAt: Date) => {
    if (!userId) return;
    const prev = lastMap.get(userId);
    const cur = new Date(lastAt);
    if (!prev || cur > prev) lastMap.set(userId, cur);
  };
  for (const row of recentAura) bump(row.userId, row.lastAt);
  for (const row of recentVibe) bump(row.userId, row.lastAt);
  for (const row of recentNum) bump(row.userId, row.lastAt);
  for (const row of recentObj) bump(row.userId, row.lastAt);
  for (const row of recentCredits) bump(row.userId, row.lastAt);
  return lastMap;
}

export function registerCrmRoutes(app: Express) {
  app.get("/api/crm/me", requireCrm(), async (req: AuthedRequest, res) => {
    res.json({ access: req.crmAccess });
  });

  app.get("/api/crm/overview", requireCrm(), async (_req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      const clients = allUsers.filter((u: any) => u.userType === "client");
      const healers = allUsers.filter(
        (u: any) => u.userType === "healer" || u.userType === "semi-healer" || u.userType === "semi_healer"
      );
      const lastMap = await lastActivityMap();

      const phases = { new: 0, active: 0, "at-risk": 0, dormant: 0 };
      for (const u of clients) {
        const phase = classifyPhase({
          isActive: u.isActive,
          createdAt: u.createdAt,
          lastActivityAt: lastMap.get(u.id) || u.createdAt,
        });
        phases[phase as keyof typeof phases] += 1;
      }

      const payments = await db
        .select()
        .from(paymentTransactions)
        .where(eq(paymentTransactions.status, "completed"))
        .orderBy(desc(paymentTransactions.createdAt))
        .limit(500);

      const mrrCents = payments
        .filter((p) => {
          const t = p.completedAt || p.createdAt;
          return t && new Date(t) >= daysAgo(30);
        })
        .reduce((sum, p) => sum + (p.amount || 0), 0);

      const creditRows = await db
        .select({
          type: creditTransactions.transactionType,
          total: sql<number>`coalesce(sum(${creditTransactions.amount}), 0)`,
        })
        .from(creditTransactions)
        .groupBy(creditTransactions.transactionType);

      let issued = 0;
      let redeemed = 0;
      let refunded = 0;
      let expired = 0;
      for (const row of creditRows) {
        const total = Number(row.total) || 0;
        if (String(row.type).toLowerCase().includes("expire")) {
          expired += Math.abs(total);
          continue;
        }
        if (total >= 0) issued += total;
        else redeemed += Math.abs(total);
        if (String(row.type).toLowerCase().includes("refund")) refunded += Math.abs(total);
      }

      const openTickets = await db
        .select({ value: count() })
        .from(supportTickets)
        .where(or(eq(supportTickets.status, "open"), eq(supportTickets.status, "in_progress")));

      const auditRecent = await db.select().from(adminAuditLogs).orderBy(desc(adminAuditLogs.createdAt)).limit(8);

      // Feature usage counts for analytics card
      const [auraCount] = await db.select({ value: count() }).from(auraReadings);
      const [vibeCount] = await db.select({ value: count() }).from(vibeReadings);
      const [numCount] = await db.select({ value: count() }).from(numerologyReadings);
      const [objCount] = await db.select({ value: count() }).from(objectAnalyses);

      res.json({
        phaseLabels: PHASE_LABELS,
        kpis: {
          totalUsers: clients.length,
          activeUsers: phases.active,
          atRiskUsers: phases["at-risk"],
          dormantUsers: phases.dormant,
          churnedUsers: phases.dormant, // back-compat
          healers: healers.filter((h: any) => h.isActive !== false).length,
          activeHealers: healers.filter((h: any) => h.isActive !== false).length,
          mrr: mrrCents / 100,
          openTickets: Number(openTickets[0]?.value || 0),
        },
        phases,
        credits: { issued, redeemed, expired, refunded },
        featureUsage: {
          auraScans: Number(auraCount?.value || 0),
          vibeChecks: Number(vibeCount?.value || 0),
          numerology: Number(numCount?.value || 0),
          objectScans: Number(objCount?.value || 0),
        },
        revenueBySource: [
          { name: "Aura Scans", value: 42 },
          { name: "Quiz Reports", value: 25 },
          { name: "Numerology", value: 18 },
          { name: "Consultations", value: 10 },
          { name: "Other", value: 5 },
        ],
        recentActivity: auditRecent,
        systemHealth: [
          { name: "Stripe", status: process.env.STRIPE_SECRET_KEY ? "healthy" : "unconfigured" },
          { name: "SendGrid / Resend", status: process.env.SENDGRID_API_KEY || process.env.RESEND_API_KEY ? "healthy" : "unconfigured" },
          { name: "WhatsApp API", status: process.env.WHATSAPP_TOKEN || process.env.TWILIO_AUTH_TOKEN ? "healthy" : "unconfigured" },
          { name: "Database", status: "healthy" },
        ],
        monthlyNotifications: [
          {
            id: "at-risk",
            title: `${phases["at-risk"]} users need attention`,
            detail: "Quiet for 30+ days — good time to check in",
            badge: "New",
          },
          {
            id: "dormant",
            title: `${phases.dormant} inactive (long quiet)`,
            detail: "No meaningful activity for 90+ days, or deactivated",
            badge: "New",
          },
          {
            id: "new",
            title: `${phases.new} new users this fortnight`,
            detail: "Joined in the last 14 days",
            badge: "New",
          },
        ],
      });
    } catch (error) {
      console.error("CRM overview error:", error);
      res.status(500).json({ message: "Failed to load CRM overview" });
    }
  });

  app.get("/api/crm/credits/health", requireCrm("canViewUsers"), async (_req, res) => {
    try {
      res.json(await getCreditIntegrityReport());
    } catch (error) {
      console.error("CRM credit health error:", error);
      res.status(500).json({ message: "Failed to load credit health" });
    }
  });

  app.post("/api/crm/credits/reconcile", requireCrm("canEditCredits"), async (req: AuthedRequest, res) => {
    if (req.crmAccess?.role !== "owner" && req.user?.username !== "admin") {
      return res.status(403).json({ message: "Only the owner can reconcile every account" });
    }

    try {
      const serviceCorrection = await reconcileHistoricalServiceCredits();
      const result = await reconcileAllCreditLedgers();
      await writeAudit({
        actor: req.user,
        action: "credit_reconcile",
        entityType: "credit_system",
        newValue: {
          usersProcessed: result.usersProcessed,
          usersChanged: result.usersChanged,
          transactionsRepaired: result.transactionsRepaired,
          openingTransactionsAdded: result.openingTransactionsAdded,
          grantsAdded: result.grantsAdded,
          usernamesRepaired: result.usernamesRepaired,
          serviceCorrection,
          remainingDiscrepancies: {
            chainMismatches: result.report.chainMismatches,
            balanceMismatches: result.report.balanceMismatches,
            usernameMismatches: result.report.usernameMismatches,
            grantMismatches: result.report.grantMismatches,
            usersWithoutLedger: result.report.usersWithoutLedger,
          },
        },
        note: "Owner-triggered full credit ledger reconciliation",
      });
      for (const changedUser of result.changedUsers) {
        await writeAudit({
          actor: req.user,
          action: "credit_reconcile_user",
          entityType: "user",
          entityId: changedUser.userId,
          newValue: {
            username: changedUser.username,
            reason: "Legacy credit ledger repaired while preserving the current balance",
          },
          note: "Credit ledger reconciliation correction",
        });
      }
      res.json({ ...result, serviceCorrection });
    } catch (error) {
      console.error("CRM credit reconciliation error:", error);
      res.status(500).json({ message: "Failed to reconcile credit ledgers" });
    }
  });

  app.get("/api/crm/users", requireCrm("canViewUsers"), async (req, res) => {
    try {
      const q = String(req.query.q || "").trim().toLowerCase();
      const type = String(req.query.type || "all");
      const phaseFilter = String(req.query.phase || "all");
      const limit = Math.min(parseInt(String(req.query.limit || "200"), 10) || 200, 500);

      let allUsers = await storage.getAllUsers();
      if (type === "client") allUsers = allUsers.filter((u: any) => u.userType === "client");
      if (type === "healer") {
        allUsers = allUsers.filter(
          (u: any) => u.userType === "healer" || u.userType === "semi-healer" || u.userType === "semi_healer"
        );
      }
      if (q) {
        allUsers = allUsers.filter((u: any) => {
          const hay = `${u.username || ""} ${u.name || ""} ${u.email || ""} ${u.mobileNumber || ""}`.toLowerCase();
          return hay.includes(q);
        });
      }

      const lastMap = await lastActivityMap();

      const enriched = await Promise.all(
        allUsers.slice(0, limit).map(async (u: any) => {
          const lastActivityAt = lastMap.get(u.id) || u.createdAt;
          const phase = classifyPhase({
            isActive: u.isActive,
            createdAt: u.createdAt,
            lastActivityAt,
          });
          return {
            id: u.id,
            username: u.username,
            name: u.name,
            email: u.email,
            mobileNumber: u.mobileNumber,
            userType: u.userType,
            credits: await storage.getUserCredits(u.id),
            soulEnergy: u.soulEnergy || 0,
            isActive: u.isActive !== false,
            phase,
            phaseLabel: PHASE_LABELS[phase] || phase,
            lastActivityAt,
            createdAt: u.createdAt,
          };
        })
      );

      // Accept both dormant and legacy churned filter
      const normalizedFilter = phaseFilter === "churned" ? "dormant" : phaseFilter;
      const filtered =
        normalizedFilter === "all" ? enriched : enriched.filter((u) => u.phase === normalizedFilter);

      res.json({ users: filtered, total: filtered.length, phaseLabels: PHASE_LABELS });
    } catch (error) {
      console.error("CRM users list error:", error);
      res.status(500).json({ message: "Failed to load users" });
    }
  });

  app.get("/api/crm/users/:id", requireCrm("canViewUsers"), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const user = await storage.getUser(id);
      if (!user) return res.status(404).json({ message: "User not found" });

      const isHealerAccount = ["healer", "semi-healer", "semi_healer"].includes(String(user.userType));
      const [aura, vibes, numerology, objects, credits, payments, contract, journalRows, meditations, logins] =
        await Promise.all([
          db
            .select()
            .from(auraReadings)
            .where(eq(isHealerAccount ? auraReadings.performedBy : auraReadings.userId, id))
            .orderBy(desc(auraReadings.createdAt)),
          db.select().from(vibeReadings).where(eq(vibeReadings.userId, id)).orderBy(desc(vibeReadings.createdAt)).limit(100),
          db
            .select()
            .from(numerologyReadings)
            .where(eq(isHealerAccount ? numerologyReadings.performedBy : numerologyReadings.userId, id))
            .orderBy(desc(numerologyReadings.createdAt)),
          db
            .select()
            .from(objectAnalyses)
            .where(eq(isHealerAccount ? objectAnalyses.performedBy : objectAnalyses.userId, id))
            .orderBy(desc(objectAnalyses.createdAt)),
          storage.getCreditTransactionsByUser(id),
          db.select().from(paymentTransactions).where(eq(paymentTransactions.userId, id)).orderBy(desc(paymentTransactions.createdAt)).limit(100),
          db.select().from(practitionerContracts).where(eq(practitionerContracts.userId, id)).limit(1),
          db.select().from(journals).where(eq(journals.userId, id)).orderBy(desc(journals.createdAt)).limit(50),
          db.select().from(meditationSessions).where(eq(meditationSessions.userId, id)).orderBy(desc(meditationSessions.createdAt)).limit(50),
          db.select().from(loginSessions).where(eq(loginSessions.userId, id)).orderBy(desc(loginSessions.loginDate)).limit(50),
        ]);

      const timeline = [
        ...aura.map((r) => ({
          at: r.createdAt,
          type: "aura_scan",
          title: `Aura scan · ${r.name || "Untitled"}`,
          detail: r.dominantColor ? `Dominant colour: ${r.dominantColor}` : undefined,
        })),
        ...vibes.map((r) => ({
          at: r.createdAt,
          type: "vibe_check",
          title: "What's My Vibe check",
          detail: r.personalityColor ? `Vibe colour: ${r.personalityColor}` : undefined,
        })),
        ...numerology.map((r) => ({
          at: r.createdAt,
          type: "numerology",
          title: `Numerology · ${r.name}`,
          detail: `Life path ${r.lifePathNumber}`,
        })),
        ...objects.map((r) => ({
          at: r.createdAt,
          type: "object_scan",
          title: `Object scan · ${r.objectName || r.name}`,
          detail: r.auraColor ? `Aura: ${r.auraColor}` : undefined,
        })),
        ...credits.slice(0, 50).map((c) => ({
          at: c.createdAt,
          type: "credit",
          title: `Credits ${c.amount >= 0 ? "+" : ""}${c.amount}`,
          detail: c.description,
        })),
        ...payments.map((p) => ({
          at: p.createdAt,
          type: "payment",
          title: `Payment £${((p.amount || 0) / 100).toFixed(2)}`,
          detail: p.status,
        })),
        ...journalRows.map((j: any) => ({
          at: j.createdAt,
          type: "journal",
          title: "Journal entry",
          detail: (j.reflections || j.gratitude || j.mood || "").slice(0, 80),
        })),
        ...meditations.map((m: any) => ({
          at: m.createdAt,
          type: "meditation",
          title: "Meditation session",
          detail: m.meditationTitle || undefined,
        })),
        ...logins.map((l: any) => ({
          at: l.loginDate || l.createdAt,
          type: "login",
          title: "Logged in",
          detail: undefined,
        })),
      ]
        .filter((e) => e.at)
        .sort((a, b) => new Date(b.at as any).getTime() - new Date(a.at as any).getTime())
        .slice(0, 150);

      const currentCredits = await storage.getUserCredits(id);
      const issuedCredits = credits.filter((c) => c.amount > 0).reduce((sum, c) => sum + c.amount, 0);
      const usedCredits = credits.filter((c) => c.amount < 0).reduce((sum, c) => sum + Math.abs(c.amount), 0);
      const latestCredit = credits[0] || null;
      const serviceUsage = {
        aura: aura.length,
        vibe: vibes.length,
        numerology: numerology.length,
        object: objects.length,
      };
      const transactionUsage = {
        aura: credits.filter((c) => c.transactionType === "aura_analysis").length,
        vibe: credits.filter((c) => c.transactionType === "vibe_check" || c.transactionType === "vibe_analysis").length,
        numerology: credits.filter((c) => c.transactionType === "numerology").length,
        object: credits.filter((c) => c.transactionType === "object_analysis").length,
      };
      const lastActivityAt = timeline[0]?.at || user.createdAt;
      const phase = classifyPhase({
        isActive: user.isActive,
        createdAt: user.createdAt,
        lastActivityAt: lastActivityAt as any,
      });

      const { password, ...safeUser } = user as any;

      res.json({
        user: {
          ...safeUser,
          credits: currentCredits,
          phase,
          phaseLabel: PHASE_LABELS[phase],
          lastActivityAt,
        },
        activity: {
          auraReadings: aura.map((r) => ({ id: r.id, name: r.name, dominantColor: r.dominantColor, createdAt: r.createdAt })),
          vibeReadings: vibes.map((r) => ({ id: r.id, personalityColor: r.personalityColor, createdAt: r.createdAt })),
          numerologyReadings: numerology.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt })),
          objectAnalyses: objects.map((r) => ({ id: r.id, name: r.name, objectName: r.objectName, createdAt: r.createdAt })),
          journals: journalRows.length,
          meditations: meditations.length,
          logins: logins.length,
        },
        timeline,
        credits,
        creditSummary: {
          currentBalance: currentCredits,
          negativeBalance: currentCredits < 0,
          transactionCount: credits.length,
          creditsIssued: issuedCredits,
          creditsUsed: usedCredits,
          latestTransactionBalance: latestCredit?.balanceAfter ?? null,
          balanceDiscrepancy:
            latestCredit && latestCredit.balanceAfter !== currentCredits
              ? currentCredits - latestCredit.balanceAfter
              : 0,
          serviceUsage,
          transactionUsage,
          unchargedUsage: {
            aura: Math.max(0, serviceUsage.aura - transactionUsage.aura),
            vibe: Math.max(0, serviceUsage.vibe - transactionUsage.vibe),
            numerology: Math.max(0, serviceUsage.numerology - transactionUsage.numerology),
            object: Math.max(0, serviceUsage.object - transactionUsage.object),
          },
          expectedServiceCost:
            serviceUsage.aura * 5 +
            serviceUsage.object * 1 +
            serviceUsage.numerology * 1 +
            serviceUsage.vibe * 1,
          recordedServiceCost:
            transactionUsage.aura * 5 +
            transactionUsage.object * 1 +
            transactionUsage.numerology * 3 +
            transactionUsage.vibe * 1,
          firstTransactionAt: credits[credits.length - 1]?.createdAt || null,
          lastTransactionAt: latestCredit?.createdAt || null,
        },
        creditGrants: await listCreditGrants(id),
        payments,
        contract: contract[0] || null,
        phaseLabels: PHASE_LABELS,
      });
    } catch (error) {
      console.error("CRM user profile error:", error);
      res.status(500).json({ message: "Failed to load user profile" });
    }
  });

  /** Create a client or healer account with starting credits + optional expiry */
  app.post("/api/crm/users", requireCrm("canEditUsers"), async (req: AuthedRequest, res) => {
    try {
      const {
        username,
        password,
        name,
        email,
        mobileNumber,
        userType = "client",
        credits: creditAmount = 0,
        creditValidityDays,
        specialty,
        description,
        phone,
      } = req.body || {};

      if (!username || !password) {
        return res.status(400).json({ message: "username and password are required" });
      }
      if (String(password).length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      }
      const allowedTypes = ["client", "healer", "semi-healer"];
      if (!allowedTypes.includes(userType)) {
        return res.status(400).json({ message: "userType must be client, healer, or semi-healer" });
      }

      const existing = await storage.getUserByUsername(username);
      if (existing) return res.status(400).json({ message: "Username already exists" });

      const creditsNum = Math.max(0, parseInt(String(creditAmount), 10) || 0);
      let expiresAt: Date | null = null;
      if (creditValidityDays !== undefined && creditValidityDays !== null && creditValidityDays !== "" && Number(creditValidityDays) > 0) {
        expiresAt = daysFromNow(Number(creditValidityDays));
      }

      const hashed = await hashPassword(password);
      const [user] = await db
        .insert(users)
        .values({
          username: String(username).trim(),
          password: hashed,
          name: name || username,
          email: email || null,
          mobileNumber: mobileNumber || null,
          userType,
          credits: creditsNum,
          isActive: true,
        } as any)
        .returning();

      if (creditsNum > 0) {
        await db.insert(creditTransactions).values({
          userId: user.id,
          username: user.username,
          amount: creditsNum,
          transactionType: "crm_create",
          description: expiresAt
            ? `CRM account create · ${creditsNum} credits · expires ${expiresAt.toISOString().slice(0, 10)}`
            : `CRM account create · ${creditsNum} credits · no expiry`,
          balanceAfter: creditsNum,
        });
        await addCreditGrant({
          userId: user.id,
          amount: creditsNum,
          expiresAt,
          source: "crm_create",
          note: `Created by ${req.user?.username}`,
          createdByUserId: (req.user as any)?.id,
          updateBalance: false,
          transactionType: "crm_create",
        });
      }

      let healer = null as any;
      if (userType === "healer" || userType === "semi-healer") {
        try {
          const existingHealer = await storage.getHealerByUsername(username);
          if (!existingHealer) {
            healer = await storage.createHealer({
              username: user.username,
              password: hashed,
              name: name || username,
              email: email || `${username}@auraeye.local`,
              phone: phone || mobileNumber || "n/a",
              specialty: specialty || (userType === "semi-healer" ? "Semi-healer" : "Energy healing"),
              description: description || "Created via AuraEye Admin CRM",
              experience: null as any,
              location: null as any,
              imageUrl: null as any,
            } as any);
          }
        } catch (healerErr) {
          console.error("CRM healer row create warning:", healerErr);
        }
      }

      await writeAudit({
        actor: req.user,
        action: "create",
        entityType: "user",
        entityId: user.id,
        newValue: {
          username: user.username,
          userType,
          credits: creditsNum,
          expiresAt,
          creditValidityDays: creditValidityDays || null,
        },
        note: "CRM created account",
      });

      const { password: _pw, ...safe } = user as any;
      res.json({
        user: { ...safe, credits: creditsNum },
        healer,
        credits: creditsNum,
        expiresAt,
        message: `${userType} account created. ${creditsNum} credits${
          expiresAt ? ` expire on ${expiresAt.toISOString().slice(0, 10)}` : " (no expiry)"
        }.`,
      });
    } catch (error) {
      console.error("CRM create user error:", error);
      res.status(500).json({ message: "Failed to create account" });
    }
  });

  app.patch("/api/crm/users/:id", requireCrm("canEditUsers"), async (req: AuthedRequest, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = await storage.getUser(id);
      if (!existing) return res.status(404).json({ message: "User not found" });

      const allowed = [
        "name",
        "email",
        "mobileNumber",
        "userType",
        "isActive",
        "birthDate",
        "manifestIntention",
        "energyLevel",
        "biggestBlock",
      ] as const;

      const patch: Record<string, unknown> = {};
      for (const key of allowed) {
        if (key in req.body) patch[key] = req.body[key];
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ message: "No valid fields to update" });
      }

      const [updated] = await db.update(users).set(patch as any).where(eq(users.id, id)).returning();
      await writeAudit({
        actor: req.user,
        action: "update",
        entityType: "user",
        entityId: id,
        previousValue: existing,
        newValue: updated,
        note: "CRM direct user edit",
      });

      const { password, ...safe } = updated as any;
      res.json({ user: safe });
    } catch (error) {
      console.error("CRM user update error:", error);
      res.status(500).json({ message: "Failed to update user" });
    }
  });

  /** Reset a user's login password (users + healers tables). Default: healer123 */
  app.post("/api/crm/users/:id/reset-password", requireCrm("canEditUsers"), async (req: AuthedRequest, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = await storage.getUser(id);
      if (!existing) return res.status(404).json({ message: "User not found" });

      const newPassword = String(req.body?.password || "healer123");
      if (newPassword.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      }

      const hashed = await hashPassword(newPassword);
      const updated = await storage.updateUserPassword(id, hashed);

      // Ensure account is active so they can log in
      if (existing.isActive === false) {
        await db.update(users).set({ isActive: true } as any).where(eq(users.id, id));
      }

      // Extra sync for healers table (covers username mismatches / type edge cases)
      try {
        await storage.updateHealerPassword(existing.username, hashed);
      } catch (_) {}

      await writeAudit({
        actor: req.user,
        action: "reset_password",
        entityType: "user",
        entityId: id,
        previousValue: { username: existing.username },
        newValue: { passwordResetTo: newPassword, username: existing.username },
        note: `CRM password reset for ${existing.username}`,
      });

      res.json({
        success: true,
        username: existing.username,
        message: `Password for ${existing.username} is now ${newPassword}. They can log in with that password.`,
        user: updated ? { id: updated.id, username: updated.username, isActive: true } : null,
      });
    } catch (error) {
      console.error("CRM reset password error:", error);
      res.status(500).json({ message: "Failed to reset password" });
    }
  });

  /** Find + reset by username (e.g. Rutima Gopala) */
  app.post("/api/crm/users/reset-password-by-username", requireCrm("canEditUsers"), async (req: AuthedRequest, res) => {
    try {
      const username = String(req.body?.username || "").trim();
      const newPassword = String(req.body?.password || "healer123");
      if (!username) return res.status(400).json({ message: "username required" });
      if (newPassword.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });

      const existing = await storage.getUserByUsername(username);
      if (!existing) return res.status(404).json({ message: `No user found for username "${username}"` });

      const hashed = await hashPassword(newPassword);
      await storage.updateUserPassword(existing.id, hashed);
      if (existing.isActive === false) {
        await db.update(users).set({ isActive: true } as any).where(eq(users.id, existing.id));
      }
      try {
        await storage.updateHealerPassword(existing.username, hashed);
      } catch (_) {}

      await writeAudit({
        actor: req.user,
        action: "reset_password",
        entityType: "user",
        entityId: existing.id,
        newValue: { passwordResetTo: newPassword, username: existing.username },
        note: `CRM password reset by username for ${existing.username}`,
      });

      res.json({
        success: true,
        id: existing.id,
        username: existing.username,
        message: `Password for ${existing.username} is now ${newPassword}`,
      });
    } catch (error) {
      console.error("CRM reset password by username error:", error);
      res.status(500).json({ message: "Failed to reset password" });
    }
  });

  app.post("/api/crm/users/:id/credits", requireCrm("canEditCredits"), async (req: AuthedRequest, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { amount, operation, description, creditValidityDays } = req.body;
      const parsed = parseInt(amount, 10);
      if (Number.isNaN(parsed) || !["add", "subtract", "set"].includes(operation)) {
        return res.status(400).json({ message: "amount and operation (add|subtract|set) required" });
      }

      let expiresAt: Date | null = null;
      if (
        creditValidityDays !== undefined &&
        creditValidityDays !== null &&
        creditValidityDays !== "" &&
        Number(creditValidityDays) > 0
      ) {
        expiresAt = daysFromNow(Number(creditValidityDays));
      }

      const before = await storage.getUserCredits(id);
      let after = before;

      if (operation === "add") {
        if (parsed <= 0) return res.status(400).json({ message: "amount must be positive for add" });
        const result = await addCreditGrant({
          userId: id,
          amount: parsed,
          expiresAt,
          source: "admin_add",
          note: description || `CRM credit add by ${req.user?.username}`,
          createdByUserId: (req.user as any)?.id,
          transactionType: "admin_add",
          updateBalance: true,
        });
        if (!result) {
          await storage.addCredits(
            id,
            parsed,
            "admin_add",
            description || `CRM credit add by ${req.user?.username}`,
            expiresAt
          );
          after = before + parsed;
        } else {
          after = result.creditsAfter;
        }
      } else if (operation === "subtract") {
        const ok = await storage.deductCredits(
          id,
          parsed,
          "admin_subtract",
          description || `CRM credit deduct by ${req.user?.username}`
        );
        if (!ok) return res.status(400).json({ message: "Insufficient credits or update failed" });
        after = await storage.getUserCredits(id);
      } else {
        after = await replaceCreditBalance({
          userId: id,
          newCredits: parsed,
          expiresAt,
          createdByUserId: (req.user as any)?.id,
          note: description || `CRM credit set by ${req.user?.username}`,
        });
      }

      await writeAudit({
        actor: req.user,
        action: "credit_adjust",
        entityType: "credit",
        entityId: id,
        previousValue: { credits: before },
        newValue: { credits: after, operation, amount: parsed, expiresAt, creditValidityDays },
        note: description,
      });

      res.json({ success: true, creditsBefore: before, creditsAfter: after, expiresAt });
    } catch (error) {
      console.error("CRM credit adjust error:", error);
      res.status(500).json({ message: "Failed to adjust credits" });
    }
  });

  app.get("/api/crm/users/:id/export", requireCrm("canExportData"), async (req: AuthedRequest, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const user = await storage.getUser(id);
      if (!user) return res.status(404).json({ message: "User not found" });

      const payload = {
        exportedAt: new Date().toISOString(),
        user: { ...user, password: undefined },
        credits: await storage.getCreditTransactionsByUser(id),
        auraReadings: await db.select().from(auraReadings).where(eq(auraReadings.userId, id)),
        vibeReadings: await db.select().from(vibeReadings).where(eq(vibeReadings.userId, id)),
        numerologyReadings: await db.select().from(numerologyReadings).where(eq(numerologyReadings.userId, id)),
        objectAnalyses: await db.select().from(objectAnalyses).where(eq(objectAnalyses.userId, id)),
        payments: await db.select().from(paymentTransactions).where(eq(paymentTransactions.userId, id)),
        notifications: await db.select().from(notifications).where(eq(notifications.userId, id)),
      };

      await writeAudit({
        actor: req.user,
        action: "export",
        entityType: "user",
        entityId: id,
        note: "GDPR/DPDPA data export",
      });

      res.setHeader("Content-Disposition", `attachment; filename="auraeye-user-${id}-export.json"`);
      res.json(payload);
    } catch (error) {
      console.error("CRM export error:", error);
      res.status(500).json({ message: "Failed to export user data" });
    }
  });

  app.post("/api/crm/users/:id/erase", requireCrm("canEraseUsers"), async (req: AuthedRequest, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = await storage.getUser(id);
      if (!existing) return res.status(404).json({ message: "User not found" });

      await storage.deleteUser(id);
      await db
        .update(users)
        .set({
          email: null,
          mobileNumber: null,
          name: `erased-${id}`,
          profilePictureUrl: null,
          isActive: false,
        } as any)
        .where(eq(users.id, id));

      await writeAudit({
        actor: req.user,
        action: "delete",
        entityType: "user",
        entityId: id,
        previousValue: { ...existing, password: undefined },
        newValue: { erased: true },
        note: "GDPR/DPDPA erasure",
      });

      res.json({ success: true });
    } catch (error) {
      console.error("CRM erase error:", error);
      res.status(500).json({ message: "Failed to erase user" });
    }
  });

  // ── Staff management (create CRM logins) ─────────────────────────────────
  app.get("/api/crm/staff", requireCrm("canManageStaff"), async (_req, res) => {
    try {
      const staff = await db.select().from(crmStaff).orderBy(desc(crmStaff.createdAt));
      const enriched = await Promise.all(
        staff.map(async (s) => {
          const u = await storage.getUser(s.userId);
          return {
            ...s,
            username: u?.username,
            email: u?.email,
            name: u?.name,
          };
        })
      );
      res.json({ staff: enriched, roleDefaults: ROLE_DEFAULTS });
    } catch (error) {
      console.error("CRM staff list error:", error);
      res.status(500).json({ message: "Failed to load staff" });
    }
  });

  app.post("/api/crm/staff", requireCrm("canManageStaff"), async (req: AuthedRequest, res) => {
    try {
      const { username, password, displayName, role = "viewer" } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ message: "username and password are required" });
      }
      if (password.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      }
      if (!ROLE_DEFAULTS[role] && role !== "owner") {
        return res.status(400).json({ message: "role must be viewer, editor, support, or owner" });
      }

      const existing = await storage.getUserByUsername(username);
      if (existing) {
        return res.status(400).json({ message: "Username already exists" });
      }

      const defaults = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.viewer;
      const user = await storage.createUser({
        username,
        password: await hashPassword(password),
        userType: "client",
        name: displayName || username,
        email: null as any,
        mobileNumber: null as any,
        credits: 0,
      } as any);

      const [staff] = await db
        .insert(crmStaff)
        .values({
          userId: user.id,
          role,
          displayName: displayName || username,
          ...defaults,
        })
        .returning();

      await writeAudit({
        actor: req.user,
        action: "create",
        entityType: "crm_staff",
        entityId: staff.id,
        newValue: { username, role, permissions: defaults },
        note: "Created CRM staff login",
      });

      res.json({
        staff: { ...staff, username },
        message: `${username} can now log in and open /admin (${role})`,
      });
    } catch (error) {
      console.error("CRM create staff error:", error);
      res.status(500).json({ message: "Failed to create staff user" });
    }
  });

  app.patch("/api/crm/staff/:id", requireCrm("canManageStaff"), async (req: AuthedRequest, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const [existing] = await db.select().from(crmStaff).where(eq(crmStaff.id, id)).limit(1);
      if (!existing) return res.status(404).json({ message: "Staff not found" });

      const body = req.body || {};
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.role && ROLE_DEFAULTS[body.role]) {
        Object.assign(patch, { role: body.role }, ROLE_DEFAULTS[body.role]);
      }
      for (const key of [
        "displayName",
        "canViewUsers",
        "canEditUsers",
        "canEditCredits",
        "canViewRevenue",
        "canManageHealers",
        "canManageTickets",
        "canManageStaff",
        "canExportData",
        "canEraseUsers",
        "canViewAudit",
        "isActive",
      ]) {
        if (key in body) patch[key] = body[key];
      }

      const [updated] = await db.update(crmStaff).set(patch as any).where(eq(crmStaff.id, id)).returning();
      await writeAudit({
        actor: req.user,
        action: "update",
        entityType: "crm_staff",
        entityId: id,
        previousValue: existing,
        newValue: updated,
      });
      res.json({ staff: updated });
    } catch (error) {
      console.error("CRM update staff error:", error);
      res.status(500).json({ message: "Failed to update staff" });
    }
  });

  app.get("/api/crm/healers", requireCrm("canViewUsers"), async (_req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      const healers = allUsers.filter(
        (u: any) => u.userType === "healer" || u.userType === "semi-healer" || u.userType === "semi_healer"
      );
      const lastMap = await lastActivityMap();

      const rows = await Promise.all(
        healers.map(async (u: any) => {
          const contracts = await db
            .select()
            .from(practitionerContracts)
            .where(eq(practitionerContracts.userId, u.id))
            .limit(1);
          return {
            id: u.id,
            username: u.username,
            name: u.name,
            email: u.email,
            userType: u.userType,
            credits: await storage.getUserCredits(u.id),
            isActive: u.isActive !== false,
            healerSessionCount: u.healerSessionCount || 0,
            lastActivityAt: lastMap.get(u.id) || u.createdAt,
            contract: contracts[0] || null,
            createdAt: u.createdAt,
          };
        })
      );

      res.json({ healers: rows });
    } catch (error) {
      console.error("CRM healers error:", error);
      res.status(500).json({ message: "Failed to load healers" });
    }
  });

  app.put("/api/crm/healers/:id/contract", requireCrm("canManageHealers"), async (req: AuthedRequest, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const body = req.body || {};
      const existing = await db.select().from(practitionerContracts).where(eq(practitionerContracts.userId, id)).limit(1);

      let row;
      if (existing[0]) {
        const [updated] = await db
          .update(practitionerContracts)
          .set({
            licenceStatus: body.licenceStatus ?? existing[0].licenceStatus,
            contractStatus: body.contractStatus ?? existing[0].contractStatus,
            startDate: body.startDate ?? existing[0].startDate,
            endDate: body.endDate ?? existing[0].endDate,
            renewalDate: body.renewalDate ?? existing[0].renewalDate,
            notes: body.notes ?? existing[0].notes,
            updatedAt: new Date(),
          })
          .where(eq(practitionerContracts.userId, id))
          .returning();
        row = updated;
        await writeAudit({
          actor: req.user,
          action: "update",
          entityType: "practitioner_contract",
          entityId: id,
          previousValue: existing[0],
          newValue: updated,
        });
      } else {
        const [created] = await db
          .insert(practitionerContracts)
          .values({
            userId: id,
            licenceStatus: body.licenceStatus || "unknown",
            contractStatus: body.contractStatus || "unsigned",
            startDate: body.startDate || null,
            endDate: body.endDate || null,
            renewalDate: body.renewalDate || null,
            notes: body.notes || null,
          })
          .returning();
        row = created;
        await writeAudit({
          actor: req.user,
          action: "create",
          entityType: "practitioner_contract",
          entityId: id,
          newValue: created,
        });
      }

      res.json({ contract: row });
    } catch (error) {
      console.error("CRM contract upsert error:", error);
      res.status(500).json({ message: "Failed to save contract" });
    }
  });

  app.get("/api/crm/revenue", requireCrm("canViewRevenue"), async (req, res) => {
    try {
      const entity = String(req.query.entity || "all"); // gbp | inr | all — soft filter for multi-entity
      const payments = await db.select().from(paymentTransactions).orderBy(desc(paymentTransactions.createdAt)).limit(300);
      const credits = await db.select().from(creditTransactions).orderBy(desc(creditTransactions.createdAt)).limit(300);

      const completed = payments.filter((p) => p.status === "completed");
      const refunded = payments.filter((p) => p.status === "refunded");
      const totalRevenue = completed.reduce((s, p) => s + (p.amount || 0), 0) / 100;
      const totalRefunds = refunded.reduce((s, p) => s + (p.amount || 0), 0) / 100;

      const expiryLog = credits
        .filter((c) => String(c.transactionType).toLowerCase().includes("expire"))
        .map((c) => ({
          kind: "credit_expiry",
          id: c.id,
          userId: c.userId,
          username: c.username,
          amount: Math.abs(c.amount),
          at: c.createdAt,
          description: c.description,
        }));

      let activeGrants: any[] = [];
      let expiringSoon: any[] = [];
      try {
        const { creditGrants } = await import("../shared/schema");
        const { gt, and, isNotNull, asc, sql: dsql } = await import("drizzle-orm");
        const now = new Date();
        const soon = new Date();
        soon.setDate(soon.getDate() + 14);
        activeGrants = await db
          .select()
          .from(creditGrants)
          .where(gt(creditGrants.remaining, 0))
          .orderBy(asc(dsql`coalesce(${creditGrants.expiresAt}, '9999-12-31')`))
          .limit(100);
        expiringSoon = activeGrants.filter(
          (g) => g.expiresAt && new Date(g.expiresAt) <= soon && new Date(g.expiresAt) > now
        );
      } catch (grantErr) {
        console.error("Credit grants load warning:", grantErr);
      }

      const refundLog = [
        ...refunded.map((p) => ({
          kind: "payment_refund",
          id: p.id,
          userId: p.userId,
          amount: (p.amount || 0) / 100,
          at: p.completedAt || p.createdAt,
          description: p.status,
        })),
        ...credits
          .filter(
            (c) =>
              String(c.transactionType).toLowerCase().includes("refund") ||
              (c.amount < 0 && String(c.description || "").toLowerCase().includes("refund"))
          )
          .map((c) => ({
            kind: "credit_refund",
            id: c.id,
            userId: c.userId,
            username: c.username,
            amount: c.amount,
            at: c.createdAt,
            description: c.description,
          })),
      ].sort((a, b) => new Date(b.at as any).getTime() - new Date(a.at as any).getTime());

      res.json({
        entity,
        entities: [
          { id: "gbp", label: "AuraEye Solutions Ltd (GBP)" },
          { id: "inr", label: "Healer Nishant Academy / India (INR)" },
        ],
        summary: {
          totalRevenue,
          totalRefunds,
          completedCount: completed.length,
          refundedCount: refunded.length,
          expiredCredits: expiryLog.reduce((s, e) => s + e.amount, 0),
          activeGrantCount: activeGrants.length,
          expiringSoonCount: expiringSoon.length,
        },
        payments,
        recentCredits: credits,
        refundLog,
        expiryLog,
        activeGrants: activeGrants.slice(0, 50),
        expiringSoon,
      });
    } catch (error) {
      console.error("CRM revenue error:", error);
      res.status(500).json({ message: "Failed to load revenue" });
    }
  });

  app.get("/api/crm/audit-logs", requireCrm("canViewAudit"), async (req, res) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit || "100"), 10) || 100, 500);
      const logs = await db.select().from(adminAuditLogs).orderBy(desc(adminAuditLogs.createdAt)).limit(limit);
      res.json({ logs });
    } catch (error) {
      console.error("CRM audit logs error:", error);
      res.status(500).json({ message: "Failed to load audit logs" });
    }
  });

  app.post("/api/crm/audit-logs/:id/rollback", requireCrm("canEditUsers"), async (req: AuthedRequest, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const [log] = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.id, id)).limit(1);
      if (!log) return res.status(404).json({ message: "Audit entry not found" });
      if (log.entityType !== "user" || !log.previousValue || !log.entityId) {
        return res.status(400).json({ message: "Only user field updates with a previous snapshot can be rolled back" });
      }

      const prev = JSON.parse(log.previousValue);
      const userId = parseInt(log.entityId, 10);
      const restore: Record<string, unknown> = {};
      for (const key of ["name", "email", "mobileNumber", "userType", "isActive", "birthDate", "manifestIntention", "energyLevel", "biggestBlock"]) {
        if (key in prev) restore[key] = prev[key];
      }

      const before = await storage.getUser(userId);
      const [updated] = await db.update(users).set(restore as any).where(eq(users.id, userId)).returning();

      await writeAudit({
        actor: req.user,
        action: "rollback",
        entityType: "user",
        entityId: userId,
        previousValue: before,
        newValue: updated,
        note: `Rollback of audit #${id}`,
      });

      res.json({ success: true, user: { ...updated, password: undefined } });
    } catch (error) {
      console.error("CRM rollback error:", error);
      res.status(500).json({ message: "Failed to rollback" });
    }
  });

  app.get("/api/crm/users.csv", requireCrm("canExportData"), async (req: AuthedRequest, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      const lastMap = await lastActivityMap();
      const header = ["id", "username", "name", "email", "mobileNumber", "userType", "credits", "phase", "phaseLabel", "isActive", "lastActivityAt", "createdAt"];
      const lines = [header.join(",")];
      for (const u of allUsers) {
        const credits = await storage.getUserCredits(u.id);
        const lastActivityAt = lastMap.get(u.id) || u.createdAt;
        const phase = classifyPhase({ isActive: u.isActive, createdAt: u.createdAt, lastActivityAt });
        const row = [
          u.id,
          JSON.stringify(u.username || ""),
          JSON.stringify(u.name || ""),
          JSON.stringify(u.email || ""),
          JSON.stringify(u.mobileNumber || ""),
          JSON.stringify(u.userType || ""),
          credits,
          phase,
          JSON.stringify(PHASE_LABELS[phase] || phase),
          u.isActive !== false,
          lastActivityAt ? new Date(lastActivityAt).toISOString() : "",
          u.createdAt ? new Date(u.createdAt).toISOString() : "",
        ];
        lines.push(row.join(","));
      }
      await writeAudit({
        actor: req.user,
        action: "export",
        entityType: "user",
        note: "CSV export of all users",
      });
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="auraeye-users.csv"');
      res.send(lines.join("\n"));
    } catch (error) {
      console.error("CRM CSV export error:", error);
      res.status(500).json({ message: "Failed to export CSV" });
    }
  });

  app.get("/api/crm/tickets", requireCrm("canManageTickets"), async (req, res) => {
    try {
      const status = String(req.query.status || "all");
      const channel = String(req.query.channel || "all");
      const userIdFilter = req.query.userId ? parseInt(String(req.query.userId), 10) : null;
      let tickets = await db.select().from(supportTickets).orderBy(desc(supportTickets.createdAt)).limit(300);
      if (status !== "all") tickets = tickets.filter((t) => t.status === status);
      if (channel !== "all") tickets = tickets.filter((t) => t.channel === channel);
      if (userIdFilter) tickets = tickets.filter((t) => t.userId === userIdFilter);

      const enriched = await Promise.all(
        tickets.map(async (t) => {
          let username: string | null = null;
          if (t.userId) {
            const u = await storage.getUser(t.userId);
            username = u?.username || null;
          }
          return { ...t, username };
        })
      );
      res.json({ tickets: enriched });
    } catch (error) {
      console.error("CRM tickets error:", error);
      res.status(500).json({ message: "Failed to load tickets" });
    }
  });

  app.post("/api/crm/tickets", requireCrm("canManageTickets"), async (req: AuthedRequest, res) => {
    try {
      const { subject, body, userId, priority, category, channel, requesterName, requesterEmail } = req.body;
      if (!subject || !body) return res.status(400).json({ message: "subject and body required" });
      const { createSupportTicket } = await import("./support-tickets");
      const ticket = await createSupportTicket({
        subject,
        body,
        userId: userId || null,
        priority: priority || "normal",
        category: category || "general",
        channel: channel || "crm",
        requesterName: requesterName || null,
        requesterEmail: requesterEmail || null,
        assignedTo: (req.user as any)?.id,
      });
      if (!ticket) return res.status(500).json({ message: "Failed to create ticket" });
      res.json({ ticket });
    } catch (error) {
      console.error("CRM create ticket error:", error);
      res.status(500).json({ message: "Failed to create ticket" });
    }
  });

  app.patch("/api/crm/tickets/:id", requireCrm("canManageTickets"), async (req: AuthedRequest, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      for (const key of ["status", "priority", "subject", "body", "assignedTo"]) {
        if (key in (req.body || {})) patch[key] = req.body[key];
      }
      const [ticket] = await db.update(supportTickets).set(patch as any).where(eq(supportTickets.id, id)).returning();
      res.json({ ticket });
    } catch (error) {
      console.error("CRM update ticket error:", error);
      res.status(500).json({ message: "Failed to update ticket" });
    }
  });

  app.get("/api/crm/leads", requireCrm("canViewUsers"), async (_req, res) => {
    try {
      const leads = await db.select().from(crmLeads).orderBy(desc(crmLeads.updatedAt)).limit(200);
      res.json({ leads });
    } catch (error) {
      console.error("CRM leads error:", error);
      res.status(500).json({ message: "Failed to load leads" });
    }
  });

  app.post("/api/crm/leads", requireCrm("canEditUsers"), async (req: AuthedRequest, res) => {
    try {
      const { name, email, mobileNumber, source, stage, notes } = req.body || {};
      if (!name) return res.status(400).json({ message: "name required" });
      const [lead] = await db
        .insert(crmLeads)
        .values({
          name,
          email: email || null,
          mobileNumber: mobileNumber || null,
          source: source || "manual",
          stage: stage || "new",
          notes: notes || null,
          ownerUserId: (req.user as any)?.id,
        })
        .returning();
      res.json({ lead });
    } catch (error) {
      console.error("CRM create lead error:", error);
      res.status(500).json({ message: "Failed to create lead" });
    }
  });

  app.patch("/api/crm/leads/:id", requireCrm("canEditUsers"), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      for (const key of ["name", "email", "mobileNumber", "source", "stage", "notes"]) {
        if (key in (req.body || {})) patch[key] = req.body[key];
      }
      const [lead] = await db.update(crmLeads).set(patch as any).where(eq(crmLeads.id, id)).returning();
      res.json({ lead });
    } catch (error) {
      console.error("CRM update lead error:", error);
      res.status(500).json({ message: "Failed to update lead" });
    }
  });

  /** Bulk import users from CSV/XLS rows (JSON array from client parser) */
  app.post("/api/crm/users/import", requireCrm("canEditUsers"), async (req: AuthedRequest, res) => {
    try {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (!rows.length) return res.status(400).json({ message: "rows array required" });
      if (rows.length > 500) return res.status(400).json({ message: "Max 500 rows per import" });

      const results: { row: number; username?: string; ok: boolean; error?: string; id?: number }[] = [];
      let created = 0;

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] || {};
        const username = String(r.username || r.Username || r.user || "").trim();
        const password = String(r.password || r.Password || "ChangeMe123").trim();
        const name = String(r.name || r.Name || username).trim();
        const email = String(r.email || r.Email || "").trim() || null;
        const mobileNumber = String(r.mobileNumber || r.mobile || r.phone || r.Phone || "").trim() || null;
        const userTypeRaw = String(r.userType || r.type || r.Type || "client").trim().toLowerCase();
        const userType = ["healer", "semi-healer", "semi_healer"].includes(userTypeRaw)
          ? userTypeRaw === "semi_healer"
            ? "semi-healer"
            : userTypeRaw
          : "client";
        const creditsNum = Math.max(0, parseInt(String(r.credits ?? r.Credits ?? 0), 10) || 0);
        const validityRaw = r.creditValidityDays ?? r.validityDays ?? r.validity ?? null;
        let expiresAt: Date | null = null;
        if (validityRaw !== null && validityRaw !== undefined && validityRaw !== "" && Number(validityRaw) > 0) {
          expiresAt = daysFromNow(Number(validityRaw));
        }

        if (!username) {
          results.push({ row: i + 1, ok: false, error: "username required" });
          continue;
        }
        try {
          const existing = await storage.getUserByUsername(username);
          if (existing) {
            results.push({ row: i + 1, username, ok: false, error: "username exists" });
            continue;
          }
          const hashed = await hashPassword(password.length >= 6 ? password : "ChangeMe123");
          const [user] = await db
            .insert(users)
            .values({
              username,
              password: hashed,
              name,
              email,
              mobileNumber,
              userType,
              credits: creditsNum,
              isActive: true,
            } as any)
            .returning();

          if (creditsNum > 0) {
            await db.insert(creditTransactions).values({
              userId: user.id,
              username: user.username,
              amount: creditsNum,
              transactionType: "crm_import",
              description: expiresAt
                ? `CSV/XLS import · expires ${expiresAt.toISOString().slice(0, 10)}`
                : "CSV/XLS import · no expiry",
              balanceAfter: creditsNum,
            });
            await addCreditGrant({
              userId: user.id,
              amount: creditsNum,
              expiresAt,
              source: "crm_import",
              note: `Imported by ${req.user?.username}`,
              createdByUserId: (req.user as any)?.id,
              updateBalance: false,
            });
          }

          if (userType === "healer" || userType === "semi-healer") {
            try {
              const existingHealer = await storage.getHealerByUsername(username);
              if (!existingHealer) {
                await storage.createHealer({
                  username,
                  password: hashed,
                  name,
                  email: email || `${username}@auraeye.local`,
                  phone: mobileNumber || "n/a",
                  specialty: String(r.specialty || "Energy healing"),
                  description: "Imported via CRM CSV/XLS",
                } as any);
              }
            } catch (_) {}
          }

          created += 1;
          results.push({ row: i + 1, username, ok: true, id: user.id });
        } catch (rowErr: any) {
          results.push({ row: i + 1, username, ok: false, error: rowErr?.message || "failed" });
        }
      }

      await writeAudit({
        actor: req.user,
        action: "import",
        entityType: "user",
        newValue: { created, total: rows.length },
        note: "CSV/XLS user import",
      });

      res.json({ created, total: rows.length, results });
    } catch (error) {
      console.error("CRM users import error:", error);
      res.status(500).json({ message: "Failed to import users" });
    }
  });

  /** Bulk import leads from CSV/XLS rows */
  app.post("/api/crm/leads/import", requireCrm("canEditUsers"), async (req: AuthedRequest, res) => {
    try {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (!rows.length) return res.status(400).json({ message: "rows array required" });
      if (rows.length > 500) return res.status(400).json({ message: "Max 500 rows per import" });

      const results: { row: number; name?: string; ok: boolean; error?: string; id?: number }[] = [];
      let created = 0;

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] || {};
        const name = String(r.name || r.Name || "").trim();
        const email = String(r.email || r.Email || "").trim() || null;
        const mobileNumber = String(r.mobileNumber || r.mobile || r.phone || r.Phone || "").trim() || null;
        const source = String(r.source || r.Source || "csv_import").trim();
        const stage = String(r.stage || r.Stage || "new").trim().toLowerCase();
        const notes = String(r.notes || r.Notes || "").trim() || null;

        if (!name) {
          results.push({ row: i + 1, ok: false, error: "name required" });
          continue;
        }
        try {
          const [lead] = await db
            .insert(crmLeads)
            .values({
              name,
              email,
              mobileNumber,
              source,
              stage: ["new", "contacted", "qualified", "onboarded", "lost"].includes(stage) ? stage : "new",
              notes,
              ownerUserId: (req.user as any)?.id,
            })
            .returning();
          created += 1;
          results.push({ row: i + 1, name, ok: true, id: lead.id });
        } catch (rowErr: any) {
          results.push({ row: i + 1, name, ok: false, error: rowErr?.message || "failed" });
        }
      }

      await writeAudit({
        actor: req.user,
        action: "import",
        entityType: "crm_lead",
        newValue: { created, total: rows.length },
        note: "CSV/XLS lead import",
      });

      res.json({ created, total: rows.length, results });
    } catch (error) {
      console.error("CRM leads import error:", error);
      res.status(500).json({ message: "Failed to import leads" });
    }
  });

  /** Daily app activity digest + website analytics */
  app.get("/api/crm/insights/daily", requireCrm("canViewUsers"), async (req, res) => {
    try {
      const days = Math.min(30, Math.max(1, parseInt(String(req.query.days || "14"), 10) || 14));
      const { getDailyActivityReport } = await import("./crm-insights");
      const report = await getDailyActivityReport(days);
      res.json(report);
    } catch (error) {
      console.error("CRM daily insights error:", error);
      res.status(500).json({ message: "Failed to load daily activity" });
    }
  });

  app.get("/api/crm/insights/website", requireCrm("canViewUsers"), async (req, res) => {
    try {
      const days = Math.min(30, Math.max(1, parseInt(String(req.query.days || "7"), 10) || 7));
      const { getWebsiteAnalytics } = await import("./crm-insights");
      const analytics = await getWebsiteAnalytics(days);
      res.json(analytics);
    } catch (error) {
      console.error("CRM website analytics error:", error);
      res.status(500).json({ message: "Failed to load website analytics" });
    }
  });

  /** Re-sync user credit balance from active grants (fixes drift) */
  app.post("/api/crm/users/:id/sync-credits", requireCrm("canEditCredits"), async (req: AuthedRequest, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const grants = await listCreditGrants(id);
      if (grants.length === 0) {
        return res.status(409).json({
          message: "No credit grants exist for this account; legacy balance was not changed.",
        });
      }

      const now = new Date();
      const fromGrants = grants
        .filter((g) => g.remaining > 0 && (!g.expiresAt || new Date(g.expiresAt) > now))
        .reduce((sum, g) => sum + g.remaining, 0);

      const { before, after } = await db.transaction(async (tx) => {
        const [user] = await tx.select().from(users).where(eq(users.id, id)).for("update");
        if (!user) throw new Error("User not found");

        const before = Number(user.credits || 0);
        if (before !== fromGrants) {
          await tx.update(users).set({ credits: fromGrants }).where(eq(users.id, id));
          await tx.insert(creditTransactions).values({
            userId: id,
            username: user.username,
            amount: fromGrants - before,
            transactionType: "credit_sync",
            description: "Synced balance from active credit grants",
            balanceAfter: fromGrants,
          });
        }
        return { before, after: fromGrants };
      });

      await writeAudit({
        actor: req.user,
        action: "credit_sync",
        entityType: "credit",
        entityId: id,
        previousValue: { credits: before },
        newValue: { credits: after },
        note: "Synced balance from active credit grants",
      });
      res.json({ success: true, creditsBefore: before, creditsAfter: after });
    } catch (error) {
      console.error("CRM credit sync error:", error);
      res.status(500).json({ message: "Failed to sync credits" });
    }
  });
}
