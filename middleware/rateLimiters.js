/**
 * middleware/rateLimiters.js
 *
 * Central place for all rate limiters, so the numbers are easy to find
 * and tune in one spot instead of scattered across route files.
 *
 * Uses express-rate-limit (in-memory store — resets on server restart,
 * and each Render instance tracks its own counts independently. That's
 * fine for a single-instance deployment; if this ever runs on multiple
 * instances behind a load balancer, switch to a shared store like
 * rate-limit-redis so all instances share one counter).
 */

const rateLimit = require("express-rate-limit");

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/**
 * Broad safety net applied to every request. Generous enough that no
 * normal usage pattern (dashboard polling every 5s, etc.) ever comes
 * close to it — this exists purely to blunt a runaway script or bot.
 */
const generalLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests from this device. Please slow down and try again in a few minutes." },
});

/**
 * Shopkeeper login. PINs are only 4-6 digits, so this is the route most
 * exposed to brute-force guessing — without a limiter here, an attacker
 * who knows (or guesses) a Shop ID could try thousands of PINs a minute.
 *
 * skipSuccessfulRequests: true means only *failed* login attempts count
 * against the limit, so a shopkeeper who logs in correctly is never
 * penalized — the limit only kicks in for repeated wrong PINs.
 */
const loginLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  max: 15,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many failed login attempts. Please wait 15 minutes and try again." },
});

/**
 * File upload and order creation. Prevents someone from spamming fake
 * orders into a shop's queue, or burning through the Cloudinary free-tier
 * upload quota with junk files.
 */
const writeLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a few minutes and try again." },
});

module.exports = { generalLimiter, loginLimiter, writeLimiter };
