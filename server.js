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
 * If the shopkeeper doesn't approve within ORDER_EXPIRY_MINUTES, a background
 * sweep marks the order "expired" so it doesn't sit in the queue forever.
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
const { PDFDocument } = require("pdf-lib");
const streamifier = require("streamifier");
const jwt = require("jsonwebtoken");
const Order = require("./models/Order");
const Shop = require("./models/Shop");
const shopsRouter = require("./routes/shops");
const requireShopAuth = require("./middleware/requireShopAuth");
const { requireAgentAuth, checkAgentAuth, AGENT_AUTH_ERROR_MESSAGES } = require("./middleware/requireAgentAuth");
const pricing = require("./utils/pricing");

const app = express();
const PORT = process.env.PORT || 3000;

// How long a shopkeeper has to approve an order before it auto-expires.
const ORDER_EXPIRY_MINUTES = 10;
// How often the expiry sweep checks for stale orders.
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 1000;

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

// multer stores the incoming file in memory temporarily before we stream it to Cloudinary.
// A hard size limit is enforced here too (not just in the frontend), so a
// direct API call can't bypass the Cloudinary free-tier per-file cap.
// Only PDFs are accepted — this is a print kiosk, not a general file host.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: pricing.MAX_FILE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("NOT_A_PDF"));
    }
    cb(null, true);
  },
});

/**
 * Wraps multer's upload.single("file") so a rejected/oversized file returns
 * a clean JSON error instead of multer's default plain-text/HTML response.
 */
function uploadSingleFile(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: `File is too large. The maximum allowed size is ${pricing.MAX_FILE_SIZE_MB}MB per file.`,
        });
      }
      if (err.message === "NOT_A_PDF") {
        return res.status(400).json({ error: "Only PDF files are supported. Please upload a .pdf file." });
      }
      console.error("File upload error:", err);
      return res.status(400).json({ error: "File upload failed." });
    }
    next();
  });
}

// ---- Shop routes: register, list, public lookup, login, change-pin, change-shop-id ----
app.use(shopsRouter);

/**
 * GET /health
 * Lightweight endpoint with no DB/Cloudinary work, used purely to keep the
 * Render free-tier instance from going to sleep (and to let the frontend
 * check whether the backend is awake before making a real request).
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * GET /pricing?shopId=shop_001
 * Returns the effective per-page rates and file-size limit for a shop —
 * that shop's own custom rates (Settings -> Print Rates) if they've set
 * any, otherwise the platform defaults. Without a shopId, always returns
 * the platform defaults. The frontend never hardcodes these numbers
 * itself — it always reflects whatever is actually in the database.
 */
app.get("/pricing", async (req, res) => {
  try {
    const { shopId } = req.query;
    const shop = shopId ? await Shop.findOne({ shopId }).select("ratePerPageBW ratePerPageColor") : null;
    const rates = pricing.effectiveRates(shop);

    res.json({
      ratePerPageBW: rates.bw,
      ratePerPageColor: rates.color,
      maxFileSizeMB: pricing.MAX_FILE_SIZE_MB,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch pricing." });
  }
});

/**
 * POST /upload
 * Accepts a single file (form field name: "file") and uploads it to Cloudinary.
 * Returns the hosted URL, which the frontend then includes in the order it creates.
 *
 * If the file is a PDF, also detects and returns its actual page count
 * (pageCount) — the frontend can use this to pre-fill/validate the "pages"
 * field instead of the customer typing it in manually. If detection fails
 * (corrupt file, password-protected PDF, non-PDF file, etc.) pageCount is
 * returned as null and the frontend should fall back to manual entry —
 * upload still succeeds either way.
 */
app.post("/upload", uploadSingleFile, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file provided." });
  }

  // fileFilter above already guarantees this is a PDF by mimetype, but that
  // only checks the declared Content-Type — it says nothing about whether
  // the file is actually a valid, readable PDF. Try to actually parse it:
  // this is also where corrupted files and password-protected PDFs get
  // caught and rejected with a clear reason, instead of silently accepting
  // a file the Local Agent won't be able to print later.
  let pageCount;
  try {
    const pdfDoc = await PDFDocument.load(req.file.buffer);
    pageCount = pdfDoc.getPageCount();
  } catch (err) {
    const message = (err && err.message) || "";
    if (message.toLowerCase().includes("encrypt")) {
      return res.status(400).json({
        error: "This PDF is password-protected. Please remove the password and upload it again.",
      });
    }
    console.warn(`Rejected unreadable PDF "${req.file.originalname}": ${message}`);
    return res.status(400).json({
      error: "This PDF appears to be corrupted or invalid. Please try re-saving or re-exporting it and upload again.",
    });
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
      res.json({ fileUrl: result.secure_url, fileName: req.file.originalname, pageCount });
    }
  );

  streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
});

