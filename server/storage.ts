import { users, type User, type InsertUser, auraReadings, type AuraReading, type InsertAuraReading, journals, type Journal, type InsertJournal, numerologyReadings, type NumerologyReading, type InsertNumerologyReading, objectAnalyses, type ObjectAnalysis, type InsertObjectAnalysis, healers, type Healer, type InsertHealer, healerBookings, type HealerBooking, type InsertHealerBooking, healerRatings, type HealerRating, type InsertHealerRating, healerBadges, type HealerBadge, type InsertHealerBadge, userAchievements, vibeFeedback, type VibeFeedback, type InsertVibeFeedback, vibeReadings, type VibeReading, type InsertVibeReading, creditTransactions, type CreditTransaction, type InsertCreditTransaction, passwordResetTokens, type PasswordResetToken, type InsertPasswordResetToken, pdfStorage, type PdfStorage, type InsertPdfStorage, moodSnapshots, type MoodSnapshot, type InsertMoodSnapshot, pushSubscriptions, type PushSubscription, type InsertPushSubscription, meditationSessions, type MeditationSession, type InsertMeditationSession, favoriteMeditations, type FavoriteMeditation, type InsertFavoriteMeditation, achievements, type Achievement, type InsertAchievement, notifications, type Notification, type InsertNotification, loginSessions } from "../shared/schema";
import { db } from "./db";
import { eq, and, gt, desc, or, gte, lt, sql, count } from "drizzle-orm";
import { getCreditCostForService } from "./credit-policy";
import createMemoryStore from "memorystore";
import session from "express-session";
import connectPg from "connect-pg-simple";

// Create appropriate session store based on environment
const createSessionStore = () => {
  if (process.env.DATABASE_URL && (process.env.NODE_ENV === "production" || process.env.REPLIT_ENVIRONMENT === "production")) {
    const PostgreSQLStore = connectPg(session);
    return new PostgreSQLStore({
      conString: process.env.DATABASE_URL,
      createTableIfMissing: true,
      ttl: 7 * 24 * 60 * 60, // 7 days in seconds
    });
  } else {
    const MemoryStore = createMemoryStore(session);
    return new MemoryStore({
      checkPeriod: 86400000, // prune expired entries every 24h
    });
  }
};

