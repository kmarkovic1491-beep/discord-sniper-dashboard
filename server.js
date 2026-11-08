
const express = require("express");

const app = express();
app.use(express.json({ limit: "10kb" }));

const allowedOrigin = "https://kmarkovic1491-beep.github.io";
const API_URL =
  "https://discord.com/api/v9/unique-username/username-attempt-unauthed";

const lastChecks = new Map();
const verifiedNames = new Map();
// Respect Discord's upstream 429 response across every visitor using this backend.
let discordCooldownUntil = 0;
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
    checker: "ready",
    checkIntervalMs: 2000,
    webhookConfigured: Boolean(process.env.DISCORD_WEBHOOK_URL),
    discordCooldownRemainingMs: Math.max(0, discordCooldownUntil - Date.now()),
    discordChecksPaused: Date.now() < discordCooldownUntil
  });
});

// Check one username
app.post("/check", async (req, res) => {
  const username = req.body?.username;

  if (
    typeof username !== "string" ||
    !/^[a-z0-9_.]{2,4}$/.test(username)
  ) {
    return res.status(400).json({ status: "INVALID" });
  }

  const ip = req.ip;
  const now = Date.now();

  if (now < discordCooldownUntil) {
    return res.status(429).json({
      status: "RATE_LIMITED",
      retryAfterMs: discordCooldownUntil - now,
      message: "Discord has asked the checker to pause. Please wait."
    });
  }

  if (lastChecks.has(ip) && now - lastChecks.get(ip) < 2000) {
    return res.status(429).json({
      status: "RATE_LIMITED",
      retryAfterMs: 2000 - (now - lastChecks.get(ip)),
      message: "Please wait before checking again."
    });
  }

  lastChecks.set(ip, now);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ username }),
      signal: AbortSignal.timeout(10000)
    });

    if (response.status === 429) {
      // Discord may return Retry-After in a header or retry_after in its JSON body.
      let body = {};
      try { body = await response.json(); } catch {}
      const retryHeader = response.headers.get("retry-after");
      const headerNumber = Number(retryHeader);
      const headerDateMs = retryHeader && !Number.isFinite(headerNumber)
        ? Date.parse(retryHeader) - Date.now()
        : 0;
      const bodySeconds = Number(body.retry_after);
      const retryAfterMs = Math.max(1000, Math.ceil(
        Number.isFinite(headerNumber) && headerNumber > 0
          ? headerNumber * 1000
          : (headerDateMs > 0
            ? headerDateMs
            : (Number.isFinite(bodySeconds) && bodySeconds > 0 ? bodySeconds * 1000 : 60000))
      ));
      discordCooldownUntil = Math.max(discordCooldownUntil, Date.now() + retryAfterMs);
      return res.status(429).json({
        status: "RATE_LIMITED",
        retryAfterMs: discordCooldownUntil - Date.now(),
        message: "Discord has rate-limited this check. The checker is paused."
      });
    }

    const data = await response.json();

    if (response.ok && typeof data.taken === "boolean") {
      if (!data.taken) {
        verifiedNames.set(username, Date.now() + 60000);
      }

      return res.json({
        status: data.taken ? "TAKEN" : "AVAILABLE"
      });
    }

    return res.status(502).json({ status: "ERROR" });
  } catch (error) {
    return res.status(502).json({ status: "ERROR" });
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


// Render health check
app.get("/health", (req, res) => {
  res.json({ status: "online", checker: "ready" });
});


function normalizeApifyStatus(row) {
  const rawStatus = String(row.status || row.availability || row.result || "").toLowerCase();
  if (rawStatus.includes("available") || row.available === true || row.isAvailable === true) return "available";
  if (rawStatus.includes("taken") || row.taken === true || row.available === false || row.isAvailable === false) return "taken";
  if (rawStatus.includes("invalid") || row.valid === false) return "invalid";
  return null;
}

// Batch availability check: one Apify actor run for up to 50 usernames.
app.post("/api/check-bulk", async (req, res) => {
  const input = req.body?.usernames;
  if (!Array.isArray(input) || input.length < 1 || input.length > 50 ||
      input.some(name => typeof name !== "string" || !/^[a-z0-9._]{2,32}$/i.test(name.trim()))) {
    return res.status(400).json({ error: "Send between 1 and 50 valid usernames." });
  }
  if (!process.env.APIFY_TOKEN) {
    return res.status(503).json({ error: "APIFY_TOKEN is not configured on the Render service." });
  }
  const usernames = [...new Set(input.map(name => name.trim()))];
  try {
    const upstream = await fetch(
      "https://api.apify.com/v2/acts/maged120~discord-username-checker/run-sync-get-dataset-items?format=json&clean=true",
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + process.env.APIFY_TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ usernames }),
        signal: AbortSignal.timeout(60000)
      }
    );
    const raw = await upstream.text();
    if (!upstream.ok) {
      console.error("Apify bulk request failed with HTTP", upstream.status);
      return res.status(502).json({ error: "Apify bulk checker failed (HTTP " + upstream.status + ")." });
    }
    let rows;
    try { rows = JSON.parse(raw); } catch {
      return res.status(502).json({ error: "Apify returned invalid JSON." });
    }
    const items = Array.isArray(rows) ? rows : (Array.isArray(rows?.items) ? rows.items : [rows]);
    const results = usernames.map(username => {
      const row = items.find(item =>
        String(item?.username || item?.input || item?.query || "").toLowerCase() === username.toLowerCase()
      );
      return { username, status: row && typeof row === "object" ? normalizeApifyStatus(row) : null };
    });
    return res.json({ results, checked: results.filter(item => item.status).length, total: usernames.length });
  } catch (error) {
    console.error("Apify bulk check failed:", error.message);
    return res.status(502).json({ error: "Could not complete the Apify bulk check." });
  }
});

