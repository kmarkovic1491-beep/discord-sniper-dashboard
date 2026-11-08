
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
    checker: "Pomelo V2",
    provider: "Pomelo V2",
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


// Render health check
app.get("/health", (req, res) => {
  res.json({ status: "online", checker: "Pomelo V2", provider: "Pomelo V2" });
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

// Pomelo V2 is the free username lookup provider. Its published free tier
// permits 2 requests per 10 seconds, so serialize calls at a 5.1s interval.
let pomeloQueue = Promise.resolve();
let lastPomeloRequestAt = 0;
const pomeloCache = new Map();

function normalizePomeloStatus(payload) {
  const queue = [payload];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) { queue.push(...value); continue; }
    for (const [key, raw] of Object.entries(value)) {
      const k = key.toLowerCase().replace(/[^a-z]/g, "");
      if (["available", "isavailable", "usernameavailable", "isusernameavailable"].includes(k) && typeof raw === "boolean") return raw ? "available" : "taken";
      if (k === "taken" && typeof raw === "boolean") return raw ? "taken" : "available";
      if (["status", "availability", "result"].includes(k) && typeof raw === "string") {
        const s = raw.trim().toLowerCase().replace(/[ _-]+/g, " ");
        if (["available", "free", "open", "claimable"].includes(s)) return "available";
        if (["taken", "unavailable", "not available", "occupied", "reserved", "claimed"].includes(s)) return "taken";
        if (["invalid", "not allowed", "disallowed"].includes(s)) return "invalid";
      }
      if (raw && typeof raw === "object") queue.push(raw);
    }
  }
  return null;
}

async function checkWithLegacyPomelo(username) {
  // Compatibility fallback: the original public Lixqa endpoint is deprecated,
  // but try it only when V2 is returning a server-side failure.
  const waitMs = Math.max(0, 5100 - (Date.now() - lastPomeloRequestAt));
  if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
  lastPomeloRequestAt = Date.now();
  const url = "https://api.lixqa.de/v3/discord/pomelo/" + encodeURIComponent(username);
  const response = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "SNIPERS-OG-Pomelo-Checker/1.0" },
    signal: AbortSignal.timeout(15000)
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error("Legacy Pomelo endpoint returned non-JSON (HTTP " + response.status + ")."); }
  if (!response.ok) throw new Error("Legacy Pomelo endpoint returned HTTP " + response.status + ".");
  const code = data?.data?.check?.status;
  if (code === 2) return "available";
  if (code === 3) return "taken";
  if (code === 0) return "invalid";
  throw new Error("Legacy Pomelo endpoint did not return a definitive availability status.");
}

async function checkWithPomelo(username) {
  const cached = pomeloCache.get(username);
  if (cached && cached.expiresAt > Date.now()) return cached.status;
  const run = async () => {
    const waitMs = Math.max(0, 5100 - (Date.now() - lastPomeloRequestAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastPomeloRequestAt = Date.now();
    const headers = { "Content-Type": "application/json" };
    if (process.env.POMELO_API_KEY) headers.Authorization = process.env.POMELO_API_KEY;
    const upstream = await fetch("https://api.pomelo.lixqa.cc/v1/lookups", {
      method: "POST",
      headers,
      body: JSON.stringify({ username }),
      signal: AbortSignal.timeout(20000)
    });
    const raw = await upstream.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error("Pomelo returned invalid JSON (HTTP " + upstream.status + ")."); }
    if (upstream.status === 429) throw Object.assign(new Error("Pomelo free-tier limit reached. Wait before scanning again."), { statusCode: 429 });
    if (!upstream.ok) {
      if (upstream.status >= 500) {
        console.warn("Pomelo V2 server error; trying legacy public endpoint.");
        const legacyStatus = await checkWithLegacyPomelo(username);
        pomeloCache.set(username, { status: legacyStatus, expiresAt: Date.now() + 15000 });
        return legacyStatus;
      }
      throw new Error("Pomelo rejected the lookup (HTTP " + upstream.status + "): " + String(payload?.message || payload?.error || "unknown API error").slice(0, 180));
    }
    const status = normalizePomeloStatus(payload);
    if (!status) throw new Error("Pomelo response did not contain a recognized availability status. No result was marked available.");
    pomeloCache.set(username, { status, expiresAt: Date.now() + 30000 });
    return status;
  };
  const current = pomeloQueue.then(run, run);
  pomeloQueue = current.catch(() => {});
  return current;
}

// Single username lookup via Pomelo V2.
app.post("/api/check", async (req, res) => {
  const username = String(req.body?.username || "").trim().toLowerCase();
  if (!/^[a-z0-9._]{2,32}$/.test(username)) return res.status(400).json({ error: "Enter a valid Discord username." });
  try {
    const status = await checkWithPomelo(username);
    return res.json({ username, status });
  } catch (error) {
    console.error("Pomelo check failed:", error.message);
    return res.status(error.statusCode || 502).json({ error: error.message });
  }
});

// Read-only GET endpoint for manual diagnostics and simple integrations.
app.get("/api/check", async (req, res) => {
  const username = String(req.query?.username || "").trim().toLowerCase();
  if (!/^[a-z0-9._]{2,32}$/.test(username)) return res.status(400).json({ error: "Enter a valid Discord username." });
  try {
    const status = await checkWithPomelo(username);
    return res.json({ username, status, provider: "Pomelo V2" });
  } catch (error) {
    console.error("Pomelo check failed:", error.message);
    return res.status(error.statusCode || 502).json({ error: error.message, provider: "Pomelo V2" });
  }
});

// Bulk lookups are intentionally capped at 2 names to honor Pomelo's free tier.
app.post("/api/check-bulk", async (req, res) => {
  const input = req.body?.usernames;
  if (!Array.isArray(input) || input.length < 1 || input.length > 2 ||
      input.some(name => typeof name !== "string" || !/^[a-z0-9._]{2,32}$/i.test(name.trim()))) {
    return res.status(400).json({ error: "Pomelo free tier supports a maximum of 2 usernames per batch." });
  }
  const usernames = [...new Set(input.map(name => name.trim().toLowerCase()))];
  const results = [];
  try {
    for (const username of usernames) {
      const status = await checkWithPomelo(username);
      results.push({ username, status });
    }
    return res.json({ results, checked: results.length, total: usernames.length });
  } catch (error) {
    console.error("Pomelo bulk check failed:", error.message);
    return res.status(error.statusCode || 502).json({ error: error.message, results });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend running on ${PORT}`);
});
