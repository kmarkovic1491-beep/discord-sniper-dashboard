const ALLOWED_ORIGIN = "https://kmarkovic1491-beep.github.io";

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = cors(origin);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" }
    });
    if (origin !== ALLOWED_ORIGIN) return json({ error: "Origin not allowed." }, 403);
    if (request.method !== "POST" || new URL(request.url).pathname !== "/check") {
      return json({ error: "Use POST /check." }, 404);
    }
    if (!env.APIFY_TOKEN) return json({ error: "Worker secret APIFY_TOKEN is not configured." }, 500);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
    const username = String(body?.username || "").trim();
    if (!/^[a-z0-9._]{2,32}$/i.test(username)) {
      return json({ error: "Enter a valid Discord username (2–32 letters, numbers, dots or underscores)." }, 400);
    }

    try {
      const upstream = await fetch(
        "https://api.apify.com/v2/acts/maged120~discord-username-checker/run-sync-get-dataset-items?format=json&clean=true",
        {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + env.APIFY_TOKEN,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ usernames: [username] })
        }
      );
      const raw = await upstream.text();
      if (!upstream.ok) {
        return json({ error: "Apify returned HTTP " + upstream.status + ": " + raw.slice(0, 400) }, 502);
      }
      let rows;
      try { rows = JSON.parse(raw); } catch { return json({ error: "Apify returned invalid JSON." }, 502); }
      const row = Array.isArray(rows) ? rows.find(x =>
        String(x.username || x.input || "").toLowerCase() === username.toLowerCase()
      ) || rows[0] : rows;
      if (!row || typeof row !== "object") return json({ error: "Apify returned no result for this username." }, 502);

      const rawStatus = String(row.status || row.availability || row.result || "").toLowerCase();
      let status = null;
      if (rawStatus.includes("available") || row.available === true || row.isAvailable === true) status = "available";
      else if (rawStatus.includes("taken") || row.taken === true || row.available === false || row.isAvailable === false) status = "taken";
      else if (rawStatus.includes("invalid") || row.valid === false) status = "invalid";
      if (!status) return json({ error: "Unrecognized actor result: " + JSON.stringify(row).slice(0, 400) }, 502);
      return json({ username, status });
    } catch (error) {
      return json({ error: "Apify request failed: " + String(error?.message || error) }, 502);
    }
  }
};
