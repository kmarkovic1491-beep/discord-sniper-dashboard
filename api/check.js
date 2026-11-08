const ALLOWED_ORIGIN = "https://kmarkovic1491-beep.github.io";

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (origin !== ALLOWED_ORIGIN) return res.status(403).json({ error: "Origin not allowed." });
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST /api/check." });
  if (!process.env.APIFY_TOKEN) return res.status(500).json({ error: "Vercel environment variable APIFY_TOKEN is not configured." });

  const username = String(req.body?.username || "").trim();
  if (!/^[a-z0-9._]{2,32}$/i.test(username)) {
    return res.status(400).json({ error: "Enter a valid Discord username (2–32 letters, numbers, dots or underscores)." });
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
        body: JSON.stringify({ usernames: [username] })
      }
    );
    const raw = await upstream.text();
    if (!upstream.ok) {
      return res.status(502).json({ error: "Apify returned HTTP " + upstream.status + ": " + raw.slice(0, 400) });
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
      return res.status(502).json({ error: "Unrecognized actor result: " + JSON.stringify(row).slice(0, 400) });
    }
    return res.status(200).json({ username, status });
  } catch (error) {
    return res.status(502).json({ error: "Apify request failed: " + String(error?.message || error) });
  }
};
