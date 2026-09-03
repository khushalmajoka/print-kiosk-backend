/**
 * models/Shop.js
 *
 * Represents a shop that has onboarded onto PrintKaro.
 * shopId is a short, unique, URL-friendly code (used in the QR code
 * and by the local agent) — separate from Mongo's internal _id.
 */

const mongoose = require("mongoose");

const shopSchema = new mongoose.Schema({
  shopId: { type: String, required: true, unique: true }, // e.g. "sharma-xerox-01"
  shopName: { type: String, required: true },              // e.g. "Sharma Xerox & Stationers"
  ownerPhone: { type: String, default: null },
  city: { type: String, default: null },
  email: { type: String, default: null },                  // used for forgot-PIN reset
  pinHash: { type: String, default: null },                 // bcrypt hash — plain PIN never stored
  agentKeyHash: { type: String, default: null },            // bcrypt hash of the Local Agent's credential

  // Per-shop print rates, set by the shopkeeper from Settings -> Print Rates.
  // null (the default) means "use the platform default rate" — see
  // utils/pricing.js's effectiveRates().
  ratePerPageBW: { type: Number, default: null },
  ratePerPageColor: { type: Number, default: null },
}, {
  timestamps: true,
});

module.exports = mongoose.model("Shop", shopSchema);
