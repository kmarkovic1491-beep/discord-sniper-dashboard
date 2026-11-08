
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
    checker: "ready",
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


// TEMPORARY one-shot Pomelo API schema test; remove after verification.
app.get("/__pomelo_test_once", async (req, res) => {
  try {
    const upstream = await fetch("https://api.pomelo.lixqa.cc/v1/lookups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "discord" }),
      signal: AbortSignal.timeout(12000)
    });
    const body = await upstream.text();
    res.status(200).json({ upstreamStatus: upstream.status, contentType: upstream.headers.get("content-type"), body: body.slice(0, 4000) });
  } catch (error) {
    res.status(200).json({ testError: error.message });
  }
});

// Render health check
app.get("/health", (req, res) => {
  res.json({ status: "online", checker: "ready" });
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
        body: JSON.stringify({
          usernames,
          proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] }
        }),
        signal: AbortSignal.timeout(60000)
      }
    );
    const raw = await upstream.text();
    if (!upstream.ok) {
      console.error("Apify bulk request failed with HTTP", upstream.status);
      if (upstream.status === 429) {
        const retryHeader = upstream.headers.get("retry-after");
        const retrySeconds = Number(retryHeader);
        const retryAfterMs = Number.isFinite(retrySeconds) && retrySeconds > 0
          ? Math.ceil(retrySeconds * 1000)
          : 30000;
        res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
        return res.status(429).json({
          error: "Apify rate-limited the batch. The scanner is pausing before retrying.",
          retryAfterMs
        });
      }
      return res.status(502).json({ error: "Apify bulk checker failed (HTTP " + upstream.status + ")." });
    }
    let rows;
    try { rows = JSON.parse(raw); } catch {
      return res.status(502).json({ error: "Apify returned invalid JSON." });
    }
    const items = Array.isArray(rows) ? rows : (Array.isArray(rows?.items) ? rows.items : [rows]);
    const quotaMessage = items.find(item => item && typeof item === "object" && item.quota)?.quota;
    if (quotaMessage) {
      console.error("Apify quota blocked bulk check:", String(quotaMessage).slice(0, 300));
      return res.status(402).json({ error: String(quotaMessage), code: "APIFY_QUOTA_EXHAUSTED" });
    }
    const results = usernames.map((username, index) => {
      // The actor normally echoes each username. Some dataset rows omit that
      // field, so use the matching position only when row counts line up.
      const row = items.find(item =>
        String(item?.username || item?.input || item?.query || "").trim().toLowerCase() === username.toLowerCase()
      ) || (items.length === usernames.length ? items[index] : null);
      return { username, status: row && typeof row === "object" ? normalizeApifyStatus(row) : null };
    });
    const unresolved = results.filter(item => !item.status).map(item => item.username);
    if (unresolved.length) {
      console.error("Apify bulk response missing clear status for", unresolved.length, "of", usernames.length, "usernames; output shape:", JSON.stringify({ isArray: Array.isArray(rows), topKeys: rows && !Array.isArray(rows) && typeof rows === "object" ? Object.keys(rows) : [], itemCount: items.length, firstItem: items[0] && typeof items[0] === "object" ? Object.fromEntries(Object.entries(items[0]).filter(([key]) => !/username|input|query/i.test(key)).slice(0, 20)) : items[0] }));
    }
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
        body: JSON.stringify({
          usernames: [username],
          proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] }
        }),
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
    if (row && typeof row === "object" && row.quota) {
      console.error("Apify quota blocked single check:", String(row.quota).slice(0, 300));
      return res.status(402).json({ error: String(row.quota), code: "APIFY_QUOTA_EXHAUSTED" });
    }
    if (!row || typeof row !== "object") {
      return res.status(502).json({ error: "Apify returned no result for this username." });
    }

    const status = normalizeApifyStatus(row);

    if (!status) {
      console.error("Unrecognized Apify result shape:", JSON.stringify({ isArray: Array.isArray(rows), topKeys: rows && !Array.isArray(rows) && typeof rows === "object" ? Object.keys(rows) : [], rowKeys: Object.keys(row), sample: Object.fromEntries(Object.entries(row).filter(([key]) => !/username|input|query/i.test(key)).slice(0, 20)) }));
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
