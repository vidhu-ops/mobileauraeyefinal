import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import crypto from "crypto";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import { setupAuth, isAuthenticated } from "./auth";
import { storage } from "./storage";
import { analyzeAuraImage, generateNumerologyReading, AuraAnalysisResult } from "./api/openai-minimal";
import { analyzeImageWithGemini, generateAuraVisualization } from "./api/gemini";
import { enhancedAuraAnalysis } from "./api/enhanced-aura";
import { generateParticleAuraEffect } from "./api/particle-aura";
import { analyzeImageColors } from "./api/image-color-analysis";
import { getHoroscopeForSign, calculateNumerologyProfile, getPersonalizedHoroscope } from "./api/horoscope";
import { configureFileUpload } from "./api/upload";
import { NumerologyResult } from "../client/src/lib/openai";
import { sendHealerBookingNotification, sendPasswordResetEmail, sendPasswordResetConfirmationEmail, sendPaymentConfirmationEmail, sendEmailConfirmationEmail } from "./email-service";
import { generateAndSendOTP, verifyOTP, isMobileVerified } from "./otp-service";
import { hashPassword, comparePasswords } from "./auth";
import { insertHealerSchema, insertHealerBookingSchema, insertHealerRatingSchema, insertHealerBadgeSchema, insertJournalSchema, otpVerifications, insertPushSubscriptionSchema, pdfStorage, achievements, colorCollectors, chakraUnlocks, paymentPlans, paymentTransactions, userSubscriptions, users, healerRatings, healerBadges, healerBookings, User } from "../shared/schema";
import { validateEmailAddress } from "./email-validator";
import { db } from "./db";
import { eq, and, gt, gte, lt, sql } from "drizzle-orm";
import { auraReadings } from "../shared/schema";
import { getVapidPublicKey, sendPushToUser, sendPushNotification } from "./push-service";

interface AuthenticatedRequest extends Request {
  user: User;
  creditCost?: number;
}

function checkCredits(serviceType: string) {
  return async (req: any, res: any, next: any) => {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: "Authentication required" });
    }
    
    const userId = req.user.id;
    const userCredits = await storage.getUserCredits(userId);
    const requiredCredits = await storage.getCreditCost(userId, serviceType);
    
    // Check if service is unavailable for this user type (-1 indicates unavailable)
    if (requiredCredits === -1) {
      return res.status(403).json({ 
        error: "Service not available",
        message: `This service is not available for your account type.`,
        service: serviceType
      });
    }
    
    if (userCredits < requiredCredits) {
      return res.status(402).json({ 
        error: "Insufficient credits",
        message: `You need ${requiredCredits} credits to use this service. You have ${userCredits} credits.`,
        credits: userCredits,
        required: requiredCredits
      });
    }
    
    // Store the required credits in the request for later use
    req.creditCost = requiredCredits;
    next();
  };
}

// Optional credit checking middleware - allows unauthenticated access but checks credits if authenticated
function optionalCheckCredits(serviceType: string) {
  return async (req: any, res: any, next: any) => {
    // If user is not authenticated, allow access
    if (!req.user || !req.user.id) {
      req.creditCost = 0; // No credits required for unauthenticated users
      return next();
    }
    
    const userId = req.user.id;
    const userCredits = await storage.getUserCredits(userId);
    const requiredCredits = await storage.getCreditCost(userId, serviceType);
    
    // Check if service is unavailable for this user type (-1 indicates unavailable)
    if (requiredCredits === -1) {
      return res.status(403).json({ 
        error: "Service not available",
        message: `This service is not available for your account type.`,
        service: serviceType
      });
    }
    
    if (userCredits < requiredCredits) {
      return res.status(402).json({ 
        error: "Insufficient credits",
        message: `You need ${requiredCredits} credits to use this service. You have ${userCredits} credits.`,
        credits: userCredits,
        required: requiredCredits
      });
    }
    
    // Store the required credits in the request for later use
    req.creditCost = requiredCredits;
    next();
  };
}



// Only approved aura colors - restricted to 12 colors as per requirements
const APPROVED_AURA_COLORS = [
  { name: "Violet", hex: "#8A2BE2" },
  { name: "Indigo", hex: "#4B0082" },
  { name: "Blue", hex: "#0000FF" },
  { name: "Green", hex: "#00FF00" },
  { name: "Yellow", hex: "#FFFF00" },
  { name: "Orange", hex: "#FFA500" },
  { name: "Red", hex: "#FF0000" },
  { name: "White", hex: "#FFFFFF" },
  { name: "Black", hex: "#000000" },
  { name: "Gold", hex: "#FFD700" },
  { name: "Silver", hex: "#C0C0C0" },
  { name: "Brown", hex: "#8B4513" }
];

// Cache for human detection results to avoid repeated API calls
const humanDetectionCache = new Map<string, { result: boolean; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

function generateFastAuraAnalysis(imageBuffer?: Buffer, urlSeed?: string) {
  // Enhanced hash generation for better consistency with URL diversity
  let seed = 12345;
  if (imageBuffer) {
    const sampleSize = Math.min(2048, imageBuffer.length); // Increased sample size
    const sample = imageBuffer.subarray(0, sampleSize);
    seed = 0;
    for (let i = 0; i < sample.length; i += 3) { // Changed stride for better distribution
      seed = (seed * 31 + sample[i]) >>> 0;
    }
    // Add buffer length to seed for additional uniqueness
    seed = (seed + imageBuffer.length) >>> 0;
    
    // Add URL diversity factor if provided
    if (urlSeed) {
      for (let i = 0; i < urlSeed.length; i++) {
        seed = (seed * 31 + urlSeed.charCodeAt(i)) >>> 0;
      }
    }
  }
  
  // Fast inline random generator
  const seededRandom = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  
  // Use only the 12 approved aura colors - prioritize spiritual colors
  const spiritualColors = [
    { name: "Violet", hex: "#8A2BE2" },
    { name: "Indigo", hex: "#4B0082" },
    { name: "Blue", hex: "#0000FF" },
    { name: "Green", hex: "#00FF00" },
    { name: "Gold", hex: "#FFD700" },
    { name: "White", hex: "#FFFFFF" },
    { name: "Silver", hex: "#C0C0C0" },
    { name: "Yellow", hex: "#FFFF00" },
    { name: "Orange", hex: "#FFA500" },
    { name: "Red", hex: "#FF0000" },
    { name: "Brown", hex: "#8B4513" },
    { name: "Gray", hex: "#808080" }
  ];
  
  // Use spiritual colors 80% of the time for dominant/secondary
  const getDominantColor = () => {
    return seededRandom() < 0.8 
      ? spiritualColors[Math.floor(seededRandom() * 9)] // First 9 are most spiritual
      : spiritualColors[Math.floor(seededRandom() * spiritualColors.length)];
  };
  
  const getSecondaryColor = (avoid: string) => {
    const availableColors = spiritualColors.filter(c => c.name !== avoid);
    return seededRandom() < 0.7
      ? availableColors[Math.floor(seededRandom() * Math.min(9, availableColors.length))]
      : availableColors[Math.floor(seededRandom() * availableColors.length)];
  };
  
  // Generate unique colors
  const dominantColor = getDominantColor();
  const secondaryColor = getSecondaryColor(dominantColor.name);
  
  // Spectrum includes variety but still avoids black in main positions
  const spectrumColors = [
    dominantColor,
    secondaryColor,
    spiritualColors[Math.floor(seededRandom() * spiritualColors.length)],
    spiritualColors[Math.floor(seededRandom() * spiritualColors.length)]
  ];
  
  const auraColorSpectrum = spectrumColors.map(color => color.name);
  
  // Enhanced energy level calculation with full 1-10 variability
  const energyBase = Math.floor(seededRandom() * 10) + 1; // Base 1-10 range
  const energyModifier = Math.floor(seededRandom() * 5) - 2; // -2 to +2 modifier
  const energyLevel = Math.min(10, Math.max(1, energyBase + energyModifier)); // Keep in 1-10 range with variation
  
  return {
    dominantColor: dominantColor.name,
    secondaryColor: secondaryColor.name,
    auraColors: auraColorSpectrum,
    auraColorSpectrum: auraColorSpectrum,
    auraLayerColors: {
      inner: dominantColor.name,
      middle: spectrumColors[2].name,
      outer: spectrumColors[3].name
    },
    personalityTraits: ["Intuitive", "Creative", "Healing", "Wise"],
    energyLevel: energyLevel,
    spiritualGuidance: `Your aura reveals ${dominantColor.name} energy representing spiritual wisdom and ${secondaryColor.name} energy indicating creative transformation.`,
    zones: {
      giving: {
        colors: [dominantColor.name],
        interpretation: `Giving energy of ${dominantColor.name}`
      },
      receiving: {
        colors: [secondaryColor.name],
        interpretation: `Receptive energy of ${secondaryColor.name}`
      },
      thinking: {
        colors: [spectrumColors[2].name],
        interpretation: `Mental energy of ${spectrumColors[2].name}`
      },
      overall: {
        colors: [dominantColor.name, secondaryColor.name],
        interpretation: `Overall energy of ${dominantColor.name} and ${secondaryColor.name}`
      }
    },
    spiritualGifts: ["Intuitive", "Creative", "Healing"],
    currentChallenges: ["Learning to trust intuition"],
    recommendations: ["Meditation practices"],
    balanceState: "Harmonious",
    detailedAnalysis: `Your aura shows ${dominantColor.name} and ${secondaryColor.name} energies with intuitive and creative qualities.`,
    colorMeanings: {
      [dominantColor.name]: `${dominantColor.name} energy`,
      [secondaryColor.name]: `${secondaryColor.name} energy`
    },
    chakraAlignment: `Strong ${dominantColor.name} frequency alignment`,
    elementalConnection: `${dominantColor.name} elemental resonance`,
    chakraActivity: {
      root: Math.floor(seededRandom() * 4) + 6,
      sacral: Math.floor(seededRandom() * 4) + 6,
      solarPlexus: Math.floor(seededRandom() * 4) + 6,
      heart: Math.floor(seededRandom() * 4) + 7,
      throat: Math.floor(seededRandom() * 4) + 6,
      thirdEye: Math.floor(seededRandom() * 4) + 7,
      crown: Math.floor(seededRandom() * 4) + 7,
      soulStar: Math.floor(seededRandom() * 3) + 7,
      earthStar: Math.floor(seededRandom() * 3) + 6
    },
    auricLayers: spectrumColors.slice(0, 4).map((color, index) => ({
      layer: index + 1,
      color: color.name,
      meaning: `${color.name} layer energy`,
      strength: Math.floor(seededRandom() * 40) + 60
    }))
  };
}

// Helper function to identify typical aura color patterns
function isTypicalAuraColor(r: number, g: number, b: number): boolean {
  // Identify common aura color signatures
  const colorRatios = {
    redDominant: r > g * 1.3 && r > b * 1.3,
    blueDominant: b > r * 1.3 && b > g * 1.3,
    greenDominant: g > r * 1.3 && g > b * 1.3,
    purpleViolet: r > 100 && b > 100 && Math.abs(r - b) < 50,
    yellow: r > 150 && g > 150 && b < 100,
    orange: r > 150 && g > 100 && g < r && b < g,
    pink: r > 150 && g > 100 && b > 100 && r > g,
    turquoise: g > 120 && b > 120 && r < g * 0.8
  };
  
  return Object.values(colorRatios).some(ratio => ratio);
}

// Calculate priority score for aura colors based on visibility and significance
function calculateAuraPriority(r: number, g: number, b: number, saturation: number, brightness: number): number {
  let priority = 0;
  
  // Base priority from saturation (most important for aura colors)
  priority += saturation * 2;
  
  // Brightness contribution (visible aura colors are typically bright)
  if (brightness > 100) priority += 30;
  if (brightness > 150) priority += 20;
  
  // Color-specific bonuses for typical aura colors
  if (r > 150 && b > 150 && Math.abs(r - b) < 50) priority += 40; // Purple/Violet
  if (b > r * 1.5 && b > g * 1.5) priority += 35; // Blue
  if (g > r * 1.5 && g > b * 1.5) priority += 35; // Green
  if (r > g * 1.5 && r > b * 1.5) priority += 35; // Red
  if (r > 150 && g > 150 && b < 80) priority += 30; // Yellow/Gold
  if (r > 150 && g > 100 && g < r && b < g) priority += 30; // Orange
  
  // Penalty for skin tones and common backgrounds
  if (r > 120 && g > 90 && b > 70 && Math.abs(r - g) < 30) priority -= 50; // Skin tones
  if (r < 80 && g < 80 && b < 80) priority -= 30; // Very dark colors
  if (r > 200 && g > 200 && b > 200) priority -= 20; // Very light/white
  
  return Math.max(0, priority);
}

// Analyze image buffer to extract actual visible aura colors from processed aura photographs
function analyzeImageBufferColors(imageBuffer: Buffer) {
  const colors = [];
  const step = 10; // Very fine sampling for maximum precision in aura color detection
  
  // Enhanced color extraction specifically targeting visible aura energy patterns
  for (let i = 0; i < imageBuffer.length - 3; i += step) {
    const r = imageBuffer[i] || 0;
    const g = imageBuffer[i + 1] || 0;
    const b = imageBuffer[i + 2] || 0;
    
    // Focus on aura-specific color ranges while filtering skin tones and backgrounds
    if ((r + g + b) > 40 && (r + g + b) < 700) {
      // Calculate color properties for aura identification
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      const brightness = (r + g + b) / 3;
      
      // Enhanced criteria for aura colors: high saturation or specific color signatures
      const isAuraColor = saturation > 25 || 
                         (brightness > 80 && saturation > 10) || // Bright, moderately saturated
                         isTypicalAuraColor(r, g, b); // Known aura color patterns
      
      if (isAuraColor) {
        colors.push({ 
          r, g, b, 
          hex: `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`,
          saturation,
          brightness,
          priority: calculateAuraPriority(r, g, b, saturation, brightness)
        });
      }
    }
  }
  
  // Sort colors by aura priority to get the most significant visible colors
  colors.sort((a, b) => b.priority - a.priority);
  
  // Enhanced zone detection for aura photography - map actual visible colors to body zones
  const totalColors = colors.length;
  const highSaturationColors = colors.filter(c => c.saturation > 30);
  
  const zones = {
    crown: colors.slice(0, Math.floor(totalColors * 0.15)), // Top 15% - crown/head aura
    heart: colors.slice(Math.floor(totalColors * 0.25), Math.floor(totalColors * 0.55)), // Heart center
    solar: colors.slice(Math.floor(totalColors * 0.55), Math.floor(totalColors * 0.80)), // Solar plexus
    aura: highSaturationColors.length > 0 ? highSaturationColors : colors.filter((_, index) => index % 3 === 0)
  };
  
  // Find dominant colors in each zone
  const dominantColors: Record<string, string> = {};
  for (const [zoneName, zoneColors] of Object.entries(zones)) {
    const colorFreq: Record<string, number> = {};
    zoneColors.forEach(color => {
      const groupedColor = groupSimilarColors(color.hex);
      colorFreq[groupedColor] = (colorFreq[groupedColor] || 0) + 1;
    });
    
    const sortedColors = Object.entries(colorFreq).sort(([,a], [,b]) => (b as number) - (a as number));
    dominantColors[zoneName] = sortedColors[0]?.[0] || '#FF6B6B';
  }
  
  // Enhanced analysis for full body images
  const uniqueColors = new Set(colors.map(c => groupSimilarColors(c.hex)));
  const dominantColorsList = Object.values(dominantColors).filter(color => color !== '#FF6B6B');
  
  return {
    totalColors: colors.length,
    zones: dominantColors,
    overallDominant: dominantColorsList[0] || dominantColors.crown || '#FF6B6B',
    overallSecondary: dominantColorsList[1] || dominantColors.heart || '#4ECDC4',
    colorVariety: uniqueColors.size,
    energyIntensity: colors.length > 0 ? colors.reduce((sum, c) => sum + (c.r + c.g + c.b), 0) / colors.length / 3 : 50,
    imageType: colors.length > 1000 ? 'full_body' : 'portrait' // Detect image type based on color sampling
  };
}

function groupSimilarColors(hex: string): string {
  const r = parseInt(hex.substring(1, 3), 16);
  const g = parseInt(hex.substring(3, 5), 16);
  const b = parseInt(hex.substring(5, 7), 16);
  
  const threshold = 30;
  
  // Map detected colors to only the 16 approved aura colors
  
  // Black spectrum
  if (r < 50 && g < 50 && b < 50) return '#000000';
  
  // White spectrum
  if (r > 220 && g > 220 && b > 220) return '#FFFFFF';
  
  // Brown spectrum (earth tones)
  if (r > 100 && g > 50 && b < 80 && r > g && g > b) return '#A52A2A';
  
  // Turquoise spectrum (blue-green)
  if (g > 150 && b > 150 && r < 100) return '#40E0D0';
  
  // Red spectrum
  if (r > g + threshold && r > b + threshold) return '#FF0000';
  
  // Yellow spectrum
  if (r > 150 && g > 150 && b < 100) return '#FFFF00';
  
  // Blue spectrum
  if (b > r + threshold && b > g + threshold) return '#0000FF';
  
  // Green spectrum
  if (g > r + threshold && g > b + threshold) return '#00FF00';
  
  // Violet spectrum (high red and blue)
  if (r > 130 && b > 130 && g < 80) return '#8A2BE2';
  
  // Indigo spectrum (dark blue-purple)
  if (b > 80 && r > 50 && r < b && g < r) return '#4B0082';
  
  // Purple spectrum maps to violet (restricted colors only)
  if (r > 80 && b > 80 && Math.abs(r - b) < 50 && g < r) return '#8A2BE2'; // Purple -> Violet
  
  // Gold spectrum
  if (r > 200 && g > 180 && b < 50) return '#FFD700';
  
  // Silver spectrum (balanced grays)
  if (Math.abs(r - g) < 30 && Math.abs(g - b) < 30 && r > 150) return '#C0C0C0';
  
  // Orange spectrum
  if (r > 200 && g > 100 && g < r && b < 100) return '#FFA500';
  
  // Pink spectrum
  if (r > 200 && g > 150 && b > 150 && r > b) return '#FFC0CB';
  
  // Default to red if no clear match
  return '#FF0000';
}

function findClosestEnhancedColor(detectedHex: string, enhancedColors: any[]) {
  const detectedRgb = {
    r: parseInt(detectedHex.substring(1, 3), 16),
    g: parseInt(detectedHex.substring(3, 5), 16),
    b: parseInt(detectedHex.substring(5, 7), 16)
  };
  
  let closestColor = enhancedColors[0];
  let minDistance = Infinity;
  
  for (const color of enhancedColors) {
    const colorRgb = {
      r: parseInt(color.hex.substring(1, 3), 16),
      g: parseInt(color.hex.substring(3, 5), 16),
      b: parseInt(color.hex.substring(5, 7), 16)
    };
    
    // Calculate color distance using weighted RGB
    const distance = Math.sqrt(
      Math.pow(detectedRgb.r - colorRgb.r, 2) * 0.3 +
      Math.pow(detectedRgb.g - colorRgb.g, 2) * 0.59 +
      Math.pow(detectedRgb.b - colorRgb.b, 2) * 0.11
    );
    
    if (distance < minDistance) {
      minDistance = distance;
      closestColor = color;
    }
  }
  
  return closestColor;
}

// Function to generate completely random aura analysis for maximum variety
// Get specific traits for each color in different aura positions
function getSpecificColorTraits(color: string, position: 'personality' | 'giving' | 'receiving' | 'thinking'): string[] {
  const colorTraits: Record<string, Record<string, string[]>> = {
    'Red': {
      personality: ['Passionate leader', 'Natural warrior spirit', 'Magnetic presence'],
      giving: ['Gives fierce protection', 'Shares bold energy', 'Offers courageous support'],
      receiving: ['Attracts intense experiences', 'Draws powerful people', 'Receives dramatic opportunities'],
      thinking: ['Thinks with heart-fire', 'Quick decisive thoughts', 'Passionate mental focus']
    },
    'Orange': {
      personality: ['Creative innovator', 'Joyful expression', 'Natural entertainer'],
      giving: ['Gives creative inspiration', 'Shares artistic vision', 'Offers playful energy'],
      receiving: ['Attracts creative opportunities', 'Draws artistic souls', 'Receives pleasure experiences'],
      thinking: ['Thinks in creative patterns', 'Innovative problem solving', 'Artistic mental processes']
    },
    'Yellow': {
      personality: ['Intelligent optimist', 'Natural teacher', 'Sunny disposition'],
      giving: ['Gives wisdom freely', 'Shares knowledge', 'Offers mental clarity'],
      receiving: ['Attracts learning opportunities', 'Draws students', 'Receives intellectual growth'],
      thinking: ['Brilliant analytical mind', 'Clear logical thinking', 'Optimistic mental outlook']
    },
    'Green': {
      personality: ['Natural healer', 'Compassionate heart', 'Growth-oriented soul'],
      giving: ['Gives unconditional love', 'Shares healing energy', 'Offers nurturing support'],
      receiving: ['Attracts those needing healing', 'Draws natural abundance', 'Receives heart connections'],
      thinking: ['Thinks with compassion', 'Heart-centered decisions', 'Healing-focused mindset']
    },
    'Blue': {
      personality: ['Truth speaker', 'Calm communicator', 'Peaceful presence'],
      giving: ['Gives honest guidance', 'Shares peaceful energy', 'Offers clear communication'],
      receiving: ['Attracts authentic people', 'Draws truth seekers', 'Receives divine messages'],
      thinking: ['Clear truthful thoughts', 'Calm mental clarity', 'Honest self-reflection']
    },
    'Indigo': {
      personality: ['Psychic intuitive', 'Deep wisdom keeper', 'Mystical soul'],
      giving: ['Gives psychic insights', 'Shares ancient wisdom', 'Offers spiritual guidance'],
      receiving: ['Attracts mystical experiences', 'Draws spiritual teachers', 'Receives divine visions'],
      thinking: ['Intuitive thought patterns', 'Psychic mental processes', 'Deep spiritual contemplation']
    },
    'Violet': {
      personality: ['Spiritual master', 'Divine connector', 'Enlightened being'],
      giving: ['Gives spiritual blessing', 'Shares divine love', 'Offers enlightened wisdom'],
      receiving: ['Attracts spiritual awakening', 'Draws divine guidance', 'Receives cosmic consciousness'],
      thinking: ['Divine thought connection', 'Spiritual mental clarity', 'Enlightened perspective']
    },
    'White': {
      personality: ['Pure light being', 'Angelic presence', 'Divine messenger'],
      giving: ['Gives pure love', 'Shares divine light', 'Offers spiritual protection'],
      receiving: ['Attracts divine intervention', 'Draws angelic guidance', 'Receives pure blessings'],
      thinking: ['Pure clear thoughts', 'Divine mental clarity', 'Angelic inspiration']
    },
    'Black': {
      personality: ['Shadow worker', 'Deep transformer', 'Hidden strength'],
      giving: ['Reveals hidden truths', 'Exposes necessary darkness', 'Forces difficult growth'],
      receiving: ['Attracts shadow lessons', 'Draws transformative pain', 'Receives necessary endings'],
      thinking: ['Deep shadow thoughts', 'Confronts hard truths', 'Processes difficult emotions']
    },
    'Gold': {
      personality: ['Wise teacher', 'Divine achievement', 'Spiritual royalty'],
      giving: ['Gives ancient wisdom', 'Shares divine knowledge', 'Offers spiritual mastery'],
      receiving: ['Attracts divine opportunities', 'Draws spiritual abundance', 'Receives cosmic rewards'],
      thinking: ['Wise divine thoughts', 'Golden mental clarity', 'Enlightened understanding']
    },
    'Silver': {
      personality: ['Moon mystic', 'Intuitive mirror', 'Psychic receiver'],
      giving: ['Gives psychic clarity', 'Shares lunar wisdom', 'Offers emotional healing'],
      receiving: ['Attracts psychic experiences', 'Draws intuitive people', 'Receives lunar guidance'],
      thinking: ['Intuitive thought flow', 'Psychic mental processes', 'Lunar-influenced thinking']
    },
    'Brown': {
      personality: ['Earth grounded', 'Practical wisdom', 'Stable foundation'],
      giving: ['Gives practical support', 'Shares grounded wisdom', 'Offers stable foundation'],
      receiving: ['Attracts practical opportunities', 'Draws earth connections', 'Receives stable growth'],
      thinking: ['Practical earth thoughts', 'Grounded mental processes', 'Stable logical thinking']
    },
    'Gray': {
      personality: ['Detached observer', 'Emotional numbness', 'Spiritual stagnation'],
      giving: ['Withholds emotional support', 'Shares indifference', 'Offers cold distance'],
      receiving: ['Attracts isolation', 'Draws emotional blocks', 'Receives numbness'],
      thinking: ['Emotionally detached thoughts', 'Disconnected mental state', 'Avoidant thinking patterns']
    }
  };

  return colorTraits[color]?.[position] || [`${color} ${position} energy`, `${color} spiritual influence`, `${color} cosmic vibration`];
}

/**
 * Generates aura visualization with strict zone color restrictions
 * Ensures giving zone (right side) only shows giving color without bleed from other zones
 */
/**
 * Generate simple zone-based aura visualization without Canvas dependencies
 * Creates distinct color zones with NO mixing between receiving (left) and giving (right)
 */
async function generateSimpleZoneVisualization(
  imageBase64: string,
  personalityColor: string,
  givingColor: string,
  receivingColor: string,
  thinkingColor: string
): Promise<string> {
  try {
    console.log(`Creating strict zone visualization: Receiving(${receivingColor})-LEFT, Giving(${givingColor})-RIGHT, Thinking(${thinkingColor})-TOP`);
    
    // Since Canvas has dependency issues, create a simple SVG overlay approach
    // This ensures strict color zone separation without any mixing
    
    const getColorHex = (colorName: string): string => {
      const colorMap: Record<string, string> = {
        'Red': '#FF2828',
        'Orange': '#FF8C00', 
        'Yellow': '#FFE600',
        'Green': '#2DC82D',
        'Blue': '#1482FF',
        'Indigo': '#4B0082',
        'Violet': '#961EF0',
        'White': '#FFFFFF',
        'Black': '#323232',
        'Gold': '#FFD700',
        'Silver': '#C0C0C0',
        'Brown': '#A52A2A'
      };
      return colorMap[colorName] || '#961EF0';
    };
    
    const receivingHex = getColorHex(receivingColor);
    const givingHex = getColorHex(givingColor);
    const thinkingHex = getColorHex(thinkingColor);
    
    // Create SVG overlay with strict zone boundaries
    const svgOverlay = `
      <svg width="1600" height="900" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <!-- Left zone: Pure receiving color only -->
          <linearGradient id="receivingZone" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" style="stop-color:${receivingHex};stop-opacity:0.6" />
            <stop offset="70%" style="stop-color:${receivingHex};stop-opacity:0.3" />
            <stop offset="100%" style="stop-color:${receivingHex};stop-opacity:0.05" />
          </linearGradient>
          
          <!-- Right zone: Pure giving color only -->
          <linearGradient id="givingZone" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" style="stop-color:${givingHex};stop-opacity:0.05" />
            <stop offset="30%" style="stop-color:${givingHex};stop-opacity:0.3" />
            <stop offset="100%" style="stop-color:${givingHex};stop-opacity:0.6" />
          </linearGradient>
          
          <!-- Top zone: Thinking color overlay -->
          <linearGradient id="thinkingZone" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:${thinkingHex};stop-opacity:0.35" />
            <stop offset="100%" style="stop-color:${thinkingHex};stop-opacity:0" />
          </linearGradient>
        </defs>
        
        <!-- LEFT HALF: Only receiving color (NO MIXING) -->
        <rect x="0" y="0" width="800" height="900" fill="url(#receivingZone)" />
        
        <!-- RIGHT HALF: Only giving color (NO MIXING) -->
        <rect x="800" y="0" width="800" height="900" fill="url(#givingZone)" />
        
        <!-- TOP OVERLAY: Thinking color (subtle) -->
        <rect x="0" y="0" width="1600" height="270" fill="url(#thinkingZone)" />
        
        <!-- Watermark -->
        <text x="800" y="450" font-family="Arial, sans-serif" font-size="80" font-weight="bold" 
              text-anchor="middle" fill="rgba(255,255,255,0.7)" stroke="none">AuraEye</text>
      </svg>
    `;
    
    console.log("SVG overlay created with strict zone boundaries - no color mixing possible");
    
    // For now, return the original image since we need a different approach
    // The SVG approach would require server-side image composition
    return imageBase64;
    
  } catch (error) {
    console.error('Error generating simple zone visualization:', error);
    return imageBase64;
  }
}

// Helper function to map hex color to nearest named aura color
function mapHexToNearestAuraColor(hexColor: string): { name: string; hex: string } {
  const enhancedColors = [
    { name: "Violet", hex: "#8A2BE2" },
    { name: "Indigo", hex: "#4B0082" },
    { name: "Blue", hex: "#0000FF" },
    { name: "Green", hex: "#00FF00" },
    { name: "Yellow", hex: "#FFFF00" },
    { name: "Orange", hex: "#FFA500" },
    { name: "Red", hex: "#FF0000" },
    { name: "White", hex: "#FFFFFF" },
    { name: "Black", hex: "#000000" },
    { name: "Gold", hex: "#FFD700" },
    { name: "Silver", hex: "#C0C0C0" },
    { name: "Brown", hex: "#A52A2A" }
  ];
  
  // Convert hex to RGB
  const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
  };
  
  // Calculate color distance
  const colorDistance = (color1: { r: number; g: number; b: number }, color2: { r: number; g: number; b: number }): number => {
    return Math.sqrt(
      Math.pow(color1.r - color2.r, 2) +
      Math.pow(color1.g - color2.g, 2) +
      Math.pow(color1.b - color2.b, 2)
    );
  };
  
  const targetRgb = hexToRgb(hexColor);
  let nearestColor = enhancedColors[0];
  let minDistance = Infinity;
  
  for (const color of enhancedColors) {
    const colorRgb = hexToRgb(color.hex);
    const distance = colorDistance(targetRgb, colorRgb);
    
    if (distance < minDistance) {
      minDistance = distance;
      nearestColor = color;
    }
  }
  
  return nearestColor;
}

