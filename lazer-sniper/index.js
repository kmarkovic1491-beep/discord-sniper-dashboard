import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.join(root, "data", "targets.json");
fs.mkdirSync(path.dirname(dataFile), { recursive: true });
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, "[]");

const readTargets = () => JSON.parse(fs.readFileSync(dataFile, "utf8"));
const saveTargets = value => fs.writeFileSync(dataFile, JSON.stringify(value, null, 2));
const send = (res, code, data) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(data));
};
const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "content-type" });
    return res.end();
  }
  if (req.url === "/api/status" && req.method === "GET") return send(res, 200, { online: true, service: "LAZER SNIPER", availability: "UNKNOWN", discordRequestsEnabled: false });
  if (req.url === "/api/targets" && req.method === "GET") return send(res, 200, { targets: readTargets() });
  if (req.url === "/api/targets" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { username } = JSON.parse(body);
        const name = String(username || "").trim().toLowerCase();
        if (!/^[a-z0-9_.]{2,32}$/.test(name)) return send(res, 400, { error: "Invalid username format" });
        const targets = readTargets();
        if (!targets.some(item => item.username === name)) targets.push({ username: name, status: "UNKNOWN", addedAt: new Date().toISOString() });
        saveTargets(targets);
        send(res, 201, { targets });
      } catch { send(res, 400, { error: "Invalid JSON" }); }
    });
    return;
  }
  if (req.url.startsWith("/api/targets/") && req.method === "DELETE") {
    const name = decodeURIComponent(req.url.slice("/api/targets/".length)).toLowerCase();
    const targets = readTargets().filter(item => item.username !== name);
    saveTargets(targets);
    return send(res, 200, { targets });
  }
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(root, "index.html")).pipe(res);
  }
  send(res, 404, { error: "Not found" });
});
const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0", () => console.log(`LAZER SNIPER listening on ${port}`));