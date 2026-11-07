const express = require("express");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "Username Sniper backend is running"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
