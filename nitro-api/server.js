import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 10000);
const ALLOWED_ORIGIN = "https://kmarkovic1491-beep.github.io";
const BODY_LIMIT = 16 * 1024;
const ipWindows = new Map();

function send(res, status, payload, origin = "") {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "vary": "Origin"
  };
  if (origin === ALLOWED_ORIGIN) headers["access-control-allow-origin"] = ALLOWED_ORIGIN;
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}
function rateLimited(ip) {
  const now = Date.now();
  const entry = ipWindows.get(ip) || { start: now, count: 0 };
  if (now - entry.start > 60_000) { entry.start = now; entry.count = 0; }
  entry.count += 1;
  ipWindows.set(ip, entry);
  return entry.count > 30;
}
function parseCode(value) {
  const input = String(value || "").trim();
  const match = input.match(/^(?:https?:\/\/(?:www\.)?discord(?:app)?\.com\/gifts\/|https?:\/\/discord\.gift\/)?([A-Za-z0-9_-]{16,})\/?$/i);
  return match ? match[1] : null;
}
function makeDemoCode() {
  return "TEST-ONLY-" + crypto.randomBytes(6).toString("hex").toUpperCase();
}
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const url = new URL(req.url || "/", "http://localhost");
  if (origin && origin !== ALLOWED_ORIGIN) return send(res, 403, { error: "Origin not allowed" });
  if (req.method === "OPTIONS") {
    if (origin !== ALLOWED_ORIGIN) return send(res, 403, { error: "Origin not allowed" });
    res.writeHead(204, {
      "access-control-allow-origin": ALLOWED_ORIGIN,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
      "vary": "Origin"
    });
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    return send(res, 200, {
      online: true,
      service: "NITRO // HUNTER API",
      codeInspection: "FORMAT_ONLY",
      redemptionAvailability: "NOT_CHECKED",
      realCodeGeneration: false
    }, origin);
  }
  if (req.method !== "POST" || !["/api/inspect", "/api/demo-generate"].includes(url.pathname)) {
    return send(res, 404, { error: "Not found" }, origin);
  }
  const ip = req.socket.remoteAddress || "unknown";
  if (rateLimited(ip)) return send(res, 429, { error: "Rate limit reached. Wait one minute." }, origin);
  let body = "";
  try {
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > BODY_LIMIT) return send(res, 413, { error: "Request too large" }, origin);
    }
    const data = JSON.parse(body || "{}");
    if (url.pathname === "/api/demo-generate") {
      const count = Math.max(1, Math.min(10, Number(data.count) || 1));
      return send(res, 200, {
        codes: Array.from({ length: count }, makeDemoCode),
        label: "TEST ONLY — NOT DISCORD GIFT CODES",
        redeemable: false
      }, origin);
    }
    const values = Array.isArray(data.items) ? data.items.slice(0, 50) : [];
    if (!values.length) return send(res, 400, { error: "Provide one or more links or codes." }, origin);
    const seen = new Set();
    const results = values.map(value => {
      const code = parseCode(value);
      if (!code) return { input: String(value).slice(0, 200), status: "FORMAT_UNKNOWN", verified: false };
      if (seen.has(code)) return { input: String(value).slice(0, 200), status: "DUPLICATE", verified: false };
      seen.add(code);
      return {
        input: String(value).slice(0, 200),
        status: "FORMAT_MATCH_UNVERIFIED",
        verified: false,
        note: "This does not establish whether the gift is unused or redeemable."
      };
    });
    return send(res, 200, {
      results,
      submitted: results.length,
      formatMatches: results.filter(x => x.status === "FORMAT_MATCH_UNVERIFIED").length,
      liveAvailabilityChecked: false
    }, origin);
  } catch {
    return send(res, 400, { error: "Invalid JSON request." }, origin);
  }
});
server.listen(PORT, "0.0.0.0", () => console.log("NITRO // HUNTER API listening on", PORT));
