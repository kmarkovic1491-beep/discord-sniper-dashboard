import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, "data");
const stateFile = path.join(dataDir, "state.json");
const settingsFile = path.join(dataDir, "settings.json");
fs.mkdirSync(dataDir, { recursive: true });
const read = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};
const write = (file, value) => {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
};
let state = read(stateFile, { targets: [], history: [] });
let settings = read(settingsFile, { webhookUrl: "", enabled: false, alertAvailable: true, alertUnknown: false, message: "⚡ SNIPERS OG: **{username}** was marked {status}. Verify it manually in Discord." });

const json = (res, code, value) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
};
const readBody = req => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", chunk => { body += chunk; if (body.length > 12000) reject(new Error("Request too large")); });
  req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("Invalid JSON")); } });
  req.on("error", reject);
});
const safeState = () => ({
  targets: state.targets,
  history: state.history.slice(0, 100),
  settings: {
    enabled: Boolean(settings.enabled),
    alertAvailable: settings.alertAvailable !== false,
    alertUnknown: Boolean(settings.alertUnknown),
    message: settings.message || "",
    webhookConfigured: Boolean(settings.webhookUrl)
  }
});
function validWebhook(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "discord.com" &&
      /^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+\/?$/.test(u.pathname);
  } catch { return false; }
}
async function sendWebhook(content) {
  if (!settings.webhookUrl || !validWebhook(settings.webhookUrl)) throw new Error("Save a valid Discord webhook URL in Settings first.");
  const response = await fetch(settings.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("Discord returned HTTP " + response.status + ".");
}
function renderMessage(name, status) {
  return (settings.message || "SNIPERS OG: {username} — {status}")
    .replaceAll("{username}", name).replaceAll("{status}", status);
}
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  try {
    if (req.method === "GET" && pathname === "/api/state") return json(res, 200, safeState());
    if (req.method === "POST" && pathname === "/api/settings") {
      const body = await readBody(req);
      const url = String(body.webhookUrl ?? "").trim();
      if (url && !validWebhook(url)) return json(res, 400, { error: "That doesn't look like a valid discord.com webhook URL." });
      settings = {
        webhookUrl: url || settings.webhookUrl || "",
        enabled: Boolean(body.enabled),
        alertAvailable: body.alertAvailable !== false,
        alertUnknown: Boolean(body.alertUnknown),
        message: String(body.message || "").slice(0, 1500)
      };
      write(settingsFile, settings);
      return json(res, 200, safeState());
    }
    if (req.method === "POST" && pathname === "/api/webhook/test") {
      await sendWebhook("⚡ **SNIPERS OG — test message**\nYour webhook connection is working. This is only a test.");
      return json(res, 200, { sent: true });
    }
    if (req.method === "POST" && pathname === "/api/targets") {
      const body = await readBody(req);
      const name = String(body.username || "").trim().toLowerCase();
      if (!/^[a-z0-9_.]{2,32}$/.test(name) || name.startsWith(".") || name.endsWith(".") || name.includes(".."))
        return json(res, 400, { error: "Enter a valid 2–32 character username." });
      if (!state.targets.some(t => t.username === name)) state.targets.unshift({ username: name, status: "UNKNOWN", addedAt: new Date().toISOString() });
      write(stateFile, state);
      return json(res, 200, safeState());
    }
    const match = pathname.match(/^\/api\/targets\/([a-z0-9_.]{2,32})\/status$/);
    if (req.method === "POST" && match) {
      const name = match[1];
      const body = await readBody(req);
      const status = String(body.status || "");
      if (!["AVAILABLE", "TAKEN", "UNKNOWN"].includes(status)) return json(res, 400, { error: "Invalid status." });
      const target = state.targets.find(t => t.username === name);
      if (!target) return json(res, 404, { error: "Target not found." });
      target.status = status;
      target.checkedAt = new Date().toISOString();
      state.history.unshift({ username: name, status, at: target.checkedAt });
      state.history = state.history.slice(0, 300);
      write(stateFile, state);
      const shouldAlert = settings.enabled &&
        ((status === "AVAILABLE" && settings.alertAvailable !== false) || (status === "UNKNOWN" && settings.alertUnknown));
      let alert = "not-sent";
      if (shouldAlert) {
        try { await sendWebhook(renderMessage(name, status)); alert = "sent"; }
        catch (error) { alert = "failed"; return json(res, 502, { ...safeState(), alert, error: error.message }); }
      }
      return json(res, 200, { ...safeState(), alert });
    }
    const remove = pathname.match(/^\/api\/targets\/([a-z0-9_.]{2,32})$/);
    if (req.method === "DELETE" && remove) {
      state.targets = state.targets.filter(t => t.username !== remove[1]);
      write(stateFile, state);
      return json(res, 200, safeState());
    }
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return fs.createReadStream(path.join(root, "index.html")).pipe(res);
    }
    return json(res, 404, { error: "Not found." });
  } catch (error) {
    return json(res, 400, { error: error.message || "Request failed." });
  }
});
server.listen(Number(process.env.PORT || 3000), "127.0.0.1", () => console.log("SNIPERS OG local app: http://localhost:" + (process.env.PORT || 3000)));
