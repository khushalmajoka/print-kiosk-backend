const jwt = require("jsonwebtoken");

function requireShopAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Login required." });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.auth = payload; // { shopId }
    next();
  } catch (e) {
    return res.status(401).json({ error: "Your session has expired. Please log in again." });
  }
}

module.exports = requireShopAuth;
