/**
 * models/Order.js
 *
 * Mongoose schema for a print order.
 *
 * Flow (no payment integration yet — shop owner handles payment offline):
 * awaiting_approval -> pending -> printing -> completed / failed
 *                    \-> rejected
 */

const mongoose = require("mongoose");

// Schema for a single file within an order
const fileSchema = new mongoose.Schema({
  fileUrl: { type: String, required: true },     // Cloudinary URL, or local path for testing
  fileName: { type: String, default: "file.pdf" }, // original name, shown to shopkeeper
  pages: { type: String, default: null },          // e.g. "1-3", null = all pages
  copies: { type: Number, default: 1 },
  color: { type: Boolean, default: true },
});

// Schema for the overall order
const orderSchema = new mongoose.Schema({
  shopId: { type: String, required: true },
  files: { type: [fileSchema], required: true },
  status: {
    type: String,
    enum: ["awaiting_approval", "pending", "printing", "completed", "failed", "rejected"],
    default: "awaiting_approval", // every order starts here — shopkeeper must approve
  },
  statusMessage: { type: String, default: null },
  estimatedPrice: { type: Number, default: 0 }, // simple calculated estimate, informational only
}, {
  timestamps: true,
});

module.exports = mongoose.model("Order", orderSchema);