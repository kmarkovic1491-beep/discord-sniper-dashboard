# Discord webhook setup

The dashboard stays on GitHub Pages. This Cloudflare Worker is the private relay that stores the Discord webhook URL as a server-side secret.

## 1. Create the free Worker
1. Sign in to Cloudflare and open **Workers & Pages**.
2. Create a Worker named something like `snipers-og-alerts`.
3. Replace its starter code with `worker/discord-webhook.js` from this repository and deploy.
4. In the Worker settings, add these **secrets** (not plain-text variables):
   - `DISCORD_WEBHOOK_URL`: your Discord channel webhook URL.
   - `DASHBOARD_KEY`: create a long random private password. Keep it private.

## 2. Connect the dashboard
1. Open the public dashboard and go to **Settings**.
2. Paste the deployed Worker URL (for example `https://snipers-og-alerts.<your-subdomain>.workers.dev`).
3. Enter the same `DASHBOARD_KEY` you saved as a Worker secret.
4. Tap **Save connection**, then **Send test alert**.

When you manually change a tracked username's status, the dashboard sends the configured message to Discord. The webhook URL never goes into the public GitHub repository or browser.

## Security notes
- Never commit the webhook URL or access key to GitHub.
- Anyone who knows your dashboard access key can trigger alerts, so don't share it.
- The Worker only accepts requests from this dashboard's GitHub Pages origin.
- This sends alerts for manual status changes only. It does not check username availability or claim names.
