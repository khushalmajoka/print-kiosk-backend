/**
 * server.js
 *
 * Express backend for the print kiosk system.
 *
 * Flow (payment handled offline by shop owner for now):
 * 1. Customer uploads files + settings -> order created as "awaiting_approval"
 * 2. Shopkeeper sees it on their dashboard, collects payment in person, clicks Approve
 * 3. Order becomes "pending" -> Local Agent picks it up, prints it, reports back
 *
 * Shop registration, shop listing, and shopkeeper self-service auth
 * (login / change PIN / change Shop ID) now live in routes/shops.js.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");
const streamifier = require("streamifier");
const jwt = require("jsonwebtoken");
const Order = require("./models/Order");
const shopsRouter = require("./routes/shops");
const requireShopAuth = require("./middleware/requireShopAuth");
const { requireAgentAuth, verifyAgentKey } = require("./middleware/requireAgentAuth");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());           // allow the frontend (different port) to call this API
app.use(express.json());

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

// ---- Shop routes: register, list, public lookup, login, change-pin, change-shop-id ----
app.use(shopsRouter);

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
 * Requires the shopkeeper's own login token, matching this exact shopId.
 */
app.get("/orders/awaiting-approval", requireShopAuth, async (req, res) => {
  try {
    const { shopId } = req.query;
    if (!shopId) return res.status(400).json({ error: "shopId query param is required." });
    if (req.auth.shopId !== shopId) {
      return res.status(403).json({ error: "Not authorized for this shop." });
    }

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
 * so the Local Agent picks it up and prints it. Requires login, and the order
 * must belong to the shop that's logged in.
 */
app.post("/orders/:id/approve", requireShopAuth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });
    if (order.shopId !== req.auth.shopId) {
      return res.status(403).json({ error: "Not authorized for this order." });
    }

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
 * Requires login, and the order must belong to the shop that's logged in.
 */
app.post("/orders/:id/reject", requireShopAuth, async (req, res) => {
  try {
    const { reason } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });
    if (order.shopId !== req.auth.shopId) {
      return res.status(403).json({ error: "Not authorized for this order." });
    }

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
 * Requires that shop's agent key (header: x-agent-key), set up once from
 * the Admin Dashboard and stored in the agent's config.json.
 */
app.get("/orders/pending", requireAgentAuth, async (req, res) => {
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
 * Body must include shopId + agentKey (verified against that shop's agent
 * key) so a random caller can't spoof status updates for someone else's order.
 */
app.post("/orders/:id/status", async (req, res) => {
  try {
    const { status, message, shopId, agentKey } = req.body;

    const ok = await verifyAgentKey(shopId, agentKey);
    if (!ok) {
      return res.status(401).json({ error: "Agent key missing ya invalid hai." });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });
    if (order.shopId !== shopId) {
      return res.status(403).json({ error: "Ye order is shop ka nahi hai." });
    }

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
 * Full order history for a shop — used by the shopkeeper dashboard, so it
 * requires that shop's own login token. Without a shopId, this returns
 * every order across all shops, so that case requires the admin key instead.
 */
app.get("/orders", async (req, res) => {
  try {
    const { shopId } = req.query;

    if (shopId) {
      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!token) return res.status(401).json({ error: "Login required" });

      let payload;
      try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
      } catch (e) {
        return res.status(401).json({ error: "Session expire ho gaya, dobara login karo" });
      }

      if (payload.shopId !== shopId) {
        return res.status(403).json({ error: "Not authorized for this shop." });
      }
    } else {
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
