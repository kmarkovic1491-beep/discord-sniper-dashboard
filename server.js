

const express = require("express");
const crypto = require("crypto");

const app = express();

const allowedOrigin =
  "https://kmarkovic1491-beep.github.io";

// Allow requests from the dashboard
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json());

// Safe configuration diagnostic
app.get("/", (req, res) => {
  res.json({
    status: "online",
    passwordConfigured: Boolean(process.env.DASHBOARD_PASSWORD),
    webhookConfigured: Boolean(process.env.DISCORD_WEBHOOK_URL)
  });
});

// Send Discord notification
app.post("/notify", async (req, res) => {
  const { password, username } = req.body || {};

  const secret = process.env.DASHBOARD_PASSWORD;
  const webhook = process.env.DISCORD_WEBHOOK_URL;

  if (!secret || !webhook) {
    return res.status(500).json({
      error: "Server not configured"
    });
  }

  if (
    typeof password !== "string" ||
    password.length !== secret.length ||
    !crypto.timingSafeEqual(
      Buffer.from(password),
      Buffer.from(secret)
    )
  ) {
    return res.status(401).json({
      error: "Wrong password"
    });
  }

  if (
    typeof username !== "string" ||
    !/^[a-z0-9_.]{2,4}$/.test(username)
  ) {
    return res.status(400).json({
      error: "Invalid username"
    });
  }

  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content: `🎯 Username submitted for verification: **${username}**`
      })
    });

    if (!response.ok) {
      return res.status(502).json({
        error: "Discord webhook failed"
      });
    }

    return res.json({ success: true });

  } catch (error) {
    return res.status(500).json({
      error: "Notification failed"
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