/**
 * POST /orders/estimate
 * Stateless price preview — same pricing logic as order creation, but
 * doesn't touch the database. The Customer UI calls this so the total it
 * shows always matches utils/pricing.js exactly (no duplicated formula),
 * and always reflects that specific shop's own rates if they've set any.
 *
 * Expected body: { shopId, files: [{ pages, copies, color, pageCount }] }
 */
app.post("/orders/estimate", async (req, res) => {
  try {
    const { shopId, files } = req.body;
    if (!files || !Array.isArray(files)) {
      return res.status(400).json({ error: "A files array is required." });
    }
    const shop = shopId ? await Shop.findOne({ shopId }).select("ratePerPageBW ratePerPageColor") : null;
    const rates = pricing.effectiveRates(shop);
    res.json({ estimatedPrice: pricing.calculateOrderPrice(files, rates) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to calculate estimate." });
  }
});

/**
 * POST /orders
 * Create a new order. Starts as "awaiting_approval" — the shopkeeper must
 * approve it (after collecting payment in person) before it gets printed.
 * Auto-expires to "expired" if not approved within ORDER_EXPIRY_MINUTES
 * (see the sweep near the bottom of this file).
 *
 * Expected body:
 * {
 *   "shopId": "shop_001",
 *   "files": [
 *     { "fileUrl": "...", "fileName": "resume.pdf", "pages": "1-2", "copies": 1, "color": false, "pageCount": 2 }
 *   ]
 * }
 */
app.post("/orders", async (req, res) => {
  try {
    const { shopId, files } = req.body;

    if (!shopId || !files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "shopId and a non-empty files array are required." });
    }

    const shop = await Shop.findOne({ shopId }).select("ratePerPageBW ratePerPageColor");
    const rates = pricing.effectiveRates(shop);
    const estimatedPrice = pricing.calculateOrderPrice(files, rates);

    const newOrder = await Order.create({ shopId, files, estimatedPrice });

    console.log(`New order created: #${newOrder._id} for ${shopId} (awaiting approval)`);
    res.status(201).json(newOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create order." });
  }
});

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
 * must belong to the shop that's logged in. An order that already auto-expired
 * can no longer be approved — the customer needs to place a new one.
 */
app.post("/orders/:id/approve", requireShopAuth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });
    if (order.shopId !== req.auth.shopId) {
      return res.status(403).json({ error: "Not authorized for this order." });
    }
    if (order.status === "expired") {
      return res.status(409).json({ error: "This order has expired and can no longer be approved." });
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

    const authResult = await checkAgentAuth(shopId, agentKey);
    if (!authResult.ok) {
      console.warn(`Agent auth rejected for shopId="${shopId}": ${authResult.reason}`);
      return res.status(401).json({
        error: AGENT_AUTH_ERROR_MESSAGES[authResult.reason],
        reason: authResult.reason,
      });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });
    if (order.shopId !== shopId) {
      return res.status(403).json({ error: "This order does not belong to your shop." });
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
      if (!token) return res.status(401).json({ error: "Login required." });

      let payload;
      try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
      } catch (e) {
        return res.status(401).json({ error: "Your session has expired. Please log in again." });
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

/**
 * Background sweep: auto-expires any order still "awaiting_approval" after
 * ORDER_EXPIRY_MINUTES. Runs on an interval rather than per-request so it
 * catches orders even if nobody happens to poll around them.
 */
async function expireStaleOrders() {
  try {
    const cutoff = new Date(Date.now() - ORDER_EXPIRY_MINUTES * 60 * 1000);
    const result = await Order.updateMany(
      { status: "awaiting_approval", createdAt: { $lt: cutoff } },
      { status: "expired", statusMessage: "Shop did not approve this order in time." }
    );
    if (result.modifiedCount > 0) {
      console.log(`Expired ${result.modifiedCount} order(s) past the ${ORDER_EXPIRY_MINUTES}-minute approval window.`);
    }
  } catch (err) {
    console.error("Order expiry sweep failed:", err);
  }
}
setInterval(expireStaleOrders, EXPIRY_SWEEP_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`Print kiosk backend running on http://localhost:${PORT}`);
});
