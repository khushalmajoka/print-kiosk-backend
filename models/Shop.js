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
}, {
  timestamps: true,
});

module.exports = mongoose.model("Shop", shopSchema);