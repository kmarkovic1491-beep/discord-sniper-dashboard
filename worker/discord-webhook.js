const ALLOWED_ORIGIN = "https://kmarkovic1491-beep.github.io";
const DISCORD_CHECK_URL = "https://discord.com/api/v9/unique-username/username-attempt-unauthed";

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "Retry-After",
    "Vary": "Origin"
  };
}
function json(data, status, headers, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, ...extra, "Content-Type": "application/json" }
  });
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = cors(origin);
    if (origin !== ALLOWED_ORIGIN) return new Response("Origin not allowed", { status: 403, headers });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      const configured = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//i.test(env.DISCORD_WEBHOOK_URL || "");
      return json({ ok: true, webhookConfigured: configured }, 200, headers);
    }
    if (request.method !== "POST") return json({ error: "POST required." }, 405, headers);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400, headers); }

    if (path === "/check") {
      const username = String(body.username || "").toLowerCase();
      if (!/^[a-z0-9_.]{2,32}$/.test(username) || username.startsWith(".") || username.endsWith(".") || username.includes("..")) {
        return json({ error: "Invalid username format." }, 400, headers);
      }
      try {
        const upstream = await fetch(DISCORD_CHECK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username })
        });
        const responseHeaders = {};
        const contentType = upstream.headers.get("Content-Type");
        const retryAfter = upstream.headers.get("Retry-After");
        if (contentType) responseHeaders["Content-Type"] = contentType;
        if (retryAfter) responseHeaders["Retry-After"] = retryAfter;
        return new Response(await upstream.text(), { status: upstream.status, headers: { ...headers, ...responseHeaders } });
      } catch {
        return json({ error: "Could not reach Discord." }, 502, headers);
      }
    }

    if (path === "/notify") {
      const webhookUrl = env.DISCORD_WEBHOOK_URL || "";
      if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//i.test(webhookUrl)) {
        return json({ error: "Cloudflare secret DISCORD_WEBHOOK_URL is missing or invalid. Add the full Discord webhook URL as a Worker secret, then redeploy." }, 503, headers);
      }
      const username = String(body.username || "test").slice(0, 32);
      const status = String(body.status || "UNKNOWN");
      const message = String(body.message || "").slice(0, 1800);
      if (!["AVAILABLE", "UNKNOWN", "TAKEN"].includes(status) || !message) {
        return json({ error: "Invalid alert payload." }, 400, headers);
      }
      try {
        const discord = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: message, allowed_mentions: { parse: [] } })
        });
        if (discord.status === 429) {
          const retryAfter = discord.headers.get("Retry-After") || "5";
          return json({ error: "Discord rate-limited the webhook. Wait before retrying.", retry_after: retryAfter }, 429, headers, { "Retry-After": retryAfter });
        }
        if (!discord.ok) {
          return json({ error: "Discord rejected the webhook. Check that the URL is current and the channel still exists.", upstream_status: discord.status }, 502, headers);
        }
        return json({ ok: true }, 200, headers);
      } catch {
        return json({ error: "Could not reach Discord webhook." }, 502, headers);
      }
    }
    return json({ error: "Not found." }, 404, headers);
  }
};