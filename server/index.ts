import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { runStartupSeed } from "./seed-data";
import { setupVite, serveStatic, log } from "./vite";
import { serveProductionStatic } from "./production-static";
import { initializeWhatsApp } from "./whatsapp-service";
import { logEmailProviderStatus } from "./email-service";
import Stripe from "stripe";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";

const app = express();

// Initialize Stripe
const stripe = process.env.STRIPE_SECRET_KEY 
  ? new Stripe(process.env.STRIPE_SECRET_KEY) 
  : null;

// Add health check endpoint first (before other middleware)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/app-info', (_req, res) => {
  res.status(200).json({
    app: 'AuraEye',
    repo: 'mobileauraeyefinal',
    description: 'Spiritual wellness platform',
    timestamp: new Date().toISOString(),
  });
});

// Root endpoint for health checks
app.get('/', (req, res, next) => {
  // If this is a health check request, respond quickly
  if (req.get('User-Agent')?.includes('health') || req.get('User-Agent')?.includes('check')) {
    return res.status(200).json({ status: 'ok' });
  }
  // Otherwise, continue to normal routing
  next();
});

// Quick Buy always gives 15 credits on successful payment
const QUICK_BUY_CREDITS = 15;

// Function to determine credits - always returns 15 for Quick Buy
function determineCredits(amountInPaise: number): number {
  // Quick Buy always gives 15 credits regardless of amount
  return QUICK_BUY_CREDITS;
}

// Stripe webhook endpoint - MUST be before JSON body parser
// This route needs raw body for signature verification
app.post('/api/webhooks/stripe', 
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response) => {
    console.log('=== STRIPE WEBHOOK RECEIVED ===');
    
    if (!stripe) {
      console.error('Stripe not configured');
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    const sig = req.headers['stripe-signature'] as string;
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    let event: Stripe.Event;
    
    try {
      // Verify webhook signature for security
      if (endpointSecret && sig) {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
      } else if (process.env.NODE_ENV === 'development') {
        // Only allow unverified webhooks in development
        const payload = typeof req.body === 'string' ? req.body : req.body.toString();
        event = JSON.parse(payload) as Stripe.Event;
        console.log('DEV MODE: Processing webhook without signature verification');
      } else {
        // In production, reject webhooks without proper signature
        console.error('Webhook rejected: Missing signature in production');
        return res.status(400).json({ error: 'Webhook signature required in production' });
      }
    } catch (err: any) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    console.log('Webhook event type:', event.type);

    // Handle checkout session completed
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const sessionId = session.id;
      const customerEmail = session.customer_email || session.customer_details?.email;
      const amountTotal = session.amount_total || 49900; // Fallback to largest pack if missing
      
      console.log('Checkout completed for email:', customerEmail);
      console.log('Session ID:', sessionId);
      console.log('Payment status:', session.payment_status);
      console.log('Amount paid:', amountTotal);
      
      if (customerEmail && session.payment_status === 'paid') {
        try {
          // Idempotency check: Verify this session hasn't been processed already
          const existingTransaction = await db.execute(
            sql`SELECT id FROM payment_transactions WHERE stripe_session_id = ${sessionId} LIMIT 1`
          );
          const existingRows = existingTransaction.rows || existingTransaction;
          
          if ((existingRows as any[]).length > 0) {
            console.log(`⚠️ Session ${sessionId} already processed, skipping duplicate webhook`);
            return res.json({ received: true, status: 'duplicate' });
          }
          
          // Find user by email
          const userResult = await db.execute(
            sql`SELECT * FROM users WHERE LOWER(email) = LOWER(${customerEmail}) LIMIT 1`
          );
          const users = userResult.rows || userResult;
          const user = (users as any[])[0];
          
          if (user) {
            const creditsToAdd = determineCredits(amountTotal);
            const currentCredits = user.credits || 0;
            const currentUserType = user.user_type || 'client';

            if (currentUserType === 'client') {
              await db.execute(sql`UPDATE users SET user_type = 'healer' WHERE id = ${user.id}`);
              console.log(`🎉 Upgraded user ${user.username} from client to healer`);
            }

            await storage.addCredits(
              user.id,
              creditsToAdd,
              'stripe_payment',
              `Stripe checkout ${sessionId}`
            );
            const newCredits = await storage.getUserCredits(user.id);

            await db.execute(sql`
              INSERT INTO payment_transactions (user_id, amount, status, billing_email, credits_before, credits_after, stripe_session_id, created_at)
              VALUES (${user.id}, ${amountTotal}, 'completed', ${customerEmail}, ${currentCredits}, ${newCredits}, ${sessionId}, NOW())
            `);

            console.log(`✅ Added ${creditsToAdd} credits to user ${user.username}. New balance: ${newCredits}`);
          } else {
            console.log('User not found for email:', customerEmail);
          }
        } catch (error) {
          console.error('Error processing payment:', error);
        }
      }
    }

    res.json({ received: true });
  }
);

// Configure body parsers with increased limits for image uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Initialize WhatsApp service
  console.log('Initializing WhatsApp service...');
  initializeWhatsApp();

  // Seed all users and healers from production data
  // Don't block server startup - seed in background
  setTimeout(() => runStartupSeed().catch(e => console.error("Seed failed:", e)), 100);
  
  const server = await registerRoutes(app);

  // Enhanced error handling for static file serving
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    
    // Log error but don't crash the server
    console.error(`Error ${status} on ${req.method} ${req.path}:`, message);
    
    if (!res.headersSent) {
      res.status(status).json({ message });
    }
    
    // Don't throw error - this prevents server crashes
    if (status >= 500) {
      console.error('Server error stack:', err.stack);
    }
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    try {
      serveProductionStatic(app);
    } catch (error) {
      console.error("Failed to serve static files with flexible approach:", error);
      // Enhanced fallback with basic static serving
      try {
        serveStatic(app);
      } catch (fallbackError) {
        console.error("All static serving methods failed:", fallbackError);
        // Ultimate fallback for health checks
        app.get('*', (req, res) => {
          if (req.path === '/' || req.path === '/health') {
            res.status(200).send('<html><body><h1>Server Running</h1></body></html>');
          } else {
            res.status(404).send('Not Found');
          }
        });
      }
    }
  }

  // ALWAYS serve the app on port 5000
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = process.env.PORT || 5000;
  const host = process.env.HOST || "0.0.0.0";
  
  server.listen({
    port: Number(port),
    host,
    reusePort: true,
  }, async () => {
    log(`serving on host ${host} port ${port}`);
    logEmailProviderStatus();
    
    // Start daily horoscope cron job after server starts
    try {
      const { startDailyHoroscopeCron } = await import('./horoscope-scraper');
      startDailyHoroscopeCron();
    } catch (error: any) {
      console.error('Failed to start horoscope cron job:', error?.message || error);
    }
    
    // Start notification scheduler
    try {
      const { startNotificationScheduler } = await import('./notification-scheduler');
      startNotificationScheduler();
    } catch (error: any) {
      console.error('Failed to start notification scheduler:', error?.message || error);
    }
  });

  // Add timeout handling for server startup
  server.setTimeout(30000); // 30 second timeout

  // Handle server errors gracefully
  server.on('error', (error: any) => {
    console.error('Server error:', error);
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use`);
    }
  });

  // Graceful shutdown handling
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
})();