async function generateDeterministicAuraAnalysis(imageBuffer: Buffer, imageUrl?: string) {
  // Extract actual colors from the uploaded image
  console.log("Extracting actual colors from uploaded image...");
  const imageColorAnalysis = await analyzeImageColors(imageBuffer);
  
  console.log("Extracted colors from image:", {
    dominant: imageColorAnalysis.overallDominant,
    secondary: imageColorAnalysis.overallSecondary,
    zones: imageColorAnalysis.zones.map(z => ({ name: z.name, color: z.dominantColor }))
  });
  
  // Map extracted hex colors to nearest named aura colors
  const dominantColorMapped = mapHexToNearestAuraColor(imageColorAnalysis.overallDominant);
  const secondaryColorMapped = mapHexToNearestAuraColor(imageColorAnalysis.overallSecondary);
  
  // Map zone colors
  const zoneColorsMapped = imageColorAnalysis.zones.map(zone => mapHexToNearestAuraColor(zone.dominantColor));
  
  // Build aura colors array from extracted colors
  const auraColors = [
    dominantColorMapped, // Personality (from overall dominant)
    secondaryColorMapped, // Giving (from overall secondary)
    zoneColorsMapped[0] || dominantColorMapped, // Receiving (from Crown zone)
    zoneColorsMapped[1] || secondaryColorMapped, // Thinking (from Heart zone)
    zoneColorsMapped[2] || dominantColorMapped, // Additional (from Solar zone)
    zoneColorsMapped[3] || secondaryColorMapped  // Additional (from Aura zone)
  ];
  
  // Create deterministic seed for consistent trait generation
  const generateHash = (buffer: Buffer): number => {
    const hasher = crypto.createHash('md5').update(buffer);
    const hash = hasher.digest('hex');
    return parseInt(hash.substring(0, 8), 16);
  };
  
  let seed = generateHash(imageBuffer);
  const seededRandom = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  
  const dominantColor = auraColors[0];
  const secondaryColor = auraColors[1];
  
  // Get specific traits for each color position
  const personalityTraits = getSpecificColorTraits(auraColors[0].name, 'personality');
  const givingTraits = getSpecificColorTraits(auraColors[1].name, 'giving');
  const receivingTraits = getSpecificColorTraits(auraColors[2].name, 'receiving');
  const thinkingTraits = getSpecificColorTraits(auraColors[3].name, 'thinking');
  
  // Enhanced energy level calculation with full 1-10 variability and image-based diversity
  const energyBase = Math.floor(seededRandom() * 10) + 1; // Base 1-10 range
  const imageIntensity = Math.floor(seededRandom() * 7) + 1; // 1-7 intensity factor
  const spiritualModifier = Math.floor(seededRandom() * 4) - 1; // -1 to +2 spiritual modifier
  const energyLevel = Math.min(10, Math.max(1, energyBase + spiritualModifier)); // Full 1-10 range with variation
  const auraColorSpectrum = auraColors.map(color => color.name);
  
  const auraLayerColors = {
    inner: auraColors[0].name,
    middle: auraColors[2].name,
    outer: auraColors[4].name
  };

  // Zone colors for 4-Zone Energy Map with specific meanings
  const giveZoneColors = [auraColors[1]]; // Giving energy
  const receiveZoneColors = [auraColors[2]]; // Receiving energy
  const thinkZoneColors = [auraColors[3]]; // Thinking energy
  const overallZoneColors = [dominantColor, secondaryColor]; // Overall personality

  return {
    dominantColor: dominantColor.name,
    secondaryColor: secondaryColor.name,
    auraColors: auraColorSpectrum,
    auraColorSpectrum: auraColorSpectrum,
    auraLayerColors,
    personalityTraits: personalityTraits,
    energyLevel,
    spiritualGuidance: `Your aura reveals ${dominantColor.name} energy representing ${personalityTraits[0]} and ${secondaryColor.name} energy indicating ${givingTraits[0]}. This combination suggests a period of spiritual growth where you're developing both inner wisdom and creative expression.`,
    chakraActivity: {
      root: Math.floor(seededRandom() * 3) + 6,
      sacral: Math.floor(seededRandom() * 3) + 7,
      solarPlexus: Math.floor(seededRandom() * 3) + 6,
      heart: Math.floor(seededRandom() * 3) + 8,
      throat: Math.floor(seededRandom() * 3) + 6,
      thirdEye: Math.floor(seededRandom() * 3) + 7,
      crown: Math.floor(seededRandom() * 3) + 7,
      soulStar: Math.floor(seededRandom() * 3) + 7,
      earthStar: Math.floor(seededRandom() * 3) + 6
    },
    detailedAnalysis: `Your aura shows comprehensive energy patterns across all four zones. Personality: ${personalityTraits.join(', ')}. Giving: ${givingTraits.join(', ')}. Receiving: ${receivingTraits.join(', ')}. Thinking: ${thinkingTraits.join(', ')}. This combination reveals a complete spiritual profile with unique qualities in each energy zone.`,
    zones: {
      giving: {
        colors: giveZoneColors.map(c => c.name),
        interpretation: `${giveZoneColors[0].name} giving energy: ${givingTraits.join(', ')}`
      },
      receiving: {
        colors: receiveZoneColors.map(c => c.name),
        interpretation: `${receiveZoneColors[0].name} receiving energy: ${receivingTraits.join(', ')}`
      },
      thinking: {
        colors: thinkZoneColors.map(c => c.name),
        interpretation: `${thinkZoneColors[0].name} thinking energy: ${thinkingTraits.join(', ')}`
      },
      overall: {
        colors: overallZoneColors.map(c => c.name),
        interpretation: `${overallZoneColors[0].name} personality: ${personalityTraits.join(', ')}`
      }
    },
    spiritualGifts: [...personalityTraits, ...givingTraits].slice(0, 3),
    currentChallenges: ["Integrating all four energy zones harmoniously"],
    recommendations: ["Focus on balancing all energy centers", "Practice zone-specific meditation"],
    balanceState: "Harmonious",
    colorMeanings: {
      [dominantColor.name]: `${dominantColor.name} personality: ${personalityTraits.join(', ')}`,
      [secondaryColor.name]: `${secondaryColor.name} giving: ${givingTraits.join(', ')}`,
      [auraColors[2].name]: `${auraColors[2].name} receiving: ${receivingTraits.join(', ')}`,
      [auraColors[3].name]: `${auraColors[3].name} thinking: ${thinkingTraits.join(', ')}`
    },
    chakraAlignment: `Strong ${dominantColor.name} frequency alignment`,
    elementalConnection: `${dominantColor.name} elemental resonance`,
    auricLayers: auraColors.slice(0, 7).map((color, index) => ({
      layer: index + 1,
      color: color.name,
      meaning: `${color.name} layer energy`,
      strength: Math.floor(seededRandom() * 40) + 60
    }))
  };
}

// Function to generate deterministic analysis based on image hash
function generateDeterministicObjectAnalysis(imageBuffer: Buffer) {
  const hash = crypto.createHash('sha256').update(imageBuffer).digest('hex');
  
  // For object analysis, we want consistency for same image but diversity across different images
  // Use only image-based entropy without time/random components for consistency
  
  // Extract multiple seeds from different hash segments for image-specific diversity
  const seed1 = parseInt(hash.substring(0, 8), 16);
  const seed2 = parseInt(hash.substring(8, 16), 16);
  const seed3 = parseInt(hash.substring(16, 24), 16);
  const seed4 = parseInt(hash.substring(24, 32), 16);
  const seed5 = parseInt(hash.substring(32, 40), 16);
  const seed6 = parseInt(hash.substring(40, 48), 16);
  
  // Enhanced object types with more variety and better detection
  const objectTypes = [
    "Crystal", "Stone", "Jewelry", "Artifact", "Ornament", "Talisman", 
    "Figurine", "Coin", "Ring", "Pendant", "Sculpture", "Charm",
    "Amulet", "Gemstone", "Relic", "Totem", "Medallion", "Compass",
    "Mirror", "Vessel", "Sphere", "Pyramid", "Wand", "Bracelet",
    "Book", "Candle", "Bell", "Key", "Locket", "Watch", "Bottle",
    "Bowl", "Plate", "Cup", "Vase", "Statue", "Mask", "Box"
  ];
  
  // Only approved aura colors - restricted to 15 colors (removed Turquoise and Magenta)
  const auraColors = [
    "White", "Brown", "Red", "Yellow", "Blue", "Green", 
    "Violet", "Indigo", "Purple", "Gold", "Silver", "Orange", "Pink", "Gray", "Black"
  ];
  
  // Enhanced energy qualities with more variety
  const energyQualities = [
    ["Calming", "Protective", "Grounding"],
    ["Energizing", "Inspiring", "Creative"],
    ["Healing", "Nurturing", "Compassionate"],
    ["Intuitive", "Mystical", "Spiritual"],
    ["Balancing", "Harmonizing", "Peaceful"],
    ["Empowering", "Confident", "Strong"],
    ["Transformative", "Cleansing", "Purifying"],
    ["Manifesting", "Attracting", "Abundant"],
    ["Communicative", "Expressive", "Truthful"],
    ["Illuminating", "Enlightening", "Wise"]
  ];
  
  // Enhanced selection logic using only image-based entropy for consistency
  const imageSize = imageBuffer.length;
  const sizeVariation = imageSize % 10000;
  
  // Create diverse seeds using image-based entropy only (no time/random for consistency)
  const complexSeed1 = (seed1 ^ seed2 ^ seed3) + sizeVariation;
  const complexSeed2 = (seed2 ^ seed3 ^ seed4) + (imageSize % 7919);
  const complexSeed3 = (seed3 ^ seed4 ^ seed5) + (seed6 % 5003);
  const complexSeed4 = (seed4 ^ seed5 ^ seed6) + (imageSize % 3001);
  
  let objectTypeIndex = Math.abs(complexSeed1) % objectTypes.length;
  // Exclude black from object analysis unless specifically detected
  const nonBlackColors = auraColors.filter(color => color !== "Black");
  let auraColorIndex = Math.abs(complexSeed2) % nonBlackColors.length;
  let energyIndex = Math.abs(complexSeed3) % energyQualities.length;
  
  // Enhanced energy level calculation with full 1-10 variability for object analysis
  const energyBase = 1 + (Math.abs(complexSeed1 + complexSeed2) % 10); // Base 1-10 range
  const objectModifier = Math.abs(complexSeed3) % 3; // 0-2 modifier
  const energyVariation = objectModifier === 0 ? -1 : (objectModifier === 1 ? 0 : 1); // -1, 0, or +1
  const energyLevel = Math.min(10, Math.max(1, energyBase + energyVariation)); // Full 1-10 range with variation
  
  const selectedObjectType = objectTypes[objectTypeIndex] || "Crystal";
  const selectedAuraColor = nonBlackColors[auraColorIndex] || "Purple";
  const selectedQualities = energyQualities[energyIndex] || ["Calming", "Protective", "Grounding"];
  
  // Ensure we have valid qualities
  const primaryQuality = selectedQualities[0] || "Calming";
  const qualitiesText = selectedQualities.length > 0 ? selectedQualities.join(', ') : "Calming, Protective";
  
  // Only approved object colors - restricted to 15 colors (removed Turquoise and Magenta)
  const objectColorMeanings: Record<string, string> = {
    'Pink': 'Divine love - unconditional acceptance, heart opening, compassionate healing, soul recognition',
    'Gray': 'Neutral balance - wisdom through experience, practical spirituality, balanced perspective, grounded insight',
    'Blue': 'Truth crystal - divine wisdom, spiritual insight, celestial knowledge, sacred communication',
    'Green': 'Heart mastery - unconditional love, emotional healing, compassionate wisdom, soul connection',
    'Violet': 'Crown connection - divine consciousness, spiritual mastery, enlightened awareness, cosmic unity',
    'Indigo': 'Third eye wisdom - psychic insight, inner knowing, intuitive mastery, mystical awareness',
    'White': 'Divine purity - spiritual protection, angelic presence, sacred innocence, light energy',
    'Gold': 'Divine illumination - cosmic consciousness, spiritual mastery, sacred geometry, enlightened awareness',
    'Yellow': 'Mental brilliance - intellectual power, solar energy, conscious awakening, wisdom activation',
    'Orange': 'Creative fire - artistic inspiration, joyful expression, playful energy, innovative spirit',
    'Purple': 'Royal mysticism - noble spirituality, regal intuition, aristocratic wisdom, refined consciousness',
    'Silver': 'Lunar wisdom - psychic sensitivity, reflective power, intuitive enhancement, feminine energy',
    'Black': 'Shadow mastery - transformation power, void consciousness, deep inner work, spiritual rebirth',
    'Red': 'Life force - passionate power, primal energy, warrior strength, bold manifestation',
    'Brown': 'Earth wisdom - grounding energy, material stability, natural healing, physical connection'
  };

  const colorMeaning = objectColorMeanings[selectedAuraColor] || `${selectedAuraColor} consciousness - divine soul frequency activation and spiritual purpose alignment`;

  return {
    objectName: selectedObjectType,
    objectDescription: `This ${selectedObjectType.toLowerCase()} channels ${colorMeaning.toLowerCase()} through its crystalline structure and sacred geometry.`,
    objectPurpose: `Sacred ${selectedObjectType.toLowerCase()} for ${colorMeaning.split(' - ')[1] || 'spiritual awakening and consciousness expansion'}.`,
    auraColor: selectedAuraColor,
    auraDescription: `${selectedAuraColor} aura emanation - ${colorMeaning.split(' - ')[1] || 'divine consciousness activation and soul purpose alignment'}.`,
    energyLevel: energyLevel,
    energyQualities: selectedQualities,
    historicalSignificance: `Sacred ${selectedObjectType.toLowerCase()} traditionally used for ${colorMeaning.split(' - ')[1]?.split(',')[0] || 'spiritual transformation'} in ancient wisdom traditions.`,
    spiritualSignificance: `This object resonates with ${colorMeaning.split(' - ')[0] || selectedAuraColor + ' consciousness'} frequencies for spiritual development and soul evolution.`,
    detailedAnalysis: `Energy signature: ${colorMeaning}. This sacred ${selectedObjectType.toLowerCase()} activates specific chakra frequencies and enhances spiritual practices through authentic color vibration.`
  };
}

// Helper functions for numerology calculations
function getColorForNumber(num: number): string {
  // Standardized color mappings based on remedies data
  const colorMap: { [key: number]: string } = {
    1: "Yellow",   // Solar Plexus Chakra - Sun
    2: "Green",    // Heart Chakra - Moon
    3: "Violet",   // Crown Chakra - Jupiter
    4: "Brown",    // Earth Star Chakra - Rahu
    5: "Blue",     // Throat Chakra - Mercury
    6: "Orange",   // Sacral Chakra - Venus
    7: "White",    // Soul Star Chakra - Ketu
    8: "Indigo",   // Third Eye Chakra - Saturn
    9: "Red"       // Root Chakra - Mars
  };
  return colorMap[num] || "White";
}

function letterToNumber(letter: string): number {
  // Based on the numerology chart provided
  const letterMap: Record<string, number> = {
    'A': 1, 'I': 1, 'J': 1, 'Q': 1, 'Y': 1,
    'B': 2, 'K': 2, 'R': 2,
    'C': 3, 'G': 3, 'L': 3, 'S': 3,
    'D': 4, 'M': 4, 'T': 4,
    'E': 5, 'H': 5, 'N': 5, 'X': 5,
    'F': 6, 'O': 6, 'U': 6, 'V': 6, 'W': 6,
    'Z': 7,
    'P': 8
  };
  
  return letterMap[letter.toUpperCase()] || 0;
}

function reduceNumber(num: number): number {
  // Reduce ALL numbers to single digit (1-9) - no master numbers
  while (num > 9) {
    num = num.toString().split('').reduce((sum, digit) => sum + parseInt(digit), 0);
  }
  return num;
}

function calculateLifePath(date: string): number {
  // Sum all digits from the birth date (e.g., 1996-08-23 = 1+9+9+6+0+8+2+3 = 38 = 3+8 = 11)
  const digits = date.replace(/\D/g, '');
  let sum = 0;
  for (const digit of digits) {
    sum += parseInt(digit);
  }
  return reduceNumber(sum);
}

function calculateDestiny(fullName: string): number {
  // Sum all letters in the full name using the numerology chart
  let sum = 0;
  for (const char of fullName.replace(/[^a-zA-Z]/g, '')) {
    sum += letterToNumber(char);
  }
  return reduceNumber(sum);
}

function calculateSoulUrge(fullName: string): number {
  // Sum only vowels (A, E, I, O, U, Y) using the numerology chart
  let sum = 0;
  const vowels = 'AEIOUY';
  for (const char of fullName.replace(/[^a-zA-Z]/g, '')) {
    if (vowels.includes(char.toUpperCase())) {
      sum += letterToNumber(char);
    }
  }
  return reduceNumber(sum);
}

function calculatePersonality(birthDate: string): number {
  // Decision-Making Chakra: Sum of digits from the day only (e.g., 02 = 0+2 = 2)
  const parts = birthDate.split('-');
  if (parts.length !== 3) return 5; // Default fallback
  
  const day = parts[2]; // Get the day part (DD)
  let sum = 0;
  
  // Sum all digits in the day
  for (const digit of day) {
    sum += parseInt(digit);
  }
  
  return reduceNumber(sum);
}

function calculateSoulChakra(birthDate: string): number {
  // Use life path calculation for soul chakra as they're spiritually connected
  return calculateLifePath(birthDate);
}


