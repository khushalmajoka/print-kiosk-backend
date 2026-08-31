/**
 * middleware/requireAgentAuth.js
 *
 * Authenticates the Local Agent (the Windows PC at the shop counter) —
 * separate from the shopkeeper's own login. The agent sends its shopId
 * and a long random agent key (stored in its config.json) with every
 * request, verified against the hash stored on the Shop document.
 *
 * Exports both an Express middleware (for routes where shopId is a query
 * param, like GET /orders/pending) and a plain verifyAgentKey() helper
 * (for routes like POST /orders/:id/status where shopId comes from the
 * request body instead).
 */

const bcrypt = require("bcryptjs");
const Shop = require("../models/Shop");

/**
 * Checks the agent's shopId + agentKey and tells you *why* it failed,
 * not just whether it did. This makes debugging config.json mismatches
 * (wrong shopId after a rename, stale/rotated key, etc.) much faster —
 * both from server logs and from the error message the agent prints.
 *
 * Returns: { ok: boolean, reason: string|null, shop: ShopDoc|null }
 * reason is one of: "missing-fields" | "shop-not-found" | "invalid-key" | null (when ok)
 */
async function checkAgentAuth(shopId, agentKey) {
  if (!shopId || !agentKey) {
    return { ok: false, reason: "missing-fields", shop: null };
  }

  const shop = await Shop.findOne({ shopId });
  if (!shop || !shop.agentKeyHash) {
    // Most common cause: shopId in config.json is outdated (shop was
    // renamed via "change Shop ID" but config.json wasn't updated to match).
    return { ok: false, reason: "shop-not-found", shop: null };
  }

  const keyMatches = await bcrypt.compare(agentKey, shop.agentKeyHash);
  if (!keyMatches) {
    // shopId is valid, but the key doesn't match this shop's stored hash —
    // most common cause: key was rotated from the Admin Dashboard since
    // config.json was last updated.
    return { ok: false, reason: "invalid-key", shop: null };
  }

  return { ok: true, reason: null, shop };
}

const AGENT_AUTH_ERROR_MESSAGES = {
  "missing-fields": "shopId ya agent key request mein missing hai.",
  "shop-not-found":
    "Ye shopId backend mein nahi mila. Agar Shop ID recently change hui hai, config.json mein shop_id update karo.",
  "invalid-key":
    "Agent key is shop ke liye match nahi hui. Ho sakta hai key rotate ho gayi ho — Admin Dashboard se fresh key generate karke config.json update karo.",
};

// Backward-compatible boolean helper (still used by routes that only need a yes/no).
async function verifyAgentKey(shopId, agentKey) {
  const result = await checkAgentAuth(shopId, agentKey);
  return result.ok;
}

async function requireAgentAuth(req, res, next) {
  try {
    const shopId = req.query.shopId || req.body.shopId;
    const agentKey = req.header("x-agent-key");

    const result = await checkAgentAuth(shopId, agentKey);
    if (!result.ok) {
      console.warn(
        `Agent auth rejected for shopId="${shopId}": ${result.reason}`
      );
      return res.status(401).json({
        error: AGENT_AUTH_ERROR_MESSAGES[result.reason],
        reason: result.reason,
      });
    }
    next();
  } catch (err) {
    console.error("Agent auth check failed", err);
    res.status(500).json({ error: "Agent auth check failed." });
  }
}

module.exports = { requireAgentAuth, verifyAgentKey, checkAgentAuth, AGENT_AUTH_ERROR_MESSAGES };
