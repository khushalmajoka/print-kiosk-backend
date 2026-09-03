/**
 * routes/shops.js
 *
 * All shop-related routes:
 * - Admin: register a shop, list all shops with stats
 * - Public: look up a single shop's name (for customer/shopkeeper UIs)
 * - Shopkeeper self-service: login, change PIN, change Shop ID
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const crypto = require("crypto");

const Shop = require("../models/Shop");
const Order = require("../models/Order");
const requireAdmin = require("../middleware/requireAdmin");
const requireShopAuth = require("../middleware/requireShopAuth");
const { loginLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

function slugify(shopName) {
  const slug = shopName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${slug}-${suffix}`;
}

/**
 * POST /shops/register
 * Admin-only. Onboards a new shop with an auto-generated shopId and an
 * initial PIN (defaults to "123456" if none given — shopkeeper should
 * change it after first login).
 *
 * Expected body: { shopName, ownerPhone, city, email, initialPin }
 */
router.post("/shops/register", requireAdmin, async (req, res) => {
  try {
    const { shopName, ownerPhone, city, email, initialPin } = req.body;
    if (!shopName) return res.status(400).json({ error: "shopName is required." });

    const shopId = slugify(shopName);
    const pinHash = await bcrypt.hash(initialPin || "123456", 10);

    const shop = await Shop.create({ shopId, shopName, ownerPhone, city, email, pinHash });
    console.log(`New shop registered: ${shop.shopName} (${shop.shopId})`);
    res.status(201).json(shop);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to register shop." });
  }
});

/**
 * GET /shops
 * Admin-only — lists every registered shop with a quick stats summary.
 */
router.get("/shops", requireAdmin, async (req, res) => {
  try {
    const shops = await Shop.find().sort({ createdAt: -1 });

    const shopsWithStats = await Promise.all(
      shops.map(async (shop) => {
        const orders = await Order.find({ shopId: shop.shopId });
        const completed = orders.filter((o) => o.status === "completed");
        const awaitingApproval = orders.filter((o) => o.status === "awaiting_approval");

        const shopObj = shop.toObject();
        delete shopObj.pinHash; // never expose the hash, even to the admin UI

        return {
          ...shopObj,
          stats: {
            totalOrders: orders.length,
            completedOrders: completed.length,
            awaitingApproval: awaitingApproval.length,
            estimatedRevenue: completed.reduce((sum, o) => sum + (o.estimatedPrice || 0), 0),
          },
        };
      })
    );

    res.json(shopsWithStats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch shops." });
  }
});

/**
 * GET /shops/:shopId
 * Public — used by customer and shopkeeper UIs to display the shop's name.
 */
router.get("/shops/:shopId", async (req, res) => {
  try {
    const shop = await Shop.findOne({ shopId: req.params.shopId }).select("-pinHash");
    if (!shop) return res.status(404).json({ error: "Shop not found." });
    res.json(shop);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch shop." });
  }
});

/**
 * POST /shops/login
 * Shopkeeper login — Shop ID + PIN -> JWT token (valid 30 days).
 */
router.post("/shops/login", loginLimiter, async (req, res) => {
  try {
    const { shopId, pin } = req.body;
    if (!shopId || !pin) {
      return res.status(400).json({ error: "Shop ID and PIN are both required." });
    }

    const shop = await Shop.findOne({ shopId });
    if (!shop || !shop.pinHash) {
      return res.status(401).json({ error: "Incorrect Shop ID or PIN." });
    }

    const valid = await bcrypt.compare(pin, shop.pinHash);
    if (!valid) {
      return res.status(401).json({ error: "Incorrect Shop ID or PIN." });
    }

    const token = jwt.sign({ shopId: shop.shopId }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });

    res.json({ token, shopId: shop.shopId, shopName: shop.shopName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed." });
  }
});

/**
 * POST /shops/:shopId/change-pin
 * Logged-in shopkeeper changes their own PIN.
 */
router.post("/shops/:shopId/change-pin", requireShopAuth, async (req, res) => {
  try {
    const { shopId } = req.params;
    if (req.auth.shopId !== shopId) {
      return res.status(403).json({ error: "Not authorized." });
    }

    const { oldPin, newPin } = req.body;
    if (!/^\d{4,6}$/.test(newPin || "")) {
      return res.status(400).json({ error: "New PIN must be a 4-6 digit number." });
    }

    const shop = await Shop.findOne({ shopId });
    const valid = await bcrypt.compare(oldPin || "", shop.pinHash);
    if (!valid) {
      return res.status(401).json({ error: "Current PIN is incorrect." });
    }

    shop.pinHash = await bcrypt.hash(newPin, 10);
    await shop.save();

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "PIN change failed." });
  }
});

/**
 * PATCH /shops/:shopId/shop-id
 * Logged-in shopkeeper renames their own Shop ID. Updates every existing
 * order to the new shopId inside a transaction, so order history doesn't
 * get orphaned under the old shopId.
 *
 * Note: the old JWT (which has the old shopId baked in) stops matching
 * after this — the shopkeeper frontend must log the user out and prompt
 * a fresh login with the new Shop ID.
 */
