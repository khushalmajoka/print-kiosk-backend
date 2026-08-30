/**
 * middleware/requireAdmin.js
 *
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

module.exports = requireAdmin;
