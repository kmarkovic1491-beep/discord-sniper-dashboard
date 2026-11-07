# LAZER SNIPER — local rebuild

A standalone local username idea generator, watchlist, history and Discord webhook notifier.

## Run locally

Requires Node.js 20 or newer.

```bash
npm start
```

Open http://localhost:3000.

## Webhook setup

Open **Settings**, paste your Discord webhook URL into the private field, save it, and use **Send test message**. The URL is stored only in the local `data/settings.json` file, which is excluded from Git by `.gitignore`. The app never returns the saved URL to the browser and never writes it to source files. Do not commit your local `data/` folder or share your webhook URL.

## Availability and safety

This build does not log in to Discord, use account tokens, automate account changes, call undocumented availability endpoints, or bypass rate limits. Discord does not provide a supported public endpoint that this local app can rely on to guarantee username availability. Names therefore start as **UNKNOWN**. After you verify a name yourself in Discord, you can manually mark it as available and send a webhook alert. Always confirm availability again in Discord before attempting to claim it.

## Data

Watchlist, history and webhook settings are stored locally in `data/`. Back up that folder privately if needed; it contains your webhook secret.
