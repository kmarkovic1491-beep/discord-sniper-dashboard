
const express = require("express");

const app = express();
app.use(express.json({ limit: "2mb" }));

const allowedOrigin = "https://kmarkovic1491-beep.github.io";
const verifiedNames = new Map();
// Respect Discord's upstream 429 response across every visitor using this backend.
const lastWebhookTests = new Map();

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => {
  res.json({
    status: "online",
    checker: "SNIPERS OG API",
    provider: "none",
    liveAvailabilityChecks: false,
    webhookConfigured: Boolean(process.env.DISCORD_WEBHOOK_URL),
  });
});


/* SNIPERS_DISCORD_OAUTH_V1 — OAuth identity only; never accepts Discord passwords. */
const crypto = require("crypto");
const FRONTEND_URL = "https://kmarkovic1491-beep.github.io/discord-sniper-dashboard/";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
function b64url(value) { return Buffer.from(value).toString("base64url"); }
function signSession(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", process.env.DISCORD_SESSION_SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function verifySession(token) {
  if (!process.env.DISCORD_SESSION_SECRET || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac("sha256", process.env.DISCORD_SESSION_SECRET).update(parts[0]).digest();
  let actual;
  try { actual = Buffer.from(parts[1], "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000) || !payload.sub) return null;
    return payload;
  } catch { return null; }
}
function readCookie(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}
function clearOAuthState(res) {
  res.setHeader("Set-Cookie", "snipers_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
}
app.get("/auth/config", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ configured: Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_REDIRECT_URI && process.env.DISCORD_SESSION_SECRET) });
});
app.get("/auth/discord", (req, res) => {
  const { DISCORD_CLIENT_ID, DISCORD_REDIRECT_URI, DISCORD_CLIENT_SECRET, DISCORD_SESSION_SECRET } = process.env;
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI || !DISCORD_SESSION_SECRET) {
    return res.status(503).send("Discord sign-in is not configured. Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI and DISCORD_SESSION_SECRET on the Render backend.");
  }
  const state = crypto.randomBytes(32).toString("hex");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", "snipers_oauth_state=" + state + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600");
  const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, response_type: "code", redirect_uri: DISCORD_REDIRECT_URI, scope: "identify", state, prompt: "consent" });
  return res.redirect("https://discord.com/oauth2/authorize?" + params.toString());
});
app.get("/auth/discord/callback", async (req, res) => {
  const state = String(req.query.state || "");
  const savedState = readCookie(req, "snipers_oauth_state");
  clearOAuthState(res);
  if (!state || !savedState || state.length !== savedState.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(savedState))) {
    return res.status(400).send("Discord sign-in could not be verified. Close this page and try again.");
  }
  if (req.query.error || !req.query.code) return res.redirect(FRONTEND_URL + "?discord_login=cancelled");
  const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI, DISCORD_SESSION_SECRET } = process.env;
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI || !DISCORD_SESSION_SECRET) return res.status(503).send("Discord OAuth is not configured on the backend.");
  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code: String(req.query.code), redirect_uri: DISCORD_REDIRECT_URI }),
      signal: AbortSignal.timeout(15000)
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) return res.status(502).send("Discord did not complete sign-in. Please return to the dashboard and try again.");
    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: "Bearer " + tokenData.access_token },
      signal: AbortSignal.timeout(15000)
    });
    const user = await userResponse.json();
    if (!userResponse.ok || !user.id) return res.status(502).send("Could not read your Discord profile.");
    const session = signSession({ sub: String(user.id), username: String(user.username || ""), global_name: String(user.global_name || ""), avatar: user.avatar || null, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS });
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(FRONTEND_URL + "#discord_session=" + encodeURIComponent(session));
  } catch (error) {
    console.error("Discord OAuth callback failed:", error.message);
    return res.status(502).send("Discord sign-in failed. Please try again.");
  }
});
app.get("/auth/me", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const user = verifySession(token);
  if (!user) return res.status(401).json({ authenticated: false });
  return res.json({ authenticated: true, user: { id: user.sub, username: user.username, global_name: user.global_name, avatar: user.avatar, is_owner: Boolean(user.is_owner) }, expiresAt: user.exp });
});
app.post("/auth/logout", (req, res) => res.json({ success: true }));