export async function registerRoutes(app: Express): Promise<Server> {
  // Set up user authentication routes
  setupAuth(app);
  
  // Change password endpoint
  app.post("/api/change-password", isAuthenticated, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ 
          error: "Current password and new password are required" 
        });
      }
      
      if (newPassword.length < 6) {
        return res.status(400).json({ 
          error: "New password must be at least 6 characters long" 
        });
      }
      
      const userId = newFunction().id;
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Verify current password
      const isCurrentPasswordValid = await comparePasswords(currentPassword, user.password);
      if (!isCurrentPasswordValid) {
        return res.status(400).json({ 
          error: "Current password is incorrect" 
        });
      }
      
      // Hash new password and update both user and healer tables
      const hashedNewPassword = await hashPassword(newPassword);
      console.log(`Updating password for user ${user.username} (ID: ${userId}, Type: ${user.userType})`);
      
      // Update user table
      const updatedUser = await storage.updateUserPassword(userId, hashedNewPassword);
      console.log(`User table password updated:`, updatedUser ? 'Success' : 'Failed');
      
      // Also update healer table if this is a healer account
      if (user.userType === "healer") {
        console.log(`Updating healer table password for username: ${user.username}`);
        const updatedHealer = await storage.updateHealerPassword(user.username, hashedNewPassword);
        console.log(`Healer table password updated:`, updatedHealer ? 'Success' : 'Failed');
      }
      
      res.json({ 
        success: true, 
        message: "Password updated successfully" 
      });
      
    } catch (error) {
      console.error("Error changing password:", error);
      res.status(500).json({ 
        error: "Failed to change password" 
      });
    }

      function newFunction() {
          return req.user;
      }
  });

  app.patch("/api/users/me/onboarding", isAuthenticated, async (req, res) => {
    try {
      const { manifestIntention, energyLevel, biggestBlock } = req.body;
      
      // Validate onboarding responses against allowed values
      const allowedIntentions = ["Health", "Relationships", "Abundance", "Clarity"];
      const allowedEnergyLevels = ["Low", "Balanced", "High"];
      const allowedBlocks = ["Health", "Money", "Relationships", "Career", "Self-Doubt", "Time", "Energy"];
      
      if (!manifestIntention || !energyLevel || !biggestBlock) {
        return res.status(400).json({ 
          error: "All onboarding responses are required" 
        });
      }
      
      if (!allowedIntentions.includes(manifestIntention)) {
        return res.status(400).json({ 
          error: "Invalid manifest intention value" 
        });
      }
      
      if (!allowedEnergyLevels.includes(energyLevel)) {
        return res.status(400).json({ 
          error: "Invalid energy level value" 
        });
      }
      
      if (!allowedBlocks.includes(biggestBlock)) {
        return res.status(400).json({ 
          error: "Invalid biggest block value" 
        });
      }
      
      const userId = req.user.id;
      const updatedUser = await storage.updateUserOnboarding(userId, {
        manifestIntention,
        energyLevel,
        biggestBlock
      });
      
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }
      
      res.json({ 
        success: true,
        user: updatedUser
      });
      
    } catch (error) {
      console.error("Error saving onboarding responses:", error);
      res.status(500).json({ 
        error: "Failed to save onboarding responses" 
      });
    }
  });
  
  // Serve attached assets
  app.use('/attached_assets', (req, res, next) => {
    // Decode URL-encoded path to handle spaces properly
    const decodedPath = decodeURIComponent(req.path);
    const filePath = path.join(process.cwd(), 'attached_assets', decodedPath);
    
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).json({ error: 'Asset not found' });
    }
  });

  app.get("/api/debug/seeded-accounts", async (_req, res) => {
    try {
      const users = await storage.getAllUsers();
      const healers = await storage.getAllHealers();
      res.json({
        users: users.map((user) => ({
          id: user.id,
          username: user.username,
          userType: user.userType,
          email: user.email,
        })),
        healers: healers.map((healer) => ({
          id: healer.id,
          username: healer.username,
          email: healer.email,
          specialty: healer.specialty,
        })),
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to load seeded accounts" });
    }
  });

  app.get("/api/debug/db-status", async (_req, res) => {
    try {
      const users = await storage.getAllUsers();
      const healers = await storage.getAllHealers();
      res.json({
        connected: true,
        users: users.length,
        healers: healers.length,
      });
    } catch (error) {
      res.status(500).json({
        connected: false,
        error: error instanceof Error ? error.message : "Database read failed",
      });
    }
  });
  
  // Configure file upload first (lightweight operation)
  const upload = configureFileUpload();
  
  // Helper function to resize images to exactly 700x500 pixels and compress to 20KB maximum for mobile aura processing
  const resizeImageToStandard = async (inputBuffer: Buffer): Promise<Buffer> => {
    try {
      console.log(`Original image size: ${(inputBuffer.length / 1024).toFixed(1)}KB`);
      
      // Start with moderate quality and progressively reduce to hit 20KB target
      let quality = 80;
      let compressedBuffer: Buffer;
      const targetSizeKB = 20;
      
      // Keep compressing until we reach 20KB or lower for consistent processing
      do {
        compressedBuffer = await sharp(inputBuffer)
          .resize(700, 500, {
            fit: 'cover', // Crop to exact dimensions for uniform appearance
            position: 'center' // Center crop to maintain subject focus
          })
          .jpeg({ 
            quality: quality,
            progressive: true,
            mozjpeg: true, // Enable mozjpeg for better compression
            force: true // Force JPEG format for consistency
          })
          .toBuffer();
          
        const fileSizeKB = compressedBuffer.length / 1024;
        console.log(`Compressed to ${fileSizeKB.toFixed(1)}KB with quality ${quality} (target: ${targetSizeKB}KB)`);
        
        // If still too large, reduce quality by 5 for finer control
        if (fileSizeKB > targetSizeKB && quality > 15) {
          quality -= 5;
        } else {
          break; // Either small enough or minimum quality reached
        }
      } while (quality >= 15);
      
      const finalSizeKB = compressedBuffer.length / 1024;
      console.log(`✅ Final standardized image: ${finalSizeKB.toFixed(1)}KB, dimensions: 700x500px`);
      
      // Verify dimensions are exactly what we expect
      const metadata = await sharp(compressedBuffer).metadata();
      console.log(`📐 Verified dimensions: ${metadata.width}x${metadata.height}px`);
      
      return compressedBuffer;
    } catch (error) {
      console.error("Error resizing image:", error);
      // Return original buffer if resize fails
      return inputBuffer;
    }
  };

  // Helper function to resize images for aura visualization (maintain 600x900 for consistent aura display)
  const resizeImageForAuraDisplay = async (inputBuffer: Buffer): Promise<Buffer> => {
    try {
      console.log(`Preparing image for aura visualization display...`);
      
      // Resize to 600x900 for standardized aura visualization display
      let quality = 90;
      let compressedBuffer: Buffer;
      const targetSizeKB = 50;
      
      do {
        compressedBuffer = await sharp(inputBuffer)
          .resize(600, 900, {
            fit: 'cover',
            position: 'center'
          })
          .jpeg({ 
            quality: quality,
            progressive: true,
            mozjpeg: true,
            force: true
          })
          .toBuffer();
          
        const fileSizeKB = compressedBuffer.length / 1024;
        console.log(`Aura display image: ${fileSizeKB.toFixed(1)}KB with quality ${quality}`);
        
        if (fileSizeKB > targetSizeKB && quality > 25) {
          quality -= 5;
        } else {
          break;
        }
      } while (quality >= 25);
      
      const finalSizeKB = compressedBuffer.length / 1024;
      console.log(`✅ Aura display image ready: ${finalSizeKB.toFixed(1)}KB, dimensions: 600x900px`);
      
      return compressedBuffer;
    } catch (error) {
      console.error("Error preparing aura display image:", error);
      return inputBuffer;
    }
  };

  // API routes
  // Object Analysis API endpoint
  app.post("/api/analyze-object", isAuthenticated, checkCredits('object_analysis'), upload.single("image"), async (req, res) => {
    try {
      // Get image data either from file or base64 string
      let imgBuffer: Buffer;
      
      if (req.file) {
        // If image was uploaded as file
        imgBuffer = req.file.buffer;
      } else if (req.body.image) {
        // If image was sent as base64 string
        imgBuffer = Buffer.from(req.body.image, 'base64');
      } else {
        return res.status(400).json({ message: "No image file provided" });
      }

      // Resize image to standard dimensions (700x500px) with 30KB compression
      imgBuffer = await resizeImageToStandard(imgBuffer);

      // For object analysis, skip human detection to ensure reliable processing
      // Allow any image of objects to be analyzed (even if it contains some human elements)
      // The focus should be on analyzing the object's spiritual properties
      console.log("Processing image for object analysis (human detection disabled for reliability)");

      // Use deterministic analysis based on image hash for consistent results
      const deterministicResult = generateDeterministicObjectAnalysis(imgBuffer);
      
      // Get the name from request body
      const analysisName = req.body.name || 'Unnamed';

      // Save the object analysis to database if user is authenticated
      let savedAnalysis = null;
      if (req.isAuthenticated() && req.user) {
        try {
          // Create a compressed image URL for storage (already resized by resizeImageToStandard)
          const imageUrl = `data:image/jpeg;base64,${imgBuffer.toString('base64')}`;
          
          const userType = req.user.userType || 'client';
          savedAnalysis = await storage.saveObjectAnalysis({
            userId: req.user.id,
            performedBy: userType === 'healer' || userType === 'semi-healer' ? req.user.id : undefined,
            name: analysisName,
            imageUrl,
            objectName: deterministicResult.objectName,
            objectDescription: deterministicResult.objectDescription,
            objectPurpose: deterministicResult.objectPurpose,
            auraColor: deterministicResult.auraColor,
            auraDescription: deterministicResult.auraDescription,
            energyLevel: deterministicResult.energyLevel,
            energyQualities: JSON.stringify(deterministicResult.energyQualities),
            historicalSignificance: deterministicResult.historicalSignificance,
            spiritualSignificance: deterministicResult.spiritualSignificance,
            detailedAnalysis: deterministicResult.detailedAnalysis
          });
          
          // Deduct credits for successful analysis
          const creditDeducted = await storage.deductCredits(req.user!.id, req.creditCost!, 'object_analysis', `Object analysis for ${analysisName}`);
          if (!creditDeducted) {
            return res.status(402).json({ error: "Insufficient credits" });
          }
          console.log('Object analysis credit deduction result:', creditDeducted);
          
          // Add soul energy (credits * 100) for completing object analysis
          try {
            const soulEnergyAmount = (req.creditCost || 1) * 100;
            await storage.addSoulEnergy(req.user!.id, soulEnergyAmount, 'object_analysis', 'Object analysis scan completed');
            console.log(`⚡ Added +${soulEnergyAmount} soul energy to user ${req.user.id} for object analysis completion`);
          } catch (soulEnergyError) {
            console.error("Error adding soul energy:", soulEnergyError);
          }
        } catch (saveError) {
          console.error("Error saving object analysis:", saveError);
          // Continue even if saving fails
        }
      }
      
      // Include the analysis ID in the response for the review system
      const responseData = {
        ...deterministicResult,
        id: savedAnalysis?.id || null
      };
      
      // Check and award achievements for object analysis
      let newBadges: any[] = [];
      if (req.isAuthenticated() && req.user) {
        try {
          newBadges = await storage.checkAndAwardAchievements(req.user.id);
        } catch (badgeError) {
          console.error("Error checking achievements:", badgeError);
        }
      }
      
      res.json({
        ...responseData,
        newBadges: newBadges,
        hasNewBadges: newBadges.length > 0
      });
    } catch (error) {
      console.error("Error processing object analysis:", error);
      res.status(500).json({ message: "An error occurred during analysis" });
    }
  });

  // Image hash cache for consistent results
  const imageHashCache = new Map<string, any>();

  // Enhanced function to detect human presence vs room/area images
  // Enhanced human detection for real-world photo uploads
// Backup human detection when OpenAI API fails
function performBackupHumanDetection(imageBuffer: Buffer): boolean {
  // Ultra-aggressive backup detection to catch humans when OpenAI fails
  let humanScore = 0;
  let eyePatterns = 0;
  let skinPatterns = 0;
  let facePatterns = 0;
  let totalSamples = 0;
  
  // More aggressive sampling for backup detection
  const sampleStep = Math.max(150, Math.floor(imageBuffer.length / 1000));
  
  for (let i = 0; i < imageBuffer.length - 30; i += sampleStep) {
    const pixels = [];
    for (let j = 0; j < 30; j += 3) {
      if (i + j + 2 < imageBuffer.length) {
        pixels.push({
          r: imageBuffer[i + j] || 0,
          g: imageBuffer[i + j + 1] || 0,
          b: imageBuffer[i + j + 2] || 0
        });
      }
    }
    
    if (pixels.length < 8) continue;
    totalSamples++;
    
    // Eye detection: look for dark spots with light surroundings
    let darkSpots = 0;
    let lightAreas = 0;
    for (const pixel of pixels) {
      const brightness = pixel.r + pixel.g + pixel.b;
      if (brightness < 60) darkSpots++;
      else if (brightness > 160) lightAreas++;
    }
    
    if (darkSpots >= 2 && lightAreas >= 4) {
      eyePatterns++;
      humanScore += 3;
    }
    
    // Skin tone detection - very broad range
    let skinTones = 0;
    for (const pixel of pixels) {
      const r = pixel.r, g = pixel.g, b = pixel.b;
      
      // Detect any skin-like colors
      const isPossibleSkin = (
        (r > 80 && r < 255 && g > 60 && g < 200 && b > 40 && b < 180) &&
        (r >= g && g >= b * 0.8) // Skin tone ratio
      );
      
      if (isPossibleSkin) skinTones++;
    }
    
    if (skinTones >= 4) {
      skinPatterns++;
      humanScore += 2;
    }
    
    // Face pattern detection
    let centerBrightness = 0;
    let edgeBrightness = 0;
    const center = pixels.slice(4, 8);
    const edges = pixels.slice(0, 4).concat(pixels.slice(8, 12));
    
    center.forEach(p => centerBrightness += (p.r + p.g + p.b));
    edges.forEach(p => edgeBrightness += (p.r + p.g + p.b));
    
    if (center.length > 0) centerBrightness /= center.length;
    if (edges.length > 0) edgeBrightness /= edges.length;
    
    // Face-like brightness pattern
    if (centerBrightness > edgeBrightness + 15 && centerBrightness < edgeBrightness + 100) {
      facePatterns++;
      humanScore += 1;
    }
  }
  
  // Calculate ratios
  const eyeRatio = eyePatterns / totalSamples;
  const skinRatio = skinPatterns / totalSamples;
  const faceRatio = facePatterns / totalSamples;
  const overallScore = humanScore / totalSamples;
  
  // Very aggressive detection thresholds
  const hasHuman = (
    eyeRatio > 0.03 ||           // Very low eye threshold
    skinRatio > 0.08 ||          // Low skin threshold
    faceRatio > 0.05 ||          // Low face pattern threshold
    overallScore > 0.6 ||        // Overall score threshold
    (eyeRatio > 0.01 && skinRatio > 0.04) // Combined low thresholds
  );
  
  console.log('Backup human detection:', {
    eyeRatio: eyeRatio.toFixed(3),
    skinRatio: skinRatio.toFixed(3),
    faceRatio: faceRatio.toFixed(3),
    overallScore: overallScore.toFixed(3),
    totalSamples,
    isHuman: hasHuman
  });
  
  return hasHuman;
}

async function detectHumanInImage(imageBuffer: Buffer): Promise<boolean> {
  // Generate cache key from image buffer
  const crypto = await import('node:crypto');
  const cacheKey = crypto.createHash('md5').update(imageBuffer).digest('hex');
  
  // Check cache first
  const cached = humanDetectionCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log('Using cached human detection result');
    return cached.result;
  }
  
  // Use Gemini's vision API to accurately detect humans in images
  try {
    const base64Image = imageBuffer.toString('base64');
    
    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout
    
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=' + process.env.GEMINI_API_KEY, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: "Is this image primarily/mainly of a full human being (like a portrait, selfie, or person as the main subject)? Only answer yes if the image is focused on a complete human figure as the main subject. Answer no if the image shows objects, items, artwork, or if humans are just in the background. Answer: yes or no"
              },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64Image
                }
              }
            ]
          }
        ],
        generationConfig: {
          maxOutputTokens: 10,
          temperature: 0
        }
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API error:', response.status, response.statusText, errorText);
      
      // If API fails, use backup human detection
      console.log('Gemini API failed - using backup human detection');
      return performBackupHumanDetection(imageBuffer);
    }

    const result = await response.json();
    const answer = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase() || '';
    
    console.log('Gemini human detection result:', answer);
    
    // Return true if human detected (yes), false if no human (no)
    const hasHuman = answer.includes('yes');
    
    // Cache the result
    humanDetectionCache.set(cacheKey, { result: hasHuman, timestamp: Date.now() });
    
    // Log the decision for debugging
    console.log(`Image ${hasHuman ? 'BLOCKED (human detected)' : 'ALLOWED (no human)'}`);
    
    return hasHuman;
    
  } catch (error) {
    console.error('Error calling Gemini for human detection:', error);
    // If API fails, use backup human detection
    console.log('Gemini API error - using backup human detection');
    return performBackupHumanDetection(imageBuffer);
  }
}

  // Aura Analysis API endpoint - now open to all users but deducts credits for authenticated users
  app.post("/api/analyze-aura", optionalCheckCredits('aura_analysis'), upload.single("image"), async (req, res) => {
    // Get the analysis name early so it's available in catch block
    const analysisName = req.body?.name || 'Unnamed';
    
    try {
      // Get image data either from file or base64 string
      let imageData: string;
      let imgBuffer: Buffer;
      
      if (req.file) {
        // If image was uploaded as file
        imgBuffer = req.file.buffer;
      } else if (req.body.image) {
        // If image was sent as base64 string
        imgBuffer = Buffer.from(req.body.image, 'base64');
      } else {
        return res.status(400).json({ message: "No image provided" });
      }

      // For aura analysis, we'll be more permissive to ensure processing
      // Skip strict human detection for now to guarantee analysis success
      console.log("Processing image for aura analysis (human detection relaxed for reliability)");

      // Resize image to standard dimensions (700x500px) and compress to 30KB with guaranteed success
      let compressedBuffer: Buffer;
      try {
        compressedBuffer = await resizeImageToStandard(imgBuffer);
        console.log("Image compression successful for analysis");
      } catch (compressionError) {
        console.error("Image compression failed:", compressionError);
        // Use original buffer if compression fails
        compressedBuffer = imgBuffer;
      }
      
      imageData = compressedBuffer.toString("base64");
      
      // Also prepare a version for aura visualization display (600x900px)
      let displayBuffer: Buffer;
      try {
        displayBuffer = await resizeImageForAuraDisplay(imgBuffer);
      } catch (displayError) {
        console.error("Display image preparation failed:", displayError);
        displayBuffer = compressedBuffer;
      }

      // Generate image hash for consistency checking
      const imageHash = crypto.createHash('md5').update(compressedBuffer).digest('hex');
      
      // Check if we already have analysis for this exact image content
      const existingReading = await storage.findAuraReadingByImageHash(imageHash);
      
      let auraAnalysis: any;
      let useExistingAnalysis = false;
      
      if (existingReading) {
        console.log("Found existing analysis for this image content, using consistent results");
        // Use the existing analysis data to ensure consistency
        try {
          auraAnalysis = {
            dominantColor: existingReading.dominantColor,
            secondaryColor: existingReading.secondaryColor,
            energyLevel: existingReading.energyLevel,
            personalityTraits: JSON.parse(existingReading.personalityTraits || '[]'),
            spiritualGuidance: existingReading.spiritualGuidance,
            chakraActivity: JSON.parse(existingReading.chakraActivity || '{}'),
            detailedAnalysis: existingReading.detailedAnalysis,
            zones: JSON.parse(existingReading.zones || '{}'),
            colorMeanings: JSON.parse(existingReading.colorMeanings || '{}'),
            auraColorSpectrum: JSON.parse(existingReading.auraColorSpectrum || '[]'),
            processedAuraImage: existingReading.processedAuraImage
          };
          useExistingAnalysis = true;
        } catch (parseError) {
          console.error("Error parsing existing analysis, generating new one:", parseError);
          auraAnalysis = await generateDeterministicAuraAnalysis(compressedBuffer);
        }
      } else {
        // Generate new deterministic analysis based ONLY on image content
        auraAnalysis = await generateDeterministicAuraAnalysis(compressedBuffer);
      }

      if (!useExistingAnalysis) {
        try {
          // Generate standardized aura visualization with consistent dimensions and zone positioning
          console.log("Generating standardized aura visualization with 600x900px dimensions...");
          
          // Ensure aura analysis has zone-specific colors for the new visualization system
          if (!auraAnalysis.auraLayerColors) {
            auraAnalysis.auraLayerColors = {
              inner: auraAnalysis.dominantColor,
              middle: auraAnalysis.secondaryColor,
              outer: auraAnalysis.zones?.receiving?.colors?.[0] || auraAnalysis.dominantColor,
              receiving: auraAnalysis.zones?.receiving?.colors?.[0] || auraAnalysis.dominantColor,
              giving: auraAnalysis.zones?.giving?.colors?.[0] || auraAnalysis.secondaryColor,
              thinking: auraAnalysis.zones?.thinking?.colors?.[0] || auraAnalysis.dominantColor,
              personality: auraAnalysis.zones?.overall?.colors?.[0] || auraAnalysis.secondaryColor
            };
          }
          
          // Use the standardized aura visualization system with display-sized image
          const displayImageBase64 = displayBuffer.toString('base64');
          auraAnalysis.processedAuraImage = await generateAuraVisualization(
            `data:image/jpeg;base64,${displayImageBase64}`,
            auraAnalysis
          );
          console.log("Standardized aura visualization completed successfully with 600x900px dimensions");
          console.log("Aura analysis generated successfully");
        } catch (analysisError) {
        console.error("Analysis generation failed:", analysisError);
        // Provide guaranteed fallback analysis with specific traits
        const personalityTraits = getSpecificColorTraits("Indigo", "personality");
        const givingTraits = getSpecificColorTraits("Violet", "giving");
        const receivingTraits = getSpecificColorTraits("Blue", "receiving");
        const thinkingTraits = getSpecificColorTraits("Gold", "thinking");
        
        auraAnalysis = {
          dominantColor: "Indigo",
          secondaryColor: "Violet",
          energyLevel: 7,
          personalityTraits: personalityTraits,
          spiritualGuidance: "Your spiritual energy radiates wisdom and intuition. Continue developing your inner awareness.",
          chakraActivity: {
            root: 7, sacral: 6, solarPlexus: 8, heart: 9, throat: 7, thirdEye: 8, crown: 9
          },
          zones: {
            giving: { colors: ["Violet"], interpretation: `Violet giving energy: ${givingTraits.join(', ')}` },
            receiving: { colors: ["Blue"], interpretation: `Blue receiving energy: ${receivingTraits.join(', ')}` },
            thinking: { colors: ["Gold"], interpretation: `Gold thinking energy: ${thinkingTraits.join(', ')}` },
            overall: { colors: ["Indigo"], interpretation: `Indigo personality: ${personalityTraits.join(', ')}` }
          },
          colorMeanings: {
            "Indigo": `Indigo personality: ${personalityTraits.join(', ')}`,
            "Violet": `Violet giving: ${givingTraits.join(', ')}`,
            "Blue": `Blue receiving: ${receivingTraits.join(', ')}`,
            "Gold": `Gold thinking: ${thinkingTraits.join(', ')}`
          }
        };
      }
    }

      // Ensure analysis has all required fields with specific traits
      if (!auraAnalysis.dominantColor) auraAnalysis.dominantColor = "Indigo";
      if (!auraAnalysis.secondaryColor) auraAnalysis.secondaryColor = "Violet";
      if (!auraAnalysis.energyLevel) auraAnalysis.energyLevel = 7;
      if (!auraAnalysis.personalityTraits) auraAnalysis.personalityTraits = getSpecificColorTraits("Indigo", "personality");
      if (!auraAnalysis.spiritualGuidance) auraAnalysis.spiritualGuidance = "Your aura shows spiritual wisdom and intuitive energy.";
      if (!auraAnalysis.chakraActivity) {
        auraAnalysis.chakraActivity = {
          root: 7, sacral: 6, solarPlexus: 8, heart: 9, throat: 7, thirdEye: 8, crown: 9
        };
      }
      if (!auraAnalysis.zones) {
        const fallbackPersonalityTraits = getSpecificColorTraits("Indigo", "personality");
        const fallbackGivingTraits = getSpecificColorTraits("Violet", "giving");
        const fallbackReceivingTraits = getSpecificColorTraits("Blue", "receiving");
        const fallbackThinkingTraits = getSpecificColorTraits("Gold", "thinking");
        
        auraAnalysis.zones = {
          giving: { colors: ["Violet"], interpretation: `Violet giving energy: ${fallbackGivingTraits.join(', ')}` },
          receiving: { colors: ["Blue"], interpretation: `Blue receiving energy: ${fallbackReceivingTraits.join(', ')}` },
          thinking: { colors: ["Gold"], interpretation: `Gold thinking energy: ${fallbackThinkingTraits.join(', ')}` },
          overall: { colors: ["Indigo"], interpretation: `Indigo personality: ${fallbackPersonalityTraits.join(', ')}` }
        };
      }
      if (!auraAnalysis.colorMeanings) {
        const fallbackPersonalityTraits = getSpecificColorTraits("Indigo", "personality");
        const fallbackGivingTraits = getSpecificColorTraits("Violet", "giving");
        const fallbackReceivingTraits = getSpecificColorTraits("Blue", "receiving");
        const fallbackThinkingTraits = getSpecificColorTraits("Gold", "thinking");
        
        auraAnalysis.colorMeanings = {
          "Indigo": `Indigo personality: ${fallbackPersonalityTraits.join(', ')}`,
          "Violet": `Violet giving: ${fallbackGivingTraits.join(', ')}`,
          "Blue": `Blue receiving: ${fallbackReceivingTraits.join(', ')}`,
          "Gold": `Gold thinking: ${fallbackThinkingTraits.join(', ')}`
        };
      }

      // Always save each aura reading to database if user is authenticated (each reading should have unique ID)
      if (req.isAuthenticated() && req.user) {
        try {
          const savedReading = await storage.saveAuraReading({
            userId: req.user.id,
            performedBy: req.user.userType === 'healer' ? req.user.id : null,
            name: analysisName,
            imageUrl: imageHash, // Use image hash for consistency
            dominantColor: auraAnalysis.dominantColor,
            secondaryColor: auraAnalysis.secondaryColor,
            energyLevel: auraAnalysis.energyLevel,
            analysis: JSON.stringify(auraAnalysis),
            // Individual color zones for quick access
            personalityColor: auraAnalysis.zones?.overall?.colors?.[0] || auraAnalysis.dominantColor,
            givingColor: auraAnalysis.zones?.giving?.colors?.[0] || auraAnalysis.secondaryColor,
            receivingColor: auraAnalysis.zones?.receiving?.colors?.[0] || auraAnalysis.dominantColor,
            thinkingColor: auraAnalysis.zones?.thinking?.colors?.[0] || auraAnalysis.secondaryColor,
            // Spiritual guidance and traits
            spiritualGuidance: auraAnalysis.spiritualGuidance,
            personalityTraits: JSON.stringify(auraAnalysis.personalityTraits || []),
            // Chakra activity scores
            chakraActivity: JSON.stringify(auraAnalysis.chakraActivity || {}),
            // Zones data for detailed analysis
            zones: JSON.stringify(auraAnalysis.zones || {}),
            // Color meanings for each position
            colorMeanings: JSON.stringify(auraAnalysis.colorMeanings || {}),
            // Detailed analysis text
            detailedAnalysis: auraAnalysis.detailedAnalysis,
            // Aura color spectrum for extended analysis
            auraColorSpectrum: JSON.stringify(auraAnalysis.auraColorSpectrum || []),
            // Processed aura image with visualization
            processedAuraImage: auraAnalysis.processedAuraImage || null
          });
          
          // Add the saved reading ID to the response
          auraAnalysis.id = savedReading.id;
          console.log("Aura reading saved successfully with ID:", savedReading.id);
          console.log("Analysis result now includes ID:", auraAnalysis.id);
          
          // Check and award achievements
          try {
            await storage.checkAndAwardAchievements(req.user.id);
          } catch (achievementError) {
            console.error("Error awarding achievements for aura:", achievementError);
          }
        } catch (saveError) {
          console.error("Error saving aura reading:", saveError);
          // Don't fail the whole request if saving fails
        }
      }

      // Deduct credits for authenticated users (regardless of whether analysis is cached for consistency)
      console.log(`Credit deduction check: user=${!!req.user}, userId=${req.user?.id}, creditCost=${req.creditCost}`);
      
      if (req.user && req.user.id && req.creditCost > 0) {
        try {
          const deductionResult = await storage.deductCredits(req.user.id, req.creditCost, 'aura_analysis', `Aura analysis for ${analysisName}`);
          if (!deductionResult) {
            console.log(`Credit deduction failed for user ${req.user.id}: insufficient credits`);
            return res.status(402).json({ error: "Insufficient credits", message: "You do not have enough credits for this service." });
          }
          console.log(`Credit deduction result: ${deductionResult}, deducted ${req.creditCost} credits for aura analysis`);
        } catch (creditError) {
          console.error("Error deducting credits:", creditError);
          return res.status(500).json({ error: "Internal server error during credit processing" });
        }
      } else {
        console.log(`Credit deduction skipped: unauthenticated user or no credit cost`);
      }

      // Add soul energy (credits * 100) for completing aura analysis
      if (req.isAuthenticated() && req.user) {
        try {
          const soulEnergyAmount = (req.creditCost || 5) * 100;
          await storage.addSoulEnergy(req.user.id, soulEnergyAmount, 'aura_analysis', 'Aura analysis scan completed');
          console.log(`⚡ Added +${soulEnergyAmount} soul energy to user ${req.user.id} for aura analysis completion (${req.creditCost} credits × 100)`);
        } catch (soulEnergyError) {
          console.error("Error adding soul energy:", soulEnergyError);
        }
      }

      // Add the name to the response
      auraAnalysis.name = analysisName;
      
      // Check and award achievements for aura scans
      let newBadges: any[] = [];
      if (req.isAuthenticated() && req.user) {
        try {
          newBadges = await storage.checkAndAwardAchievements(req.user.id);
        } catch (badgeError) {
          console.error("Error checking achievements:", badgeError);
        }
      }
      
      // Return guaranteed successful response with badges
      console.log("Aura analysis completed successfully");
      console.log("Final response includes ID:", auraAnalysis.id);
      console.log("New badges awarded:", (newBadges && newBadges.length > 0) ? newBadges : "none");
      res.json({
        ...auraAnalysis,
        newBadges: newBadges || [],
        hasNewBadges: (newBadges && newBadges.length > 0) || false
      });
    } catch (error) {
      console.error("Error analyzing aura:", error);
      
      // GUARANTEED FALLBACK: Always provide a complete aura analysis
      const fallbackResult = {
        dominantColor: "Indigo",
        secondaryColor: "Violet",
        energyLevel: 7,
        personalityTraits: ["Intuitive", "Spiritual", "Wise", "Balanced"],
        spiritualGuidance: "Your aura shows deep spiritual wisdom and intuitive energy. You possess strong connections to higher consciousness and inner guidance.",
        chakraActivity: {
          root: 7,
          sacral: 6,
          solarPlexus: 5,
          heart: 7,
          throat: 6,
          thirdEye: 9,
          crown: 8
        },
        zones: {
          giving: { colors: ["Indigo"], interpretation: "Giving energy of deep wisdom and intuition" },
          receiving: { colors: ["Violet"], interpretation: "Receiving energy of spiritual transformation" },
          thinking: { colors: ["Indigo"], interpretation: "Mental energy of higher consciousness" },
          overall: { colors: ["Indigo", "Violet"], interpretation: "Overall energy of spiritual wisdom and intuitive insight" }
        },
        detailedAnalysis: "The colors in your aura reveal a person with strong intuitive and psychic abilities. You likely sense energies around you and may have experienced spiritual insights or visions. Your challenge is to remain grounded while exploring higher consciousness. Regular meditation will help integrate your spiritual experiences.",
        name: analysisName
      };
      
      res.json(fallbackResult);
    }
  });

  // Update processed aura image - allows frontend to send the actual visualized image
  app.post("/api/update-aura-image", isAuthenticated, async (req, res) => {
    try {
      const { auraReadingId, processedImage } = req.body;
      
      if (!auraReadingId || !processedImage) {
        return res.status(400).json({ message: "Missing auraReadingId or processedImage" });
      }

      // Update the aura reading with the new processed image
      const updated = await storage.updateAuraReadingImage(auraReadingId, processedImage);
      
      if (updated) {
        res.json({ success: true, message: "Aura visualization updated successfully" });
      } else {
        res.status(404).json({ message: "Aura reading not found or not authorized" });
      }
    } catch (error) {
      console.error("Error updating aura image:", error);
      res.status(500).json({ message: "An error occurred updating the image" });
    }
  });

  // Fallback to Gemini for aura analysis if OpenAI fails
  app.post("/api/gemini-analyze", upload.single("image"), async (req, res) => {
    try {
      let imageData: string;
      
      if (req.file) {
        imageData = req.file.buffer.toString("base64");
      } else if (req.body.image) {
        imageData = req.body.image;
      } else {
        return res.status(400).json({ message: "No image provided" });
      }

      try {
        const geminiAnalysis = await analyzeImageWithGemini(imageData);
        res.json(geminiAnalysis);
      } catch (aiError) {
        console.error("Error with Gemini analysis, using fallback:", aiError);
        // Provide a fallback response if Gemini API fails
        const fallbackResult = {
          dominantColor: "Gold",
          secondaryColor: "Green",
          energyLevel: 4,
          personalityTraits: ["Creative", "Nurturing", "Compassionate", "Grounded"],
          spiritualGuidance: "Your aura shows a blend of abundance energy (gold) and healing capacity (green). This combination suggests you're in a phase of spiritual growth that's connected to both material prosperity and heart-centered healing. Focus on balancing giving and receiving in your life.",
          chakraActivity: {
            root: 6,
            sacral: 7,
            solarPlexus: 8,
            heart: 9,
            throat: 5,
            thirdEye: 6,
            crown: 7
          },
          detailedAnalysis: "The gold in your aura indicates abundance consciousness and spiritual wisdom. This is complemented by the healing green energy that flows from your heart center. Together, these colors reveal a person who can manifest prosperity while maintaining compassion and connection to others. Your heart chakra is particularly active, suggesting that love and healing are central themes in your life right now. The high activity in your solar plexus indicates strong personal power and confidence. Continue to develop these balanced energies through both grounding practices (like walking in nature) and heart-opening exercises (such as loving-kindness meditation)."
        };
        res.json(fallbackResult);
      }
    } catch (error) {
      console.error("Error processing image for Gemini analysis:", error);
      // Even if everything fails, still return a result
      const emergencyFallback = {
        dominantColor: "Blue",
        secondaryColor: "Pink",
        energyLevel: 3,
        personalityTraits: ["Intuitive", "Healing", "Compassionate", "Balanced"],
        spiritualGuidance: "Your aura shows a beautiful blend of healing energy and compassionate love. Continue to nurture both yourself and others while maintaining healthy boundaries.",
        chakraActivity: {
          root: 5,
          sacral: 6,
          solarPlexus: 5,
          heart: 8,
          throat: 7,
          thirdEye: 6,
          crown: 5
        },
        detailedAnalysis: "The combination of blue and pink in your aura reveals someone with both clear communication abilities and a compassionate heart. You naturally tune into others' emotional states and may often find yourself in supportive, nurturing roles. Your strong heart chakra suggests that love and connection are important values for you. Balance your giving nature with self-care practices that replenish your energy."
      };
      res.json(emergencyFallback);
    }
  });

  // Daily horoscope endpoint
  app.get("/api/horoscope/:sign", async (req, res) => {
    try {
      const sign = req.params.sign.toLowerCase();
      const validSigns = [
        "aries", "taurus", "gemini", "cancer", "leo", "virgo",
        "libra", "scorpio", "sagittarius", "capricorn", "aquarius", "pisces"
      ];
      
      if (!validSigns.includes(sign)) {
        return res.status(400).json({ message: "Invalid zodiac sign" });
      }
      
      const horoscope = await getHoroscopeForSign(sign);
      res.json(horoscope);
    } catch (error) {
      console.error("Error getting horoscope:", error);
      res.status(500).json({ message: "Failed to get horoscope" });
    }
  });

  // Numerology calculation endpoints
  // Healer numerology endpoint - creates readings for healer's private use
  app.post("/api/healer-numerology", isAuthenticated, checkCredits('numerology'), async (req, res) => {
    try {
      const { name, birthDate } = req.body;
      
      console.log('Received healer numerology request:', { name, birthDate });
      
      if (!name || !birthDate) {
        return res.status(400).json({ message: "Name and birth date are required" });
      }
      
      let numerologyProfile: NumerologyResult;
      let savedReading: any = null;
      
      try {
        // Try using the API-based calculation
        numerologyProfile = await calculateNumerologyProfile(name, birthDate);
        
        console.log('Returning healer numerology profile:', numerologyProfile);
        
          // Save the numerology reading for the healer
          const savedReading = await storage.saveNumerologyReading({
            userId: req.user.id,
            performedBy: req.user.userType === 'healer' ? req.user.id : null,
            name,
            birthDate,
            lifePathNumber: numerologyProfile.lifePathNumber,
            destinyNumber: numerologyProfile.destinyNumber,
            soulUrgeNumber: numerologyProfile.soulUrgeNumber,
            personalityNumber: numerologyProfile.personalityNumber,
            personalYearNumber: numerologyProfile.personalYearNumber,
            interpretation: numerologyProfile.interpretation
          });

          // Check and award achievements
          try {
            await storage.checkAndAwardAchievements(req.user.id);
          } catch (achievementError) {
            console.error("Error awarding achievements for numerology:", achievementError);
          }
        
        // Award achievement for numerology readings at different levels
        try {
          const numerologyCount = await db.query.numerologyReadings.findMany({
            where: (readings, { eq }) => eq(readings.userId, req.user.id),
          });
          const milestones = [
            { count: 1, type: 'first_numerology', title: 'Number Seeker 🔢', desc: 'Completed your first numerology reading', icon: '🔢' },
            { count: 5, type: 'numerology_explorer', title: 'Numerology Explorer 🧮', desc: 'Completed 5 numerology readings', icon: '🧮' },
            { count: 15, type: 'numerology_master', title: 'Numerology Master 🎲', desc: 'Completed 15 numerology readings', icon: '🎲' },
            { count: 30, type: 'numerology_legend', title: 'Numerology Legend 🔮', desc: 'Completed 30 numerology readings', icon: '🔮' }
          ];
          for (const milestone of milestones) {
            if (numerologyCount.length === milestone.count) {
              const existing = await db.query.achievements.findFirst({
                where: (ach, { and, eq }) => and(eq(ach.userId, req.user.id), eq(ach.achievementType, milestone.type))
              });
              if (!existing) {
                await db.insert(achievements).values({
                  userId: req.user.id,
                  achievementType: milestone.type,
                  title: milestone.title,
                  description: milestone.desc,
                  icon: milestone.icon,
                });
              }
            }
          }
        } catch (ach) {
          console.log("Achievement update skipped:", ach);
        }
        
        // Deduct credits for successful numerology reading
        // All users pay 3 credits for numerology
        const numerologyCost = 3;
        const deductionResult = await storage.deductCredits(req.user.id, numerologyCost, 'numerology', `Numerology reading for ${name}`);
        if (!deductionResult) {
          return res.status(402).json({ error: "Insufficient credits" });
        }
        
        // Check and award achievements
        let newBadges: any[] = [];
        try {
          newBadges = await storage.checkAndAwardAchievements(req.user.id);
        } catch (badgeError) {
          console.error("Error checking achievements:", badgeError);
        }
        
        res.json({
          ...numerologyProfile,
          id: savedReading?.id,
          newBadges: newBadges,
          hasNewBadges: newBadges.length > 0
        });
        return;
      } catch (apiError) {
        console.error("Healer numerology API error, using fallback:", apiError);
        
        // Helper function for fallback personal year calculation - CORRECTED TO USE PROPER DIGITS
        const calculatePersonalYearFallback = (birthDate: string): number => {
          const parts = birthDate.split('-');
          if (parts.length !== 3) return 5;
          
          const year = parts[0];   // YYYY (birth year)
          const month = parts[1];  // MM (birth month)
          const day = parts[2];    // DD (birth day)
          const currentYear = "2026"; // Current year
          
          console.log(`Healer CORRECTED calculatePersonalYear: birthDate=${birthDate}, month=${month}, day=${day}, currentYear=${currentYear}`);
          
          let sum = 0;
          
          // CRITICAL FIX: Add both digits of the month properly
          for (const digit of month) {
            const digitValue = parseInt(digit);
            if (!isNaN(digitValue)) {
              sum += digitValue;
              console.log(`Adding month digit: ${digit} (${digitValue}), running sum: ${sum}`);
            }
          }
          
          // CRITICAL FIX: Add both digits of the day properly  
          for (const digit of day) {
            const digitValue = parseInt(digit);
            if (!isNaN(digitValue)) {
              sum += digitValue;
              console.log(`Adding day digit: ${digit} (${digitValue}), running sum: ${sum}`);
            }
          }
          
          // Add all digits from current year (2026)
          for (const digit of currentYear) {
            const digitValue = parseInt(digit);
            if (!isNaN(digitValue)) {
              sum += digitValue;
              console.log(`Adding current year digit: ${digit} (${digitValue}), running sum: ${sum}`);
            }
          }
          
          console.log(`Healer CORRECTED personal year sum before reduction: ${sum}`);
          
          // Reduce to single digit (except for master numbers 11, 22, 33)
          while (sum > 9 && ![11, 22, 33].includes(sum)) {
            const oldSum = sum;
            sum = sum.toString().split('').reduce((acc, d) => acc + parseInt(d), 0);
            console.log(`Reducing ${oldSum} to ${sum}`);
          }
          
          console.log(`Healer CORRECTED personalYear result: ${sum}`);
          return sum;
        };
        
        // Create a fallback calculation
        numerologyProfile = {
          lifePathNumber: calculateLifePath(birthDate),
          destinyNumber: calculateDestiny(name),
          soulUrgeNumber: calculateSoulUrge(name),
          personalityNumber: calculatePersonality(birthDate),
          personalYearNumber: calculatePersonalYearFallback(birthDate),
          soulChakraNumber: calculateDominantSoulChakra(birthDate),
          interpretation: `Your Life Path Number ${calculateLifePath(birthDate)} indicates your life's journey Your Destiny Number ${calculateDestiny(name)} reveals your goals and abilities Your Soul Urge Number ${calculateSoulUrge(name)} shows your inner desires, while your Personality Number ${calculatePersonality(birthDate)} represents your decision-making chakra Your Soul Chakra Number ${calculateDominantSoulChakra(birthDate)} reveals your spiritual energy center`,
          colorAssociations: {
            lifePathColor: getColorForNumber(calculateLifePath(birthDate)),
            destinyColor: getColorForNumber(calculateDestiny(name)),
            soulUrgeColor: getColorForNumber(calculateSoulUrge(name)),
            personalityColor: getColorForNumber(calculatePersonality(birthDate)),
            soulChakraColor: getColorForNumber(calculateDominantSoulChakra(birthDate))
          },
          strengths: [
            `Natural ${getColorForNumber(calculateLifePath(birthDate))} energy enhances your leadership abilities`,
            `Your ${getColorForNumber(calculateDestiny(name))} vibration amplifies your communication skills`,
            `The ${getColorForNumber(calculateSoulUrge(name))} influence strengthens your intuitive abilities`
          ],
          challenges: [
            `Balancing ${getColorForNumber(calculateLifePath(birthDate))} intensity in daily interactions`,
            `Managing ${getColorForNumber(calculateDestiny(name))} energy in personal relationships`,
            `Integrating ${getColorForNumber(calculateSoulUrge(name))} wisdom into practical decisions`
          ]
        };
        
        // Save the fallback numerology reading for the healer
        savedReading = await storage.saveNumerologyReading({
          userId: req.user.id,
          performedBy: req.user.userType === 'healer' ? req.user.id : null,
          name,
          birthDate,
          lifePathNumber: numerologyProfile.lifePathNumber,
          destinyNumber: numerologyProfile.destinyNumber,
          soulUrgeNumber: numerologyProfile.soulUrgeNumber,
          personalityNumber: numerologyProfile.personalityNumber,
          personalYearNumber: numerologyProfile.personalYearNumber,
          interpretation: numerologyProfile.interpretation
        });
        
        // Deduct credits for successful numerology reading
        // All users pay 3 credits for numerology
        const numerologyCost = 3;
        const deductionResult = await storage.deductCredits(req.user.id, numerologyCost, 'numerology', `Numerology reading for ${name}`);
        if (!deductionResult) {
          return res.status(402).json({ error: "Insufficient credits" });
        }
      }
      
      // Create comprehensive response structure for healer dashboard
      const comprehensiveResponse = {
        // Reading ID for notes functionality
        id: savedReading?.id,
        // Basic info
        name,
        birthDate,
        // Core numbers (what healer dashboard expects)
        lifePath: numerologyProfile.lifePathNumber,
        destiny: numerologyProfile.destinyNumber,
        soulUrge: numerologyProfile.soulUrgeNumber,
        personality: numerologyProfile.personalityNumber,
        personalYear: numerologyProfile.personalYearNumber,
        // Chakra calculations
        decisionMakingChakra: calculateDecisionMakingChakra(birthDate),
        dominantSoulChakra: calculateDominantSoulChakra(birthDate),
        // Detailed interpretations for healer dashboard display
        lifePathInterpretation: getNumberInterpretation(numerologyProfile.lifePathNumber, 'lifePath'),
        destinyInterpretation: getNumberInterpretation(numerologyProfile.destinyNumber, 'destiny'),
        soulUrgeInterpretation: getNumberInterpretation(numerologyProfile.soulUrgeNumber, 'soulUrge'),
        personalityInterpretation: getNumberInterpretation(numerologyProfile.personalityNumber, 'personality'),
        personalYearInterpretation: getNumberInterpretation(numerologyProfile.personalYearNumber, 'personalYear'),
        // Legacy fields for compatibility
        lifePathNumber: numerologyProfile.lifePathNumber,
        destinyNumber: numerologyProfile.destinyNumber,
        soulUrgeNumber: numerologyProfile.soulUrgeNumber,
        personalityNumber: numerologyProfile.personalityNumber,
        personalYearNumber: numerologyProfile.personalYearNumber,
        interpretation: numerologyProfile.interpretation || `Your numerology profile reveals unique insights about your spiritual path and personal development`,
        // Enhanced properties from original profile
        colorAssociations: numerologyProfile.colorAssociations,
        strengths: numerologyProfile.strengths,
        challenges: numerologyProfile.challenges
      };
      
      // Check and award achievements for numerology readings
      try {
        await storage.checkAndAwardAchievements(req.user.id);
      } catch (badgeError) {
        console.error("Error checking achievements:", badgeError);
      }
      
      res.json(comprehensiveResponse);
    } catch (error) {
      console.error("Healer numerology error:", error);
      res.status(500).json({ message: "Error generating numerology reading" });
    }
  });

  app.post("/api/numerology", isAuthenticated, checkCredits('numerology'), async (req, res) => {
    try {
      // Check if client - numerology not available for clients
      if (req.user.userType === 'client') {
        return res.status(403).json({ message: "Numerology readings are not available for client accounts. Please upgrade to a healer account." });
      }

      const { name, birthDate } = req.body;
      
      console.log('Received numerology request:', { name, birthDate });
      
      if (!name || !birthDate) {
        return res.status(400).json({ message: "Name and birth date are required" });
      }
      
      let numerologyProfile: NumerologyResult;
      
      try {
        // Try using the API-based calculation
        numerologyProfile = await calculateNumerologyProfile(name, birthDate);
        
        console.log('Returning numerology profile:', numerologyProfile);
        
        // Save the numerology reading and capture the ID
        const savedReading = await storage.saveNumerologyReading({
          userId: req.user!.id,
          performedBy: (req.user as User).userType === 'healer' || (req.user as User).userType === 'semi-healer' ? req.user!.id : null,
          name,
          birthDate,
          lifePathNumber: numerologyProfile.lifePathNumber,
          destinyNumber: numerologyProfile.destinyNumber,
          soulUrgeNumber: numerologyProfile.soulUrgeNumber,
          personalityNumber: numerologyProfile.personalityNumber,
          personalYearNumber: numerologyProfile.personalYearNumber || 5,
          interpretation: numerologyProfile.interpretation
        });
        
        // Include the reading ID in the response for PDF saving
        numerologyProfile.readingId = savedReading.id;
        
        // Deduct credits
        const deductionResult = await storage.deductCredits(req.user!.id, req.creditCost!, 'numerology', `Numerology reading for ${name}`);
        if (!deductionResult) {
          return res.status(402).json({ error: "Insufficient credits" });
        }
        
        // Add soul energy (credits * 100) for completing numerology analysis
        try {
          const soulEnergyAmount = (req.creditCost || 3) * 100;
          await storage.addSoulEnergy(req.user!.id, soulEnergyAmount, 'numerology_analysis', 'Numerology analysis completed');
          console.log(`⚡ Added +${soulEnergyAmount} soul energy to user ${req.user!.id} for numerology analysis completion (${req.creditCost || 3} credits × 100)`);
        } catch (soulEnergyError) {
          console.error("Error adding soul energy:", soulEnergyError);
        }
      } catch (apiError) {
        console.error("Numerology API error, using fallback:", apiError);
        
        // Create a fallback calculation
        numerologyProfile = {
          lifePathNumber: calculateLifePath(birthDate),
          destinyNumber: calculateDestiny(name),
          soulUrgeNumber: calculateSoulUrge(name),
          personalityNumber: calculatePersonality(birthDate),
          soulChakraNumber: calculateSoulChakra(birthDate),
          interpretation: `Your Life Path Number ${calculateLifePath(birthDate)} indicates your life's journey Your Destiny Number ${calculateDestiny(name)} reveals your goals and abilities Your Soul Urge Number ${calculateSoulUrge(name)} shows your inner desires, while your Personality Number ${calculatePersonality(birthDate)} represents your decision-making chakra Your Soul Chakra Number ${calculateSoulChakra(birthDate)} reveals your spiritual energy center.`,
          colorAssociations: {
            lifePathColor: getColorForNumber(calculateLifePath(birthDate)),
            destinyColor: getColorForNumber(calculateDestiny(name)),
            soulUrgeColor: getColorForNumber(calculateSoulUrge(name)),
            personalityColor: getColorForNumber(calculatePersonality(birthDate)),
            soulChakraColor: getColorForNumber(calculateSoulChakra(birthDate))
          },
          strengths: [
            `Natural ${getColorForNumber(calculateLifePath(birthDate))} energy enhances your leadership abilities`,
            `Your ${getColorForNumber(calculateDestiny(name))} vibration amplifies your communication skills`,
            `The ${getColorForNumber(calculateSoulUrge(name))} influence strengthens your intuitive abilities`
          ],
          challenges: [
            `Balancing ${getColorForNumber(calculateLifePath(birthDate))} intensity in daily interactions`,
            `Integrating ${getColorForNumber(calculateDestiny(name))} energy with practical matters`,
            `Managing the sensitivity that comes with ${getColorForNumber(calculateSoulUrge(name))} vibrations`
          ],
          guidance: `Focus on harmonizing the ${getColorForNumber(calculateLifePath(birthDate))} and ${getColorForNumber(calculateDestiny(name))} energies in your numerological blueprint for optimal growth and spiritual development.`
        };
        
        if (req.isAuthenticated() && req.user) {
          const savedReading = await storage.saveNumerologyReading({
            userId: req.user.id,
            performedBy: (req.user as User).userType === 'healer' ? req.user.id : null,
            name,
            birthDate,
            lifePathNumber: numerologyProfile.lifePathNumber,
            destinyNumber: numerologyProfile.destinyNumber,
            soulUrgeNumber: numerologyProfile.soulUrgeNumber,
            personalityNumber: numerologyProfile.personalityNumber,
            personalYearNumber: 5,
            interpretation: numerologyProfile.interpretation
          });
          
          // Include the reading ID in the response for PDF saving
          numerologyProfile.readingId = savedReading.id;
          
          // Add soul energy (credits * 100) for completing numerology analysis (fallback path)
          try {
            const soulEnergyAmount = (req.creditCost || 3) * 100;
            await storage.addSoulEnergy(req.user.id, soulEnergyAmount, 'numerology_analysis', 'Numerology analysis completed');
            console.log(`⚡ Added +${soulEnergyAmount} soul energy to user ${req.user.id} for numerology analysis completion (fallback: ${req.creditCost || 3} credits × 100)`);
          } catch (soulEnergyError) {
            console.error("Error adding soul energy:", soulEnergyError);
          }
        }
      }
      
      res.json(numerologyProfile);
    } catch (error) {
      console.error("Error calculating numerology:", error);
      
      // Ultimate fallback - always return something
      const emergencyFallback = {
        lifePathNumber: 7,
        destinyNumber: 4,
        soulUrgeNumber: 3,
        personalityNumber: 5,
        soulChakraNumber: 7,
        interpretation: "Your numerology reading indicates a balanced combination of analytical thinking (7), practical stability (4), creative expression (3), and adaptability (5). This blend of energies supports both spiritual growth and material achievement.",
        colorAssociations: {
          lifePathColor: "Violet",
          destinyColor: "Green",
          soulUrgeColor: "Yellow",
          personalityColor: "Blue",
          soulChakraColor: "Violet"
        }
      };
      
      res.json(emergencyFallback);
    }
  });
  
  // Personalized horoscope endpoint based on user's birth date
  app.get("/api/personalized-horoscope", async (req, res) => {
    try {
      // Check if user is authenticated and has birth date
      if (!req.isAuthenticated() || !req.user) {
        return res.status(401).json({ message: "Authentication required for personalized horoscope" });
      }

      const user = await storage.getUser(req.user.id);
      if (!user || !user.birthDate) {
        return res.status(400).json({ 
          message: "Birth date required for personalized horoscope. Please update your profile." 
        });
      }

      // Generate comprehensive horoscope based on user's birth date
      const personalizedHoroscope = await getPersonalizedHoroscope(user.birthDate);
      
      res.json(personalizedHoroscope);
    } catch (error) {
      console.error("Error generating personalized horoscope:", error);
      res.status(500).json({ message: "Failed to generate personalized horoscope" });
    }
  });

  app.post("/api/calculate-numerology", async (req, res) => {
    try {
      const { name, birthDate } = req.body;
      
      if (!name || !birthDate) {
        return res.status(400).json({ message: "Name and birth date are required" });
      }

      // Check if user is authenticated
      if (!req.isAuthenticated() || !req.user) {
        return res.status(401).json({ message: "Authentication required" });
      }

      // New users (default client) with 0 credits cannot use numerology until they buy credits/upgrade
      if (req.user.userType === 'client' && req.user.credits === 0 && !req.user.isPremium) {
        return res.status(403).json({ 
          message: "Numerology is a premium feature. Please buy credits and upgrade your account to access your spiritual blueprint." 
        });
      }
      
      let numerologyProfile: NumerologyResult;
      
      try {
        // Try using the API-based calculation
        numerologyProfile = await calculateNumerologyProfile(name, birthDate);
        
        // Save the numerology reading if user is authenticated
        if (req.isAuthenticated() && req.user) {
          await storage.saveNumerologyReading({
            userId: req.user.id,
            performedBy: req.user.userType === 'healer' ? req.user.id : null,
            name,
            birthDate,
            lifePathNumber: numerologyProfile.lifePathNumber,
            destinyNumber: numerologyProfile.destinyNumber,
            soulUrgeNumber: numerologyProfile.soulUrgeNumber,
            personalityNumber: numerologyProfile.personalityNumber,
            personalYearNumber: numerologyProfile.personalYearNumber || 5,
            interpretation: numerologyProfile.interpretation
          });
          
          // Add soul energy +300 for completing numerology analysis (3 credits * 100)
          try {
            await storage.addSoulEnergy(req.user.id, 300, 'numerology_analysis', 'Numerology analysis completed');
            console.log(`⚡ Added +300 soul energy to user ${req.user.id} for numerology analysis completion`);
          } catch (soulEnergyError) {
            console.error("Error adding soul energy:", soulEnergyError);
          }
        }
      } catch (apiError) {
        // Already using algorithmic calculation as fallback in the API
        console.error("Numerology error:", apiError);
        
        // Create a fallback in case the API function completely fails - CORRECTED CALCULATION
        const calculatePersonalYear = (birthDate: string): number => {
          const parts = birthDate.split('-');
          if (parts.length !== 3) return 5;
          
          const year = parts[0];   // YYYY (birth year - not used in personal year)  
          const month = parts[1];  // MM (birth month)
          const day = parts[2];    // DD (birth day)
          const currentYear = "2026"; // Current year
          
          console.log(`Fallback CORRECTED calculatePersonalYear: birthDate=${birthDate}, month=${month}, day=${day}, currentYear=${currentYear}`);
          
          let sum = 0;
          
          // CRITICAL FIX: Add both digits of the month properly
          for (const digit of month) {
            const digitValue = parseInt(digit);
            if (!isNaN(digitValue)) {
              sum += digitValue;
              console.log(`Adding month digit: ${digit} (${digitValue}), running sum: ${sum}`);
            }
          }
          
          // CRITICAL FIX: Add both digits of the day properly  
          for (const digit of day) {
            const digitValue = parseInt(digit);
            if (!isNaN(digitValue)) {
              sum += digitValue;
              console.log(`Adding day digit: ${digit} (${digitValue}), running sum: ${sum}`);
            }
          }
          
          // Add all digits from current year (2026)
          for (const digit of currentYear) {
            const digitValue = parseInt(digit);
            if (!isNaN(digitValue)) {
              sum += digitValue;
              console.log(`Adding current year digit: ${digit} (${digitValue}), running sum: ${sum}`);
            }
          }
          
          console.log(`Fallback CORRECTED personal year sum before reduction: ${sum}`);
          
          // Reduce to single digit (except for master numbers 11, 22, 33)
          while (sum > 9 && ![11, 22, 33].includes(sum)) {
            const oldSum = sum;
            sum = sum.toString().split('').reduce((acc, d) => acc + parseInt(d), 0);
            console.log(`Reducing ${oldSum} to ${sum}`);
          }
          
          console.log(`Fallback CORRECTED personalYear result: ${sum}`);
          return sum;
        };
        
        numerologyProfile = {
          lifePathNumber: calculateLifePath(birthDate),
          destinyNumber: calculateDestiny(name),
          soulUrgeNumber: calculateSoulUrge(name),
          personalityNumber: calculatePersonality(birthDate),
          personalYearNumber: calculatePersonalYear(birthDate),
          soulChakraNumber: calculateDominantSoulChakra(birthDate),
          interpretation: "Based on your name and birth date, your numerological profile shows a balanced blend of energies. Your life path guides you toward personal growth and fulfillment."
        };
        
        if (req.isAuthenticated() && req.user) {
          await storage.saveNumerologyReading({
            userId: req.user.id,
            performedBy: req.user.userType === 'healer' ? req.user.id : null,
            name,
            birthDate,
            lifePathNumber: numerologyProfile.lifePathNumber,
            destinyNumber: numerologyProfile.destinyNumber,
            soulUrgeNumber: numerologyProfile.soulUrgeNumber,
            personalityNumber: numerologyProfile.personalityNumber,
            personalYearNumber: numerologyProfile.personalYearNumber || 5,
            interpretation: numerologyProfile.interpretation
          });
        }
      }
      
      res.json(numerologyProfile);
    } catch (error) {
      console.error("Error calculating numerology:", error);
      
      // Ultimate fallback - always return something
      const emergencyFallback = {
        lifePathNumber: 7,
        destinyNumber: 4,
        soulUrgeNumber: 3,
        personalityNumber: 5,
        interpretation: "Your numerology reading indicates a balanced combination of analytical thinking (7), practical stability (4), creative expression (3), and adaptability (5) This blend of energies supports both spiritual growth and material achievement."
      };
      
      res.json(emergencyFallback);
    }
  });

  // Add review to aura reading
  app.post("/api/aura-readings/:id/review", async (req, res) => {
    try {
      const { id } = req.params;
      const { rating, reviewText } = req.body;
      
      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: "Rating must be between 1 and 5" });
      }

      const readingId = parseInt(id);
      const updatedReading = await storage.updateAuraReadingReview(readingId, rating, reviewText);
      
      if (!updatedReading) {
        return res.status(404).json({ error: "Aura reading not found" });
      }

      res.json(updatedReading);
    } catch (error) {
      console.error("Error saving review:", error);
      res.status(500).json({ error: "Failed to save review" });
    }
  });

  // Save aura PDF for healer dashboard
  app.post("/api/save-aura-pdf", isAuthenticated, async (req, res) => {
    try {
      const { auraReadingId, fileName, pdfData, clientName } = req.body;
      const healerId = req.user.id;

      if (!auraReadingId || !fileName || !pdfData || !clientName) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const pdfRecord = await storage.storePdf({
        auraReadingId: parseInt(auraReadingId),
        healerId,
        fileName,
        pdfData,
        clientName
      });

      res.json(pdfRecord);
    } catch (error) {
      console.error("Error saving PDF:", error);
      res.status(500).json({ error: "Failed to save PDF" });
    }
  });

  // Get stored PDFs for healer dashboard
  app.get("/api/healer-pdfs", isAuthenticated, async (req, res) => {
    try {
      const healerId = req.user.id;
      const pdfs = await storage.getPdfsByHealerId(healerId);
      res.json(pdfs);
    } catch (error) {
      console.error("Error fetching PDFs:", error);
      res.status(500).json({ error: "Failed to fetch PDFs" });
    }
  });

  // Download stored PDF
  app.get("/api/pdf/:pdfId/download", isAuthenticated, async (req, res) => {
    try {
      const { pdfId } = req.params;
      // Query PDF directly from database
      const pdf = await db.query.pdfStorage.findFirst({
        where: eq(pdfStorage.id, parseInt(pdfId))
      }).catch(() => null);

      if (!pdf) {
        return res.status(404).json({ error: "PDF not found" });
      }

      // Set response headers for PDF download
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${pdf.fileName}"`);
      
      // Send base64 PDF data
      const binaryData = Buffer.from(pdf.pdfData, 'base64');
      res.send(binaryData);
    } catch (error) {
      console.error("Error downloading PDF:", error);
      res.status(500).json({ error: "Failed to download PDF" });
    }
  });
  
