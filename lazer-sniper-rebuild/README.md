# SNIPERS OG — Crimson Moon local dashboard

A private, local dashboard for organizing username candidates, manually tracking statuses, generating random ideas, reviewing activity, and sending Discord webhook notifications.

## Start the dashboard on Windows

1. Install the current **Node.js LTS** release from https://nodejs.org/en/download if it is not already installed.
2. Download this branch as a ZIP from GitHub and extract it.
3. Open the extracted `lazer-sniper-rebuild` folder.
4. Double-click **START-SNIPERS-OG.bat**.
5. Your browser should open at **http://localhost:3000**. Keep the black terminal window open while using the dashboard.

If Windows asks which app to use for the `.bat` file, choose Command Prompt. You can also start it manually by opening a terminal in this folder and running `npm start`.

## Start manually (Windows, macOS, or Linux)

Requires Node.js 20 or newer.

```bash
npm start
```

Then open http://localhost:3000.

## Features

- Crimson Moon / Discord-inspired dashboard
- Username watchlist with manual UNKNOWN / AVAILABLE / TAKEN status
- Random 3-, 4-, and 5-character username idea generator
- Activity history
- Local Discord webhook settings, custom alert message, and test message
- Mobile-friendly sidebar and layout

## Webhook setup

Open **Webhook Alerts**, paste your Discord webhook URL into the private field, save it, and use **Send test**. The URL is stored only in the local `data/settings.json` file. The app never returns the saved URL to the browser or puts it in source files. The `data/` folder is excluded from Git. Do not commit or share it.

## Availability and safety

This build does not log in to Discord, use account tokens, automate account changes, call undocumented availability endpoints, or bypass rate limits. Discord does not provide a supported public endpoint this app can rely on to guarantee arbitrary username availability. Generated names are ideas only and begin as **UNKNOWN**. Verify each name yourself in Discord before manually changing its status or attempting to claim it.

## Local data

The watchlist, history, and webhook settings are stored in `data/` on your computer. Back it up privately if needed; it contains your webhook secret.
