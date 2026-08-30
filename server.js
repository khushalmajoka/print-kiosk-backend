/**
 * server.js
 *
 * Express backend for the print kiosk system.
 *
 * Flow (payment handled offline by shop owner for now):
 * 1. Customer uploads files + settings -> order created as "awaiting_approval"
 * 2. Shopkeeper sees it on their dashboard, collects payment in person, clicks Approve
 * 3. Order becomes "pending" -> Local Agent picks it up, prints it, reports back
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");
const streamifier = require("streamifier");
const Order = require("./models/Order");
const Shop = require("./models/Shop");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());           // allow the frontend (different port) to call this API
app.use(express.json());

/**
 * Simple admin authentication — protects shop registration and the
 * cross-shop admin views. Not full auth (no per-admin accounts), but
 * enough to stop random people from registering shops or listing them.
 * The admin frontend sends this key in the "x-admin-key" header.
 */
function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  next();
}

// ---- Connect to MongoDB ----
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// ---- Configure Cloudinary ----
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// multer stores the incoming file in memory temporarily before we stream it to Cloudinary
const upload = multer({ storage: multer.memoryStorage() });

// Simple pricing — adjust these rates to whatever the shop charges
const RATE_PER_PAGE_BW = 2;      // ₹2 per page black & white
const RATE_PER_PAGE_COLOR = 10;  // ₹10 per page color

/**
 * POST /shops/register
 * Onboards a new shop. shopId is auto-generated from the shop name
 * (lowercased, hyphenated) with a random suffix to keep it unique.
 *
 * Expected body: { "shopName": "Sharma Xerox & Stationers", "ownerPhone": "9876543210", "city": "Panipat" }
 */
app.post("/shops/register", requireAdmin, async (req, res) => {
  try {
    const { shopName, ownerPhone, city } = req.body;
    if (!shopName) return res.status(400).json({ error: "shopName is required." });

    const slug = shopName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const suffix = Math.random().toString(36).slice(2, 6);
    const shopId = `${slug}-${suffix}`;

    const shop = await Shop.create({ shopId, shopName, ownerPhone, city });
    console.log(`New shop registered: ${shop.shopName} (${shop.shopId})`);
    res.status(201).json(shop);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to register shop." });
  }
});

/**
 * GET /shops
 * Admin-only — lists every registered shop, each with a quick stats summary
 * (total orders, completed, pending approval, estimated revenue from
 * completed orders). Used by the admin dashboard.
 */
