import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.join(root, "data", "targets.json");
const SITE_ORIGIN = "https://kmarkovic1491-beep.github.io";
const BODY_LIMIT = 2048;
const CHECK_INTERVAL_MS = 2500;
const IP_MIN_INTERVAL_MS = 2500;
const IP_HOURLY_LIMIT = 30;
const ALERT_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const notifiedAvailableNames = new Set();

async function notifyAvailableUsername(username) {
  if (!ALERT_WEBHOOK_URL || notifiedAvailableNames.has(username)) return;
  notifiedAvailableNames.add(username);
  try {
    const response = await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: `LAZER SNIPER: username appears available — ${username}. Open Discord to verify and claim manually.`,
        allowed_mentions: { parse: [] }
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      notifiedAvailableNames.delete(username);
      console.error("Webhook alert failed with status", response.status);
    }
  } catch (error) {
    notifiedAvailableNames.delete(username);
    console.error("Webhook alert failed:", error.message);
  }
}

fs.mkdirSync(path.dirname(dataFile), { recursive: true });
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, "[]");

const readTargets = () => JSON.parse(fs.readFileSync(dataFile, "utf8"));
const saveTargets = value => fs.writeFileSync(dataFile, JSON.stringify(value, null, 2));
const allowedOrigin = origin => !origin || origin === SITE_ORIGIN;

const send = (res, code, data, origin = "") => {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "vary": "Origin"
  };
  if (origin === SITE_ORIGIN) headers["access-control-allow-origin"] = SITE_ORIGIN;
  res.writeHead(code, headers);
  res.end(JSON.stringify(data));
};

let lastDiscordCheck = 0;
const clientChecks = new Map();

function checkClientLimit(ip) {
  const now = Date.now();
  const entry = clientChecks.get(ip) || { last: 0, windowStart: now, count: 0 };
  if (now - entry.windowStart >= 60 * 60 * 1000) {
    entry.windowStart = now;
    entry.count = 0;
  }
  if (now - entry.last < IP_MIN_INTERVAL_MS) {
    return { limited: true, retryAfterMs: IP_MIN_INTERVAL_MS - (now - entry.last) };
  }
  if (entry.count >= IP_HOURLY_LIMIT) {
    return { limited: true, retryAfterMs: 60 * 60 * 1000 - (now - entry.windowStart) };
  }
  entry.last = now;
  entry.count += 1;
  clientChecks.set(ip, entry);
  return null;
}

async function checkDiscordUsername(username) {
  const wait = CHECK_INTERVAL_MS - (Date.now() - lastDiscordCheck);
  if (wait > 0) return { limited: true, retryAfterMs: wait };
  lastDiscordCheck = Date.now();

  try {
    const response = await fetch("https://discord.com/api/v9/unique-username/username-attempt-unauthed", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "LAZER-SNIPER/1.0" },
      body: JSON.stringify({ username }),
      signal: AbortSignal.timeout(10000)
    });
    if (response.status === 429) {
      const limitData = await response.json().catch(() => ({}));
      const retryAfterMs = Number.isFinite(Number(limitData.retry_after))
        ? Math.max(1000, Math.ceil(Number(limitData.retry_after) * 1000))
        : 60000;
      return { unknown: true, rateLimited: true, retryAfterMs };
    }
    if (!response.ok) return { unknown: true };
    const data = await response.json();
    if (typeof data.taken !== "boolean") return { unknown: true };
    return { status: data.taken ? "TAKEN" : "AVAILABLE", checkedAt: new Date().toISOString() };
  } catch {
    return { unknown: true };
  }
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || "";
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  console.log("Request", req.method, pathname);
  if (!allowedOrigin(origin)) return send(res, 403, { error: "Origin not allowed" });

  if (req.method === "OPTIONS") {
    if (origin !== SITE_ORIGIN) return send(res, 403, { error: "Origin not allowed" });
    res.writeHead(204, {
      "access-control-allow-origin": SITE_ORIGIN,
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
      "vary": "Origin"
    });
    return res.end();
  }

  if (pathname === "/api/status" && req.method === "GET") {
    return send(res, 200, {
      online: true,
      service: "LAZER SNIPER",
      availability: "BEST_EFFORT",
      discordRequestsEnabled: true,
      webhookAlertsEnabled: Boolean(ALERT_WEBHOOK_URL)
    }, origin);
  }

  if (pathname === "/api/check" && req.method === "POST") {
    const length = Number(req.headers["content-length"] || 0);
    if (length > BODY_LIMIT) return send(res, 413, { error: "Request too large" }, origin);

    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > BODY_LIMIT) {
        send(res, 413, { error: "Request too large" }, origin);
        req.destroy();
      }
    });
    req.on("end", async () => {
      if (res.writableEnded) return;
      try {
        const parsed = JSON.parse(body);
        const name = String(parsed.username || "").trim().toLowerCase();
        if (name.length < 2 || name.length > 32 || !/^[a-z0-9_.]+$/.test(name) ||
            name.startsWith(".") || name.endsWith(".") || name.includes("..")) {
          return send(res, 400, { error: "Invalid Discord username format" }, origin);
        }

        const ip = req.socket.remoteAddress || "unknown";
        const clientLimit = checkClientLimit(ip);
        if (clientLimit) {
          return send(res, 429, {
            status: "UNKNOWN",
            retryAfterMs: clientLimit.retryAfterMs,
            message: "Please wait before checking again."
          }, origin);
        }

        const result = await checkDiscordUsername(name);
        if (result.limited) {
          return send(res, 429, {
            status: "UNKNOWN",
            retryAfterMs: result.retryAfterMs,
            message: "Please wait before checking another name."
          }, origin);
        }
        if (result.status === "AVAILABLE") {
          void notifyAvailableUsername(name);
        }
        if (result.status) return send(res, 200, result, origin);
        return send(res, 503, {
          status: "UNKNOWN",
          message: result.rateLimited
            ? "Discord rate-limited this check. Try again later."
            : "Discord could not verify this name.",
          retryAfterMs: result.retryAfterMs || null
        }, origin);
      } catch {
        return send(res, 400, { error: "Invalid JSON" }, origin);
      }
    });
    return;
  }

  if (pathname === "/api/targets" && req.method === "GET") {
    return send(res, 200, { targets: readTargets() }, origin);
  }

  if (pathname === "/api/targets" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > BODY_LIMIT) req.destroy();
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        const name = String(parsed.username || "").trim().toLowerCase();
        if (!/^[a-z0-9_.]{2,32}$/.test(name)) {
          return send(res, 400, { error: "Invalid username format" }, origin);
        }
        const targets = readTargets();
        if (!targets.some(item => item.username === name)) {
          targets.push({ username: name, status: "UNKNOWN", addedAt: new Date().toISOString() });
        }
        saveTargets(targets);
        send(res, 201, { targets }, origin);
      } catch {
        send(res, 400, { error: "Invalid JSON" }, origin);
      }
    });
    return;
  }

  if (pathname.startsWith("/api/targets/") && req.method === "DELETE") {
    const name = decodeURIComponent(pathname.slice("/api/targets/".length)).toLowerCase();
    const targets = readTargets().filter(item => item.username !== name);
    saveTargets(targets);
    return send(res, 200, { targets }, origin);
  }

  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" });
    return fs.createReadStream(path.join(root, "index.html")).pipe(res);
  }

  send(res, 404, { error: "Not found" }, origin);
});

const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0", () => console.log("LAZER SNIPER listening on " + port));
