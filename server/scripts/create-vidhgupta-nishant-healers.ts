import { db } from "../db";
import { users, healers, creditTransactions } from "../../shared/schema";
import { hashPassword } from "../auth";
import { eq, sql } from "drizzle-orm";

const HEALER_ACCOUNTS = [
  {
    username: "vidhgupta",
    email: "vishugupta1996@gmail.com",
    name: "Vidhu Gupta",
    specialty: "Aura Reading & Spiritual Guidance",
    location: "India",
  },
  {
    username: "nishanthealer",
    email: "teamauraeye@gmail.com",
    name: "Nishant Healer",
    specialty: "Energy Healing & Coaching",
    location: "India",
  },
] as const;

const PASSWORD = "healer123";
const INITIAL_CREDITS = 10;

async function upsertHealerAccount(account: (typeof HEALER_ACCOUNTS)[number]) {
  const hashedPassword = await hashPassword(PASSWORD);
  const normalizedUsername = account.username.toLowerCase();

  const existingUsers = await db
    .select()
    .from(users)
    .where(sql`LOWER(${users.username}) = ${normalizedUsername}`);

  let user = existingUsers[0];

  if (user) {
    const [updatedUser] = await db
      .update(users)
      .set({
        email: account.email,
        password: hashedPassword,
        userType: "healer",
        credits: INITIAL_CREDITS,
        isActive: true,
        name: account.name,
      })
      .where(eq(users.id, user.id))
      .returning();
    user = updatedUser;
    console.log(`♻️  Updated user: ${account.username} (id ${user.id})`);
  } else {
    const [newUser] = await db
      .insert(users)
      .values({
        username: account.username,
        email: account.email,
        password: hashedPassword,
        userType: "healer",
        credits: INITIAL_CREDITS,
        name: account.name,
        isActive: true,
      })
      .returning();
    user = newUser;
    console.log(`✅ Created user: ${account.username} (id ${user.id})`);
  }

  const existingHealers = await db
    .select()
    .from(healers)
    .where(sql`LOWER(${healers.username}) = ${normalizedUsername}`);

  if (existingHealers.length > 0) {
    await db
      .update(healers)
      .set({
        name: account.name,
        email: account.email,
        password: hashedPassword,
        specialty: account.specialty,
        description: `Experienced ${account.specialty.toLowerCase()} with AuraEye.`,
        phone: existingHealers[0].phone || "+91 0000000000",
        location: account.location,
      })
      .where(eq(healers.id, existingHealers[0].id));
    console.log(`♻️  Updated healer profile: ${account.username}`);
  } else {
    await db.insert(healers).values({
      name: account.name,
      username: account.username,
      password: hashedPassword,
      specialty: account.specialty,
      description: `Experienced ${account.specialty.toLowerCase()} with AuraEye.`,
      email: account.email,
      phone: "+91 0000000000",
      location: account.location,
      rating: 5,
      experience: "5+ years",
    });
    console.log(`✅ Created healer profile: ${account.username}`);
  }

  const isNewUser = existingUsers.length === 0;
  if (isNewUser) {
    await db.insert(creditTransactions).values({
      userId: user.id,
      username: user.username,
      amount: INITIAL_CREDITS,
      transactionType: "bonus",
      description: "Initial healer account credits",
      balanceAfter: INITIAL_CREDITS,
    });
    console.log(`💰 Added initial ${INITIAL_CREDITS} credits for ${account.username}`);
  } else {
    console.log(`💰 Credits set to ${INITIAL_CREDITS} for ${account.username}`);
  }
  console.log(`📧 Email: ${account.email} | 🔑 Password: ${PASSWORD}`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Add your Replit/Neon connection string to Cursor Cloud Secrets.");
  }

  console.log("🔮 Creating/updating healer accounts on production database...\n");

  for (const account of HEALER_ACCOUNTS) {
    try {
      await upsertHealerAccount(account);
      console.log("");
    } catch (error) {
      console.error(`❌ Failed for ${account.username}:`, error);
    }
  }

  console.log("🎉 Done.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
