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
const send = (res, code, data) => { res.writeHead(code, { "content-type":"application/json; charset=utf-8", "access-control-allow-origin":"*" }); res.end(JSON.stringify(data)); };
let lastDiscordCheck = 0;
const CHECK_INTERVAL_MS = 2500;
async function checkDiscordUsername(username) {
  const wait = CHECK_INTERVAL_MS - (Date.now() - lastDiscordCheck);
  if (wait > 0) return { limited:true, retryAfterMs:wait };
  lastDiscordCheck = Date.now();
  try {
    const response = await fetch("https://discord.com/api/v9/unique-username/username-attempt-unauthed", {
      method:"POST", headers:{"content-type":"application/json","user-agent":"LAZER-SNIPER/1.0"},
      body:JSON.stringify({username}), signal:AbortSignal.timeout(10000)
    });
    if (response.status === 429) return { unknown:true, rateLimited:true };
    if (!response.ok) return { unknown:true };
    const data = await response.json();
    if (typeof data.taken !== "boolean") return { unknown:true };
    return { status:data.taken ? "TAKEN" : "AVAILABLE", checkedAt:new Date().toISOString() };
  } catch { return { unknown:true }; }
}
const server = http.createServer((req,res) => {
  if (req.method === "OPTIONS") { res.writeHead(204,{"access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,DELETE,OPTIONS","access-control-allow-headers":"content-type"}); return res.end(); }
  if (req.url === "/api/status" && req.method === "GET") return send(res,200,{online:true,service:"LAZER SNIPER",availability:"BEST_EFFORT",discordRequestsEnabled:true});
  if (req.url === "/api/check" && req.method === "POST") {
    let body = "";
    req.on("data",chunk => { body += chunk; if (body.length > 2048) req.destroy(); });
    req.on("end",async () => {
      try {
        const parsed = JSON.parse(body);
        const name = String(parsed.username || "").trim().toLowerCase();
        if (name.length < 2 || name.length > 32 || !/^[a-z0-9_.]+$/.test(name) || name.startsWith(".") || name.endsWith(".") || name.includes("..")) return send(res,400,{error:"Invalid Discord username format"});
        const result = await checkDiscordUsername(name);
        if (result.limited) return send(res,429,{status:"UNKNOWN",retryAfterMs:result.retryAfterMs,message:"Please wait before checking another name."});
        if (result.status) return send(res,200,result);
        return send(res,503,{status:"UNKNOWN",message:result.rateLimited ? "Discord rate-limited this check. Try again later." : "Discord could not verify this name."});
      } catch { return send(res,400,{error:"Invalid JSON"}); }
    });
    return;
  }
  if (req.url === "/api/targets" && req.method === "GET") return send(res,200,{targets:readTargets()});
  if (req.url === "/api/targets" && req.method === "POST") {
    let body = ""; req.on("data",chunk => body += chunk);
    req.on("end",() => { try { const parsed=JSON.parse(body); const name=String(parsed.username||"").trim().toLowerCase(); if(!/^[a-z0-9_.]{2,32}$/.test(name)) return send(res,400,{error:"Invalid username format"}); const targets=readTargets(); if(!targets.some(item=>item.username===name)) targets.push({username:name,status:"UNKNOWN",addedAt:new Date().toISOString()}); saveTargets(targets); send(res,201,{targets}); } catch { send(res,400,{error:"Invalid JSON"}); } });
    return;
  }
  if (req.url.startsWith("/api/targets/") && req.method === "DELETE") { const name=decodeURIComponent(req.url.slice("/api/targets/".length)).toLowerCase(); const targets=readTargets().filter(item=>item.username!==name); saveTargets(targets); return send(res,200,{targets}); }
  if (req.url === "/" || req.url === "/index.html") { res.writeHead(200,{"content-type":"text/html; charset=utf-8"}); return fs.createReadStream(path.join(root,"index.html")).pipe(res); }
  send(res,404,{error:"Not found"});
});
const port=Number(process.env.PORT||3000);
server.listen(port,"0.0.0.0",()=>console.log("LAZER SNIPER listening on "+port));