export interface IStorage {
  // User management
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByMobileNumber(mobileNumber: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUserPassword(userId: number, hashedPassword: string): Promise<User | undefined>;
  updateUserOnboarding(userId: number, onboarding: { manifestIntention: string; energyLevel: string; biggestBlock: string }): Promise<User | undefined>;
  updateNotificationPreferences(userId: number, preferences: { smsEnabled?: boolean; phoneNumber?: string; browserEnabled?: boolean; emailEnabled?: boolean }): Promise<User | undefined>;
  updateProfilePicture(userId: number, pictureUrl: string): Promise<User | undefined>;
  updateUserCredits(userId: number, newCredits: number): Promise<User | undefined>;
  updateUserEmail(userId: number, newEmail: string): Promise<User | undefined>;
  getAllUsers(): Promise<User[]>;
  createNotification(notification: InsertNotification): Promise<Notification>;
  getNotificationsByUser(userId: number): Promise<Notification[]>;
  deleteUser(userId: number): Promise<boolean>;
  
  // Push notification subscriptions
  savePushSubscription(subscription: InsertPushSubscription): Promise<PushSubscription>;
  getPushSubscriptionsByUser(userId: number): Promise<PushSubscription[]>;
  getAllPushSubscriptions(): Promise<PushSubscription[]>;
  deletePushSubscription(endpoint: string): Promise<boolean>;
  
  // Credit costs based on user type
  getCreditCost(userId: number, serviceType: string): Promise<number>;
  
  // Aura readings
  saveAuraReading(reading: InsertAuraReading): Promise<AuraReading>;
  findAuraReadingByImageHash(imageHash: string): Promise<AuraReading | undefined>;
  getAuraReadingsByUser(userId: number): Promise<AuraReading[]>;
  getAuraReadingsByPerformedBy(performedBy: number, limit?: number): Promise<AuraReading[]>;
  getAuraReadingsCountByPerformedBy(performedBy: number): Promise<number>;
  getAuraReading(id: number): Promise<AuraReading | undefined>;
  updateAuraReadingReview(id: number, rating: number, reviewText?: string): Promise<AuraReading | undefined>;
  updateAuraReadingNotes(id: number, healerNotes: string): Promise<AuraReading | undefined>;
  updateAuraReadingImage(id: number, processedImage: string): Promise<boolean>;
  
  // Journal entries
  createJournalEntry(entry: InsertJournal): Promise<Journal>;
  getJournalEntriesByUser(userId: number): Promise<Journal[]>;
  getJournalEntry(id: number): Promise<Journal | undefined>;
  
  // Numerology readings
  saveNumerologyReading(reading: InsertNumerologyReading): Promise<NumerologyReading>;
  getNumerologyReadingsByUser(userId: number): Promise<NumerologyReading[]>;
  getNumerologyReadingsByPerformedBy(performedBy: number): Promise<NumerologyReading[]>;
  getNumerologyReadingsCountByPerformedBy(performedBy: number): Promise<number>;
  getNumerologyReading(id: number): Promise<NumerologyReading | undefined>;
  updateNumerologyReadingNotes(id: number, healerNotes: string): Promise<NumerologyReading | undefined>;
  updateNumerologyReadingPdf(id: number, pdfData: string, healerNotes?: string): Promise<NumerologyReading | undefined>;
  
  // Object analyses
  saveObjectAnalysis(analysis: InsertObjectAnalysis): Promise<ObjectAnalysis>;
  getObjectAnalysesByUser(userId: number): Promise<ObjectAnalysis[]>;
  getObjectAnalysesByPerformedBy(performedBy: number): Promise<ObjectAnalysis[]>;
  getObjectAnalysesCountByPerformedBy(performedBy: number): Promise<number>;
  getObjectAnalysis(id: number): Promise<ObjectAnalysis | undefined>;
  updateObjectAnalysisReview(id: number, rating: number, reviewText?: string): Promise<ObjectAnalysis | undefined>;
  
  // Healer management
  getAllHealers(): Promise<Healer[]>;
  getHealer(id: number): Promise<Healer | undefined>;
  getHealerByUsername(username: string): Promise<Healer | undefined>;
  createHealer(healer: InsertHealer): Promise<Healer>;
  updateHealerPassword(username: string, hashedPassword: string): Promise<Healer | undefined>;
  
  // Healer bookings
  createHealerBooking(booking: InsertHealerBooking): Promise<HealerBooking>;
  getHealerBookingsByUser(userId: number): Promise<HealerBooking[]>;
  getHealerBookingsByHealer(healerId: number): Promise<HealerBooking[]>;
  getHealerBooking(bookingId: number): Promise<HealerBooking | undefined>;
  updateBookingStatus(bookingId: number, status: string): Promise<HealerBooking | undefined>;
  updateBookingStatusWithResponse(bookingId: number, status: string, healerResponse?: string): Promise<HealerBooking | undefined>;
  
  // Healer ratings
  createHealerRating(rating: InsertHealerRating): Promise<HealerRating>;
  getHealerRatings(healerId: number): Promise<HealerRating[]>;
  getHealerAverageRating(healerId: number): Promise<number>;

  // Healer badges
  createHealerBadge(badge: InsertHealerBadge): Promise<HealerBadge>;
  getHealerBadges(healerId: number): Promise<HealerBadge[]>;
  deleteExpiredBadges(): Promise<void>;
  
  // User achievements
  createUserAchievement(achievement: InsertAchievement): Promise<Achievement>;
  getUserAchievements(userId: number): Promise<Achievement[]>;
  checkAndAwardAchievements(userId: number): Promise<Achievement[]>;
  
  // Healer analytics
  getHealerClientStats(healerId: number): Promise<any>;
  getHealerBookingTrends(healerId: number): Promise<any>;
  
  // Vibe feedback
  saveVibeFeedback(feedback: InsertVibeFeedback): Promise<VibeFeedback>;
  getVibeFeedbackByUser(userId: number): Promise<VibeFeedback[]>;
  
  // Vibe readings for healer dashboard
  saveVibeReading(reading: InsertVibeReading): Promise<VibeReading>;
  getVibeReadingsByUserId(userId: number): Promise<VibeReading[]>;
  getVibeReadingsCountByUserId(userId: number): Promise<number>;
  getAllVibeReadings(): Promise<any[]>;
  
  // Credit management
  getUserCredits(userId: number): Promise<number>;
  deductCredits(userId: number, amount: number, type: string, description: string): Promise<boolean>;
  addCredits(userId: number, amount: number, type: string, description: string, expiresAt?: Date | null): Promise<boolean>;
  getCreditTransactionsByUser(userId: number): Promise<CreditTransaction[]>;
  createCreditTransaction(transaction: InsertCreditTransaction): Promise<CreditTransaction>;
  createNotification(notification: { userId: number; title: string; message: string; type?: string }): Promise<any>;
  
  // Soul energy management
  getUserSoulEnergy(userId: number): Promise<number>;
  addSoulEnergy(userId: number, amount: number, source: string): Promise<boolean>;
  
  // Password reset tokens
  createPasswordResetToken(token: InsertPasswordResetToken): Promise<PasswordResetToken>;
  validatePasswordResetToken(username: string, email: string, token: string): Promise<PasswordResetToken | undefined>;
  validatePasswordResetTokenByMobile(username: string, mobileNumber: string, token: string): Promise<PasswordResetToken | undefined>;
  markPasswordResetTokenAsUsed(tokenId: number): Promise<void>;

  // PDF storage for exact PDF retrieval
  storePdf(pdfStorage: InsertPdfStorage): Promise<PdfStorage>;
  getPdfByAuraReadingId(auraReadingId: number): Promise<PdfStorage | undefined>;
  getPdfsByHealerId(healerId: number): Promise<PdfStorage[]>;

  // Mood snapshots
  createMoodSnapshot(snapshot: InsertMoodSnapshot): Promise<MoodSnapshot>;
  getMoodSnapshotsByUser(userId: number): Promise<MoodSnapshot[]>;
  getRecentMoodSnapshots(userId: number, limit: number): Promise<MoodSnapshot[]>;

  // Meditation sessions
  createMeditationSession(session: InsertMeditationSession): Promise<MeditationSession>;
  getUserMeditationSessions(userId: number): Promise<MeditationSession[]>;
  getMeditationStats(userId: number): Promise<{ sessionsCount: number; totalMinutes: number; totalEnergy: number }>;

  // Favorite meditations
  addFavoriteMeditation(favorite: InsertFavoriteMeditation): Promise<FavoriteMeditation>;
  removeFavoriteMeditation(userId: number, meditationId: number): Promise<boolean>;
  getFavoriteMeditations(userId: number): Promise<FavoriteMeditation[]>;
  isMeditationFavorite(userId: number, meditationId: number): Promise<boolean>;

  // User statistics
  getUserStats(userId: number): Promise<any>;

  // Login streak tracking
  recordLogin(userId: number): Promise<void>;
  getLoginStreak(userId: number): Promise<{ currentStreak: number; longestStreak: number; weeklyActiveDates: string[] }>;

  // Session store
  sessionStore: any;
}

export class DatabaseStorage implements IStorage {
  sessionStore: any;

