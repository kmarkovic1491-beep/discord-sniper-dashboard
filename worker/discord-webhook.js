const ALLOWED_ORIGIN = "https://kmarkovic1491-beep.github.io";
const DISCORD_CHECK_URL = "https://discord.com/api/v9/unique-username/username-attempt-unauthed";

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "Retry-After",
    "Vary": "Origin"
  };
}
function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = cors(origin);
    if (origin !== ALLOWED_ORIGIN) return new Response("Origin not allowed", { status: 403, headers });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return json({ error: "POST required." }, 405, headers);
    const path = new URL(request.url).pathname;
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
        const text = await upstream.text();
        const responseHeaders = { ...headers, "Content-Type": upstream.headers.get("Content-Type") || "application/json" };
        const retryAfter = upstream.headers.get("Retry-After");
        if (retryAfter) responseHeaders["Retry-After"] = retryAfter;
        return new Response(text, { status: upstream.status, headers: responseHeaders });
      } catch {
        return json({ error: "Could not reach Discord." }, 502, headers);
      }
    }

    if (path === "/notify") {
      if (!env.DISCORD_WEBHOOK_URL) return json({ error: "Worker secret DISCORD_WEBHOOK_URL is not configured." }, 503, headers);
      const username = String(body.username || "test").slice(0, 32);
      const status = String(body.status || "UNKNOWN");
      const message = String(body.message || "").slice(0, 1800);
      if (!["AVAILABLE", "UNKNOWN", "TAKEN"].includes(status) || !message) {
        return json({ error: "Invalid alert payload." }, 400, headers);
      }
      try {
        const discord = await fetch(env.DISCORD_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: message, allowed_mentions: { parse: [] } })
        });
        if (!discord.ok) return json({ error: "Discord rejected the webhook request.", upstream_status: discord.status }, 502, headers);
        return json({ ok: true }, 200, headers);
      } catch {
        return json({ error: "Could not reach Discord webhook." }, 502, headers);
      }
    }
    return json({ error: "Not found." }, 404, headers);
  }
};