/* SNIPERS_USER_CLOUD_STATE_V1 — each authenticated account gets its own saved dashboard. */
let userStatePool = null;
let userStateTableReady = null;
async function getUserStatePool() {
  if (!process.env.DATABASE_URL) return null;
  if (!userStatePool) {
    const { Pool } = require("pg");
    userStatePool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
    userStateTableReady = userStatePool.query(`
      CREATE TABLE IF NOT EXISTS snipers_user_state (
        discord_user_id TEXT PRIMARY KEY,
        dashboard_state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    userStatePool.on("error", error => console.error("User state database pool error:", error.message));
  }
  await userStateTableReady;
  return userStatePool;
}
function requireSession(req, res) {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const user = verifySession(token);
  if (!user) {
    res.status(401).json({ error: "Please sign in again." });
    return null;
  }
  return user;
}
app.get("/api/state", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = requireSession(req, res);
  if (!user) return;
  try {
    const pool = await getUserStatePool();
    if (!pool) return res.status(503).json({ error: "Cloud saving is not configured yet." });
    const result = await pool.query("SELECT dashboard_state, updated_at FROM snipers_user_state WHERE discord_user_id = $1", [String(user.sub)]);
    return res.json({ state: result.rows[0]?.dashboard_state || null, updatedAt: result.rows[0]?.updated_at || null });
  } catch (error) {
    console.error("Cloud state load failed:", error.message);
    return res.status(503).json({ error: "Could not load your saved dashboard right now." });
  }
});
app.put("/api/state", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = requireSession(req, res);
  if (!user) return;
  const dashboardState = req.body?.state;
  if (!dashboardState || typeof dashboardState !== "object" || Array.isArray(dashboardState)) {
    return res.status(400).json({ error: "A dashboard state object is required." });
  }
  try {
    const pool = await getUserStatePool();
    if (!pool) return res.status(503).json({ error: "Cloud saving is not configured yet." });
    await pool.query(
      "INSERT INTO snipers_user_state (discord_user_id, dashboard_state, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (discord_user_id) DO UPDATE SET dashboard_state = EXCLUDED.dashboard_state, updated_at = NOW()",
      [String(user.sub), JSON.stringify(dashboardState)]
    );
    return res.json({ success: true });
  } catch (error) {
    console.error("Cloud state save failed:", error.message);
    return res.status(503).json({ error: "Could not save your dashboard right now." });
  }
});


// Test the configured webhook
app.post("/test-webhook", async (req, res) => {
  const suppliedWebhook = req.body?.webhookUrl;
  const validWebhook = typeof suppliedWebhook === "string" &&
    /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(suppliedWebhook);
  if (suppliedWebhook && !validWebhook) {
    return res.status(400).json({ success: false, error: "Invalid Discord webhook URL" });
  }
  const webhook = validWebhook ? suppliedWebhook : process.env.DISCORD_WEBHOOK_URL;
  const ip = req.ip;
  const now = Date.now();

  if (!webhook) {
    return res.status(500).json({
      success: false,
      error: "Webhook is not configured on the server"
    });
  }

  if (
    lastWebhookTests.has(ip) &&
    now - lastWebhookTests.get(ip) < 30000
  ) {
    return res.status(429).json({
      success: false,
      error: "Please wait 30 seconds before testing again"
    });
  }

  lastWebhookTests.set(ip, now);

  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "🍥 SHINOBI TEST — Webhook connection successful!"
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        error: "Discord rejected the test message (HTTP " + response.status + ")"
      });
    }

    return res.json({ success: true });
  } catch (error) {
    return res.status(502).json({
      success: false,
      error: "Could not send the test message"
    });
  }
});

// Notify when a recently checked username appeared available
app.post("/notify", async (req, res) => {
  const username = req.body?.username;
  const webhook = process.env.DISCORD_WEBHOOK_URL;

  if (!webhook) {
    return res.status(500).json({ error: "Webhook not configured" });
  }

  if (
    typeof username !== "string" ||
    !/^[a-z0-9_.]{2,4}$/.test(username)
  ) {
    return res.status(400).json({ error: "Invalid username" });
  }

  const expiry = verifiedNames.get(username);

  if (!expiry || expiry < Date.now()) {
    verifiedNames.delete(username);
    return res.status(403).json({
      error: "Username not recently verified"
    });
  }

  verifiedNames.delete(username);

  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `🎯 Username reported AVAILABLE: **${username}**`
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      return res.status(502).json({
        error: "Discord notification failed"
      });
    }

    return res.json({ success: true });
  } catch (error) {
    return res.status(502).json({
      error: "Notification failed"
    });
  }
});


// SNIPERS OG experimental single-name checker.
// ClaimCord references Discord's undocumented unauthenticated signup-check route.
// This is unofficial and may stop working at any time. No proxies, account tokens,
// parallel requests, or rate-limit bypasses are used. Bulk scanning stays disabled.
let lastAvailabilityRequestAt = 0;
const availabilityLastByIp = new Map();
const AVAILABILITY_GLOBAL_GAP_MS = 1500;
const AVAILABILITY_IP_GAP_MS = 3000;
app.post("/api/check", async (req, res) => {
  const username = String(req.body?.username || "").trim().toLowerCase();
  if (!/^[a-z0-9._]{2,32}$/.test(username) || username.startsWith(".") || username.endsWith(".") || username.includes("..")) {
    return res.status(400).json({ status: "INVALID", checked: false, error: "Enter a valid Discord username." });
  }
  const now = Date.now();
  const ip = String(req.ip || "unknown");
  const wait = Math.max(0, AVAILABILITY_GLOBAL_GAP_MS - (now - lastAvailabilityRequestAt), AVAILABILITY_IP_GAP_MS - (now - (availabilityLastByIp.get(ip) || 0)));
  if (wait > 0) return res.status(429).json({ status: "UNCONFIRMED", checked: false, retryAfterMs: wait, error: "Please wait before checking another username. The checker does not bypass Discord rate limits." });
  lastAvailabilityRequestAt = now;
  availabilityLastByIp.set(ip, now);
  try {
    const upstream = await fetch("https://discord.com/api/v9/unique-username/username-attempt-unauthed", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "SNIPERS-OG-Username-Checker/1.0" },
      body: JSON.stringify({ username }),
      signal: AbortSignal.timeout(10000)
    });
    let payload = {};
    try { payload = await upstream.json(); } catch (_) {}
    if (upstream.status === 429) {
      const retryHeader = Number(upstream.headers.get("retry-after") || 0);
      const retryAfterMs = Math.max(3000, retryHeader > 0 ? retryHeader * 1000 : 10000);
      return res.status(429).json({ status: "UNCONFIRMED", checked: false, retryAfterMs, error: "Discord rate-limited this check. Wait before trying again." });
    }
    if (!upstream.ok) {
      return res.status(502).json({ status: "UNCONFIRMED", checked: false, error: "Discord's unofficial check endpoint returned HTTP " + upstream.status + ". No availability result was recorded." });
    }
    if (typeof payload.taken !== "boolean") {
      return res.status(502).json({ status: "UNCONFIRMED", checked: false, error: "Discord returned an unexpected response. No availability result was recorded." });
    }
    return res.json({
      username,
      status: payload.taken ? "TAKEN" : "AVAILABLE",
      checked: true,
      checkedAt: new Date().toISOString(),
      source: "discord-unofficial-signup-check",
      note: "Unofficial point-in-time result; it does not reserve the username."
    });
  } catch (error) {
    console.error("Unofficial username check failed:", error.message);
    return res.status(502).json({ status: "UNCONFIRMED", checked: false, error: "Could not reach Discord's unofficial check endpoint. Try again later." });
  }
});
app.get("/api/check", (req, res) => {
  return res.status(405).json({ status: "UNCONFIRMED", checked: false, error: "Use POST to check one username." });
});
app.post("/api/check-bulk", (req, res) => {
  return res.status(501).json({ status: "UNCONFIRMED", checked: false, error: "Bulk live checking is disabled. Check one username at a time." });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend running on ${PORT}`);
});