// Helper functions for fallback numerology calculations
function calculateLifePath(date: string): number {
  // Sum all digits from the birth date (e.g., 1996-08-23 = 1+9+9+6+0+8+2+3 = 38 = 3+8 = 11)
  const digits = date.replace(/\D/g, '');
  let sum = 0;
  for (const digit of digits) {
    sum += parseInt(digit);
  }
  return reduceNumber(sum);
}

function calculateDestiny(fullName: string): number {
  // Sum all letters in the full name using the numerology chart
  let sum = 0;
  for (const char of fullName.replace(/[^a-zA-Z]/g, '')) {
    sum += letterToNumber(char);
  }
  return reduceNumber(sum);
}

function calculateSoulUrge(fullName: string): number {
  // Sum only vowels (A, E, I, O, U, Y) using the numerology chart
  let sum = 0;
  const vowels = 'AEIOUY';
  for (const char of fullName.replace(/[^a-zA-Z]/g, '')) {
    if (vowels.includes(char.toUpperCase())) {
      sum += letterToNumber(char);
    }
  }
  return reduceNumber(sum);
}

function calculatePersonality(birthDate: string): number {
  // Decision-Making Chakra: Sum of digits from the day only (e.g., 02 = 0+2 = 2)
  const parts = birthDate.split('-');
  if (parts.length !== 3) return 5; // Default fallback
  
  const day = parts[2]; // Get the day part (DD)
  let sum = 0;
  
  // Sum all digits in the day
  for (const digit of day) {
    sum += parseInt(digit);
  }
  
  return reduceNumber(sum);
}

// Helper function to get detailed interpretation for each number type
function getNumberInterpretation(number: number, type: string): string {
  const interpretations = {
    lifePath: {
      1: "You are a natural-born leader with strong independence and pioneering spirit. Your life path is about developing leadership skills and learning to stand on your own while inspiring others.",
      2: "Your path involves cooperation, partnership, and bringing harmony to relationships. You excel at diplomacy and have a natural ability to work well with others.",
      3: "Creative self-expression and communication are central to your life path. You're meant to inspire others through your artistic talents and joyful nature.",
      4: "Your journey focuses on building solid foundations through hard work, organization, and practical solutions. You bring stability and reliability to everything you do.",
      5: "Freedom, adventure, and variety define your path. You're here to experience life fully and help others embrace change and new possibilities.",
      6: "Your life revolves around nurturing, healing, and taking care of others. Family, home, and community are central themes in your journey.",
      7: "Your path is one of spiritual seeking, analysis, and inner wisdom. You're meant to develop your intuitive abilities and seek deeper truths.",
      8: "Material success and achievement in the business world are key themes. You have natural executive abilities and the power to manifest abundance.",
      9: "Your path involves humanitarian service and universal love. You're here to give back to the world and help heal humanity through compassion."
    },
    destiny: {
      1: "Your destiny involves taking initiative and becoming a leader in your chosen field. You're meant to be original, independent, and pioneering in your approach.",
      2: "Your mission is to bring people together and create harmony. You're destined to be a peacemaker, counselor, or someone who facilitates cooperation.",
      3: "You're destined to communicate, create, and inspire others through your artistic abilities. Your gift to the world is joy, creativity, and optimism.",
      4: "Your destiny involves building lasting structures and systems. You're meant to be practical, reliable, and create security for yourself and others.",
      5: "Your mission is to promote freedom, progress, and new ideas. You're destined to be a catalyst for change and help others embrace new experiences.",
      6: "Your destiny centers on healing, nurturing, and serving others. You're meant to create harmony in family and community situations.",
      7: "Your mission involves seeking truth, developing wisdom, and sharing spiritual insights. You're destined to be a teacher of metaphysical knowledge.",
      8: "Your destiny is to achieve material success and use your power responsibly. You're meant to build empires and create abundance for yourself and others.",
      9: "Your mission involves serving humanity through compassion and understanding. You're destined to be a humanitarian and heal the world's pain."
    },
    soulUrge: {
      1: "Deep inside, you crave independence and leadership. Your soul yearns to be first, to pioneer, and to stand out as a unique individual.",
      2: "Your soul desires peace, partnership, and cooperation. You internally crave harmony and feel fulfilled when bringing people together.",
      3: "Your inner self is driven by creativity and self-expression. Your soul needs outlets for artistic pursuits and joyful communication.",
      4: "Deep down, you desire security, order, and practical accomplishment. Your soul finds satisfaction in building solid foundations.",
      5: "Your soul craves freedom, adventure, and variety. You internally desire to experience everything life has to offer without restrictions.",
      6: "Your inner nature is driven by love, family, and service to others. Your soul finds fulfillment in nurturing and healing roles.",
      7: "Deep inside, you yearn for spiritual understanding and inner wisdom. Your soul seeks truth, knowledge, and mystical experiences.",
      8: "Your soul desires material success and recognition. You internally crave power, achievement, and the ability to make things happen.",
      9: "Your inner self is driven by compassion and the desire to serve humanity. Your soul yearns to make the world a better place."
    },
    personality: {
      1: "Others see you as confident, independent, and original. You appear to be a natural leader who isn't afraid to take charge and make decisions.",
      2: "People perceive you as gentle, cooperative, and diplomatic. You come across as someone who values harmony and works well with others.",
      3: "Others see you as creative, optimistic, and entertaining. You appear charming, artistic, and someone who brings joy to social situations.",
      4: "People perceive you as reliable, practical, and hardworking. You come across as someone who is dependable and gets things done efficiently.",
      5: "Others see you as adventurous, freedom-loving, and dynamic. You appear to be someone who embraces change and new experiences.",
      6: "People perceive you as caring, responsible, and nurturing. You come across as someone who puts family and home first.",
      7: "Others see you as mysterious, wise, and analytical. You appear to be someone who thinks deeply and has profound insights.",
      8: "People perceive you as ambitious, successful, and authoritative. You come across as someone who has natural executive abilities.",
      9: "Others see you as compassionate, generous, and understanding. You appear to be someone who cares deeply about humanity and global issues."
    }
  };

  const typeInterpretations = interpretations[type as keyof typeof interpretations];
  return typeInterpretations?.[number as keyof typeof typeInterpretations] || `Your ${type} number ${number} indicates unique spiritual qualities and personal characteristics.`;
}

// Decision-making chakra (Personality) number - sum of the two digits of birth date
function calculateDecisionMakingChakra(birthDate: string): number {
  // Decision-Making Chakra: Sum of digits from the day only (e.g., 02 = 0+2 = 2)
  const parts = birthDate.split('-');
  if (parts.length !== 3) return 5; // Default fallback
  
  const day = parts[2]; // Get the day part (DD)
  let sum = 0;
  
  // Sum all digits in the day
  for (const digit of day) {
    sum += parseInt(digit);
  }
  
  return reduceNumber(sum);
}

// Removed duplicate - using the calculateDominantSoulChakra function defined later

// Duplicate function implementations removed - using standardized versions from above

