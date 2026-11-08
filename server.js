
const express = require("express");

const app = express();
app.use(express.json({ limit: "10kb" }));

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => {
  res.json({
    status: "online",
    checker: "FeedMiner (Apify)",
    provider: "FeedMiner",
    providerConfigured: Boolean(process.env.APIFY_API_TOKEN),
    webhookConfigured: Boolean(process.env.DISCORD_WEBHOOK_URL),
  });
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


// FeedMiner (Apify) provider. It uses the actor the owner tested manually.
// Keep requests serialized and at least 5 seconds apart; provider/upstream limits
// may still apply. Never convert unchecked or ambiguous rows into availability.
const FEEDMINER_ACTOR_ID = "bQ1gNUV9OXLXAP4aj";
let feedMinerQueue = Promise.resolve();
let lastFeedMinerStart = 0;
const feedMinerCache = new Map();

async function runFeedMinerBatch(usernames) {
  if (!process.env.APIFY_API_TOKEN) {
    throw Object.assign(new Error("FeedMiner is not configured yet. Add APIFY_API_TOKEN to the Render service environment."), { statusCode: 503 });
  }
  const task = feedMinerQueue.then(async () => {
    const waitMs = Math.max(0, 10000 - (Date.now() - lastFeedMinerStart));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastFeedMinerStart = Date.now();
    const response = await fetch("https://api.apify.com/v2/acts/" + FEEDMINER_ACTOR_ID + "/run-sync-get-dataset-items", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.APIFY_API_TOKEN,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ usernames, maxRows: usernames.length, debugMode: false }),
      signal: AbortSignal.timeout(120000)
    });
    const raw = await response.text();
    let rows;
    try { rows = JSON.parse(raw); } catch { throw Object.assign(new Error("FeedMiner returned a non-JSON response (HTTP " + response.status + ")."), { statusCode: 502 }); }
    if (!response.ok) {
      const detail = String(rows?.error?.message || rows?.error || rows?.message || raw || response.statusText).slice(0, 240);
      const limited = response.status === 429 || /rate.?limit|too many requests|temporarily blocked/i.test(detail);
      const retryHeader = Number(response.headers.get("retry-after"));
      const retryAfterMs = limited ? Math.max(30000, Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader * 1000 : 0) : 0;
      throw Object.assign(new Error("FeedMiner request failed (HTTP " + response.status + "): " + detail), { statusCode: limited ? 429 : 502, retryAfterMs });
    }
    if (!Array.isArray(rows)) throw Object.assign(new Error("FeedMiner did not return a dataset array."), { statusCode: 502 });
    const normalized = new Map();
    for (const row of rows) {
      if (!row || row.kind !== "username" || typeof row.username !== "string") continue;
      const name = row.username.trim().toLowerCase();
      const status = String(row.status || "").trim().toLowerCase();
      if (usernames.includes(name) && ["available", "taken", "invalid"].includes(status)) normalized.set(name, status);
    }
    const missing = usernames.filter(name => !normalized.has(name));
    if (missing.length) {
      const unchecked = rows.filter(row => row && typeof row.username === "string" && missing.includes(row.username.trim().toLowerCase()));
      const reason = unchecked.map(row => String(row.reason || row.reason_code || "")).filter(Boolean).join("; ");
      throw Object.assign(new Error("FeedMiner could not confirm: " + missing.join(", ") + (reason ? " (" + reason.slice(0, 180) + ")" : "") + ". These names remain queued for retry; no availability result was recorded."), { statusCode: 429, retryAfterMs: 30000 });
    }
    for (const [name, status] of normalized) feedMinerCache.set(name, { status, expiresAt: Date.now() + 15000 });
    return usernames.map(username => ({ username, status: normalized.get(username) }));
  });
  feedMinerQueue = task.catch(() => {});
  return task;
}

async function checkWithFeedMiner(username) {
  const cached = feedMinerCache.get(username);
  if (cached && cached.expiresAt > Date.now()) return cached.status;
  const result = await runFeedMinerBatch([username]);
  return result[0].status;
}

// Render health check
app.get("/health", (req, res) => {
  res.json({ status: "online", checker: "FeedMiner (Apify)", provider: "FeedMiner", providerConfigured: Boolean(process.env.APIFY_API_TOKEN) });
});


function normalizeApifyStatus(row) {
  if (!row || typeof row !== "object") return null;

  // Trust explicit booleans first. Do not use substring matching here:
  // "unavailable" contains "available" and must never trigger an alert.
  if (typeof row.available === "boolean") return row.available ? "available" : "taken";
  if (typeof row.isAvailable === "boolean") return row.isAvailable ? "available" : "taken";
  if (typeof row.taken === "boolean") return row.taken ? "taken" : "available";
  if (row.valid === false) return "invalid";

  const raw = String(row.status || row.availability || row.result || "")
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, " ");

  if (["available", "free", "open", "claimable"].includes(raw)) return "available";
  if (["taken", "unavailable", "not available", "occupied", "reserved"].includes(raw)) return "taken";
  if (["invalid", "not allowed", "disallowed"].includes(raw)) return "invalid";
  return null;
}

// Single username lookup via FeedMiner.
app.post("/api/check", async (req, res) => {
  const username = String(req.body?.username || "").trim().toLowerCase();
  if (!/^[a-z0-9._]{2,32}$/.test(username)) return res.status(400).json({ error: "Enter a valid username." });
  try {
    const status = await checkWithFeedMiner(username);
    return res.json({ username, status });
  } catch (error) {
    console.error("FeedMiner check failed:", error.message);
    return res.status(error.statusCode || 502).json({ error: error.message });
  }
});

// Read-only GET endpoint for manual diagnostics and simple integrations.
app.get("/api/check", async (req, res) => {
  const username = String(req.query?.username || "").trim().toLowerCase();
  if (!/^[a-z0-9._]{2,32}$/.test(username)) return res.status(400).json({ error: "Enter a valid username." });
  try {
    const status = await checkWithFeedMiner(username);
    return res.json({ username, status, provider: "FeedMiner" });
  } catch (error) {
    console.error("FeedMiner check failed:", error.message);
    return res.status(error.statusCode || 502).json({ error: error.message, provider: "FeedMiner" });
  }
});

// Bulk lookups are capped at 2 names per actor run to keep cost and rate exposure low.
app.post("/api/check-bulk", async (req, res) => {
  const input = req.body?.usernames;
  if (!Array.isArray(input) || input.length < 1 || input.length > 2 ||
      input.some(name => typeof name !== "string" || !/^[a-z0-9._]{2,32}$/i.test(name.trim()))) {
    return res.status(400).json({ error: "FeedMiner integration currently accepts a maximum of 2 usernames per batch." });
  }
  const usernames = [...new Set(input.map(name => name.trim().toLowerCase()))];
  const results = [];
  try {
    const checked = await runFeedMinerBatch(usernames);
    results.push(...checked);
    return res.json({ results, checked: results.length, total: usernames.length });
  } catch (error) {
    console.error("FeedMiner bulk check failed:", error.message);
    return res.status(error.statusCode || 502).json({ error: error.message, retryAfterMs: error.retryAfterMs || 0, results });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend running on ${PORT}`);
});