app.get("/shops", requireAdmin, async (req, res) => {
  try {
    const shops = await Shop.find().sort({ createdAt: -1 });

    const shopsWithStats = await Promise.all(
      shops.map(async (shop) => {
        const orders = await Order.find({ shopId: shop.shopId });
        const completed = orders.filter((o) => o.status === "completed");
        const awaitingApproval = orders.filter((o) => o.status === "awaiting_approval");

        return {
          ...shop.toObject(),
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
 * Used by the customer and shopkeeper UIs to display the shop's name.
 */
app.get("/shops/:shopId", async (req, res) => {
  try {
    const shop = await Shop.findOne({ shopId: req.params.shopId });
    if (!shop) return res.status(404).json({ error: "Shop not found." });
    res.json(shop);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch shop." });
  }
});

/**
 * POST /upload
 * Accepts a single file (form field name: "file") and uploads it to Cloudinary.
 * Returns the hosted URL, which the frontend then includes in the order it creates.
 */
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file provided." });
  }

  const uploadStream = cloudinary.uploader.upload_stream(
    {
      resource_type: "raw",       // PDFs are not images, so "raw" is correct
      folder: "print-kiosk-uploads",
    },
    (error, result) => {
      if (error) {
        console.error("Cloudinary upload error:", error);
        return res.status(500).json({ error: "Upload failed." });
      }
      res.json({ fileUrl: result.secure_url, fileName: req.file.originalname });
    }
  );

  streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
});

/**
 * POST /orders
 * Create a new order. Starts as "awaiting_approval" — the shopkeeper must
 * approve it (after collecting payment in person) before it gets printed.
 *
 * Expected body:
 * {
 *   "shopId": "shop_001",
 *   "files": [
 *     { "fileUrl": "...", "fileName": "resume.pdf", "pages": "1-2", "copies": 1, "color": false }
 *   ]
 * }
 */
app.post("/orders", async (req, res) => {
  try {
    const { shopId, files } = req.body;

    if (!shopId || !files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "shopId and a non-empty files array are required." });
    }

    // Very simple price estimate — assumes 1 page per file if "pages" isn't a range.
    // This is informational only for now; real page-count detection comes later.
    let estimatedPrice = 0;
    for (const f of files) {
      const pageCount = estimatePageCount(f.pages);
      const rate = f.color ? RATE_PER_PAGE_COLOR : RATE_PER_PAGE_BW;
      estimatedPrice += pageCount * rate * (f.copies || 1);
    }

    const newOrder = await Order.create({ shopId, files, estimatedPrice });

    console.log(`New order created: #${newOrder._id} for ${shopId} (awaiting approval)`);
    res.status(201).json(newOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create order." });
  }
});

function estimatePageCount(pagesString) {
  if (!pagesString) return 1; // unknown -> assume 1 page for the estimate
  if (pagesString.includes("-")) {
    const [start, end] = pagesString.split("-").map(Number);
    return Math.max(1, end - start + 1);
  }
  if (pagesString.includes(",")) {
    return pagesString.split(",").length;
  }
  return 1;
}

/**
 * GET /orders/awaiting-approval?shopId=shop_001
 * Shopkeeper dashboard polls this to show new incoming requests.
 */
app.get("/orders/awaiting-approval", async (req, res) => {
  try {
    const { shopId } = req.query;
    if (!shopId) return res.status(400).json({ error: "shopId query param is required." });

    const orders = await Order.find({ shopId, status: "awaiting_approval" }).sort({ createdAt: 1 });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch orders." });
  }
});

/**
 * POST /orders/:id/approve
 * Shopkeeper approves an order (payment collected in person) -> moves to "pending"
 * so the Local Agent picks it up and prints it.
 */
app.post("/orders/:id/approve", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });

    order.status = "pending";
    await order.save();

    console.log(`Order #${order._id} approved -> pending`);
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to approve order." });
  }
});

/**
 * POST /orders/:id/reject
 * Shopkeeper rejects an order (e.g. can't fulfil it, customer didn't pay, etc).
 */
app.post("/orders/:id/reject", async (req, res) => {
  try {
    const { reason } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });

    order.status = "rejected";
    if (reason) order.statusMessage = reason;
    await order.save();

    console.log(`Order #${order._id} rejected`);
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reject order." });
  }
});

/**
 * GET /orders/pending?shopId=shop_001
 * Local Agent polls this — only approved (status: "pending") orders show up here.
 */
app.get("/orders/pending", async (req, res) => {
  try {
    const { shopId } = req.query;
    if (!shopId) return res.status(400).json({ error: "shopId query param is required." });

    const pendingOrders = await Order.find({ shopId, status: "pending" });
    res.json(pendingOrders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch pending orders." });
  }
});

/**
 * POST /orders/:id/status
 * Local Agent calls this after attempting to print, to report the outcome.
 */
app.post("/orders/:id/status", async (req, res) => {
  try {
    const { status, message } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });

    order.status = status;
    if (message) order.statusMessage = message;
    await order.save();

    console.log(`Order #${order._id} status updated to: ${status}`);
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update order status." });
  }
});

/**
 * GET /orders?shopId=shop_001
 * Full order history for a shop — used by the shopkeeper dashboard.
 * Without a shopId, this would return every order across all shops,
 * so that case requires the admin key.
 */
app.get("/orders", async (req, res) => {
  try {
    const { shopId } = req.query;

    if (!shopId) {
      const key = req.header("x-admin-key");
      if (!key || key !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: "shopId is required, or use an admin key to fetch all orders." });
      }
    }

    const filter = shopId ? { shopId } : {};
    const orders = await Order.find(filter).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch orders." });
  }
});

/**
 * GET /orders/:id
 * Single order lookup — used by the customer's "track my order" page.
 */
app.get("/orders/:id", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch order." });
  }
});

app.listen(PORT, () => {
  console.log(`Print kiosk backend running on http://localhost:${PORT}`);
});