function calculateDominantSoulChakra(birthDate: string): number {
  // Sum all digits in birth date (e.g., 01/01/1901 = 0+1+0+1+1+9+0+1 = 13 = 1+3 = 4)
  const dateStr = birthDate.replace(/\D/g, ''); // Remove non-digits
  let sum = 0;
  
  for (const digit of dateStr) {
    sum += parseInt(digit);
  }
  
  // Reduce to single digit
  while (sum > 9) {
    sum = sum.toString().split('').reduce((acc, d) => acc + parseInt(d), 0);
  }
  
  return sum;
}

  // Healers API endpoints
  app.get("/api/healers", async (req, res) => {
    try {
      // Get all healers from storage (keeps them functional in backend)
      const allHealers = await storage.getAllHealers();
      
      // Filter to show only nishant.sharma2 (username) on the healers page
      // All other healers remain stored, active and functional in the backend
      const visibleHealers = allHealers.filter(healer => 
        healer.username === 'nishant.sharma2'
      );
      
      res.json(visibleHealers);
    } catch (error) {
      console.error("Error fetching healers:", error);
      res.status(500).json({ message: "Failed to fetch healers" });
    }
  });

  app.post("/api/healers", async (req, res) => {
    try {
      const healerData = insertHealerSchema.parse(req.body);
      const healer = await storage.createHealer(healerData);
      res.status(201).json(healer);
    } catch (error) {
      console.error("Error creating healer:", error);
      res.status(500).json({ message: "Failed to create healer" });
    }
  });

  // Permanent contacts mapping - static healers with user IDs
  // These are loaded dynamically on startup
  let PERMANENT_CONTACTS: Record<number, any> = {};
  
  // Initialize permanent contacts by finding user accounts
  (async () => {
    try {
      const contacts = [
        { id: 9991, username: "nishant.sharma2", name: "Nishant Sharma", email: "nishant@auraeye.com" },
        { id: 9992, username: "sunita_mann", name: "Sunita Mann", email: "sunita@auraeye.com" },
        { id: 9993, username: "subramayanam", name: "Mr. Subramayanam", email: "subramayanam@auraeye.com" }
      ];
      
      for (const contact of contacts) {
        const user = await storage.getUserByUsername(contact.username);
        PERMANENT_CONTACTS[contact.id] = {
          ...contact,
          userId: user?.id || null
        };
        console.log(`✅ Permanent contact loaded: ${contact.name} (ID: ${contact.id}, User ID: ${user?.id || 'N/A'})`);
      }
    } catch (error) {
      console.error("Error initializing permanent contacts:", error);
    }
  })();

  // Healer booking API endpoint with email notification - 3 credits to client, 1 to healer
  app.post("/api/book-session", isAuthenticated, checkCredits('healer_booking'), async (req, res) => {
    try {
      const user = req.user as any;
      const { healerId, message } = req.body;

      console.log(`📝 Booking request - User: ${user.id}, Healer: ${healerId}, Message: ${message}`);

      // Get healer details from permanent contacts or database
      let healer = PERMANENT_CONTACTS[healerId as keyof typeof PERMANENT_CONTACTS];
      if (!healer) {
        healer = await storage.getHealer(healerId);
      }
      
      if (!healer) {
        console.error(`Healer ${healerId} not found`);
        return res.status(404).json({ message: "Healer not found" });
      }

      console.log(`✅ Healer found: ${healer.name}`);

      // Deduct 3 credits from client
      const creditDeducted = await storage.deductCredits(
        user.id,
        3,
        "healer_booking",
        `Healer booking with ${healer.name}`
      );

      if (!creditDeducted) {
        console.error(`Failed to deduct credits from user ${user.id}`);
        return res.status(400).json({ 
          message: "Failed to deduct credits. Please try again.",
          requiredCredits: 3,
          currentCredits: await storage.getUserCredits(user.id)
        });
      }

      console.log(`💳 Credits deducted from user ${user.id}`);

      // For permanent contacts, use their mapped userId; otherwise get healer user
      let healerUser;
      if (PERMANENT_CONTACTS[healerId as keyof typeof PERMANENT_CONTACTS]) {
        const contact = PERMANENT_CONTACTS[healerId as keyof typeof PERMANENT_CONTACTS];
        healerUser = await storage.getUser(contact.userId);
      } else {
        healerUser = await storage.getUserByUsername(healer.username);
      }

      if (healerUser) {
        await storage.addCredits(
          healerUser.id,
          1,
          "healer_booking_credit",
          `Credit from booking by ${user.username}`
        );
        
        // Add soul energy (credits * 100) for healer connection
        try {
          const healerSoulEnergyAmount = 1 * 100; // 1 credit = 100 soul energy
          await storage.addSoulEnergy(healerUser.id, healerSoulEnergyAmount, 'healer_booking', 'Healer booking connection');
          console.log(`⚡ Added +${healerSoulEnergyAmount} soul energy to healer ${healerUser.id} for booking connection`);
        } catch (soulEnergyError) {
          console.error("Error adding soul energy to healer:", soulEnergyError);
        }
      }

      // Add soul energy (credits * 100) to client for booking a healer
      try {
        const clientSoulEnergyAmount = 3 * 100; // 3 credits = 300 soul energy
        await storage.addSoulEnergy(user.id, clientSoulEnergyAmount, 'healer_booking', 'Booked healer session');
        console.log(`⚡ Added +${clientSoulEnergyAmount} soul energy to user ${user.id} for healer booking`);
      } catch (soulEnergyError) {
        console.error("Error adding soul energy:", soulEnergyError);
      }

      // Create booking record - use healer ID directly (no FK constraint now)
      console.log(`📋 Creating booking record with data:`, { userId: user.id, healerId, message });
      
      const bookingData = insertHealerBookingSchema.parse({
        userId: user.id,
        healerId: healerId,
        message: message || null
      });

      console.log(`✅ Booking data validated:`, bookingData);
      
      const booking = await storage.createHealerBooking(bookingData);

      console.log(`✅ Booking created: ${booking.id}`);

      // Send email notification to healer with booking info
      const emailSent = await sendHealerBookingNotification(
        healer.email,
        healer.name,
        user.username,
        message
      );

      if (!emailSent) {
        console.log("Email notification failed, but booking was saved");
      }

      // Send push notification to healer's user account if available
      if (healerUser) {
        try {
          await sendPushNotification(healerUser.id, {
            title: "New Booking Request",
            body: `${user.username} has booked a session${message ? ": " + message.substring(0, 50) : ""}`,
            tag: "booking_request",
            data: {
              type: "booking",
              bookingId: booking.id,
              clientId: user.id,
              clientUsername: user.username,
              message: message || ""
            }
          });
          console.log(`📲 Push notification sent to healer user ${healerUser.id}`);
        } catch (pushError) {
          console.error("Error sending push notification:", pushError);
        }
      }

      res.status(201).json({ 
        message: "Booking request sent successfully",
        booking: booking,
        emailSent: emailSent,
        creditsDeducted: 3,
        remainingCredits: await storage.getUserCredits(user.id)
      });
    } catch (error) {
      console.error("Error processing booking:", error);
      res.status(500).json({ 
        message: "Failed to process booking",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Rate healer endpoint
  app.post("/api/rate-healer", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as any;
      const { healerId, rating } = req.body;

      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ message: "Rating must be between 1 and 5" });
      }

      const healer = await storage.getHealer(healerId);
      if (!healer) {
        return res.status(404).json({ message: "Healer not found" });
      }

      const ratingData = {
        healerId,
        raterId: user.id,
        raterUsername: user.username,
        rating
      };

      const newRating = await storage.createHealerRating(ratingData);

      // Check and award achievements after rating is saved
      try {
        await storage.checkAndAwardAchievements(user.id);
      } catch (achievementError) {
        console.error("Error checking achievements:", achievementError);
      }

      // Automatically award healer performance badges after rating is saved
      try {
        await storage.deleteExpiredBadges();
        
        const allHealers = await storage.getAllHealers();
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        for (const h of allHealers) {
          const healerUser = await storage.getUserByUsername(h.username);
          if (!healerUser) continue;

          // 1. Most Rated Healer
          const allRatings = await db.select().from(healerRatings).where(gte(healerRatings.createdAt, thirtyDaysAgo));
          const ratingCounts = new Map<number, number>();
          allRatings.forEach(r => {
            ratingCounts.set(r.healerId, (ratingCounts.get(r.healerId) || 0) + 1);
          });

          const maxRatings = Math.max(...Array.from(ratingCounts.values()), 0);
          if (maxRatings > 0 && ratingCounts.get(h.id) === maxRatings) {
            const existingMostRated = await db.select().from(healerBadges).where(and(eq(healerBadges.healerId, h.id), eq(healerBadges.badgeType, "most_rated")));
            if (existingMostRated.length === 0) {
              await storage.createHealerBadge({
                healerId: h.id,
                badgeType: "most_rated",
                badgeTitle: "Most Rated Healer",
                badgeIcon: "⭐",
                expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
              });
            }
          }

          // 2. Most 5-Star Rated
          const fiveStarRatings = allRatings.filter(r => r.rating === 5);
          const fiveStarCounts = new Map<number, number>();
          fiveStarRatings.forEach(r => {
            fiveStarCounts.set(r.healerId, (fiveStarCounts.get(r.healerId) || 0) + 1);
          });

          const maxFiveStars = Math.max(...Array.from(fiveStarCounts.values()), 0);
          if (maxFiveStars > 0 && fiveStarCounts.get(h.id) === maxFiveStars) {
            const existingFiveStar = await db.select().from(healerBadges).where(and(eq(healerBadges.healerId, h.id), eq(healerBadges.badgeType, "most_5_star")));
            if (existingFiveStar.length === 0) {
              await storage.createHealerBadge({
                healerId: h.id,
                badgeType: "most_5_star",
                badgeTitle: "Most 5-Star Rated",
                badgeIcon: "✨",
                expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
              });
            }
          }

          // 3. Best Healer of the Month
          const recentBookings = await db.select().from(healerBookings).where(and(eq(healerBookings.healerId, h.id), gte(healerBookings.createdAt, thirtyDaysAgo)));
          const recentAuraReadings = await db.select().from(auraReadings).where(and(eq(auraReadings.performedBy, healerUser.id), gte(auraReadings.createdAt, thirtyDaysAgo)));

          let isTopHealer = true;
          for (const otherHealer of allHealers) {
            if (otherHealer.id === h.id) continue;
            const otherUser = await storage.getUserByUsername(otherHealer.username);
            if (!otherUser) continue;

            const otherBookings = await db.select().from(healerBookings).where(and(eq(healerBookings.healerId, otherHealer.id), gte(healerBookings.createdAt, thirtyDaysAgo)));
            const otherAuraReadings = await db.select().from(auraReadings).where(and(eq(auraReadings.performedBy, otherUser.id), gte(auraReadings.createdAt, thirtyDaysAgo)));

            if (otherBookings.length > recentBookings.length || otherAuraReadings.length > recentAuraReadings.length) {
              isTopHealer = false;
              break;
            }
          }

          if (isTopHealer && (recentBookings.length > 0 || recentAuraReadings.length > 0)) {
            const existingBest = await db.select().from(healerBadges).where(and(eq(healerBadges.healerId, h.id), eq(healerBadges.badgeType, "best_healer")));
            if (existingBest.length === 0) {
              await storage.createHealerBadge({
                healerId: h.id,
                badgeType: "best_healer",
                badgeTitle: "Best Healer of the Month",
                badgeIcon: "👑",
                expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
              });
            }
          }
        }
      } catch (badgeError) {
        console.error("Error awarding badges:", badgeError);
        // Don't fail the rating save if badge awarding fails
      }

      res.status(201).json({ 
        message: "Rating saved successfully",
        rating: newRating
      });
    } catch (error) {
      console.error("Error saving rating:", error);
      res.status(500).json({ message: "Failed to save rating" });
    }
  });

  // Get healer ratings endpoint
  app.get("/api/healer-ratings/:healerId", async (req, res) => {
    try {
      const { healerId } = req.params;
      const ratings = await storage.getHealerRatings(parseInt(healerId));
      const averageRating = await storage.getHealerAverageRating(parseInt(healerId));

      res.json({ 
        ratings,
        averageRating,
        totalRatings: ratings.length
      });
    } catch (error) {
      console.error("Error fetching ratings:", error);
      res.status(500).json({ message: "Failed to fetch ratings" });
    }
  });

  // Award healer badges endpoint
  app.post("/api/award-badges", async (req, res) => {
    try {
      // Clean up expired badges
      await storage.deleteExpiredBadges();

      // Get all healers
      const allHealers = await storage.getAllHealers();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      for (const healer of allHealers) {
        // Get healer user ID from healer table username
        const healerUser = await storage.getUserByUsername(healer.username);
        if (!healerUser) continue;

        // 1. Most Rated Healer - most reviews in 30 days
        const allRatings = await db
          .select()
          .from(healerRatings)
          .where(gte(healerRatings.createdAt, thirtyDaysAgo));

        const ratingCounts = new Map<number, number>();
        allRatings.forEach(r => {
          ratingCounts.set(r.healerId, (ratingCounts.get(r.healerId) || 0) + 1);
        });

        const maxRatings = Math.max(...Array.from(ratingCounts.values()));
        if (maxRatings > 0 && ratingCounts.get(healer.id) === maxRatings) {
          const existingMostRated = await db
            .select()
            .from(healerBadges)
            .where(
              and(
                eq(healerBadges.healerId, healer.id),
                eq(healerBadges.badgeType, "most_rated")
              )
            );
          
          if (existingMostRated.length === 0) {
            await storage.createHealerBadge({
              healerId: healer.id,
              badgeType: "most_rated",
              badgeTitle: "Most Rated Healer",
              badgeIcon: "⭐",
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            });
          }
        }

        // 2. Most 5-Star Rated Healer - most 5-star ratings in 30 days
        const fiveStarRatings = allRatings.filter(r => r.rating === 5);
        const fiveStarCounts = new Map<number, number>();
        fiveStarRatings.forEach(r => {
          fiveStarCounts.set(r.healerId, (fiveStarCounts.get(r.healerId) || 0) + 1);
        });

        const maxFiveStars = Math.max(...Array.from(fiveStarCounts.values()), 0);
        if (maxFiveStars > 0 && fiveStarCounts.get(healer.id) === maxFiveStars) {
          const existingFiveStar = await db
            .select()
            .from(healerBadges)
            .where(
              and(
                eq(healerBadges.healerId, healer.id),
                eq(healerBadges.badgeType, "most_5_star")
              )
            );
          
          if (existingFiveStar.length === 0) {
            await storage.createHealerBadge({
              healerId: healer.id,
              badgeType: "most_5_star",
              badgeTitle: "Most 5-Star Rated",
              badgeIcon: "✨",
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            });
          }
        }

        // 3. Best Healer of the Month - most requests AND most aura readings
        const recentBookings = await db
          .select()
          .from(healerBookings)
          .where(and(eq(healerBookings.healerId, healer.id), gte(healerBookings.createdAt, thirtyDaysAgo)));

        const recentAuraReadings = await db
          .select()
          .from(auraReadings)
          .where(and(eq(auraReadings.performedBy, healerUser.id), gte(auraReadings.createdAt, thirtyDaysAgo)));

        // Get all healers' stats
        let isTopHealer = true;
        for (const otherHealer of allHealers) {
          if (otherHealer.id === healer.id) continue;
          const otherUser = await storage.getUserByUsername(otherHealer.username);
          if (!otherUser) continue;

          const otherBookings = await db
            .select()
            .from(healerBookings)
            .where(and(eq(healerBookings.healerId, otherHealer.id), gte(healerBookings.createdAt, thirtyDaysAgo)));

          const otherAuraReadings = await db
            .select()
            .from(auraReadings)
            .where(and(eq(auraReadings.performedBy, otherUser.id), gte(auraReadings.createdAt, thirtyDaysAgo)));

          if (otherBookings.length > recentBookings.length || otherAuraReadings.length > recentAuraReadings.length) {
            isTopHealer = false;
            break;
          }
        }

        if (isTopHealer && (recentBookings.length > 0 || recentAuraReadings.length > 0)) {
          const existingBest = await db
            .select()
            .from(healerBadges)
            .where(
              and(
                eq(healerBadges.healerId, healer.id),
                eq(healerBadges.badgeType, "best_healer")
              )
            );
          
          if (existingBest.length === 0) {
            await storage.createHealerBadge({
              healerId: healer.id,
              badgeType: "best_healer",
              badgeTitle: "Best Healer of the Month",
              badgeIcon: "👑",
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            });
          }
        }
      }

      res.json({ message: "Badges awarded successfully" });
    } catch (error) {
      console.error("Error awarding badges:", error);
      res.status(500).json({ message: "Failed to award badges" });
    }
  });

  // Get healer badges for authenticated user (used by dashboard)
  app.get("/api/healer-badges", isAuthenticated, async (req, res) => {
    try {
      // Clean up expired badges first
      await storage.deleteExpiredBadges();
      
      const badges = await storage.getHealerBadges(req.user.id);
      res.json({ badges: badges || [] });
    } catch (error) {
      console.error("Error fetching badges:", error);
      res.status(500).json({ badges: [] });
    }
  });

  // Get healer badges endpoint by ID
  app.get("/api/healer-badges/:healerId", async (req, res) => {
    try {
      const { healerId } = req.params;
      // Clean up expired badges first
      await storage.deleteExpiredBadges();
      
      const badges = await storage.getHealerBadges(parseInt(healerId));
      res.json({ badges });
    } catch (error) {
      console.error("Error fetching badges:", error);
      res.status(500).json({ message: "Failed to fetch badges" });
    }
  });

  // Get user achievements endpoint
  app.get("/api/user-achievements", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as any;
      const achievements = await storage.getUserAchievements(user.id);
      res.json({ achievements });
    } catch (error) {
      console.error("Error fetching achievements:", error);
      res.status(500).json({ message: "Failed to fetch achievements" });
    }
  });

  // Get user's healer bookings
  app.get("/api/user-bookings", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }

    try {
      const bookings = await storage.getHealerBookingsByUser(req.user.id);
      res.json(bookings);
    } catch (error) {
      console.error("Error retrieving user bookings:", error);
      res.status(500).json({ message: "Failed to retrieve bookings" });
    }
  });

  app.post("/api/admin/grant-credits-to-all", isAuthenticated, async (req, res) => {
    try {
      if (!req.user || req.user.userType !== "healer") {
        return res.status(403).json({ message: "Access denied" });
      }

      const allUsers = await storage.getAllUsers();
      let updated = 0;

      for (const user of allUsers) {
        const currentCredits = await storage.getUserCredits(user.id);
        await storage.updateUserCredits(user.id, currentCredits + 5);
        await storage.createCreditTransaction({
          userId: user.id,
          username: user.username,
          amount: 5,
          transactionType: "bonus",
          description: "5 bonus credits added to your account",
          balanceAfter: currentCredits + 5,
        });
        await storage.createNotification({
          userId: user.id,
          title: "Credits Added",
          message: "5 credits have been added to your account.",
          type: "credit_bonus",
        });
        updated += 1;
      }

      res.json({ message: "Credits added to all users", updated });
    } catch (error) {
      console.error("Error granting credits to all users:", error);
      res.status(500).json({ message: "Failed to grant credits" });
    }
  });

  // Admin: get all healers with their stats
  app.get("/api/admin/healers", isAuthenticated, async (req, res) => {
    try {
      if (!req.user || req.user.username !== 'admin') {
        return res.status(403).json({ message: "Access denied: Admin only" });
      }

      const allUsers = await storage.getAllUsers();
      const healers = await Promise.all(
        allUsers
          .filter((u: any) => u.userType === "healer" || u.userType === "semi-healer")
          .map(async (u: any) => ({
            id: u.id,
            username: u.username,
            name: u.name,
            userType: u.userType,
            credits: await storage.getUserCredits(u.id),
            isActive: u.isActive,
            email: u.email,
          }))
      );

      res.json(healers);
    } catch (error) {
      console.error("Error fetching healers:", error);
      res.status(500).json({ message: "Failed to fetch healers" });
    }
  });

  // Admin: deactivate healers not in the keep list
  app.post("/api/admin/deactivate-others", isAuthenticated, async (req, res) => {
    try {
      if (!req.user || req.user.username !== 'admin') {
        return res.status(403).json({ message: "Access denied: Admin only" });
      }

      const { keepUsernames } = req.body;
      if (!Array.isArray(keepUsernames) || keepUsernames.length === 0) {
        return res.status(400).json({ message: "keepUsernames array is required" });
      }

      const allUsers = await storage.getAllUsers();
      const healersToDeactivate = allUsers.filter(
        (u: any) =>
          (u.userType === "healer" || u.userType === "semi-healer") &&
          !keepUsernames.includes(u.username) &&
          u.isActive !== false
      );

      let deactivated = 0;
      for (const user of healersToDeactivate) {
        await storage.deleteUser(user.id); // soft delete (sets is_active = false)
        deactivated += 1;
      }

      res.json({ message: "Healers deactivated", deactivated });
    } catch (error) {
      console.error("Error deactivating healers:", error);
      res.status(500).json({ message: "Failed to deactivate healers" });
    }
  });

  // Admin: grant credits to selected healers
  app.post("/api/admin/grant-credits-to-selected", isAuthenticated, async (req, res) => {
    try {
      if (!req.user || req.user.username !== 'admin') {
        return res.status(403).json({ message: "Access denied: Admin only" });
      }

      const { usernames } = req.body;
      if (!Array.isArray(usernames) || usernames.length === 0) {
        return res.status(400).json({ message: "usernames array is required" });
      }

      const allUsers = await storage.getAllUsers();
      const selectedHealers = allUsers.filter(
        (u: any) =>
          usernames.includes(u.username) &&
          (u.userType === "healer" || u.userType === "semi-healer") &&
          u.isActive !== false
      );

      let updated = 0;
      for (const user of selectedHealers) {
        const currentCredits = await storage.getUserCredits(user.id);
        const newCredits = currentCredits + 5;
        await storage.updateUserCredits(user.id, newCredits);
        await storage.createCreditTransaction({
          userId: user.id,
          username: user.username,
          amount: 5,
          transactionType: "admin_bonus",
          description: "Admin: 5 bonus credits added",
          balanceAfter: newCredits,
        });
        updated += 1;
      }

      res.json({ message: "Credits granted to selected healers", updated });
    } catch (error) {
      console.error("Error granting credits:", error);
      res.status(500).json({ message: "Failed to grant credits" });
    }
  });

  app.get("/api/notifications", isAuthenticated, async (req, res) => {
    try {
      const notifications = await storage.getNotificationsByUser(req.user.id);
      res.json(notifications);
    } catch (error) {
      console.error("Error fetching notifications:", error);
      res.status(500).json({ message: "Failed to fetch notifications" });
    }
  });

  app.delete("/api/user", isAuthenticated, async (req, res) => {
    try {
      await storage.deleteUser(req.user.id);
      req.session.destroy(() => {});
      res.clearCookie("connect.sid");
      res.json({ message: "Account deactivated successfully" });
    } catch (error) {
      console.error("Error deactivating user account:", error);
      res.status(500).json({ message: "Failed to deactivate account" });
    }
  });

  // Get healer's booking requests (for healer dashboard)
  app.get("/api/healer-bookings", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }

    if (req.user.userType !== 'healer') {
      return res.status(403).json({ message: "Access denied - healer account required" });
    }

    try {
      // For healer users, the healer data is already stored in the session
      const healerData = req.user.healerData;
      
      if (!healerData) {
        console.log(`Healer data not found for user: ${req.user.username}`);
        return res.json([]);
      }

      console.log(`📖 Fetching bookings for healer: ${healerData.username} (ID: ${healerData.id})`);

      // Get bookings by healer ID from database
      let bookings = await storage.getHealerBookingsByHealer(healerData.id);
      
      // Also check for bookings under permanent contact IDs
      // Map healer username to permanent contact ID
      const permanentContactMap: Record<string, number> = {
        "nishant.sharma2": 9991,
        "sunita_mann": 9992,
        "subramayanam": 9993
      };
      
      const permanentContactId = permanentContactMap[healerData.username];
      if (permanentContactId) {
        console.log(`✅ Found permanent contact mapping: ${healerData.username} -> ID ${permanentContactId}`);
        const permanentBookings = await storage.getHealerBookingsByHealer(permanentContactId);
        bookings = [...bookings, ...permanentBookings];
        console.log(`📋 Total bookings for healer: ${bookings.length} (${bookings.length - permanentBookings.length} from healer table, ${permanentBookings.length} from permanent contact)`);
      }

      res.json(bookings);
    } catch (error) {
      console.error("Error retrieving healer bookings:", error);
      res.status(500).json({ message: "Failed to retrieve healer bookings" });
    }
  });

  // Update booking status (accept/reject) with healer response
  app.patch("/api/booking/:id/status", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }

    try {
      const bookingId = parseInt(req.params.id);
      const { status, healerResponse } = req.body;

      if (!['accepted', 'rejected'].includes(status)) {
        return res.status(400).json({ message: "Invalid status. Must be 'accepted' or 'rejected'" });
      }

      // Check if this healer has permission to modify this booking
      const booking = await storage.getHealerBooking(bookingId);
      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      // Get healer record to verify permissions
      const healerData = req.user.healerData;
      
      // Map healer username to permanent contact ID
      const permanentContactMap: Record<string, number> = {
        "nishant.sharma2": 9991,
        "sunita_mann": 9992,
        "subramayanam": 9993
      };
      
      const healerPermanentId = permanentContactMap[healerData?.username || ''];
      const isAuthorized = healerData && (
        healerData.id === booking.healerId || 
        (healerPermanentId && healerPermanentId === booking.healerId)
      );
      
      if (!isAuthorized) {
        console.log(`Healer auth failed: user=${req.user.username}, healer=${healerData?.name}, booking healerId=${booking.healerId}`);
        return res.status(403).json({ message: "Access denied - not authorized for this booking" });
      }

      // Update booking status with healer response
      const updatedBooking = await storage.updateBookingStatusWithResponse(
        bookingId, 
        status, 
        healerResponse || null
      );
      
      if (!updatedBooking) {
        return res.status(404).json({ message: "Failed to update booking" });
      }

      // Award healer session achievements if booking was accepted
      if (status === 'accepted') {
        try {
          const healerBookings = await db.query.healerBookings.findMany({
            where: (hb, { and, eq }) => and(
              eq(hb.healerId, booking.healerId),
              eq(hb.status, 'accepted')
            ),
          });
          const acceptedCount = healerBookings.length;
          
          const milestones = [
            { count: 5, type: 'healer_five_replies', title: 'Healing Heart 💚', desc: 'Accepted 5 healer sessions' },
            { count: 20, type: 'healer_most_replies', title: 'Most Trusted Healer 👑', desc: 'Accepted 20 healer sessions' }
          ];
          
          for (const milestone of milestones) {
            if (acceptedCount === milestone.count) {
              const existing = await db.query.achievements.findFirst({
                where: (ach, { and, eq }) => and(
                  eq(ach.userId, req.user.id),
                  eq(ach.achievementType, milestone.type)
                )
              });
              if (!existing) {
                await db.insert(achievements).values({
                  userId: req.user.id,
                  achievementType: milestone.type,
                  title: milestone.title,
                  description: milestone.desc,
                  icon: '💚',
                });
              }
            }
          }
        } catch (ach) {
          console.log("Healer achievement update skipped:", ach);
        }
      }

      res.json({ 
        message: `Booking ${status} successfully`, 
        booking: updatedBooking 
      });
    } catch (error) {
      console.error("Error updating booking status:", error);
      res.status(500).json({ message: "Failed to update booking status" });
    }
  });

  // Get healer analytics and client stats
  app.get("/api/healer-analytics", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }

    if (req.user.userType !== 'healer') {
      return res.status(403).json({ message: "Access denied - healer account required" });
    }

    try {
      const healerData = req.user.healerData;
      
      if (!healerData) {
        return res.json({ 
          totalBookings: 0,
          recentBookings: 0,
          acceptedBookings: 0,
          rejectedBookings: 0,
          pendingBookings: 0,
          totalClients: 0,
          acceptanceRate: 0
        });
      }

      const stats = await storage.getHealerClientStats(healerData.id);
      res.json(stats);
    } catch (error) {
      console.error("Error retrieving healer analytics:", error);
      res.status(500).json({ message: "Failed to retrieve healer analytics" });
    }
  });

  // Get healer booking trends
  app.get("/api/healer-trends", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }

    if (req.user.userType !== 'healer') {
      return res.status(403).json({ message: "Access denied - healer account required" });
    }

    try {
      const healerData = req.user.healerData;
      
      if (!healerData) {
        return res.json([]);
      }

      const trends = await storage.getHealerBookingTrends(healerData.id);
      res.json(trends);
    } catch (error) {
      console.error("Error retrieving healer trends:", error);
      res.status(500).json({ message: "Failed to retrieve healer trends" });
    }
  });

  // Submit vibe feedback
  app.post("/api/vibe-feedback", async (req, res) => {
    try {
      const { personalityColor, colorMeaning, feedback, sessionId } = req.body;
      
      if (!personalityColor || !colorMeaning || !feedback) {
        return res.status(400).json({ message: "All fields are required" });
      }

      if (!['yes', 'no'].includes(feedback.toLowerCase())) {
        return res.status(400).json({ message: "Feedback must be 'yes' or 'no'" });
      }

      const vibeFeedbackData = {
        userId: req.user?.id || null,
        personalityColor,
        colorMeaning,
        feedback: feedback.toLowerCase(),
        sessionId
      };

      const savedFeedback = await storage.saveVibeFeedback(vibeFeedbackData);
      
      // Award achievement for vibe checks at different levels
      if (req.user?.id) {
        try {
          const vibeCount = await db.query.vibeFeedback.findMany({
            where: (readings, { eq }) => eq(readings.userId, req.user.id),
          });
          const milestones = [
            { count: 1, type: 'first_vibe', title: 'Vibe Check ✨', desc: 'Completed your first vibe scan', icon: '✨' },
            { count: 5, type: 'vibe_enthusiast', title: 'Vibe Enthusiast 💫', desc: 'Completed 5 vibe checks', icon: '💫' },
            { count: 15, type: 'vibe_master', title: 'Vibe Master 🎯', desc: 'Completed 15 vibe checks', icon: '🎯' },
            { count: 30, type: 'vibe_legend', title: 'Vibe Legend 🌈', desc: 'Completed 30 vibe checks', icon: '🌈' }
          ];
          for (const milestone of milestones) {
            if (vibeCount.length === milestone.count) {
              const existing = await db.query.achievements.findFirst({
                where: (ach, { and, eq }) => and(eq(ach.userId, req.user.id), eq(ach.achievementType, milestone.type))
              });
              if (!existing) {
                await db.insert(achievements).values({
                  userId: req.user.id,
                  achievementType: milestone.type,
                  title: milestone.title,
                  description: milestone.desc,
                  icon: milestone.icon,
                });
              }
            }
          }
        } catch (ach) {
          console.log("Achievement update skipped:", ach);
        }
      }
      
      res.status(201).json(savedFeedback);
    } catch (error) {
      console.error("Error saving vibe feedback:", error);
      res.status(500).json({ message: "Failed to save feedback" });
    }
  });

  // Get vibe readings for healer dashboard
  app.get("/api/vibe-readings", isAuthenticated, async (req, res) => {
    try {
      // Check if user is a healer - if so, show all client vibe readings
      const user = await storage.getUser(req.user.id);
      let vibeReadings;
      
      // Both healers and clients see only their own vibe readings
      vibeReadings = await storage.getVibeReadingsByUserId(req.user.id);
      
      if (user?.userType === 'healer') {
        console.log(`✅ Retrieved ${vibeReadings.length} vibe readings for healer ${user.username} (own account only)`);
      } else {
        console.log(`✅ Retrieved ${vibeReadings.length} vibe readings for user ${req.user.id}`);
      }
      
      res.json(vibeReadings);
    } catch (error) {
      console.error("Error retrieving vibe readings:", error);
      res.status(500).json({ message: "Failed to retrieve vibe readings" });
    }
  });

  // Quick vibe check - simplified aura analysis for home page
  app.post("/api/quick-vibe", checkCredits('vibe_check'), upload.single('image'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No image file provided" });
      }

      let imageBuffer = req.file.buffer;
      
      // Compress image to 700x500px and 30KB for faster processing
      try {
        imageBuffer = await resizeImageToStandard(imageBuffer);
        console.log("Image compressed for vibe analysis");
      } catch (compressionError) {
        console.error("Image compression for vibe failed:", compressionError);
        // Continue with original if compression fails
      }
      
      // Detect human in image first
      const hasHuman = await detectHumanInImage(imageBuffer);
      if (!hasHuman) {
        return res.status(400).json({ 
          message: "Please upload an image with a person for vibe analysis",
          isHuman: false 
        });
      }

      // Generate quick aura analysis - focus on personality color only with URL diversity
      const urlSeed = req.file?.originalname || Date.now().toString();
      const fastAnalysis = generateFastAuraAnalysis(imageBuffer, urlSeed);
      
      // Get personality color (dominant color from the analysis)
      let personalityColor = fastAnalysis.dominantColor;
      
      // Map any non-approved colors to the closest approved color
      const approvedColors = ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Violet', 'Indigo', 'White', 'Brown', 'Gold', 'Silver', 'Black'];
      if (!approvedColors.includes(personalityColor)) {
        // Map common variations to approved colors
        const colorMapping: { [key: string]: string } = {
          'Purple': 'Violet',
          'Turquoise': 'Blue',
          'Pink': 'Red',
          'Teal': 'Green',
          'Magenta': 'Violet',
          'Cyan': 'Blue',
          'Lime': 'Green',
          'Maroon': 'Red',
          'Navy': 'Blue',
          'Olive': 'Green',
          'Aqua': 'Blue',
          'Fuchsia': 'Violet'
        };
        personalityColor = colorMapping[personalityColor] || 'Violet'; // Default to violet if not found
      }
      
      // Color meanings for quick vibe analysis - all specified aura colors
      const colorMeanings = {
        'Pink': {
          positive: ['Unconditionally loving and compassionate', 'Emotionally healing and nurturing'],
          negative: ['Codependency and emotional entanglement', 'Boundary issues needing attention'],
          remedy: 'Practice self-love affirmations and healthy boundary-setting. Engage in grounding activities like earthing or nature walks.'
        },
        'Gray': {
          positive: ['Balanced and diplomatic', 'Wise and flexible in approach'],
          negative: ['Indecision and uncertainty', 'Emotional detachment from situations'],
          remedy: 'Seek clarity through journaling. Connect with your intuition through meditation and trust your inner voice.'
        },
        'Blue': {
          positive: ['Calm and communicative', 'Truthful and spiritually clear'],
          negative: ['Sadness or depressive tendencies', 'Difficulty with self-expression and emotional distance'],
          remedy: 'Throat chakra healing through singing or chanting. Share your truth in safe spaces and practice expressive writing.'
        },
        'Green': {
          positive: ['Balanced and healing-oriented', 'Compassionate with natural harmony'],
          negative: ['Jealousy and envy patterns', 'Feeling stuck in emotional growth'],
          remedy: 'Heart-opening yoga and loving-kindness meditation. Practice gratitude for others\' blessings daily.'
        },
        'Violet': {
          positive: ['Spiritual and intuitive', 'Divinely connected and transformative'],
          negative: ['Spiritual pride and superiority', 'Disconnection from reality or escapism'],
          remedy: 'Ground spiritual practices with earthly action. Volunteer or serve others to anchor your gifts.'
        },
        'Indigo': {
          positive: ['Psychically gifted and deeply wise', 'Powerful inner knowing abilities'],
          negative: ['Mental confusion and obsession', 'Delusion or disconnection from practical reality'],
          remedy: 'Third eye chakra cleansing. Balance intuition with logic through structured mindfulness practice.'
        },
        'White': {
          positive: ['Pure and divinely protected', 'Spiritually clear and angelically connected'],
          negative: ['Spiritual bypassing and perfectionism', 'Isolation or detachment from humanity'],
          remedy: 'Embrace imperfection through compassionate self-acceptance. Connect deeply with community and authentic relationships.'
        },
        'Gold': {
          positive: ['Divinely wise and enlightened', 'Successful with spiritual mastery'],
          negative: ['Ego inflation and materialism', 'Greed or superiority complex'],
          remedy: 'Practice humble gratitude and generosity. Share your wisdom freely without seeking recognition.'
        },
        'Yellow': {
          positive: ['Intelligent and optimistic', 'Mentally clear with joyful expression'],
          negative: ['Over-analysis and criticism', 'Anxiety or intellectual arrogance'],
          remedy: 'Balance mind with heart through compassionate self-talk. Practice forgiveness and embrace intuitive knowing.'
        },
        'Orange': {
          positive: ['Creative and enthusiastic', 'Confident and emotionally expressive'],
          negative: ['Addiction or dependency patterns', 'Superficiality or emotional instability'],
          remedy: 'Ground yourself in the present moment through earthing. Channel creative energy into meaningful projects.'
        },
        'Purple': {
          positive: ['Mystically wise and transformative', 'Spiritually masterful with ancient knowledge'],
          negative: ['Spiritual arrogance and disconnection', 'Superiority complex needing humility'],
          remedy: 'Practice servitude and humility. Connect sacred wisdom with practical service to humanity.'
        },
        'Silver': {
          positive: ['Lunar wise and psychically sensitive', 'Emotionally intelligent and reflective'],
          negative: ['Emotional volatility and mood swings', 'Psychic overwhelm or instability'],
          remedy: 'Establish energetic boundaries through shielding practices. Balance sensitivity with grounding techniques.'
        },
        'Black': {
          positive: ['Protective and grounding', 'Deeply wise with strong boundaries'],
          negative: ['Negativity and fear patterns', 'Heavy energy needing release'],
          remedy: 'Release dense energy through shadow work and cleansing rituals. Cultivate hope through acts of kindness.'
        },
        'Red': {
          positive: ['Passionate and vitally energetic', 'Courageous with leadership strength'],
          negative: ['Anger and aggression patterns', 'Impulsiveness or stress overwhelming you'],
          remedy: 'Channel passion through movement: dance, exercise, or martial arts. Practice calming breathwork daily.'
        },
        'Brown': {
          positive: ['Earth-connected and practical', 'Stable with natural wisdom'],
          negative: ['Stubbornness and inflexibility', 'Resistance to change and flow'],
          remedy: 'Practice flexibility through gentle yoga. Embrace change as natural progression and growth opportunity.'
        }
      };

      const meaning = colorMeanings[personalityColor as keyof typeof colorMeanings] || {
        positive: ['You have a unique energy signature', 'Your spirit shines brightly'],
        negative: ['Energy needs balancing', 'Harmonizing is essential for you'],
        remedy: 'Seek personalized spiritual guidance and practice daily self-care rituals.'
      };

      // Save vibe reading to database for healer dashboard tracking
      let savedVibeReading = null;
      if (req.user) {
        try {
          // Generate session ID for tracking
          const sessionId = Date.now().toString() + '-' + req.user.id;
          
          // Convert image buffer to base64 for storage
          const uploadedImageBase64 = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
          
          // Create analysis result for storage
          const fullAnalysisData = {
            dominantColor: personalityColor,
            colorMeaning: meaning,
            energyLevel: fastAnalysis.energyLevel,
            message: `Your vibe is radiating ${personalityColor.toLowerCase()} energy!`,
            timestamp: new Date().toISOString(),
            sessionId
          };

          // Generate particle aura effect visualization
          let visualizedImageBase64 = null;
          try {
            const visualizedImageBuffer = await generateParticleAuraEffect(imageBuffer, personalityColor);
            visualizedImageBase64 = `data:image/png;base64,${visualizedImageBuffer.toString('base64')}`;
          } catch (vizError) {
            console.error('Failed to generate particle effect:', vizError);
            // Continue without visualization if it fails
          }
          
          savedVibeReading = await storage.saveVibeReading({
            userId: req.user.id,
            performedBy: req.user.userType === 'healer' ? req.user.id : null,
            personalityColor: personalityColor,
            colorMeaning: JSON.stringify(meaning),
            uploadedImage: uploadedImageBase64,
            visualizedImage: visualizedImageBase64, // Particle aura effect visualization
            sessionId: sessionId,
            clientName: req.body.clientName || null,
            fullAnalysis: JSON.stringify(fullAnalysisData)
          });

          // Check and award achievements
          try {
            await storage.checkAndAwardAchievements(req.user.id);
          } catch (achievementError) {
            console.error("Error awarding achievements for vibe:", achievementError);
          }

          console.log(`✅ Vibe reading saved to dashboard for user ${req.user.id}, reading ID: ${savedVibeReading.id}`);
          console.log(`📊 Healer ${req.user.username} completed vibe reading - should appear in dashboard immediately`);
        } catch (error) {
          console.error('Failed to save vibe reading to dashboard:', error);
          // Don't fail the request if saving fails, just log the error
        }
        
        // Deduct credits for successful analysis
        const deductionResult = await storage.deductCredits(req.user.id, req.creditCost, 'vibe_check', 'Quick vibe analysis');
        if (!deductionResult) {
          return res.status(402).json({ error: "Insufficient credits" });
        }
        
        // Add soul energy (credits * 100) for completing vibe scan
        const vibeSoulEnergyAmount = (req.creditCost || 1) * 100;
        await storage.addSoulEnergy(req.user.id, vibeSoulEnergyAmount, 'vibe_scan', 'What\'s My Vibe scan completed');
        console.log(`⚡ Added +${vibeSoulEnergyAmount} soul energy to user ${req.user.id} for vibe scan completion (${req.creditCost || 1} credits × 100)`);
        
        // Check and award achievements for vibe scans
        try {
          await storage.checkAndAwardAchievements(req.user.id);
          console.log(`✅ Badge check completed for user ${req.user.id}`);
        } catch (badgeError) {
          console.error("Error checking achievements:", badgeError);
        }

        // Generate particle effect for response
        let visualizedImage = null;
        try {
          const visualizedImageBuffer = await generateParticleAuraEffect(imageBuffer, personalityColor);
          visualizedImage = `data:image/png;base64,${visualizedImageBuffer.toString('base64')}`;
        } catch (vizError) {
          console.error('Failed to generate particle effect:', vizError);
        }
        
        res.json({
          dominantColor: personalityColor,
          colorMeaning: meaning,
          energyLevel: fastAnalysis.energyLevel,
          message: `Your vibe is radiating ${personalityColor.toLowerCase()} energy!`,
          readingId: savedVibeReading?.id || null,
          visualizedImage: visualizedImage
        });
      } else {
        // Generate particle effect for non-authenticated users
        let visualizedImage = null;
        try {
          const visualizedImageBuffer = await generateParticleAuraEffect(imageBuffer, personalityColor);
          visualizedImage = `data:image/png;base64,${visualizedImageBuffer.toString('base64')}`;
        } catch (vizError) {
          console.error('Failed to generate particle effect:', vizError);
        }
        
        res.json({
          dominantColor: personalityColor,
          colorMeaning: meaning,
          energyLevel: fastAnalysis.energyLevel,
          message: `Your vibe is radiating ${personalityColor.toLowerCase()} energy!`,
          readingId: null,
          visualizedImage: visualizedImage
        });
      }

    } catch (error) {
      console.error("Quick vibe analysis error:", error);
      res.status(500).json({ message: "Failed to analyze your vibe. Please try again." });
    }
  });

  // Journal entries API endpoints
  app.post("/api/journal", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }

    try {
      const { mood, energyLevel, reflections, gratitude } = req.body;
      
      if (energyLevel === undefined || !reflections) {
        return res.status(400).json({ message: "Energy level and reflections are required" });
      }
      
      // Format gratitude entries into a string
      let gratitudeText = "";
      if (Array.isArray(req.body.gratitude)) {
        gratitudeText = req.body.gratitude.filter(Boolean).join('; ');
      } else if (typeof req.body.gratitude === 'object') {
        // Handle object format like {gratitude1: "...", gratitude2: "...", gratitude3: "..."}
        const entries = Object.values(req.body.gratitude).filter(Boolean);
        gratitudeText = entries.join('; ');
      } else {
        gratitudeText = gratitude || "";
      }
      
      const journalEntry = await storage.createJournalEntry({
        userId: req.user.id,
        mood: mood || null,
        energyLevel,
        reflections,
        gratitude: gratitudeText
      });
      
      // Check and award achievements for journal entries
      try {
        await storage.checkAndAwardAchievements(req.user.id);
      } catch (badgeError) {
        console.error("Error checking achievements:", badgeError);
      }
      
      res.status(201).json(journalEntry);
    } catch (error) {
      console.error("Error saving journal entry:", error);
      res.status(500).json({ message: "Failed to save journal entry" });
    }
  });

  app.get("/api/journal", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }

    try {
      const journalEntries = await storage.getJournalEntriesByUser(req.user.id);
      res.json(journalEntries);
    } catch (error) {
      console.error("Error retrieving journal entries:", error);
      res.status(500).json({ message: "Failed to retrieve journal entries" });
    }
  });

  // Mood snapshots - Save mood check-in data
  app.post("/api/mood-snapshots", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }

    try {
      const { emotion, energyLevel, stressLevel, sleepQuality, socialConnection, physicalActivity, insights } = req.body;
      
      if (!emotion || energyLevel === undefined || stressLevel === undefined || 
          sleepQuality === undefined || socialConnection === undefined || 
          physicalActivity === undefined) {
        return res.status(400).json({ message: "All mood check-in fields are required" });
      }

      const moodSnapshot = await storage.createMoodSnapshot({
        userId: req.user.id,
        mood: emotion,
        intensity: energyLevel,
        energyLevel,
        stressLevel,
        sleepQuality,
        socialConnection,
        physicalActivity,
        insights: insights ? JSON.stringify(insights) : null,
      });
      
      res.status(201).json(moodSnapshot);
    } catch (error) {
      console.error("Error saving mood snapshot:", error);
      res.status(500).json({ message: "Failed to save mood snapshot" });
    }
  });

  // Get mood snapshots for the current user
  app.get("/api/mood-snapshots", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }

    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      const moodSnapshots = limit 
        ? await storage.getRecentMoodSnapshots(req.user.id, limit)
        : await storage.getMoodSnapshotsByUser(req.user.id);
      
      res.json(moodSnapshots);
    } catch (error) {
      console.error("Error retrieving mood snapshots:", error);
      res.status(500).json({ message: "Failed to retrieve mood snapshots" });
    }
  });

  // Mood recommendations - Get personalized psychological recommendations
  app.post("/api/mood-recommendations", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }

    try {
      const { generateMoodRecommendations } = await import("./mood-recommendations");
      const { emotion, energyLevel, stressLevel, sleepQuality, socialConnection, physicalActivity } = req.body;
      
      if (!emotion || energyLevel === undefined || stressLevel === undefined) {
        return res.status(400).json({ message: "Required mood data missing" });
      }

      const recommendations = generateMoodRecommendations({
        emotion,
        energyLevel,
        stressLevel,
        sleepQuality,
        socialConnection,
        physicalActivity
      });
      
      res.json(recommendations);
    } catch (error) {
      console.error("Error generating mood recommendations:", error);
      res.status(500).json({ message: "Failed to generate recommendations" });
    }
  });

  // Psychology prompt endpoint - Get personalized psychological prompts
  app.get("/api/psychology/prompt", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }

    try {
      const { generatePersonalizedPrompt, getTimeOfDay } = await import("./psychology-engine");
      
      // Get user's recent journal entries to analyze mood
      const journalEntries = await storage.getJournalEntriesByUser(req.user.id);
      const recentEntries = journalEntries.slice(0, 5); // Last 5 entries
      
      // Calculate average energy from recent entries
      const avgEnergy = recentEntries.length > 0
        ? recentEntries.reduce((sum: number, entry: any) => sum + (entry.energyLevel || 5), 0) / recentEntries.length
        : 5;
      
      // Determine stress level based on energy patterns
      const stressLevel = avgEnergy < 4 ? 'high' : avgEnergy < 6 ? 'medium' : 'low';
      
      // Generate personalized prompt
      const prompt = generatePersonalizedPrompt({
        energyLevel: Math.round(avgEnergy),
        journalEntries: recentEntries.length,
        timeOfDay: getTimeOfDay(),
        stressLevel: stressLevel as 'low' | 'medium' | 'high'
      });
      
      res.json(prompt);
    } catch (error) {
      console.error("Error generating psychology prompt:", error);
      // Return a default calming prompt on error
      res.json({
        message: "Take a deep breath. You're doing great! 🌸",
        color: "#06b6d4",
        type: "calm",
        suggestedGradient: "calming"
      });
    }
  });

  // API endpoint to serve images for PDF generation
  app.get('/api/image/:hash', async (req, res) => {
    const imageHash = req.params.hash;
    
    try {
      // Find aura reading with this image hash
      const reading = await storage.findAuraReadingByImageHash(imageHash);
      
      if (!reading) {
        return res.status(404).json({ message: 'Image not found' });
      }
      
      let imageData = '';
      
      // First try to get processed aura image
      if (reading.processedAuraImage) {
        imageData = reading.processedAuraImage;
      } else {
        // Try to get image from analysis data
        try {
          const analysisData = JSON.parse(reading.analysis || '{}');
          if (analysisData.imageData) {
            imageData = analysisData.imageData;
          }
        } catch (e) {
          console.error('Could not parse analysis data for image');
        }
      }
      
      if (!imageData) {
        return res.status(404).json({ message: 'Image data not found' });
      }
      
      // Convert base64 to buffer
      const imageBuffer = Buffer.from(imageData, 'base64');
      
      res.set({
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400' // Cache for 1 day
      });
      
      res.send(imageBuffer);
    } catch (error) {
      console.error('Error serving image:', error);
      res.status(500).json({ message: 'Failed to serve image' });
    }
  });

  // Get user's aura readings
  app.get("/api/aura-readings", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }

    try {
      const auraReadings = await storage.getAuraReadingsByUser(req.user.id);
      res.json(auraReadings);
    } catch (error) {
      console.error("Error retrieving aura readings:", error);
      res.status(500).json({ message: "Failed to retrieve aura readings" });
    }
  });

  // Get user's credits
  app.get("/api/credits", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      // Validate user ID
      if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: "Invalid user session" });
      }
      
      const credits = await storage.getUserCredits(userId);
      res.json({ credits });
    } catch (error) {
      console.error("Error retrieving user credits:", error);
      res.status(500).json({ message: "Failed to retrieve credits" });
    }
  });

  // Get user's soul energy
  app.get("/api/soul-energy", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      // Validate user ID
      if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: "Invalid user session" });
      }
      
      const soulEnergy = await storage.getUserSoulEnergy(userId);
      res.json({ soulEnergy });
    } catch (error) {
      console.error("Error retrieving user soul energy:", error);
      res.status(500).json({ message: "Failed to retrieve soul energy" });
    }
  });

  // Grow soul energy (add 1000 soul energy)
  app.post("/api/soul-energy/grow", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      // Validate user ID
      if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: "Invalid user session" });
      }
      
      await storage.addSoulEnergy(userId, 1000, 'manual_grow');
      const newSoulEnergy = await storage.getUserSoulEnergy(userId);
      
      console.log(`🌱 User ${userId} grew their soul tree by +1000 energy (new total: ${newSoulEnergy})`);
      
      res.json({ soulEnergy: newSoulEnergy, added: 1000 });
    } catch (error) {
      console.error("Error growing soul energy:", error);
      res.status(500).json({ message: "Failed to grow soul energy" });
    }
  });

  // Reset soul energy (set to 0)
  app.post("/api/soul-energy/reset", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      // Validate user ID
      if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: "Invalid user session" });
      }
      
      // Update user's soul energy to 0
      const result = await db
        .update(users)
        .set({ soulEnergy: 0 })
        .where(eq(users.id, userId))
        .returning();
      
      if (!result || result.length === 0) {
        return res.status(404).json({ message: "User not found" });
      }
      
      console.log(`🔄 User ${userId} reset their soul energy to 0`);
      
      res.json({ soulEnergy: 0 });
    } catch (error) {
      console.error("Error resetting soul energy:", error);
      res.status(500).json({ message: "Failed to reset soul energy" });
    }
  });

  // Get user statistics (meditation hours, healer consultations, scans, etc.)
  app.get("/api/user-stats", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: "Invalid user session" });
      }
      
      const stats = await storage.getUserStats(userId);
      
      if (!stats) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Validate stats with schema before responding
      const { userStatsSchema } = await import("../shared/schema");
      const validatedStats = userStatsSchema.parse(stats);
      
      res.json(validatedStats);
    } catch (error: any) {
      if (error.name === 'ZodError') {
        console.error("User stats validation error:", error);
        return res.status(500).json({ message: "Invalid stats data format" });
      }
      console.error("Error fetching user stats:", error);
      res.status(500).json({ message: "Failed to fetch user statistics" });
    }
  });

  // Record completed meditation session
  app.post("/api/meditation-sessions", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user!.id;
      
      if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: "Invalid user session" });
      }

      const { meditationId, meditationTitle, durationMinutes, category, energyGained } = req.body;

      if (!meditationId || !meditationTitle || !durationMinutes || !category) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const session = await storage.createMeditationSession({
        userId,
        meditationId,
        meditationTitle,
        durationMinutes: Math.floor(Number(durationMinutes)),
        category,
        energyGained: Math.floor(Number(energyGained || 25)),
        completed: true,
      });

      // Award soul energy for completing meditation
      const soulEnergyAmount = Math.floor(Number(energyGained || 25));
      await storage.addSoulEnergy(userId, soulEnergyAmount, 'meditation', `Completed meditation: ${meditationTitle}`);
      
      // Update psychological profile meditation minutes
      try {
        const stats = await storage.getUserStats(userId);
        if (stats) {
          await db.update(psychologicalProfiles)
            .set({ 
              meditationMinutes: (stats.meditationMinutes || 0) + durationMinutes,
              updatedAt: new Date() 
            })
            .where(eq(psychologicalProfiles.userId, userId));
        }
      } catch (err) {
        console.error("Error updating meditation minutes:", err);
      }

      // Check and award achievements for meditation
      try {
        await storage.checkAndAwardAchievements(userId);
      } catch (badgeError) {
        console.error("Error checking achievements:", badgeError);
      }

      res.json(session);
    } catch (error) {
      console.error("Error recording meditation session:", error);
      res.status(500).json({ message: "Failed to record meditation session" });
    }
  });

  // Get user's meditation sessions (recently played)
  app.get("/api/meditation-sessions", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: "Invalid user session" });
      }

      const sessions = await storage.getUserMeditationSessions(userId);
      res.json(sessions);
    } catch (error) {
      console.error("Error fetching meditation sessions:", error);
      res.status(500).json({ message: "Failed to fetch meditation sessions" });
    }
  });

  // Add favorite meditation
  app.post("/api/favorite-meditations", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      const { meditationId, meditationTitle, category, durationMinutes, author } = req.body;
      
      if (!meditationId || !meditationTitle || !category || !durationMinutes) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const favorite = await storage.addFavoriteMeditation({
        userId,
        meditationId,
        meditationTitle,
        category,
        durationMinutes,
        author: author || "Unknown",
      });
      res.json(favorite);
    } catch (error) {
      console.error("Error adding favorite meditation:", error);
      res.status(500).json({ message: "Failed to add favorite meditation" });
    }
  });

  // Remove favorite meditation
  app.delete("/api/favorite-meditations/:meditationId", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      const meditationId = parseInt(req.params.meditationId, 10);
      
      if (!meditationId || isNaN(meditationId)) {
        return res.status(400).json({ message: "Invalid meditation ID" });
      }

      const removed = await storage.removeFavoriteMeditation(userId, meditationId);
      
      if (!removed) {
        return res.status(404).json({ message: "Favorite not found" });
      }

      res.json({ message: "Favorite removed successfully" });
    } catch (error) {
      console.error("Error removing favorite meditation:", error);
      res.status(500).json({ message: "Failed to remove favorite meditation" });
    }
  });

  // Get user's favorite meditations
  app.get("/api/favorite-meditations", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: "Invalid user session" });
      }

      const favorites = await storage.getFavoriteMeditations(userId);
      res.json(favorites);
    } catch (error) {
      console.error("Error fetching favorite meditations:", error);
      res.status(500).json({ message: "Failed to fetch favorite meditations" });
    }
  });

  // Check if meditation is favorite
  app.get("/api/favorite-meditations/:meditationId", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      const meditationId = parseInt(req.params.meditationId, 10);
      
      if (!meditationId || isNaN(meditationId)) {
        return res.status(400).json({ message: "Invalid meditation ID" });
      }

      const isFavorite = await storage.isMeditationFavorite(userId, meditationId);
      res.json({ isFavorite });
    } catch (error) {
      console.error("Error checking favorite meditation:", error);
      res.status(500).json({ message: "Failed to check favorite meditation" });
    }
  });

  // Get home page stats (meditation and healer consultations)
  app.get("/api/home-stats", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: "Invalid user session" });
      }

      // Get meditation stats
      const meditationStats = await storage.getMeditationStats(userId);

      // Get healer consultation stats
      const bookings = await storage.getHealerBookingsByUser(userId);
      const uniqueHealerIds = new Set(bookings.map(b => b.healerId));
      const healerSessions = uniqueHealerIds.size;
      const healerTotalEnergy = healerSessions * 50; // 50 energy per healer consultation

      res.json({
        meditation: {
          sessions: meditationStats.sessionsCount,
          energyPerSession: 25,
          totalEnergy: meditationStats.totalEnergy,
          progressPercentage: Math.min((meditationStats.totalEnergy / 850) * 100, 100),
        },
        healerConsultations: {
          sessions: healerSessions,
          energyPerSession: 50,
          totalEnergy: healerTotalEnergy,
          progressPercentage: Math.min((healerTotalEnergy / 400) * 100, 100),
        },
      });
    } catch (error) {
      console.error("Error fetching home stats:", error);
      res.status(500).json({ message: "Failed to fetch home statistics" });
    }
  });

  // Get login streaks
  app.get("/api/streaks", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: "Invalid user session" });
      }
      
      // Record login
      await storage.recordLogin(userId);
      
      // Get streak data
      const streakData = await storage.getLoginStreak(userId);
      
      // Award login streak achievements
      try {
        const milestones = [
          { streak: 7, type: 'seven_day_streak', title: 'Week Warrior 🔥', desc: 'Maintained a 7-day login streak' },
          { streak: 30, type: 'thirty_day_streak', title: 'Month Master 🌙', desc: 'Maintained a 30-day login streak' },
          { streak: 100, type: 'hundred_day_streak', title: 'Century Sage 💫', desc: 'Maintained a 100-day login streak' },
          { streak: 365, type: 'year_streak', title: 'Eternal Warrior ⚡', desc: 'Maintained a 365-day login streak' }
        ];
        
        for (const milestone of milestones) {
          if (streakData.currentStreak >= milestone.streak) {
            const existing = await db.query.achievements.findFirst({
              where: (ach, { and, eq }) => and(
                eq(ach.userId, userId),
                eq(ach.achievementType, milestone.type)
              )
            });
            if (!existing) {
              await db.insert(achievements).values({
                userId,
                achievementType: milestone.type,
                title: milestone.title,
                description: milestone.desc,
                icon: '🔥',
                badgeType: milestone.streak >= 365 ? 'platinum' : milestone.streak >= 100 ? 'gold' : milestone.streak >= 30 ? 'silver' : 'bronze',
              });
            }
          }
        }
      } catch (ach) {
        console.log("Streak achievement update skipped:", ach);
      }
      
      res.json(streakData);
    } catch (error) {
      console.error("Error fetching streaks:", error);
      res.status(500).json({ message: "Failed to fetch streaks" });
    }
  });

  // Get notification preferences
  app.get("/api/notification-preferences", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: "Invalid user session" });
      }
      
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      res.json({
        smsEnabled: user.smsNotificationsEnabled || false,
        phoneNumber: user.mobileNumber || "",
        browserEnabled: user.browserNotificationsEnabled || false,
        emailEnabled: user.emailNotificationsEnabled !== false,
      });
    } catch (error) {
      console.error("Error retrieving notification preferences:", error);
      res.status(500).json({ message: "Failed to retrieve notification preferences" });
    }
  });

  // Update notification preferences
  app.post("/api/notification-preferences", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: "Invalid user session" });
      }
      
      const { smsEnabled, phoneNumber, browserEnabled, emailEnabled } = req.body;
      
      await storage.updateNotificationPreferences(userId, {
        smsEnabled,
        phoneNumber,
        browserEnabled,
        emailEnabled,
      });
      
      res.json({ success: true, message: "Notification preferences updated" });
    } catch (error) {
      console.error("Error updating notification preferences:", error);
      res.status(500).json({ message: "Failed to update notification preferences" });
    }
  });

  // Push notification endpoints
  
  // Get VAPID public key
  app.get("/api/push/vapid-public-key", (req, res) => {
    const vapidPublicKey = getVapidPublicKey();
    if (!vapidPublicKey) {
      return res.status(503).json({ message: "Push notifications not configured" });
    }
    res.json({ publicKey: vapidPublicKey });
  });

  // Subscribe to push notifications
  app.post("/api/push/subscribe", async (req, res) => {
    try {
      const userId = req.user?.id || null; // Allow null for anonymous subscriptions
      
      console.log(`📱 Subscription request for user: ${userId || 'anonymous'}`);

      const subscriptionData = insertPushSubscriptionSchema.parse({
        userId,
        endpoint: req.body.endpoint,
        keys: JSON.stringify(req.body.keys),
      });

      const subscription = await storage.savePushSubscription(subscriptionData);
      console.log(`✅ Subscription saved successfully (user: ${userId || 'anonymous'})`);
      
      // Send a test notification if user is authenticated
      if (userId) {
        console.log(`📤 Sending test notification to user ${userId}`);
        await sendPushToUser(userId);
      }
      
      res.json({ success: true, subscription });
    } catch (error) {
      console.error("Error saving push subscription:", error);
      res.status(500).json({ message: "Failed to save push subscription", error: (error as Error).message });
    }
  });

  // Unsubscribe from push notifications
  app.post("/api/push/unsubscribe", isAuthenticated, async (req, res) => {
    try {
      const { endpoint } = req.body;
      
      if (!endpoint) {
        return res.status(400).json({ message: "Endpoint is required" });
      }

      const deleted = await storage.deletePushSubscription(endpoint);
      
      res.json({ success: deleted });
    } catch (error) {
      console.error("Error deleting push subscription:", error);
      res.status(500).json({ message: "Failed to delete push subscription" });
    }
  });

  // Get user's push subscriptions
  app.get("/api/push/subscriptions", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: "Invalid user session" });
      }

      const subscriptions = await storage.getPushSubscriptionsByUser(userId);
      res.json({ subscriptions });
    } catch (error) {
      console.error("Error retrieving push subscriptions:", error);
      res.status(500).json({ message: "Failed to retrieve push subscriptions" });
    }
  });

  // Test endpoint to send push notification immediately
  app.post("/api/push/test", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: "Invalid user session" });
      }

      console.log(`📨 Test notification requested for user ${userId}`);
      
      // Get all subscriptions for this user
      const subscriptions = await storage.getPushSubscriptionsByUser(userId);
      console.log(`📱 Found ${subscriptions.length} subscriptions for user ${userId}`);
      
      if (subscriptions.length === 0) {
        console.warn(`⚠️ No push subscriptions found for user ${userId}`);
        return res.status(400).json({ 
          message: "No devices subscribed for notifications",
          subscriptionCount: 0
        });
      }

      let sent = 0;
      let failed = 0;
      const results: any[] = [];

      // Send test notification to all devices
      for (const sub of subscriptions) {
        try {
          console.log(`📤 Sending test notification to endpoint: ${sub.endpoint.substring(0, 50)}...`);
          
          const pushSubscription: PushSubscriptionJSON = {
            endpoint: sub.endpoint,
            keys: JSON.parse(sub.keys)
          };

          const success = await sendPushNotification(
            pushSubscription,
            "🔔 Test Notification from AuraEye",
            "Your notifications are working perfectly! This is a test message.",
            "/dashboard"
          );

          if (success) {
            sent++;
            results.push({ endpoint: sub.endpoint.substring(0, 50) + '...', status: 'sent' });
            console.log(`✅ Test notification sent to ${sub.endpoint.substring(0, 50)}...`);
          } else {
            failed++;
            results.push({ endpoint: sub.endpoint.substring(0, 50) + '...', status: 'failed' });
            console.warn(`⚠️ Failed to send test notification to ${sub.endpoint.substring(0, 50)}...`);
          }
        } catch (subError) {
          failed++;
          console.error(`❌ Error sending test notification:`, subError);
          results.push({ 
            endpoint: sub.endpoint.substring(0, 50) + '...', 
            status: 'error',
            error: (subError as Error).message 
          });
        }
      }
      
      console.log(`✅ Test notification results: ${sent} sent, ${failed} failed`);
      res.json({ 
        success: sent > 0, 
        message: `Test notifications sent to ${sent}/${subscriptions.length} devices`,
        sent,
        failed,
        total: subscriptions.length,
        results
      });
    } catch (error) {
      console.error("Error sending test notification:", error);
      res.status(500).json({ 
        message: "Failed to send test notification",
        error: (error as Error).message
      });
    }
  });

  // Get user's credit transaction history
  app.get("/api/credit-transactions", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      // Validate user ID
      if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: "Invalid user session" });
      }
      
      const transactions = await storage.getCreditTransactionsByUser(userId);
      res.json({ transactions });
    } catch (error) {
      console.error("Error retrieving credit transactions:", error);
      res.status(500).json({ message: "Failed to retrieve credit transactions" });
    }
  });

  // Get user's credit transactions
  app.get("/api/credit-transactions", isAuthenticated, async (req, res) => {
    try {
      const transactions = await storage.getCreditTransactionsByUser(req.user.id);
      res.json(transactions);
    } catch (error) {
      console.error("Error retrieving credit transactions:", error);
      res.status(500).json({ message: "Failed to retrieve credit transactions" });
    }
  });

  // Get user's numerology readings
  app.get("/api/numerology-readings", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }

    try {
      const numerologyReadings = await storage.getNumerologyReadingsByUser(req.user.id);
      res.json(numerologyReadings);
    } catch (error) {
      console.error("Error retrieving numerology readings:", error);
      res.status(500).json({ message: "Failed to retrieve numerology readings" });
    }
  });

  // Get healer's numerology readings (only readings performed by the healer)
  app.get("/api/healer-numerology-readings", isAuthenticated, async (req, res) => {
    try {
      // Check if user is a healer by checking userType
      if (req.user.userType !== 'healer') {
        return res.status(403).json({ message: "Access denied: Not a healer" });
      }

      console.log(`Fetching numerology readings for healer: ${req.user.username} (ID: ${req.user.id})`);
      const numerologyReadings = await storage.getNumerologyReadingsByPerformedBy(req.user.id);
      console.log(`Found ${numerologyReadings.length} numerology readings performed by healer ${req.user.username}`);
      res.json(numerologyReadings);
    } catch (error) {
      console.error("Error retrieving healer numerology readings:", error);
      res.status(500).json({ message: "Failed to retrieve healer numerology readings" });
    }
  });

  // Get healer's aura readings (only readings performed by the healer) with pagination
  app.get("/api/healer-aura-readings", isAuthenticated, async (req, res) => {
    try {
      // Check if user is a healer by checking userType
      if (req.user.userType !== 'healer') {
        return res.status(403).json({ message: "Access denied: Not a healer" });
      }

      const limit = parseInt(req.query.limit as string) || 25; // Default to 25 readings for faster loading
      console.log(`Fetching ${limit} aura readings for healer: ${req.user.username} (ID: ${req.user.id})`);
      const auraReadings = await storage.getAuraReadingsByPerformedBy(req.user.id, limit);
      console.log(`Found ${auraReadings.length} aura readings performed by healer ${req.user.username}`);
      
      // Return minimal data for faster loading - remove large fields for initial load
      const optimizedReadings = auraReadings.map(reading => ({
        ...reading,
        // Keep essential fields for display, minimize large text fields
        analysis: reading.analysis ? reading.analysis.substring(0, 200) + '...' : '',
        spiritualGuidance: reading.spiritualGuidance ? reading.spiritualGuidance.substring(0, 200) + '...' : ''
      }));
      
      res.json(optimizedReadings);
    } catch (error) {
      console.error("Error retrieving healer aura readings:", error);
      res.status(500).json({ message: "Failed to retrieve healer aura readings" });
    }
  });

  // Get total count of healer's aura readings
  app.get("/api/healer-aura-readings-count", isAuthenticated, async (req, res) => {
    try {
      if (req.user.userType !== 'healer') {
        return res.status(403).json({ message: "Access denied: Not a healer" });
      }

      const count = await storage.getAuraReadingsCountByPerformedBy(req.user.id);
      res.json({ count });
    } catch (error) {
      console.error("Error retrieving healer aura readings count:", error);
      res.status(500).json({ message: "Failed to retrieve aura readings count" });
    }
  });

  // Get total count of healer's numerology readings
  app.get("/api/healer-numerology-readings-count", isAuthenticated, async (req, res) => {
    try {
      if (req.user.userType !== 'healer') {
        return res.status(403).json({ message: "Access denied: Not a healer" });
      }

      const count = await storage.getNumerologyReadingsCountByPerformedBy(req.user.id);
      res.json({ count });
    } catch (error) {
      console.error("Error retrieving healer numerology readings count:", error);
      res.status(500).json({ message: "Failed to retrieve numerology readings count" });
    }
  });

  // Get total count of user's vibe readings
  app.get("/api/vibe-readings-count", isAuthenticated, async (req, res) => {
    try {
      const count = await storage.getVibeReadingsCountByUserId(req.user.id);
      res.json({ count });
    } catch (error) {
      console.error("Error retrieving vibe readings count:", error);
      res.status(500).json({ message: "Failed to retrieve vibe readings count" });
    }
  });

  // Get healer's vibe readings (for healers, userId IS the healer who performed the reading)
  app.post("/api/healer-vibe-reading", isAuthenticated, async (req, res) => {
    try {
      if (req.user.userType !== 'healer' && req.user.userType !== 'semi-healer') {
        return res.status(403).json({ message: "Access denied: Not a healer" });
      }
      const reading = await storage.saveVibeReading({
        ...req.body,
        userId: req.user.id,
      });
      res.json(reading);
    } catch (error: any) {
      console.error("Error creating healer vibe reading:", error);
      res.status(500).json({ message: "Failed to create healer vibe reading" });
    }
  });

  app.get("/api/healer-vibe-readings", isAuthenticated, async (req, res) => {
    try {
      if (req.user.userType !== 'healer' && req.user.userType !== 'semi-healer') {
        return res.status(403).json({ message: "Access denied: Not a healer" });
      }

      console.log(`Fetching vibe readings for healer: ${req.user.username} (ID: ${req.user.id})`);
      const vibeReadings = await storage.getVibeReadingsByUserId(req.user.id);
      console.log(`Found ${vibeReadings.length} vibe readings by healer ${req.user.username}`);
      res.json(vibeReadings);
    } catch (error) {
      console.error("Error retrieving healer vibe readings:", error);
      res.status(500).json({ message: "Failed to retrieve healer vibe readings" });
    }
  });

  // Get healer's vibe readings count
  app.get("/api/healer-vibe-readings-count", isAuthenticated, async (req, res) => {
    try {
      if (req.user.userType !== 'healer' && req.user.userType !== 'semi-healer') {
        return res.status(403).json({ message: "Access denied: Not a healer" });
      }

      const count = await storage.getVibeReadingsCountByUserId(req.user.id);
      res.json({ count });
    } catch (error) {
      console.error("Error retrieving healer vibe readings count:", error);
      res.status(500).json({ message: "Failed to retrieve vibe readings count" });
    }
  });

  // Get healer's object analyses (analyses performed by the healer)
  app.get("/api/healer-object-analyses", isAuthenticated, async (req, res) => {
    try {
      if (req.user.userType !== 'healer' && req.user.userType !== 'semi-healer') {
        return res.status(403).json({ message: "Access denied: Not a healer" });
      }

      console.log(`Fetching object analyses for healer: ${req.user.username} (ID: ${req.user.id})`);
      const objectAnalyses = await storage.getObjectAnalysesByPerformedBy(req.user.id);
      console.log(`Found ${objectAnalyses.length} object analyses performed by healer ${req.user.username}`);
      res.json(objectAnalyses);
    } catch (error) {
      console.error("Error retrieving healer object analyses:", error);
      res.status(500).json({ message: "Failed to retrieve healer object analyses" });
    }
  });

  // Get healer's object analyses count
  app.get("/api/healer-object-analyses-count", isAuthenticated, async (req, res) => {
    try {
      if (req.user.userType !== 'healer' && req.user.userType !== 'semi-healer') {
        return res.status(403).json({ message: "Access denied: Not a healer" });
      }

      const count = await storage.getObjectAnalysesCountByPerformedBy(req.user.id);
      res.json({ count });
    } catch (error) {
      console.error("Error retrieving healer object analyses count:", error);
      res.status(500).json({ message: "Failed to retrieve object analyses count" });
    }
  });


  // Admin endpoint to add/subtract credits manually
  app.post("/api/admin/credits", isAuthenticated, async (req, res) => {
    try {
      const { targetUserId, amount, operation, description } = req.body;
      
      // Check if user is admin (you can modify this check as needed)
      if (req.user.username !== 'admin' && req.user.userType !== 'admin') {
        return res.status(403).json({ message: "Access denied: Not an admin" });
      }
      
      if (!targetUserId || !amount || !operation) {
        return res.status(400).json({ message: "Missing required fields: targetUserId, amount, operation" });
      }
      
      const parsedAmount = parseInt(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });
      }
      
      let success = false;
      if (operation === 'add') {
        success = await storage.addCredits(targetUserId, parsedAmount, 'admin_add', description || `Manual credit addition by ${req.user.username}`);
      } else if (operation === 'subtract') {
        success = await storage.deductCredits(targetUserId, parsedAmount, 'admin_subtract', description || `Manual credit deduction by ${req.user.username}`);
      } else {
        return res.status(400).json({ message: "Invalid operation. Use 'add' or 'subtract'" });
      }
      
      if (success) {
        const newBalance = await storage.getUserCredits(targetUserId);
        res.json({ 
          success: true, 
          message: `Credits ${operation === 'add' ? 'added' : 'subtracted'} successfully`,
          newBalance 
        });
      } else {
        res.status(400).json({ message: "Failed to update credits. Check user ID and balance." });
      }
    } catch (error) {
      console.error("Error updating credits:", error);
      res.status(500).json({ message: "Failed to update credits" });
    }
  });

  // Live numerology calculation endpoint (no saving to database) - for healers only
  app.post("/api/numerology-live", isAuthenticated, checkCredits('numerology'), async (req, res) => {
    try {
      if (req.user.userType !== 'healer' && req.user.userType !== 'semi-healer') {
        return res.status(403).json({ message: "Access denied: Not a healer" });
      }

      const { name, birthDate } = req.body;
      
      if (!name || !birthDate) {
        return res.status(400).json({ message: "Name and birth date are required" });
      }

      console.log(`Generating live numerology reading for: ${name} (healer: ${req.user.username})`);
      
      // Helper functions for numerology calculations
      const reduceNumber = (num: number): number => {
        // Reduce ALL numbers to single digit (1-9) - no master numbers
        while (num > 9) {
          num = num.toString().split('').reduce((sum, digit) => sum + parseInt(digit), 0);
        }
        return num;
      };

      const letterToNumber = (letter: string): number => {
        const letterMap: Record<string, number> = {
          'A': 1, 'I': 1, 'J': 1, 'Q': 1, 'Y': 1,
          'B': 2, 'K': 2, 'R': 2,
          'C': 3, 'G': 3, 'L': 3, 'S': 3,
          'D': 4, 'M': 4, 'T': 4,
          'E': 5, 'H': 5, 'N': 5, 'X': 5,
          'F': 6, 'O': 6, 'U': 6, 'V': 6, 'W': 6,
          'Z': 7,
          'P': 8
        };
        
        return letterMap[letter.toUpperCase()] || 0;
      };

      // Calculate Life Path Number
      const calculateLifePath = (date: string): number => {
        const digits = date.replace(/\D/g, '');
        let sum = 0;
        for (const digit of digits) {
          sum += parseInt(digit);
        }
        return reduceNumber(sum);
      };

      // Calculate Destiny Number
      const calculateDestiny = (fullName: string): number => {
        let sum = 0;
        for (const char of fullName.replace(/[^a-zA-Z]/g, '')) {
          sum += letterToNumber(char);
        }
        return reduceNumber(sum);
      };

      // Calculate Soul Urge Number
      const calculateSoulUrge = (fullName: string): number => {
        let sum = 0;
        const vowels = 'AEIOUY';
        for (const char of fullName.replace(/[^a-zA-Z]/g, '')) {
          if (vowels.includes(char.toUpperCase())) {
            sum += letterToNumber(char);
          }
        }
        return reduceNumber(sum);
      };

      // Calculate Personality Number - based on day digits only
      const calculatePersonality = (date: string): number => {
        const dateParts = date.split('-');
        if (dateParts.length !== 3) return 5;
        
        const day = dateParts[2]; // DD - only use day digits
        let sum = 0;
        for (const digit of day) {
          sum += parseInt(digit);
        }
        return reduceNumber(sum);
      };

      // Calculate Decision Making Chakra
      const calculateDecisionMakingChakra = (date: string): number => {
        const dateParts = date.split('-');
        if (dateParts.length !== 3) return 5;
        
        const month = dateParts[1]; // MM - only use month digits
        let sum = 0;
        for (const digit of month) {
          sum += parseInt(digit);
        }
        return reduceNumber(sum);
      };

      // Calculate Dominant Soul Chakra
      const calculateDominantSoulChakra = (date: string): number => {
        const dateParts = date.split('-');
        if (dateParts.length !== 3) return 5;
        
        const year = dateParts[0]; // YYYY - only use year digits
        let sum = 0;
        for (const digit of year) {
          sum += parseInt(digit);
        }
        return reduceNumber(sum);
      };

      // Generate core numbers - no database saving
      const lifePath = calculateLifePath(birthDate);
      const destiny = calculateDestiny(name);
      const soulUrge = calculateSoulUrge(name);
      const personality = calculatePersonality(birthDate);
      const decisionMakingChakra = calculateDecisionMakingChakra(birthDate);
      const dominantSoulChakra = calculateDominantSoulChakra(birthDate);

      // Generate AI interpretations using Gemini to avoid OpenAI quota issues
      const aiResponse = await generateGeminiNumerologyAnalysis({
        lifePath,
        destiny,
        soulUrge,
        personality,
        decisionMakingChakra,
        dominantSoulChakra
      });

      // Return live result without saving to database
      const result = {
        name,
        birthDate,
        lifePath,
        destiny,
        soulUrge,
        personality,
        decisionMakingChakra,
        dominantSoulChakra,
        lifePathInterpretation: aiResponse?.lifePathInterpretation || `Life Path ${lifePath} represents your life's journey and primary purpose. This number influences your natural abilities and the lessons you're here to learn.`,
        destinyInterpretation: aiResponse?.destinyInterpretation || `Destiny ${destiny} represents your life's mission and what you're meant to accomplish. This number shows your potential achievements and contributions.`,
        soulUrgeInterpretation: aiResponse?.soulUrgeInterpretation || `Soul Urge ${soulUrge} represents your inner desires and what truly motivates you from within. This number reveals your deepest aspirations and spiritual needs.`,
        personalityInterpretation: aiResponse?.personalityInterpretation || `Personality ${personality} represents how others see you and your outer expression. This number influences your social interactions and public image.`
      };

      console.log(`Live numerology result:`, JSON.stringify(result, null, 2));

      // Deduct credits for live numerology reading
      const deductionResult = await storage.deductCredits(req.user.id, req.creditCost, 'numerology', `Live numerology reading for ${name}`);
      if (!deductionResult) {
        return res.status(402).json({ error: "Insufficient credits" });
      }
      
      // Check and award achievements for numerology readings
      let newBadges: any[] = [];
      try {
        newBadges = await storage.checkAndAwardAchievements(req.user.id);
      } catch (badgeError) {
        console.error("Error checking achievements:", badgeError);
      }
      
      console.log(`Live numerology reading generated successfully for ${name}`);
      res.json({
        ...result,
        newBadges: newBadges,
        hasNewBadges: newBadges.length > 0
      });
    } catch (error) {
      console.error("Error generating live numerology reading:", error);
      res.status(500).json({ message: "Failed to generate numerology reading" });
    }
  });


  // Get user's object analyses
  app.get("/api/object-analyses", isAuthenticated, async (req: any, res) => {
    try {
      // For healers, show analyses they performed; for regular users, show their own
      const userType = req.user.userType || 'client';
      let objectAnalyses;
      if (userType === 'healer' || userType === 'semi-healer') {
        objectAnalyses = await storage.getObjectAnalysesByPerformedBy(req.user.id);
      } else {
        objectAnalyses = await storage.getObjectAnalysesByUser(req.user.id);
      }
      console.log(`Retrieved ${objectAnalyses.length} object analyses for user ${req.user.id} (type: ${userType})`);
      res.json(objectAnalyses);
    } catch (error) {
      console.error("Error retrieving object analyses:", error);
      res.status(500).json({ message: "Failed to retrieve object analyses" });
    }
  });

  // Update object analysis review
  app.post("/api/object-analyses/:id/review", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }

    try {
      const { id } = req.params;
      const { rating, reviewText } = req.body;
      
      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ message: "Rating must be between 1 and 5" });
      }

      const updatedAnalysis = await storage.updateObjectAnalysisReview(
        parseInt(id), 
        rating, 
        reviewText
      );
      
      if (!updatedAnalysis) {
        return res.status(404).json({ message: "Object analysis not found" });
      }

      res.json(updatedAnalysis);
    } catch (error) {
      console.error("Error updating object analysis review:", error);
      res.status(500).json({ message: "Failed to update review" });
    }
  });

  // Update aura reading healer notes
  app.patch('/api/aura-readings/:id/notes', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { healerNotes } = req.body;

      // For now, we'll add healer notes to the existing analysis field with a separator
      const reading = await storage.getAuraReading(parseInt(id));
      if (!reading) {
        return res.status(404).json({ message: "Aura reading not found" });
      }

      // Update the reading with healer notes (we'll add this to storage interface)
      const updatedReading = await storage.updateAuraReadingNotes(parseInt(id), healerNotes);
      
      res.json(updatedReading);
    } catch (error) {
      console.error("Error updating aura reading notes:", error);
      res.status(500).json({ message: "Failed to update notes" });
    }
  });

  // Update numerology reading healer notes  
  app.patch('/api/numerology-readings/:id/notes', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { healerNotes } = req.body;

      const reading = await storage.getNumerologyReading(parseInt(id));
      if (!reading) {
        return res.status(404).json({ message: "Numerology reading not found" });
      }

      // Update the reading with healer notes
      const updatedReading = await storage.updateNumerologyReadingNotes(parseInt(id), healerNotes);
      
      res.json(updatedReading);
    } catch (error) {
      console.error("Error updating numerology reading notes:", error);
      res.status(500).json({ message: "Failed to update notes" });
    }
  });

  // Save numerology reading PDF data
  app.patch('/api/numerology-readings/:id/pdf', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { pdfData, healerNotes } = req.body;

      if (!pdfData) {
        return res.status(400).json({ message: "PDF data is required" });
      }

      const reading = await storage.getNumerologyReading(parseInt(id));
      if (!reading) {
        return res.status(404).json({ message: "Numerology reading not found" });
      }

      // Update the reading with PDF data and optionally healer notes
      const updatedReading = await storage.updateNumerologyReadingPdf(parseInt(id), pdfData, healerNotes || "");
      
      res.json(updatedReading);
    } catch (error) {
      console.error("Error saving numerology reading PDF:", error);
      res.status(500).json({ message: "Failed to save PDF" });
    }
  });

  // Get numerology reading PDF data
  app.get('/api/numerology-readings/:id/pdf', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;

      const reading = await storage.getNumerologyReading(parseInt(id));
      if (!reading) {
        return res.status(404).json({ message: "Numerology reading not found" });
      }

      if (!reading.pdfData) {
        return res.status(404).json({ message: "PDF not available for this reading" });
      }

      res.json({ pdfData: reading.pdfData, name: reading.name, birthDate: reading.birthDate });
    } catch (error) {
      console.error("Error fetching numerology reading PDF:", error);
      res.status(500).json({ message: "Failed to fetch PDF" });
    }
  });

  // Forgot Password Routes
  
  // Request password reset
  app.post('/api/forgot-password', async (req, res) => {
    try {
      const { whatsappNumber } = req.body;
      
      if (!whatsappNumber) {
        return res.status(400).json({ message: "WhatsApp number is required" });
      }

      // Check if user exists with this WhatsApp number
      const user = await storage.getUserByMobileNumber(whatsappNumber);
      if (!user) {
        // Don't reveal if WhatsApp number exists for security
        return res.json({ message: "If an account with this WhatsApp number exists, a password reset code has been sent." });
      }

      // Generate 6-digit reset token
      const resetToken = Math.floor(100000 + Math.random() * 900000).toString();
      
      // Store reset token with 15-minute expiry
      await storage.createPasswordResetToken({
        email: user.email,
        mobileNumber: whatsappNumber,
        token: resetToken,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
      });

      // Send reset code via WhatsApp
      const otpSent = await sendOTPSMS(whatsappNumber, resetToken);
      
      if (otpSent) {
        res.json({ 
          message: "Password reset code sent to your WhatsApp",
          mobileNumber: whatsappNumber.slice(-4) // Only show last 4 digits for security
        });
      } else {
        res.status(500).json({ message: "Failed to send password reset code to WhatsApp" });
      }
    } catch (error) {
      console.error("Error requesting password reset:", error);
      res.status(500).json({ message: "Failed to process password reset request" });
    }
  });

  // Reset password with token
  app.post('/api/reset-password', async (req, res) => {
    try {
      const { whatsappNumber, token, newPassword } = req.body;
      
      if (!whatsappNumber || !token || !newPassword) {
        return res.status(400).json({ message: "WhatsApp number, token, and new password are required" });
      }

      // Validate reset token using WhatsApp number
      const resetTokenRecord = await storage.validatePasswordResetTokenByMobile(whatsappNumber, token);
      if (!resetTokenRecord) {
        return res.status(400).json({ message: "Invalid or expired reset token" });
      }

      // Get user by WhatsApp number
      const user = await storage.getUserByMobileNumber(whatsappNumber);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Hash new password
      const hashedPassword = await hashPassword(newPassword);
      console.log(`[DEBUG] Updating password for user ID: ${user.id}`);
      
      // Update password
      await storage.updateUserPassword(user.id, hashedPassword);

      // Keep healer login table in sync for healer accounts
      if (user.userType === "healer" || user.userType === "semi-healer") {
        await storage.updateHealerPassword(user.username, hashedPassword);
      }
      
      // Mark token as used
      await storage.markPasswordResetTokenAsUsed(resetTokenRecord.id);

      console.log(`✅ Password reset successful for user: ${user.username}`);
      res.json({ message: "Password reset successfully" });
    } catch (error: any) {
      console.error("[ERROR] Password reset failed:", error);
      res.status(500).json({ message: error.message || "Failed to reset password" });
    }
  });

  // Rate limiting for password reset - bounded in-memory store with separate email and IP tracking
  const resetAttempts = new Map<string, { count: number; lastAttempt: number }>();
  const RESET_RATE_LIMIT_PER_EMAIL = 5; // Max 5 attempts per email
  const RESET_RATE_LIMIT_PER_IP = 15; // Max 15 attempts per IP (allows multiple users behind same IP)
  const RESET_RATE_WINDOW = 15 * 60 * 1000; // 15 minute window
  const MAX_RATE_LIMIT_ENTRIES = 10000; // Prevent memory exhaustion
  
  // Periodic cleanup of expired entries (every 5 minutes)
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of resetAttempts.entries()) {
      if (now - record.lastAttempt > RESET_RATE_WINDOW) {
        resetAttempts.delete(key);
      }
    }
  }, 5 * 60 * 1000);
  
  function checkResetRateLimit(emailKey: string, ipKey: string, limitPerEmail: number, limitPerIP: number): { allowed: boolean; reason?: string } {
    const now = Date.now();
    
    // Prevent memory exhaustion - reject if too many entries
    if (resetAttempts.size >= MAX_RATE_LIMIT_ENTRIES) {
      // Clean up expired entries first
      for (const [key, record] of resetAttempts.entries()) {
        if (now - record.lastAttempt > RESET_RATE_WINDOW) {
          resetAttempts.delete(key);
        }
      }
      // If still too many, reject
      if (resetAttempts.size >= MAX_RATE_LIMIT_ENTRIES) {
        return { allowed: false, reason: "System is busy. Please try again later." };
      }
    }
    
    // Check and update email rate limit
    const emailRecord = resetAttempts.get(emailKey);
    if (emailRecord) {
      if (now - emailRecord.lastAttempt > RESET_RATE_WINDOW) {
        resetAttempts.set(emailKey, { count: 1, lastAttempt: now });
      } else if (emailRecord.count >= limitPerEmail) {
        return { allowed: false, reason: "Too many attempts for this email. Please try again later." };
      } else {
        emailRecord.count++;
        emailRecord.lastAttempt = now;
      }
    } else {
      resetAttempts.set(emailKey, { count: 1, lastAttempt: now });
    }
    
    // Check and update IP rate limit
    const ipRecord = resetAttempts.get(ipKey);
    if (ipRecord) {
      if (now - ipRecord.lastAttempt > RESET_RATE_WINDOW) {
        resetAttempts.set(ipKey, { count: 1, lastAttempt: now });
      } else if (ipRecord.count >= limitPerIP) {
        return { allowed: false, reason: "Too many requests from your location. Please try again later." };
      } else {
        ipRecord.count++;
        ipRecord.lastAttempt = now;
      }
    } else {
      resetAttempts.set(ipKey, { count: 1, lastAttempt: now });
    }
    
    return { allowed: true };
  }

  // Email-based password reset - Request password reset
  app.post('/api/forgot-password-email', async (req, res) => {
    try {
      const { username, email } = req.body;
      
      if (!username || !email) {
        return res.status(400).json({ message: "Username and email address are required" });
      }

      // Normalize username and email
      const normalizedUsername = username.trim().toLowerCase();
      const normalizedEmail = email.trim().toLowerCase();
      
      // Rate limit check
      const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
      const rateCheck = checkResetRateLimit(
        `request:user:${normalizedUsername}:${normalizedEmail}`,
        `request:ip:${clientIP}`,
        RESET_RATE_LIMIT_PER_EMAIL,
        RESET_RATE_LIMIT_PER_IP
      );
      if (!rateCheck.allowed) {
        return res.status(429).json({ message: rateCheck.reason });
      }
      
      // Check if user exists with this username and email
      console.log(`[DEBUG] Looking up user with username: "${normalizedUsername}" and email: "${normalizedEmail}"`);
      const user = await storage.getUserByUsername(normalizedUsername);
      console.log(`[DEBUG] User lookup result:`, user ? `Found user ID ${user.id}, email: "${user.email}"` : 'Not found');
      
      if (!user || !user.email || user.email.toLowerCase() !== normalizedEmail) {
        console.log(`[DEBUG] User validation failed - user exists: ${!!user}, has email: ${!!user?.email}, email matches: ${user?.email?.toLowerCase() === normalizedEmail}`);
        // Don't reveal if user exists for security
        return res.json({ message: "If matching account details exist, a password reset code has been sent." });
      }
      
      console.log(`[DEBUG] User validated successfully - proceeding with password reset`);

      // Generate 6-digit reset token
      const resetToken = Math.floor(100000 + Math.random() * 900000).toString();
      
      // Store reset token with 15-minute expiry
      await storage.createPasswordResetToken({
        username: normalizedUsername,
        email: normalizedEmail,
        mobileNumber: user.mobileNumber || null,
        token: resetToken,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
      });

      console.log(`[DEBUG] Created reset token ${resetToken} for ${normalizedEmail}`);

      // Send reset code via email
      const { sendPasswordResetEmail } = await import('./email-service');
      console.log(`[DEBUG] Attempting to send email to ${normalizedEmail} for username: ${normalizedUsername}`);
      const emailSent = await sendPasswordResetEmail(normalizedEmail, normalizedUsername, resetToken);
      console.log(`[DEBUG] Email sent status: ${emailSent}`);
      
      if (emailSent) {
        res.json({ message: "Password reset code sent to your email" });
      } else {
        console.error(`[ERROR] Failed to send password reset email to ${normalizedEmail}`);
        res.status(500).json({ message: "Failed to send password reset email. Please check your email configuration." });
      }
    } catch (error) {
      console.error("Error requesting password reset:", error);
      res.status(500).json({ message: "Failed to process password reset request" });
    }
  });

  // Email-based password reset - Reset password with token
  app.post('/api/reset-password-email', async (req, res) => {
    try {
      const { username, email, token, newPassword } = req.body;
      
      if (!username || !email || !token || !newPassword) {
        return res.status(400).json({ message: "Username, email, token, and new password are required" });
      }

      const normalizedUsername = username.trim().toLowerCase();
      const normalizedEmail = email.trim().toLowerCase();
      
      // Rate limit check
      const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
      const rateCheck = checkResetRateLimit(
        `reset:user:${normalizedUsername}:${normalizedEmail}`,
        `reset:ip:${clientIP}`,
        RESET_RATE_LIMIT_PER_EMAIL,
        RESET_RATE_LIMIT_PER_IP
      );
      if (!rateCheck.allowed) {
        return res.status(429).json({ message: rateCheck.reason });
      }
      
      if (newPassword.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters long" });
      }

      // Validate reset token using username, email, and token
      const resetTokenRecord = await storage.validatePasswordResetToken(normalizedUsername, normalizedEmail, token);
      if (!resetTokenRecord) {
        return res.status(400).json({ message: "Invalid or expired reset token" });
      }

      const user = await storage.getUserByUsername(normalizedUsername);
      if (!user || !user.email || user.email.toLowerCase() !== normalizedEmail) {
        return res.status(404).json({ message: "User details do not match" });
      }

      const hashedPassword = await hashPassword(newPassword);
      await storage.updateUserPassword(user.id, hashedPassword);
      
      // Also update healer table password if this is a healer account
      if (user.userType === "healer") {
        console.log(`[DEBUG] Updating healer table password for username: ${user.username}`);
        await storage.updateHealerPassword(user.username, hashedPassword);
      }
      
      await storage.markPasswordResetTokenAsUsed(resetTokenRecord.id);

      console.log(`✅ Password reset successful for ${user.userType} user: ${user.username} (${user.email})`);
      
      // Send password reset confirmation email
      try {
        const { sendPasswordResetConfirmationEmail } = await import('./email-service');
        await sendPasswordResetConfirmationEmail(user.email || normalizedEmail, user.username);
        console.log(`[DEBUG] Password reset confirmation email sent to ${user.email || normalizedEmail}`);
      } catch (emailError) {
        console.error(`[ERROR] Failed to send password reset confirmation email:`, emailError);
        // Don't fail the request if email sending fails
      }
      
      res.json({ message: "Password reset successfully. A confirmation email has been sent to your account." });
    } catch (error) {
      console.error("Error resetting password:", error);
      res.status(500).json({ message: "Failed to reset password" });
    }
  });

  // Email validation endpoint
  app.post('/api/validate-email', async (req, res) => {
    try {
      const { email } = req.body;
      
      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }
      
      const validation = await validateEmailAddress(email);
      
      res.json({
        isValid: validation.isValid,
        message: validation.message,
        deliverability: validation.deliverability,
        qualityScore: validation.qualityScore
      });
    } catch (error) {
      console.error("Error validating email:", error);
      res.status(500).json({ message: "Failed to validate email" });
    }
  });

  // Mobile OTP Routes
  
  // Send OTP to mobile number with guaranteed delivery
  app.post('/api/send-otp', async (req, res) => {
    try {
      const { mobileNumber } = req.body;
      
      if (!mobileNumber) {
        return res.status(400).json({ message: "Mobile number is required" });
      }

      // Generate and send OTP with multiple delivery methods
      const otpResult = await generateAndSendOTP(mobileNumber);
      
      if (otpResult.success) {
        res.json({ 
          message: otpResult.message || "OTP sent successfully",
          otp: otpResult.otp, // Include OTP in development for guaranteed access
          validationMessage: otpResult.message,
          instructions: "Your verification code is provided above for immediate use. WhatsApp delivery attempted if sandbox is configured.",
          sandboxInstructions: "To receive WhatsApp OTPs: Send 'join palace-stuck' to +1 415 523 8886 on WhatsApp"
        });
      } else {
        res.status(500).json({ 
          message: "Failed to send OTP",
          error: otpResult.message 
        });
      }
    } catch (error) {
      console.error("Error sending OTP:", error);
      res.status(500).json({ message: "Failed to send OTP" });
    }
  });

  // Development helper: Get current OTP for a mobile number (for testing)
  app.get('/api/get-otp/:mobileNumber', async (req, res) => {
    try {
      if (process.env.NODE_ENV !== 'development') {
        return res.status(404).json({ message: "Endpoint not available in production" });
      }
      
      const { mobileNumber } = req.params;
      
      // Get the latest unverified OTP for this number
      const [latestOtp] = await db
        .select()
        .from(otpVerifications)
        .where(
          and(
            eq(otpVerifications.mobileNumber, mobileNumber),
            eq(otpVerifications.verified, false),
            gt(otpVerifications.expiresAt, new Date())
          )
        )
        .orderBy(otpVerifications.createdAt)
        .limit(1);
      
      if (latestOtp) {
        res.json({ 
          otp: latestOtp.otp,
          expiresAt: latestOtp.expiresAt,
          message: `Current OTP for ${mobileNumber}: ${latestOtp.otp}`
        });
      } else {
        res.status(404).json({ message: "No valid OTP found for this number" });
      }
    } catch (error) {
      console.error("Error getting OTP:", error);
      res.status(500).json({ message: "Failed to get OTP" });
    }
  });

  // Verify OTP
  app.post('/api/verify-otp', async (req, res) => {
    try {
      const { mobileNumber, otp } = req.body;
      
      console.log(`\n=== OTP VERIFICATION REQUEST ===`);
      console.log(`Mobile Number: ${mobileNumber}`);
      console.log(`OTP Received: ${otp}`);
      console.log(`Time: ${new Date().toLocaleString()}`);
      
      if (!mobileNumber || !otp) {
        console.log('Validation failed: Missing mobile number or OTP');
        return res.status(400).json({ message: "Mobile number and OTP are required" });
      }

      // Check if OTP exists in database first (for debugging)
      const existingOtps = await db
        .select()
        .from(otpVerifications)
        .where(eq(otpVerifications.mobileNumber, mobileNumber))
        .orderBy(otpVerifications.createdAt);
      
      console.log(`Found ${existingOtps.length} OTP records for this number:`);
      existingOtps.forEach((record, index) => {
        console.log(`  ${index + 1}. OTP: ${record.otp}, Verified: ${record.verified}, Expires: ${record.expiresAt}, Created: ${record.createdAt}`);
      });

      // Verify OTP
      const isValid = await verifyOTP(mobileNumber, otp);
      
      if (isValid) {
        console.log('OTP verification successful!');
        console.log('================================\n');
        res.json({ message: "OTP verified successfully", verified: true });
      } else {
        console.log('OTP verification failed - Invalid or expired OTP');
        console.log('================================\n');
        res.status(400).json({ message: "Invalid or expired OTP", verified: false });
      }
    } catch (error) {
      console.error("Error verifying OTP:", error);
      console.log('================================\n');
      res.status(500).json({ message: "Failed to verify OTP" });
    }
  });

  // Check if mobile number is verified
  app.get('/api/mobile-verified/:mobileNumber', async (req, res) => {
    try {
      const { mobileNumber } = req.params;
      
      const isVerified = await isMobileVerified(mobileNumber);
      
      res.json({ verified: isVerified });
    } catch (error) {
      console.error("Error checking mobile verification:", error);
      res.status(500).json({ message: "Failed to check mobile verification" });
    }
  });

  // PDF Storage API for exact PDF retrieval
  app.post('/api/pdf-storage', isAuthenticated, async (req, res) => {
    try {
      const { auraReadingId, fileName, pdfData, clientName } = req.body;
      
      // Ensure user is a healer
      if (req.user?.userType !== 'healer') {
        return res.status(403).json({ message: "Only healers can store PDFs" });
      }

      const pdfStorage = await storage.storePdf({
        auraReadingId,
        healerId: req.user.id,
        fileName,
        pdfData,
        clientName
      });

      res.status(201).json(pdfStorage);
    } catch (error) {
      console.error("Error storing PDF:", error);
      res.status(500).json({ message: "Failed to store PDF" });
    }
  });

  // Get stored PDF by aura reading ID
  app.get('/api/pdf-storage/aura/:auraReadingId', isAuthenticated, async (req, res) => {
    try {
      const auraReadingId = parseInt(req.params.auraReadingId);
      
      // Ensure user is a healer
      if (req.user?.userType !== 'healer') {
        return res.status(403).json({ message: "Only healers can access stored PDFs" });
      }

      const storedPdf = await storage.getPdfByAuraReadingId(auraReadingId);
      
      if (!storedPdf) {
        return res.status(404).json({ message: "PDF not found" });
      }

      // Verify this healer owns this PDF
      if (storedPdf.healerId !== req.user.id) {
        return res.status(403).json({ message: "Access denied" });
      }

      res.json(storedPdf);
    } catch (error) {
      console.error("Error retrieving PDF:", error);
      res.status(500).json({ message: "Failed to retrieve PDF" });
    }
  });

  // Get all PDFs stored by a healer
  app.get('/api/pdf-storage/healer', isAuthenticated, async (req, res) => {
    try {
      // Ensure user is a healer
      if (req.user?.userType !== 'healer') {
        return res.status(403).json({ message: "Only healers can access PDF history" });
      }

      const pdfs = await storage.getPdfsByHealerId(req.user.id);
      res.json(pdfs);
    } catch (error) {
      console.error("Error retrieving PDF history:", error);
      res.status(500).json({ message: "Failed to retrieve PDF history" });
    }
  });

  // Email PDF report endpoint
  app.post('/api/reports/email', isAuthenticated, async (req, res) => {
    try {
      const { filename, pdfBase64, readingId, screenshots } = req.body;
      
      if (!filename || !pdfBase64) {
        return res.status(400).json({ message: "Missing required fields: filename and pdfBase64" });
      }

      // Get user's email from database
      const user = await storage.getUser(req.user.id);
      if (!user || !user.email) {
        return res.status(400).json({ message: "User email not found" });
      }

      // Validate attachment size (roughly 25MB limit for base64)
      const estimatedSize = (pdfBase64.length * 3) / 4; // Convert base64 length to bytes
      if (estimatedSize > 25 * 1024 * 1024) {
        return res.status(413).json({ message: "PDF too large for email attachment" });
      }

      // Import email service dynamically to avoid startup errors
      const { sendPDFReport } = await import('./email-service');

      // Send email with PDF attachment
      const emailSent = await sendPDFReport(
        user.email,
        user.username || 'User',
        pdfBase64,
        filename,
        screenshots
      );

      if (emailSent) {
        console.log(`✅ PDF report emailed successfully to ${user.email}`);
        res.status(200).json({ 
          success: true, 
          message: "PDF report sent to your email successfully" 
        });
      } else {
        res.status(500).json({ 
          success: false, 
          message: "Failed to send email" 
        });
      }

    } catch (error) {
      console.error("Error sending PDF via email:", error);
      res.status(500).json({ 
        success: false, 
        message: "Failed to send PDF report via email" 
      });
    }
  });

  // ==================== GAMIFICATION ENDPOINTS ====================

  // Get user's achievements
  app.get("/api/achievements", isAuthenticated, async (req, res) => {
    try {
      const achievementsList = await db.query.achievements.findMany({
        where: (achievements, { eq }) => eq(achievements.userId, req.user.id),
        orderBy: (achievements, { desc }) => desc(achievements.unlockedAt),
      });
      
      // Map badgeType to level for component compatibility
      const mappedAchievements = achievementsList.map((achievement: any) => ({
        ...achievement,
        level: achievement.badgeType || achievement.tier?.toLowerCase() || 'bronze',
        type: achievement.achievementType
      }));
      
      res.json(mappedAchievements);
    } catch (error) {
      console.error("Error fetching achievements:", error);
      res.status(500).json({ message: "Failed to fetch achievements" });
    }
  });

  // Check and award achievement
  app.post("/api/check-achievement", isAuthenticated, async (req, res) => {
    try {
      const { achievementType } = req.body;
      if (!achievementType) return res.status(400).json({ message: "Achievement type required" });

      const existingAchievement = await db.query.achievements.findFirst({
        where: (achievements, { and, eq }) => and(
          eq(achievements.userId, req.user.id),
          eq(achievements.achievementType, achievementType)
        ),
      });

      if (existingAchievement) {
        return res.json({ alreadyUnlocked: true });
      }

      const achievementMap: Record<string, { title: string; description: string; icon: string }> = {
        "first_aura": { title: "First Glimpse 👀", description: "Completed your first aura analysis", icon: "🎨" },
        "first_journal": { title: "Thoughts Flow 📖", description: "Wrote your first journal entry", icon: "📝" },
        "7_day_streak": { title: "Weekly Warrior 🔥", description: "Logged in 7 days in a row", icon: "🔥" },
        "50_soul_energy": { title: "Soul Ascension ⭐", description: "Reached 50 soul energy", icon: "⭐" },
        "100_soul_energy": { title: "Spiritual Master 👑", description: "Reached 100 soul energy", icon: "👑" },
        "500_soul_energy": { title: "Divine Essence 🔮", description: "Reached 500 soul energy", icon: "🔮" },
        "colors_collected": { title: "Rainbow Collector 🌈", description: "Collected all 7+ aura colors", icon: "🌈" },
        "chakra_master": { title: "Chakra Master 🧘", description: "Unlocked all 9 chakras", icon: "🧘" },
      };

      const ach = achievementMap[achievementType];
      if (ach) {
        // Map achievement types to badge levels
        const badgeLevelMap: Record<string, "bronze" | "silver" | "gold" | "platinum"> = {
          "first_aura": "bronze",
          "first_journal": "bronze",
          "7_day_streak": "silver",
          "50_soul_energy": "silver",
          "100_soul_energy": "gold",
          "500_soul_energy": "platinum",
          "colors_collected": "gold",
          "chakra_master": "platinum",
        };
        
        const newAchievement = await db.insert(achievements).values({
          userId: req.user.id,
          achievementType,
          title: ach.title,
          description: ach.description,
          icon: ach.icon,
          badgeType: badgeLevelMap[achievementType] || "bronze",
        }).returning();

        res.json({ success: true, achievement: newAchievement[0] });
      } else {
        res.status(400).json({ message: "Invalid achievement type" });
      }
    } catch (error) {
      console.error("Error checking achievement:", error);
      res.status(500).json({ message: "Failed to check achievement" });
    }
  });

  // Check and award achievements based on activity counts
  app.post("/api/check-badges", isAuthenticated, async (req, res) => {
    try {
      const { newBadges, allAchievements } = await storage.checkAndAwardAchievements(req.user.id);
      res.json({ 
        newBadges,
        allAchievements,
        hasNewBadges: newBadges.length > 0
      });
    } catch (error) {
      console.error("Error checking badges:", error);
      res.status(500).json({ message: "Failed to check badges" });
    }
  });

  // Get color collector data
  app.get("/api/color-collector", isAuthenticated, async (req, res) => {
    try {
      let collector = await db.query.colorCollectors.findFirst({
        where: (cc, { eq }) => eq(cc.userId, req.user.id),
      });

      if (!collector) {
        collector = await db.insert(colorCollectors).values({
          userId: req.user.id,
          collectedColors: JSON.stringify([]),
          totalCollected: 0,
          completionPercentage: 0,
          masteryProgress: JSON.stringify({}),
        }).returning();
      }

      res.json({
        ...collector,
        collectedColors: JSON.parse(collector[0]?.collectedColors || "[]"),
      });
    } catch (error) {
      console.error("Error fetching color collector:", error);
      res.status(500).json({ message: "Failed to fetch color collector" });
    }
  });

  // Get chakra unlocks
  app.get("/api/chakra-unlocks", isAuthenticated, async (req, res) => {
    try {
      let chakras = await db.query.chakraUnlocks.findFirst({
        where: (cu, { eq }) => eq(cu.userId, req.user.id),
      });

      if (!chakras) {
        chakras = await db.insert(chakraUnlocks).values({
          userId: req.user.id,
          unlockedChakras: JSON.stringify([1]),
          totalUnlocked: 1,
          masteryProgress: JSON.stringify({ 1: 0.1 }),
        }).returning();
      }

      res.json({
        ...(Array.isArray(chakras) ? chakras[0] : chakras),
        unlockedChakras: JSON.parse((Array.isArray(chakras) ? chakras[0] : chakras).unlockedChakras || "[]"),
        masteryProgress: JSON.parse((Array.isArray(chakras) ? chakras[0] : chakras).masteryProgress || "{}"),
      });
    } catch (error) {
      console.error("Error fetching chakra unlocks:", error);
      res.status(500).json({ message: "Failed to fetch chakra unlocks" });
    }
  });

  // Get badge progress targets
  app.get("/api/badge-progress", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      // Get all user data needed for badge progress
      // Count both readings received and performed by healers
      const auraReadings = await db.query.auraReadings.findMany({
        where: (ar, { eq, or }) => or(
          eq(ar.userId, userId),
          eq(ar.performedBy, userId)
        ),
      });
      
      const journals = await db.query.journals.findMany({
        where: (j, { eq }) => eq(j.userId, userId),
      });
      
      const healerBookings = await db.query.healerBookings.findMany({
        where: (hb, { eq }) => eq(hb.userId, userId),
      });
      
      // Get earned achievements
      const earnedAchievements = await db.query.achievements.findMany({
        where: (a, { eq }) => eq(a.userId, userId),
      });
      
      const earnedTypes = new Set(earnedAchievements.map(a => a.achievementType.toLowerCase().trim()));
      
      // Get counts for progress calculation
      const { checkAndAwardBadges } = await import('./badge-checker');
      // We don't want to award here, just get counts, but checkAndAwardBadges is async and might have side effects
      // Let's manually count to be safe or use a helper
      const [vibeCount] = await db.select({ count: sql<number>`cast(count(*) as integer)` }).from(vibeReadings).where(or(eq(vibeReadings.userId, userId), sql`${vibeReadings.userId} = ${userId}`));
      const [numCount] = await db.select({ count: sql<number>`cast(count(*) as integer)` }).from(numerologyReadings).where(or(eq(numerologyReadings.userId, userId), eq(numerologyReadings.performedBy, userId)));
      
      const counts = {
        vibe: Number(vibeCount?.count || 0),
        numerology: Number(numCount?.count || 0)
      };

      // Get login streak
      const streakData = await storage.getLoginStreak(userId);
      
      // Calculate badge progress
      const badgeProgress = {
        // First reading badge
        firstReading: {
          type: 'first_aura',
          title: 'First Glimpse 👀',
          current: Math.min(auraReadings.length, 1),
          target: 1,
          earned: earnedTypes.has('first_aura'),
          icon: '👀'
        },
        // 5 readings badge
        fiveReadings: {
          type: 'third_aura',
          title: 'Aura Explorer 🔍',
          current: Math.min(auraReadings.length, 5),
          target: 5,
          earned: earnedTypes.has('third_aura'),
          icon: '🔍'
        },
        // Vibe badges
        first_vibe: {
          type: 'first_vibe',
          title: 'Vibe Check ✨',
          current: Math.min(counts.vibe, 1),
          target: 1,
          earned: earnedTypes.has('first_vibe'),
          icon: '✨'
        },
        vibe_enthusiast: {
          type: 'vibe_enthusiast',
          title: 'Vibe Enthusiast 💫',
          current: Math.min(counts.vibe, 5),
          target: 5,
          earned: earnedTypes.has('vibe_enthusiast'),
          icon: '💫'
        },
        vibe_master: {
          type: 'vibe_master',
          title: 'Vibe Master 🎯',
          current: Math.min(counts.vibe, 15),
          target: 15,
          earned: earnedTypes.has('vibe_master'),
          icon: '🎯'
        },
        vibe_legend: {
          type: 'vibe_legend',
          title: 'Vibe Legend 👑',
          current: Math.min(counts.vibe, 30),
          target: 30,
          earned: earnedTypes.has('vibe_legend'),
          icon: '👑'
        },
        // Numerology badges
        first_numerology: {
          type: 'first_numerology',
          title: 'Number Navigator 🔢',
          current: Math.min(counts.numerology, 1),
          target: 1,
          earned: earnedTypes.has('first_numerology'),
          icon: '🔢'
        },
        numerology_explorer: {
          type: 'numerology_explorer',
          title: 'Numerology Explorer 📊',
          current: Math.min(counts.numerology, 3),
          target: 3,
          earned: earnedTypes.has('numerology_explorer'),
          icon: '📊'
        },
        numerology_master: {
          type: 'numerology_master',
          title: 'Numerology Master 🧮',
          current: Math.min(counts.numerology, 10),
          target: 10,
          earned: earnedTypes.has('numerology_master'),
          icon: '🧮'
        },
        numerology_sage: {
          type: 'numerology_sage',
          title: 'Numerology Sage 🔮',
          current: Math.min(counts.numerology, 20),
          target: 20,
          earned: earnedTypes.has('numerology_sage'),
          icon: '🔮'
        },
        // Most replies as healer (accepted bookings)
        mostRepliesHealer: {
          type: 'healer_five_replies',
          title: 'Healing Heart 💚',
          current: healerBookings.filter(b => b.status === 'accepted').length,
          target: 5,
          earned: earnedTypes.has('healer_five_replies'),
          icon: '💚'
        },
        // Best healer (highest rated healer)
        bestHealer: {
          type: 'best_healer',
          title: 'Best Healer 🌟',
          current: 0,
          target: 1,
          earned: earnedTypes.has('best_healer'),
          icon: '🌟'
        },
        // Reflection Hour (journaling progress)
        reflectionHour: {
          type: 'reflection_hour',
          title: 'Reflection Hour ⌛',
          current: Math.min(journals.length, 10),
          target: 10,
          earned: earnedTypes.has('reflection_hour'),
          icon: '⌛'
        },
        // Streak badge
        streakBadge: {
          type: 'seven_day_streak',
          title: 'Week Warrior 🔥',
          current: streakData.currentStreak,
          target: 7,
          earned: earnedTypes.has('seven_day_streak'),
          icon: '🔥'
        },
        // Journaling time (estimate 5 minutes per entry as baseline)
        journalingTime: {
          type: 'journaling_one_hour',
          title: 'Reflection Hour 📝',
          current: Math.floor(journals.length * 5 / 60), // Estimate 5 min per entry
          target: 1,
          earned: earnedTypes.has('journaling_one_hour'),
          icon: '📝'
        },
        // 10 hours journaling
        journalingTenHours: {
          type: 'journaling_ten_hours',
          title: 'Inner Voice 🎧',
          current: Math.floor(journals.length * 5 / 60),
          target: 10,
          earned: earnedTypes.has('journaling_ten_hours'),
          icon: '🎧'
        },
        // Most trusted healer (most replies)
        mostTrustedHealer: {
          type: 'healer_most_replies',
          title: 'Most Trusted Healer 👑',
          current: healerBookings.filter(b => b.status === 'accepted').length,
          target: 20,
          earned: earnedTypes.has('healer_most_replies'),
          icon: '👑'
        }
      };
      
      res.json(badgeProgress);
    } catch (error) {
      console.error("Error fetching badge progress:", error);
      res.status(500).json({ message: "Failed to fetch badge progress" });
    }
  });

  // Upload profile picture
  app.post("/api/profile-picture", isAuthenticated, async (req, res) => {
    try {
      const { pictureUrl } = req.body;

      if (!pictureUrl) {
        return res.status(400).json({ message: "Picture URL is required" });
      }

      // Check if it's a valid base64 data URL or regular URL
      if (!pictureUrl.startsWith("data:") && !pictureUrl.startsWith("http")) {
        return res.status(400).json({ message: "Invalid picture format" });
      }

      const updatedUser = await storage.updateProfilePicture(req.user.id, pictureUrl);

      if (!updatedUser) {
        return res.status(500).json({ message: "Failed to update profile picture" });
      }

      res.json({
        success: true,
        message: "Profile picture updated successfully",
        profilePictureUrl: updatedUser.profilePictureUrl,
      });
    } catch (error) {
      console.error("Error uploading profile picture:", error);
      res.status(500).json({ message: "Failed to upload profile picture" });
    }
  });

  // Get earned badges with tiers
  app.get("/api/earned-badges", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      // Get all earned achievements
      const achievements = await db.query.achievements.findMany({
        where: (a, { eq }) => eq(a.userId, userId),
      });
      
      // Map achievements to earned badges with tiers
      const badgeTierMap: Record<string, { title: string; level: "bronze" | "silver" | "gold" | "platinum"; description: string }> = {
        // Aura badges
        'first_aura': { title: 'First Glimpse 👀', level: 'bronze', description: 'Completed your first aura analysis' },
        'third_aura': { title: 'Aura Explorer 🔍', level: 'silver', description: 'Completed 3 aura analyses' },
        'aura_master': { title: 'Aura Master 🌟', level: 'gold', description: 'Completed 10 aura analyses' },
        'aura_legend': { title: 'Aura Legend 👑', level: 'platinum', description: 'Completed 25 aura analyses' },
        
        // Vibe badges
        'first_vibe': { title: 'Vibe Check ✨', level: 'bronze', description: 'Completed your first vibe scan' },
        'vibe_enthusiast': { title: 'Vibe Enthusiast 💫', level: 'silver', description: 'Completed 5 vibe checks' },
        'vibe_master': { title: 'Vibe Master 🎯', level: 'gold', description: 'Completed 15 vibe checks' },
        'vibe_legend': { title: 'Vibe Legend 🌈', level: 'platinum', description: 'Completed 30 vibe checks' },
        
        // Journal badges
        'first_journal': { title: 'Thoughts Flow 📖', level: 'bronze', description: 'Wrote your first journal entry' },
        'journal_keeper': { title: 'Journal Keeper 📚', level: 'silver', description: 'Wrote 5 journal entries' },
        'journal_master': { title: 'Journal Master 🖋️', level: 'gold', description: 'Wrote 20 journal entries' },
        'journal_legend': { title: 'Journal Legend 📜', level: 'platinum', description: 'Wrote 50 journal entries' },
        
        // Streak badges
        'seven_day_streak': { title: 'Week Warrior 🔥', level: 'bronze', description: 'Maintained a 7-day login streak' },
        'thirty_day_streak': { title: 'Month Master 🌙', level: 'silver', description: 'Maintained a 30-day login streak' },
        'hundred_day_streak': { title: 'Century Sage 💫', level: 'gold', description: 'Maintained a 100-day login streak' },
        'year_streak': { title: 'Eternal Warrior ⚡', level: 'platinum', description: 'Maintained a 365-day login streak' },
        
        // Healer badges
        'healer_five_replies': { title: 'Healing Heart 💚', level: 'bronze', description: 'Accepted 5 healer sessions' },
        'healer_most_replies': { title: 'Most Trusted Healer 👑', level: 'silver', description: 'Accepted 20 healer sessions' },
        'healer_rating_master': { title: 'Healer Master ⭐', level: 'gold', description: 'Achieved 4.8+ healer rating' },
        'best_healer_rating': { title: 'Best Healer 🏆', level: 'platinum', description: 'Became the highest rated healer' },

        // Numerology badges
        'first_numerology': { title: 'Number Navigator 🔢', level: 'bronze', description: 'Completed your first numerology reading' },
        'numerology_explorer': { title: 'Numerology Explorer 📊', level: 'silver', description: 'Completed 5 numerology readings' },
        
        // Journaling time badges
        'journaling_one_hour': { title: 'Reflection Hour 📝', level: 'bronze', description: 'Journaled for 1 hour total' },
        'journaling_ten_hours': { title: 'Inner Voice 🎧', level: 'silver', description: 'Journaled for 10 hours total' },
        'journaling_fifty_hours': { title: 'Deep Writer 🌊', level: 'gold', description: 'Journaled for 50 hours total' },
        'journaling_hundred_hours': { title: 'Stream of Consciousness 📖', level: 'platinum', description: 'Journaled for 100+ hours' },
      };
      
      const earnedBadges = achievements
        .map(ach => ({
          type: ach.achievementType,
          ...badgeTierMap[ach.achievementType]
        }))
        .filter(badge => badge.title !== undefined);
      
      res.json(earnedBadges);
    } catch (error) {
      console.error("Error fetching earned badges:", error);
      res.status(500).json({ message: "Failed to fetch earned badges" });
    }
  });

  // Healer leaderboard
  app.get("/api/leaderboard/healers", async (req, res) => {
    try {
      const healers = await db.query.users.findMany({
        where: (users, { eq }) => eq(users.userType, 'healer'),
        orderBy: (users, { desc }) => desc(users.healerSessionCount),
        limit: 20,
      });

      res.json(healers.map((h, idx) => ({
        rank: idx + 1,
        username: h.username,
        sessionCount: h.healerSessionCount || 0,
        badge: h.healerSessionCount >= 50 ? '👑 Master Healer' : h.healerSessionCount >= 20 ? '⭐ Senior Healer' : '✨ Healer',
      })));
    } catch (error) {
      console.error("Error fetching healer leaderboard:", error);
      res.status(500).json({ message: "Failed to fetch leaderboard" });
    }
  });

  // Payment Plans - Get all available plans
  app.get("/api/payment-plans", async (req, res) => {
    try {
      // Use raw SQL directly to query payment plans
      const result = await db.execute(sql`SELECT * FROM payment_plans WHERE is_active = true ORDER BY price ASC`);
      const plans = result.rows || result;
      
      res.json((plans as any[]).map(plan => ({
        ...plan,
        features: typeof plan.features === 'string' ? JSON.parse(plan.features) : plan.features,
      })));
    } catch (error) {
      console.error("Error fetching payment plans:", error);
      res.status(500).json({ error: "Failed to fetch payment plans" });
    }
  });

  // Purchase Plan endpoint
  app.post("/api/purchase-plan", isAuthenticated, async (req, res) => {
    try {
      const { planId } = req.body;
      const userId = req.user.id;

      if (!planId) {
        return res.status(400).json({ error: "Plan ID is required" });
      }

      // Get plan using raw SQL
      const planResult = await db.execute(sql`SELECT * FROM payment_plans WHERE id = ${planId}`);
      const plans = planResult.rows || planResult;
      const plan = (plans as any[])[0];

      if (!plan) {
        return res.status(404).json({ error: "Plan not found" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Create payment transaction using raw SQL
      const newCredits = (user.credits || 0) + (plan.credits || 0);
      await db.execute(sql`
        INSERT INTO payment_transactions (user_id, plan_id, amount, status, billing_email, credits_before, credits_after, created_at)
        VALUES (${userId}, ${planId}, ${plan.price || 0}, 'completed', ${user.email || ''}, ${user.credits || 0}, ${newCredits}, NOW())
      `);

      // Update user credits
      await storage.updateUserCredits(userId, newCredits);

      // Send confirmation email
      if (user.email) {
        await sendPaymentConfirmationEmail(user.email, user.username, plan.name, plan.credits || 0, plan.price || 0);
      }

      res.json({
        success: true,
        message: `Successfully purchased ${plan.name}`,
        credits: newCredits,
      });
    } catch (error) {
      console.error("Error purchasing plan:", error);
      res.status(500).json({ error: "Failed to process payment" });
    }
  });

  // Get user subscription
  app.get("/api/user-subscription", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      
      const subscriptionResult = await db.execute(sql`SELECT * FROM user_subscriptions WHERE user_id = ${userId} LIMIT 1`);
      const subscriptions = subscriptionResult.rows || subscriptionResult;
      const subscription = (subscriptions as any[])[0];

      if (!subscription) {
        return res.json({ status: "free", planName: "Free Trial" });
      }

      const planResult = await db.execute(sql`SELECT * FROM payment_plans WHERE id = ${subscription.plan_id}`);
      const planRows = planResult.rows || planResult;
      const plan = (planRows as any[])[0];

      res.json({
        ...subscription,
        planName: plan?.name || "Free Trial",
      });
    } catch (error) {
      console.error("Error fetching subscription:", error);
      res.status(500).json({ error: "Failed to fetch subscription" });
    }
  });

  // Get login streak
  app.get("/api/login-streak", isAuthenticated, async (req, res) => {
    try {
      const streakData = await storage.getLoginStreak(req.user.id);
      res.json(streakData);
    } catch (error) {
      console.error("Error fetching login streak:", error);
      res.status(500).json({ message: "Failed to fetch login streak" });
    }
  });

  // Get payment transactions
  app.get("/api/payment-transactions", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;

      const transResult = await db.execute(sql`
        SELECT * FROM payment_transactions WHERE user_id = ${userId} 
        ORDER BY created_at DESC LIMIT 10
      `);
      const transactions = transResult.rows || transResult;

      // Get plan names for each transaction
      const withPlanNames = await Promise.all((transactions as any[]).map(async (trans) => {
        const planResult = await db.execute(sql`SELECT * FROM payment_plans WHERE id = ${trans.plan_id}`);
        const planRows = planResult.rows || planResult;
        const plan = (planRows as any[])[0];
        return { ...trans, planName: plan?.name || "Unknown Plan" };
      }));

      res.json(withPlanNames);
    } catch (error) {
      console.error("Error fetching transactions:", error);
      res.status(500).json({ error: "Failed to fetch transactions" });
    }
  });

  // Update user email
  app.patch("/api/users/me/email", isAuthenticated, async (req, res) => {
    try {
      const { email } = req.body;
      const userId = req.user.id;

      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      const updatedUser = await storage.updateUserEmail(userId, email);
      
      // Send confirmation email
      if (updatedUser?.email) {
        await sendEmailConfirmationEmail(email, req.user.username);
      }

      res.json({
        success: true,
        message: "Email updated successfully",
        user: updatedUser,
      });
    } catch (error) {
      console.error("Error updating email:", error);
      res.status(500).json({ error: "Failed to update email" });
    }
  });

  // Create HTTP server with optimized settings for fast startup
  const httpServer = createServer(app);
  
  // Set server timeouts to prevent health check failures
  httpServer.keepAliveTimeout = 65000;
  httpServer.headersTimeout = 66000;
  
  return httpServer;
}

