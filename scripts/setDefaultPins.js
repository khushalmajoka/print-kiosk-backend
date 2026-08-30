/**
 * scripts/setDefaultPins.js
 *
 * ONE-TIME migration script.
 * Finds every shop that doesn't have a pinHash yet (existing shops,
 * registered before the login system existed) and sets a default PIN
 * on them, so they can log in and then change it to something of
 * their own from the dashboard.
 *
 * Usage:
 *   node scripts/setDefaultPins.js
 *   node scripts/setDefaultPins.js 999999   <- optional: custom default PIN
 *
 * Safe to run more than once — it only touches shops where pinHash is
 * still null, so shops that already have a PIN set are left untouched.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const Shop = require("../models/Shop");

const DEFAULT_PIN = process.argv[2] || "123456";

async function run() {
  if (!/^\d{4,6}$/.test(DEFAULT_PIN)) {
    console.error("Default PIN must be a 4-6 digit number.");
    process.exit(1);
  }

  console.log("Connecting to MongoDB...");
  await mongoose.connect(process.env.MONGO_URI);

  const shopsWithoutPin = await Shop.find({
    $or: [{ pinHash: null }, { pinHash: { $exists: false } }],
  });

  if (shopsWithoutPin.length === 0) {
    console.log("Sab shops ka pehle se PIN set hai — kuch karne ki zarurat nahi.");
    await mongoose.disconnect();
    return;
  }

  console.log(`${shopsWithoutPin.length} shop(s) mila/mile bina PIN ke:`);
  shopsWithoutPin.forEach((s) => console.log(`  - ${s.shopName} (${s.shopId})`));

  const pinHash = await bcrypt.hash(DEFAULT_PIN, 10);

  const result = await Shop.updateMany(
    { $or: [{ pinHash: null }, { pinHash: { $exists: false } }] },
    { $set: { pinHash } }
  );

  console.log(`\nDone. ${result.modifiedCount} shop(s) ka PIN set ho gaya: "${DEFAULT_PIN}"`);
  console.log("Shopkeepers ko bata dena ye default PIN hai — login karke turant apna naya PIN set kar lein.");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