// Apify-backed username availability check
app.post("/api/check", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  if (!/^[a-z0-9._]{2,32}$/i.test(username)) {
    return res.status(400).json({ error: "Enter a valid Discord username." });
  }
  if (!process.env.APIFY_TOKEN) {
    return res.status(503).json({ error: "APIFY_TOKEN is not configured on the Render service." });
  }

  try {
    const upstream = await fetch(
      "https://api.apify.com/v2/acts/maged120~discord-username-checker/run-sync-get-dataset-items?format=json&clean=true",
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + process.env.APIFY_TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ usernames: [username] }),
        signal: AbortSignal.timeout(60000)
      }
    );
    const raw = await upstream.text();
    if (!upstream.ok) {
      console.error("Apify request failed with HTTP", upstream.status);
      return res.status(502).json({ error: "Apify checker request failed (HTTP " + upstream.status + ")." });
    }

    let rows;
    try { rows = JSON.parse(raw); } catch {
      return res.status(502).json({ error: "Apify returned invalid JSON." });
    }
    const row = Array.isArray(rows)
      ? rows.find(x => String(x.username || x.input || "").toLowerCase() === username.toLowerCase()) || rows[0]
      : rows;
    if (!row || typeof row !== "object") {
      return res.status(502).json({ error: "Apify returned no result for this username." });
    }

    const rawStatus = String(row.status || row.availability || row.result || "").toLowerCase();
    let status = null;
    if (rawStatus.includes("available") || row.available === true || row.isAvailable === true) status = "available";
    else if (rawStatus.includes("taken") || row.taken === true || row.available === false || row.isAvailable === false) status = "taken";
    else if (rawStatus.includes("invalid") || row.valid === false) status = "invalid";

    if (!status) {
      console.error("Unrecognized Apify result shape");
      return res.status(502).json({ error: "Apify returned an unrecognized result. Check the actor output schema." });
    }
    return res.json({ username, status });
  } catch (error) {
    console.error("Apify check failed:", error.message);
    return res.status(502).json({ error: "Could not complete the Apify username check." });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend running on ${PORT}`);
});
