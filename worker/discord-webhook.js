const ALLOWED_ORIGIN = "https://kmarkovic1491-beep.github.io";

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Dashboard-Key",
    "Vary": "Origin"
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = cors(origin);
    if (origin !== ALLOWED_ORIGIN) return new Response("Origin not allowed", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/notify") {
      return Response.json({ error: "Not found" }, { status: 404, headers });
    }
    if (!env.DISCORD_WEBHOOK_URL || !env.DASHBOARD_KEY) {
      return Response.json({ error: "Worker secrets are not configured." }, { status: 503, headers });
    }
    if (request.headers.get("X-Dashboard-Key") !== env.DASHBOARD_KEY) {
      return Response.json({ error: "Invalid dashboard access key." }, { status: 401, headers });
    }
    let body;
    try { body = await request.json(); } catch {
      return Response.json({ error: "Invalid JSON." }, { status: 400, headers });
    }
    const username = String(body.username || "test").slice(0, 32);
    const status = String(body.status || "UNKNOWN");
    const message = String(body.message || "").slice(0, 1800);
    if (!["AVAILABLE", "UNKNOWN", "TAKEN"].includes(status) || !message) {
      return Response.json({ error: "Invalid alert payload." }, { status: 400, headers });
    }
    const discord = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message, allowed_mentions: { parse: [] } })
    });
    if (!discord.ok) {
      return Response.json({ error: "Discord rejected the webhook request." }, { status: 502, headers });
    }
    return Response.json({ ok: true }, { status: 200, headers });
  }
};
