const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "Username Sniper backend is running"
  });
});

app.post("/notify", async (req, res) => {
  const { password, username } = req.body;

  const secret = process.env.DASHBOARD_PASSWORD;
  const webhook = process.env.DISCORD_WEBHOOK_URL;

  if (!secret || !webhook) {
    return res.status(500).json({ error: "Server not configured" });
  }

  if (
    typeof password !== "string" ||
    password.length !== secret.length ||
    !crypto.timingSafeEqual(
      Buffer.from(password),
      Buffer.from(secret)
    )
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (
    typeof username !== "string" ||
    !/^[a-z0-9_.]{2,4}$/.test(username)
  ) {
    return res.status(400).json({ error: "Invalid username" });
  }

  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `🎯 Username submitted for verification: **${username}**`
      })
    });

    if (!response.ok) {
      return res.status(502).json({ error: "Webhook failed" });
    }

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Notification failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
