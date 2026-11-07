
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
    discordCooldownRemainingMs: Math.max(0, discordCooldownUntil - Date.now())
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
      const headerSeconds = Number(response.headers.get("retry-after"));
      const bodySeconds = Number(body.retry_after);
      const retrySeconds = Number.isFinite(headerSeconds) && headerSeconds > 0
        ? headerSeconds
        : (Number.isFinite(bodySeconds) && bodySeconds > 0 ? bodySeconds : 60);
      const retryAfterMs = Math.max(1000, Math.ceil(retrySeconds * 1000));
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend running on ${PORT}`);
});
