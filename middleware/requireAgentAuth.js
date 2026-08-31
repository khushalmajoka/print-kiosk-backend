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

async function verifyAgentKey(shopId, agentKey) {
  if (!shopId || !agentKey) return false;
  const shop = await Shop.findOne({ shopId });
  if (!shop || !shop.agentKeyHash) return false;
  return bcrypt.compare(agentKey, shop.agentKeyHash);
}

async function requireAgentAuth(req, res, next) {
  try {
    const shopId = req.query.shopId || req.body.shopId;
    const agentKey = req.header("x-agent-key");

    const ok = await verifyAgentKey(shopId, agentKey);
    if (!ok) {
      return res.status(401).json({ error: "Agent key missing ya invalid hai." });
    }
    next();
  } catch (err) {
    console.error("Agent auth check failed", err);
    res.status(500).json({ error: "Agent auth check failed." });
  }
}

module.exports = { requireAgentAuth, verifyAgentKey };