router.patch("/shops/:shopId/shop-id", requireShopAuth, async (req, res) => {
  const { shopId } = req.params;
  if (req.auth.shopId !== shopId) {
    return res.status(403).json({ error: "Not authorized." });
  }

  const { newShopId } = req.body;
  if (!newShopId || !/^[a-z0-9-]{3,40}$/.test(newShopId)) {
    return res.status(400).json({
      error: "Shop ID can only contain lowercase letters, numbers, and hyphens (minimum 3 characters).",
    });
  }

  if (newShopId === shopId) {
    return res.status(400).json({ error: "That's already your current Shop ID." });
  }

  const existing = await Shop.findOne({ shopId: newShopId });
  if (existing) {
    return res.status(409).json({ error: "This Shop ID is already taken." });
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const result = await Shop.updateOne({ shopId }, { shopId: newShopId }, { session });
      if (result.matchedCount === 0) {
        throw new Error("Shop not found");
      }
      await Order.updateMany({ shopId }, { shopId: newShopId }, { session });
    });

    res.json({ success: true, newShopId });
  } catch (e) {
    console.error("Shop ID change failed", e);
    res.status(500).json({ error: "Shop ID change failed. Please try again." });
  } finally {
    session.endSession();
  }
});

/**
 * PATCH /shops/:shopId/pricing
 * Logged-in shopkeeper sets their own per-page print rates (Settings ->
 * Print Rates). Send null (or omit/empty-string) for a field to clear it
 * back to the platform default instead of a custom value.
 *
 * Expected body: { ratePerPageBW, ratePerPageColor } — either field optional.
 */
router.patch("/shops/:shopId/pricing", requireShopAuth, async (req, res) => {
  try {
    const { shopId } = req.params;
    if (req.auth.shopId !== shopId) {
      return res.status(403).json({ error: "Not authorized." });
    }

    const { ratePerPageBW, ratePerPageColor } = req.body;
    const updates = {};

    for (const [field, value] of Object.entries({ ratePerPageBW, ratePerPageColor })) {
      if (value === null || value === undefined || value === "") {
        updates[field] = null; // explicit clear -> falls back to the platform default
        continue;
      }
      const num = Number(value);
      if (isNaN(num) || num <= 0) {
        return res.status(400).json({ error: `${field} must be a positive number.` });
      }
      updates[field] = num;
    }

    const shop = await Shop.findOneAndUpdate({ shopId }, updates, { new: true }).select("-pinHash");
    if (!shop) return res.status(404).json({ error: "Shop not found." });

    res.json(shop);
  } catch (err) {
    console.error("Pricing update failed", err);
    res.status(500).json({ error: "Failed to update print rates." });
  }
});

/**
 * POST /shops/:shopId/admin-reset-pin
 * Admin-only. For when a shopkeeper forgets their PIN — they call/message
 * you, you hit this from the Admin Dashboard, and it generates a fresh
 * random PIN which you read out to them over the phone. No email service
 * needed. The plain PIN is only ever visible in this one response —
 * only the hash is stored afterwards.
 */
router.post("/shops/:shopId/admin-reset-pin", requireAdmin, async (req, res) => {
  try {
    const { shopId } = req.params;
    const shop = await Shop.findOne({ shopId });
    if (!shop) return res.status(404).json({ error: "Shop not found." });

    // 6-digit random PIN, e.g. "042817"
    const newPin = Math.floor(100000 + Math.random() * 900000).toString();
    shop.pinHash = await bcrypt.hash(newPin, 10);
    await shop.save();

    console.log(`Admin reset PIN for shop: ${shop.shopName} (${shop.shopId})`);
    res.json({ success: true, newPin }); // only place the plain PIN is ever returned
  } catch (err) {
    console.error("Admin PIN reset failed", err);
    res.status(500).json({ error: "PIN reset failed. Please try again." });
  }
});

/**
 * POST /shops/:shopId/agent-key
 * Admin-only. Generates a fresh random agent key for a shop's Local Agent
 * and stores its hash. The plain key is only ever shown in this one
 * response — paste it into that shop's config.json ("agent_key" field).
 * Calling this again rotates the key, invalidating the old one.
 */
router.post("/shops/:shopId/agent-key", requireAdmin, async (req, res) => {
  try {
    const { shopId } = req.params;
    const shop = await Shop.findOne({ shopId });
    if (!shop) return res.status(404).json({ error: "Shop not found." });

    const agentKey = crypto.randomBytes(24).toString("hex");
    shop.agentKeyHash = await bcrypt.hash(agentKey, 10);
    await shop.save();

    console.log(`Agent key generated for shop: ${shop.shopName} (${shop.shopId})`);
    res.json({ success: true, agentKey });
  } catch (err) {
    console.error("Agent key generation failed", err);
    res.status(500).json({ error: "Failed to generate agent key." });
  }
});

module.exports = router;