  constructor() {
    this.sessionStore = createSessionStore();
  }

  // User management
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(
      sql`LOWER(${users.username}) = LOWER(${username})`
    );
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(
      sql`LOWER(${users.email}) = LOWER(${email})`
    );
    return user || undefined;
  }

  async getUserByMobileNumber(mobileNumber: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.mobileNumber, mobileNumber));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    // Set credits based on user type: clients get 5 welcome credits, healers/semi-healers get 100
    // SECURITY: Always ignore user-supplied credits to prevent privilege escalation
    const userType = insertUser.userType || "client";
    const isHealer = userType === 'healer' || userType === 'semi-healer';
    const initialCredits = isHealer ? 100 : 5;
    
    // Use database transaction to ensure atomicity
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          ...insertUser,
          userType,
          credits: initialCredits // Always use role-based credits, ignore user input
        })
        .returning();
      
      // Log the initial credit grant in same transaction
      await tx.insert(creditTransactions).values({
        userId: user.id,
        username: user.username,
        amount: initialCredits,
        transactionType: "registration",
        description: `Welcome bonus - ${initialCredits} free credits (${isHealer ? 'healer' : 'client'} account)`,
        balanceAfter: initialCredits,
      });
      
      return user;
    });
  }

  async updateUserPassword(userId: number, hashedPassword: string): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set({ password: hashedPassword })
      .where(eq(users.id, userId))
      .returning();

    // Always sync healers table by username (case-insensitive) so healer login stays in sync
    if (user?.username) {
      try {
        await db
          .update(healers)
          .set({ password: hashedPassword })
          .where(sql`LOWER(${healers.username}) = LOWER(${user.username})`);
      } catch (err) {
        console.error("Failed to sync healer password:", err);
      }
    }
    return user || undefined;
  }

  async updateUserOnboarding(userId: number, onboarding: { manifestIntention: string; energyLevel: string; biggestBlock: string }): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set({
        manifestIntention: onboarding.manifestIntention,
        energyLevel: onboarding.energyLevel,
        biggestBlock: onboarding.biggestBlock
      })
      .where(eq(users.id, userId))
      .returning();
    return user || undefined;
  }

  async updateNotificationPreferences(userId: number, preferences: { smsEnabled?: boolean; phoneNumber?: string; browserEnabled?: boolean; emailEnabled?: boolean }): Promise<User | undefined> {
    const updateData: any = {};
    
    if (preferences.smsEnabled !== undefined) {
      updateData.smsNotificationsEnabled = preferences.smsEnabled;
    }
    if (preferences.phoneNumber !== undefined) {
      updateData.mobileNumber = preferences.phoneNumber;
    }
    if (preferences.browserEnabled !== undefined) {
      updateData.browserNotificationsEnabled = preferences.browserEnabled;
    }
    if (preferences.emailEnabled !== undefined) {
      updateData.emailNotificationsEnabled = preferences.emailEnabled;
    }
    
    const [user] = await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, userId))
      .returning();
    return user || undefined;
  }

  async updateProfilePicture(userId: number, pictureUrl: string): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set({ profilePictureUrl: pictureUrl })
      .where(eq(users.id, userId))
      .returning();
    return user || undefined;
  }

  async updateUserCredits(userId: number, newCredits: number): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set({ credits: newCredits })
      .where(eq(users.id, userId))
      .returning();
    return user || undefined;
  }

  async updateUserEmail(userId: number, newEmail: string): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set({ email: newEmail })
      .where(eq(users.id, userId))
      .returning();
    return user || undefined;
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users);
  }

  async createNotification(notification: InsertNotification): Promise<Notification> {
    const [created] = await db.insert(notifications).values(notification).returning();
    return created;
  }

  async getNotificationsByUser(userId: number): Promise<Notification[]> {
    return await db.select().from(notifications).where(eq(notifications.userId, userId));
  }

  async deleteUser(userId: number): Promise<boolean> {
    await db
      .update(users)
      .set({ isActive: false })
      .where(eq(users.id, userId));
    return true;
  }

  async getAllPushSubscriptions(): Promise<PushSubscription[]> {
    return await db.select().from(pushSubscriptions);
  }

  async savePushSubscription(subscription: InsertPushSubscription): Promise<PushSubscription> {
    const [newSub] = await db
      .insert(pushSubscriptions)
      .values(subscription)
      .returning();
    return newSub;
  }

  async getPushSubscriptionsByUser(userId: number): Promise<PushSubscription[]> {
    return await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  }

  async deletePushSubscription(endpoint: string): Promise<boolean> {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    return true;
  }

  // Aura readings
  async saveAuraReading(reading: InsertAuraReading): Promise<AuraReading> {
    const [auraReading] = await db
      .insert(auraReadings)
      .values({
        ...reading,
        secondaryColor: reading.secondaryColor || null
      })
      .returning();
    return auraReading;
  }

  async findAuraReadingByImageHash(imageHash: string): Promise<AuraReading | undefined> {
    // Look for existing analysis with the same image hash
    const [reading] = await db
      .select()
      .from(auraReadings)
      .where(eq(auraReadings.imageUrl, imageHash))
      .limit(1);
    return reading;
  }

  async getAuraReadingsByUser(userId: number): Promise<AuraReading[]> {
    return await db.select().from(auraReadings).where(eq(auraReadings.userId, userId));
  }

  async getAuraReadingsByPerformedBy(performedBy: number, limit: number = 50): Promise<AuraReading[]> {
    return await db.select().from(auraReadings)
      .where(eq(auraReadings.performedBy, performedBy))
      .orderBy(desc(auraReadings.createdAt))
      .limit(limit);
  }

  async getAuraReadingsCountByPerformedBy(performedBy: number): Promise<number> {
    const result = await db.select({ count: sql<number>`cast(count(*) as integer)` })
      .from(auraReadings)
      .where(eq(auraReadings.performedBy, performedBy));
    return result[0]?.count || 0;
  }

  async getAuraReading(id: number): Promise<AuraReading | undefined> {
    const [reading] = await db.select().from(auraReadings).where(eq(auraReadings.id, id));
    return reading || undefined;
  }

  async updateAuraReadingReview(id: number, rating: number, reviewText?: string): Promise<AuraReading | undefined> {
    const [updatedReading] = await db
      .update(auraReadings)
      .set({ rating, reviewText })
      .where(eq(auraReadings.id, id))
      .returning();
    return updatedReading || undefined;
  }

  async updateAuraReadingNotes(id: number, healerNotes: string): Promise<AuraReading | undefined> {
    const [updatedReading] = await db
      .update(auraReadings)
      .set({ healerNotes })
      .where(eq(auraReadings.id, id))
      .returning();
    return updatedReading || undefined;
  }

  async updateAuraReadingImage(id: number, processedImage: string): Promise<boolean> {
    try {
      const [updatedReading] = await db
        .update(auraReadings)
        .set({ processedAuraImage: processedImage })
        .where(eq(auraReadings.id, id))
        .returning();
      return !!updatedReading;
    } catch (error) {
      console.error("Error updating aura reading image:", error);
      return false;
    }
  }

  // Journal entries
  async createJournalEntry(entry: InsertJournal): Promise<Journal> {
    const [journalEntry] = await db
      .insert(journals)
      .values(entry)
      .returning();
    return journalEntry;
  }

  async getJournalEntriesByUser(userId: number): Promise<Journal[]> {
    return await db.select().from(journals).where(eq(journals.userId, userId));
  }

  async getJournalEntry(id: number): Promise<Journal | undefined> {
    const [entry] = await db.select().from(journals).where(eq(journals.id, id));
    return entry || undefined;
  }

  // Numerology readings
  async saveNumerologyReading(reading: InsertNumerologyReading): Promise<NumerologyReading> {
    const [numerologyReading] = await db
      .insert(numerologyReadings)
      .values(reading)
      .returning();
    return numerologyReading;
  }

  async getNumerologyReadingsByUser(userId: number): Promise<NumerologyReading[]> {
    return await db.select().from(numerologyReadings).where(eq(numerologyReadings.userId, userId));
  }

  async getNumerologyReadingsByPerformedBy(performedBy: number): Promise<NumerologyReading[]> {
    return await db.select().from(numerologyReadings).where(eq(numerologyReadings.performedBy, performedBy)).orderBy(desc(numerologyReadings.createdAt));
  }

  async getNumerologyReadingsCountByPerformedBy(performedBy: number): Promise<number> {
    const result = await db.select({ count: sql<number>`cast(count(*) as integer)` })
      .from(numerologyReadings)
      .where(eq(numerologyReadings.performedBy, performedBy));
    return result[0]?.count || 0;
  }

  async getNumerologyReading(id: number): Promise<NumerologyReading | undefined> {
    const [reading] = await db.select().from(numerologyReadings).where(eq(numerologyReadings.id, id));
    return reading || undefined;
  }

  async updateNumerologyReadingNotes(id: number, healerNotes: string): Promise<NumerologyReading | undefined> {
    const [updatedReading] = await db
      .update(numerologyReadings)
      .set({ healerNotes })
      .where(eq(numerologyReadings.id, id))
      .returning();
    return updatedReading || undefined;
  }

  async updateNumerologyReadingPdf(id: number, pdfData: string, healerNotes?: string): Promise<NumerologyReading | undefined> {
    const updateData: any = { pdfData };
    if (healerNotes !== undefined) {
      updateData.healerNotes = healerNotes;
    }
    const [updatedReading] = await db
      .update(numerologyReadings)
      .set(updateData)
      .where(eq(numerologyReadings.id, id))
      .returning();
    return updatedReading || undefined;
  }

  // Object analyses
  async saveObjectAnalysis(analysis: InsertObjectAnalysis): Promise<ObjectAnalysis> {
    const [objectAnalysis] = await db
      .insert(objectAnalyses)
      .values(analysis)
      .returning();
    return objectAnalysis;
  }

  async getObjectAnalysesByUser(userId: number): Promise<ObjectAnalysis[]> {
    return await db.select().from(objectAnalyses).where(eq(objectAnalyses.userId, userId));
  }

  async getObjectAnalysesByPerformedBy(performedBy: number): Promise<ObjectAnalysis[]> {
    return await db.select().from(objectAnalyses).where(eq(objectAnalyses.performedBy, performedBy)).orderBy(desc(objectAnalyses.createdAt));
  }

  async getObjectAnalysesCountByPerformedBy(performedBy: number): Promise<number> {
    const result = await db.select({ count: sql<number>`cast(count(*) as integer)` })
      .from(objectAnalyses)
      .where(eq(objectAnalyses.performedBy, performedBy));
    return result[0]?.count || 0;
  }

  async getObjectAnalysis(id: number): Promise<ObjectAnalysis | undefined> {
    const [analysis] = await db.select().from(objectAnalyses).where(eq(objectAnalyses.id, id));
    return analysis || undefined;
  }

  async updateObjectAnalysisReview(id: number, rating: number, reviewText?: string): Promise<ObjectAnalysis | undefined> {
    const [updatedAnalysis] = await db
      .update(objectAnalyses)
      .set({ rating, reviewText })
      .where(eq(objectAnalyses.id, id))
      .returning();
    return updatedAnalysis || undefined;
  }

  // Healer management
  async getAllHealers(): Promise<Healer[]> {
    return await db.select().from(healers);
  }

  async getHealer(id: number): Promise<Healer | undefined> {
    const STATIC_HEALERS_MAP: Record<number, Healer> = {
      9991: {
        id: 9991,
        name: "Nishant Sharma",
        username: "nishant.sharma2",
        specialty: "Aura Reading",
        description: "Founded by Nishant Sharma, an IT Engineer with a Master's in Applied Positive Psychology & Coaching Psychology (UEL, London) and over 20 years as a certified Energy healer.",
        email: "nishant@auraeye.com",
        phone: "+91-XXXXXXXXXX",
        imageUrl: "/nishant-new.jpg",
      },
      9992: {
        id: 9992,
        name: "Sunita Mann",
        username: "sunita_mann",
        specialty: "Spiritual Teacher & Healer",
        description: "Sunita Mann is a spiritual teacher & healer with over 20 years of experience. Trained in various modalities like Aura reading, Reiki healing, Angel's therapy etc.",
        email: "sunita@auraeye.com",
        phone: "+91-XXXXXXXXXX",
        imageUrl: "/sunita.jpg",
      },
      9993: {
        id: 9993,
        name: "Mr. Subramayanam",
        username: "subramayanam",
        specialty: "Energy Healer & Engineer",
        description: "Subramayanam is a Mechanical Engineer, Aura Reader, and Energy Healer who blends analytical precision with intuitive insight.",
        email: "subramayanam@auraeye.com",
        phone: "+91-XXXXXXXXXX",
        imageUrl: "/subramanyam.jpg",
      }
    };

    if (STATIC_HEALERS_MAP[id]) {
      return STATIC_HEALERS_MAP[id];
    }

    const [healer] = await db.select().from(healers).where(eq(healers.id, id));
    return healer || undefined;
  }

  async getHealerByUsername(username: string): Promise<Healer | undefined> {
    const STATIC_HEALERS_MAP: Record<string, Healer> = {
      "nishant.sharma2": {
        id: 9991,
        name: "Nishant Sharma",
        username: "nishant.sharma2",
        specialty: "Aura Reading",
        email: "nishant@auraeye.com",
        phone: "+91-XXXXXXXXXX",
        imageUrl: "/nishant-new.jpg",
        description: "Founded by Nishant Sharma, an IT Engineer with a Master's in Applied Positive Psychology & Coaching Psychology (UEL, London) and over 20 years as a certified Energy healer.",
      },
      "sunita_mann": {
        id: 9992,
        name: "Sunita Mann",
        username: "sunita_mann",
        specialty: "Spiritual Teacher & Healer",
        email: "sunita@auraeye.com",
        phone: "+91-XXXXXXXXXX",
        imageUrl: "/sunita.jpg",
        description: "Sunita Mann is a spiritual teacher & healer with over 20 years of experience. Trained in various modalities like Aura reading, Reiki healing, Angel's therapy etc.",
      },
      "subramayanam": {
        id: 9993,
        name: "Mr. Subramayanam",
        username: "subramayanam",
        specialty: "Energy Healer & Engineer",
        email: "subramayanam@auraeye.com",
        phone: "+91-XXXXXXXXXX",
        imageUrl: "/subramanyam.jpg",
        description: "Subramayanam is a Mechanical Engineer, Aura Reader, and Energy Healer who blends analytical precision with intuitive insight.",
      }
    };

    if (STATIC_HEALERS_MAP[username]) {
      return STATIC_HEALERS_MAP[username];
    }

    const [healer] = await db.select().from(healers).where(
      sql`LOWER(${healers.username}) = LOWER(${username})`
    );
    return healer || undefined;
  }

  async createHealer(healer: InsertHealer): Promise<Healer> {
    const [newHealer] = await db
      .insert(healers)
      .values(healer)
      .returning();
    return newHealer;
  }

  async updateHealerPassword(username: string, hashedPassword: string): Promise<Healer | undefined> {
    const [healer] = await db
      .update(healers)
      .set({ password: hashedPassword })
      .where(sql`LOWER(${healers.username}) = LOWER(${username})`)
      .returning();
    return healer || undefined;
  }

  // Healer bookings
  async createHealerBooking(booking: InsertHealerBooking): Promise<HealerBooking> {
    const [newBooking] = await db
      .insert(healerBookings)
      .values(booking)
      .returning();
    return newBooking;
  }

  async getHealerBookingsByUser(userId: number): Promise<HealerBooking[]> {
    return await db.select().from(healerBookings).where(eq(healerBookings.userId, userId));
  }

  async getHealerBookingsByHealer(healerId: number): Promise<HealerBooking[]> {
    return await db.select().from(healerBookings).where(eq(healerBookings.healerId, healerId));
  }

  async getHealerBooking(bookingId: number): Promise<HealerBooking | undefined> {
    const [booking] = await db.select().from(healerBookings).where(eq(healerBookings.id, bookingId));
    return booking;
  }

  async updateBookingStatus(bookingId: number, status: string): Promise<HealerBooking | undefined> {
    const [updatedBooking] = await db
      .update(healerBookings)
      .set({ status })
      .where(eq(healerBookings.id, bookingId))
      .returning();
    return updatedBooking;
  }

  async updateBookingStatusWithResponse(bookingId: number, status: string, healerResponse?: string): Promise<HealerBooking | undefined> {
    const [updatedBooking] = await db
      .update(healerBookings)
      .set({ status, healerResponse, respondedAt: new Date() })
      .where(eq(healerBookings.id, bookingId))
      .returning();
    return updatedBooking;
  }

  // Healer ratings
  async createHealerRating(rating: InsertHealerRating): Promise<HealerRating> {
    const [newRating] = await db.insert(healerRatings).values(rating).returning();
    return newRating;
  }

  async getHealerRatings(healerId: number): Promise<HealerRating[]> {
    return await db.select().from(healerRatings).where(eq(healerRatings.healerId, healerId));
  }

  async getHealerAverageRating(healerId: number): Promise<number> {
    const ratings = await this.getHealerRatings(healerId);
    if (ratings.length === 0) return 5;
    const sum = ratings.reduce((acc, r) => acc + r.rating, 0);
    return sum / ratings.length;
  }

  // Healer badges
  async createHealerBadge(badge: InsertHealerBadge): Promise<HealerBadge> {
    const [newBadge] = await db.insert(healerBadges).values(badge).returning();
    return newBadge;
  }

  async getHealerBadges(healerId: number): Promise<HealerBadge[]> {
    return await db.select().from(healerBadges).where(eq(healerBadges.healerId, healerId));
  }

  async deleteExpiredBadges(): Promise<void> {
    await db.delete(healerBadges).where(lt(healerBadges.expiresAt, new Date()));
  }

  // User achievements
  async createUserAchievement(achievement: InsertAchievement): Promise<Achievement> {
    const [newAchievement] = await db.insert(userAchievements).values(achievement as any).returning();
    return newAchievement as Achievement;
  }

  async getUserAchievements(userId: number): Promise<Achievement[]> {
    return await db.select().from(userAchievements).where(eq(userAchievements.userId, userId)) as Achievement[];
  }

  async checkAndAwardAchievements(userId: number): Promise<Achievement[]> {
    try {
      const { checkAndAwardBadges } = await import("./badge-checker");
      await checkAndAwardBadges(userId);
      return await this.getUserAchievements(userId);
    } catch (error) {
      console.error("Error in checkAndAwardAchievements:", error);
      return [];
    }
  }

  // Healer analytics
  async getHealerClientStats(healerId: number): Promise<any> {
    const result = await db.select({
      totalClients: sql<number>`cast(count(distinct ${healerBookings.userId}) as integer)`,
      totalBookings: sql<number>`cast(count(*) as integer)`
    })
    .from(healerBookings)
    .where(eq(healerBookings.healerId, healerId));
    return result[0];
  }

  async getHealerBookingTrends(healerId: number): Promise<any> {
    return await db.select()
      .from(healerBookings)
      .where(eq(healerBookings.healerId, healerId))
      .orderBy(desc(healerBookings.createdAt))
      .limit(10);
  }

  // Vibe feedback
  async saveVibeFeedback(feedback: InsertVibeFeedback): Promise<VibeFeedback> {
    const [newFeedback] = await db.insert(vibeFeedback).values(feedback).returning();
    return newFeedback;
  }

  async getVibeFeedbackByUser(userId: number): Promise<VibeFeedback[]> {
    return await db.select().from(vibeFeedback).where(eq(vibeFeedback.userId, userId));
  }

  // Vibe readings for healer dashboard
  async saveVibeReading(reading: InsertVibeReading): Promise<VibeReading> {
    const [newReading] = await db.insert(vibeReadings).values(reading).returning();
    return newReading;
  }

  async getVibeReadingsByUserId(userId: number): Promise<VibeReading[]> {
    return await db.select().from(vibeReadings).where(eq(vibeReadings.userId, userId));
  }

  async getVibeReadingsCountByUserId(userId: number): Promise<number> {
    const result = await db.select({ count: sql<number>`cast(count(*) as integer)` })
      .from(vibeReadings)
      .where(eq(vibeReadings.userId, userId));
    return result[0]?.count || 0;
  }

  async getAllVibeReadings(): Promise<any[]> {
    return await db.select().from(vibeReadings);
  }

  // Credit management
  async getUserCredits(userId: number): Promise<number> {
    try {
      const { expireCreditsForUser } = await import("./credit-grants");
      await expireCreditsForUser(userId);
    } catch (e) {
      console.error("Credit expiry check failed:", e);
    }
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    return user?.credits ?? 0;
  }

  async deductCredits(userId: number, amount: number, type: string, description: string): Promise<boolean> {
    try {
      const { expireCreditsForUser, consumeCreditGrants } = await import("./credit-grants");
      await expireCreditsForUser(userId);
      const ok = await db.transaction(async (tx) => {
        const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
        if (!user) {
          console.error(`DeductCredits: User ${userId} not found`);
          return false;
        }

        const currentCredits = Number(user.credits || 0);
        if (currentCredits < amount) {
          console.log(`DeductCredits: User ${userId} has insufficient credits (${currentCredits} < ${amount})`);
          return false;
        }

        const newCredits = currentCredits - amount;
        await tx.update(users).set({ credits: newCredits }).where(eq(users.id, userId));
        await tx.insert(creditTransactions).values({
          userId,
          username: user.username,
          amount: -amount,
          transactionType: type,
          description,
          balanceAfter: newCredits,
        });
        await consumeCreditGrants(userId, amount, tx);
        console.log(`DeductCredits SUCCESS: User ${userId}, deducted ${amount}, new balance ${newCredits}`);
        return true;
      });
      return ok;
    } catch (error) {
      console.error("DeductCredits error:", error);
      return false;
    }
  }

  async addCredits(
    userId: number,
    amount: number,
    type: string,
    description: string,
    expiresAt?: Date | null
  ): Promise<boolean> {
    try {
      const { addCreditGrant } = await import("./credit-grants");
      const result = await addCreditGrant({
        userId,
        amount,
        expiresAt: expiresAt === undefined ? null : expiresAt,
        source: type,
        note: description,
        transactionType: type,
        updateBalance: true,
      });
      if (result) return true;

      // Fallback if grants table missing
      return await db.transaction(async (tx) => {
        const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
        if (!user) return false;

        const newCredits = (user.credits || 0) + amount;
        await tx.update(users).set({ credits: newCredits }).where(eq(users.id, userId));
        await tx.insert(creditTransactions).values({
          userId,
          username: user.username,
          amount,
          transactionType: type,
          description,
          balanceAfter: newCredits,
        });
        return true;
      });
    } catch (error) {
      console.error("AddCredits error:", error);
      return false;
    }
  }

  async getCreditTransactionsByUser(userId: number): Promise<CreditTransaction[]> {
    try {
      return await db.select().from(creditTransactions).where(eq(creditTransactions.userId, userId)).orderBy(desc(creditTransactions.createdAt));
    } catch (error) {
      console.error("Error fetching credit transactions:", error);
      return [];
    }
  }

  async createCreditTransaction(transaction: InsertCreditTransaction): Promise<CreditTransaction> {
    const [newTransaction] = await db.insert(creditTransactions).values(transaction).returning();
    return newTransaction;
  }

  // Soul energy management
  async getUserSoulEnergy(userId: number): Promise<number> {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    return user?.soulEnergy || 0;
  }

  async addSoulEnergy(userId: number, amount: number, source: string): Promise<boolean> {
    const user = await this.getUser(userId);
    if (!user) return false;

    await db.update(users)
      .set({ soulEnergy: (user.soulEnergy || 0) + amount })
      .where(eq(users.id, userId));
    return true;
  }

  // Password reset tokens
  async createPasswordResetToken(token: InsertPasswordResetToken): Promise<PasswordResetToken> {
    const [newToken] = await db.insert(passwordResetTokens).values(token).returning();
    return newToken;
  }

  async validatePasswordResetToken(username: string, email: string, token: string): Promise<PasswordResetToken | undefined> {
    const [record] = await db.select().from(passwordResetTokens).where(
      and(
        sql`LOWER(${passwordResetTokens.username}) = LOWER(${username})`,
        sql`LOWER(${passwordResetTokens.email}) = LOWER(${email})`,
        eq(passwordResetTokens.token, token),
        gt(passwordResetTokens.expiresAt, new Date()),
        eq(passwordResetTokens.used, false)
      )
    );
    return record || undefined;
  }

  async validatePasswordResetTokenByMobile(username: string, mobileNumber: string, token: string): Promise<PasswordResetToken | undefined> {
    const [record] = await db.select().from(passwordResetTokens).where(
      and(
        eq(passwordResetTokens.username, username),
        eq(passwordResetTokens.mobileNumber, mobileNumber),
        eq(passwordResetTokens.token, token),
        gt(passwordResetTokens.expiresAt, new Date()),
        eq(passwordResetTokens.used, false)
      )
    );
    return record || undefined;
  }

  async markPasswordResetTokenAsUsed(tokenId: number): Promise<void> {
    await db.update(passwordResetTokens).set({ used: true }).where(eq(passwordResetTokens.id, tokenId));
  }

  // Credit costs based on user type
  async getCreditCost(userId: number, serviceType: string): Promise<number> {
    const user = await this.getUser(userId);
    if (!user) return 1;

    return getCreditCostForService(serviceType);
  }

  // Store PDF
  async storePdf(pdf: InsertPdfStorage): Promise<PdfStorage> {
    const [newPdf] = await db.insert(pdfStorage).values(pdf).returning();
    return newPdf;
  }

  async getPdfByAuraReadingId(auraReadingId: number): Promise<PdfStorage | undefined> {
    const [pdf] = await db.select().from(pdfStorage).where(eq(pdfStorage.auraReadingId, auraReadingId));
    return pdf || undefined;
  }

  async getPdfsByHealerId(healerId: number): Promise<PdfStorage[]> {
    return await db.select().from(pdfStorage).where(eq(pdfStorage.healerId, healerId));
  }

  // Mood Snapshots
  async createMoodSnapshot(snapshot: InsertMoodSnapshot): Promise<MoodSnapshot> {
    const [newSnapshot] = await db.insert(moodSnapshots).values(snapshot).returning();
    return newSnapshot;
  }

  async getMoodSnapshotsByUser(userId: number): Promise<MoodSnapshot[]> {
    try {
      return await db.select().from(moodSnapshots).where(eq(moodSnapshots.userId, userId)).orderBy(desc(moodSnapshots.timestamp));
    } catch (error) {
      console.error("Error fetching mood snapshots:", error);
      return [];
    }
  }

  async getRecentMoodSnapshots(userId: number, limit: number): Promise<MoodSnapshot[]> {
    return await db.select().from(moodSnapshots).where(eq(moodSnapshots.userId, userId)).orderBy(desc(moodSnapshots.timestamp)).limit(limit);
  }

  // Meditation sessions
  async createMeditationSession(session: InsertMeditationSession): Promise<MeditationSession> {
    const [newSession] = await db.insert(meditationSessions).values(session).returning();
    return newSession;
  }

  async getUserMeditationSessions(userId: number): Promise<MeditationSession[]> {
    try {
      return await db.select().from(meditationSessions).where(eq(meditationSessions.userId, userId)).orderBy(desc(meditationSessions.createdAt));
    } catch (error) {
      console.error("Error fetching meditation sessions:", error);
      return [];
    }
  }

  async getMeditationStats(userId: number): Promise<{ sessionsCount: number; totalMinutes: number; totalEnergy: number }> {
    const sessions = await this.getUserMeditationSessions(userId);
    return {
      sessionsCount: sessions.length,
      totalMinutes: sessions.reduce((acc, s) => acc + (s.durationMinutes || 0), 0),
      totalEnergy: sessions.reduce((acc, s) => acc + (s.energyGained || 0), 0)
    };
  }

  // Favorite meditations
  async addFavoriteMeditation(favorite: InsertFavoriteMeditation): Promise<FavoriteMeditation> {
    const [newFavorite] = await db.insert(favoriteMeditations).values(favorite).returning();
    return newFavorite;
  }

  async removeFavoriteMeditation(userId: number, meditationId: number): Promise<boolean> {
    const result = await db.delete(favoriteMeditations).where(
      and(
        eq(favoriteMeditations.userId, userId),
        eq(favoriteMeditations.meditationId, meditationId)
      )
    );
    return !!result;
  }

  async getFavoriteMeditations(userId: number): Promise<FavoriteMeditation[]> {
    return await db.select().from(favoriteMeditations).where(eq(favoriteMeditations.userId, userId));
  }

  async isMeditationFavorite(userId: number, meditationId: number): Promise<boolean> {
    const [fav] = await db.select().from(favoriteMeditations).where(
      and(
        eq(favoriteMeditations.userId, userId),
        eq(favoriteMeditations.meditationId, meditationId)
      )
    );
    return !!fav;
  }

  // User stats
  async getUserStats(userId: number): Promise<any> {
    try {
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      const [auraReadingsCount] = await db.select({ count: sql<number>`cast(count(*) as integer)` }).from(auraReadings).where(eq(auraReadings.userId, userId));
      const [numerologyReadingsCount] = await db.select({ count: sql<number>`cast(count(*) as integer)` }).from(numerologyReadings).where(eq(numerologyReadings.userId, userId));
      const [vibeReadingsCount] = await db.select({ count: sql<number>`cast(count(*) as integer)` }).from(vibeReadings).where(eq(vibeReadings.userId, userId));
      const [journalsCount] = await db.select({ count: sql<number>`cast(count(*) as integer)` }).from(journals).where(eq(journals.userId, userId));
      const [objectAnalysesCount] = await db.select({ count: sql<number>`cast(count(*) as integer)` }).from(objectAnalyses).where(eq(objectAnalyses.userId, userId));
      const [meditationSessionsCount] = await db.select({ count: sql<number>`cast(count(*) as integer)` }).from(meditationSessions).where(eq(meditationSessions.userId, userId));

      return {
        name: user?.name,
        email: user?.email,
        auraReadings: auraReadingsCount?.count || 0,
        numerologyReadings: numerologyReadingsCount?.count || 0,
        vibeReadings: vibeReadingsCount?.count || 0,
        journals: journalsCount?.count || 0,
        objectAnalyses: objectAnalysesCount?.count || 0,
        meditationSessions: meditationSessionsCount?.count || 0,
        auraScans: auraReadingsCount?.count || 0,
        totalSessions: (auraReadingsCount?.count || 0) + (meditationSessionsCount?.count || 0),
        meditationHours: 0,
        healersConsulted: 0,
      };
    } catch (error) {
      console.error("Error fetching user stats:", error);
      return {
        auraReadings: 0,
        numerologyReadings: 0,
        vibeReadings: 0,
        journals: 0,
        objectAnalyses: 0,
        meditationSessions: 0,
        auraScans: 0,
        totalSessions: 0,
        healersConsulted: 0,
        meditationHours: 0,
      };
    }
  }

  // Login streak tracking
  async recordLogin(userId: number): Promise<void> {
    try {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0, 0);
      const existing = await db
        .select()
        .from(loginSessions)
        .where(and(eq(loginSessions.userId, userId), eq(loginSessions.loginDate, today)))
        .limit(1);
      if (!existing.length) {
        await db.insert(loginSessions).values({ userId, loginDate: today });
      }
    } catch (error) {
      console.error("recordLogin failed:", error);
    }
  }

  async getLoginStreak(userId: number): Promise<{ currentStreak: number; longestStreak: number; weeklyActiveDates: string[] }> {
    try {
      const sessions = await db
        .select()
        .from(loginSessions)
        .where(eq(loginSessions.userId, userId))
        .orderBy(desc(loginSessions.loginDate))
        .limit(400);

      const dates = sessions.map((s) => {
        const d = new Date(s.loginDate);
        return d.toISOString().slice(0, 10);
      });
      const uniqueDates = [...new Set(dates)].sort().reverse();

      let currentStreak = 0;
      let longestStreak = 0;
      let run = 0;
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0, 0);

      for (let i = 0; i < uniqueDates.length; i++) {
        const expected = new Date(today);
        expected.setUTCDate(expected.getUTCDate() - i);
        const expectedStr = expected.toISOString().slice(0, 10);
        if (uniqueDates[i] === expectedStr) {
          currentStreak++;
        } else if (i === 0) {
          break;
        } else {
          break;
        }
      }

      let prev: Date | null = null;
      for (const ds of [...uniqueDates].sort()) {
        const d = new Date(ds + "T00:00:00Z");
        if (prev) {
          const diff = (d.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000);
          if (diff === 1) run++;
          else run = 1;
        } else {
          run = 1;
        }
        longestStreak = Math.max(longestStreak, run);
        prev = d;
      }

      const weekAgo = new Date(today);
      weekAgo.setUTCDate(weekAgo.getUTCDate() - 6);
      const weeklyActiveDates = uniqueDates.filter((d) => new Date(d + "T00:00:00Z") >= weekAgo);

      return { currentStreak, longestStreak, weeklyActiveDates };
    } catch (error) {
      console.error("Error fetching login streak:", error);
      return { currentStreak: 0, longestStreak: 0, weeklyActiveDates: [] };
    }
  }
}

export const storage = new DatabaseStorage();