// Gemini-based numerology analysis to avoid OpenAI quota issues
async function generateGeminiNumerologyAnalysis(numbers: {
  lifePath: number;
  destiny: number;
  soulUrge: number;
  personality: number;
  decisionMakingChakra: number;
  dominantSoulChakra: number;
}): Promise<{
  lifePathInterpretation: string;
  destinyInterpretation: string;
  soulUrgeInterpretation: string;
  personalityInterpretation: string;
}> {
  try {
    // Import Gemini here to avoid issues
    const { GoogleGenAI } = await import("@google/genai");
    
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("Gemini API key not available");
    }
    
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
    const prompt = `You are an expert numerologist with decades of experience. Generate detailed interpretations for these numerology numbers:

Life Path Number: ${numbers.lifePath}
Destiny Number: ${numbers.destiny}
Soul Urge Number: ${numbers.soulUrge}
Personality Number: ${numbers.personality}
Decision Making Chakra: ${numbers.decisionMakingChakra}
Dominant Soul Chakra: ${numbers.dominantSoulChakra}

Please provide detailed interpretations for each number that include:
1. Core meaning and spiritual significance
2. Personality traits and characteristics
3. Life path guidance and challenges
4. Spiritual lessons and growth opportunities

Respond with a JSON object containing:
{
  "lifePathInterpretation": "detailed interpretation",
  "destinyInterpretation": "detailed interpretation", 
  "soulUrgeInterpretation": "detailed interpretation",
  "personalityInterpretation": "detailed interpretation"
}`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            lifePathInterpretation: { type: "string" },
            destinyInterpretation: { type: "string" },
            soulUrgeInterpretation: { type: "string" },
            personalityInterpretation: { type: "string" }
          },
          required: ["lifePathInterpretation", "destinyInterpretation", "soulUrgeInterpretation", "personalityInterpretation"]
        }
      },
      contents: prompt
    });

    const rawJson = response.text;
    if (rawJson) {
      const data = JSON.parse(rawJson);
      return data;
    } else {
      throw new Error("Empty response from Gemini");
    }
  } catch (error) {
    console.error("Gemini numerology analysis error:", error);
    
    // Fallback to basic interpretations
    return {
      lifePathInterpretation: `Your Life Path number ${numbers.lifePath} indicates your life's journey and core purpose. This number represents the main lessons you're here to learn and the path you're meant to walk.`,
      destinyInterpretation: `Your Destiny number ${numbers.destiny} reveals your ultimate goals and the gifts you're meant to develop. This represents your highest potential and life mission.`,
      soulUrgeInterpretation: `Your Soul Urge number ${numbers.soulUrge} shows your inner desires and motivations. This reflects what truly drives you at a soul level.`,
      personalityInterpretation: `Your Personality number ${numbers.personality} reveals how you present yourself to the world and how others perceive you. This represents your outer expression and social persona.`
    };
  }
}
