# LAZER SNIPER

A Node.js starter inspired by the file layout of [discord-username-sniper](https://github.com/yutomiwana/discord-username-sniper).

## Included
- `index.js`: small HTTP server and target-list API
- `utils/check.js`: conservative UNKNOWN result until a supported verification method exists
- `utils/claim.js`: opens Discord for a user-confirmed manual claim
- `config.example.json`: non-secret configuration
- `usernames.txt`: username list template

## Run
Requires Node.js 20 or newer:

```bash
npm start
```

Open http://localhost:3000.

## Important
This project does not collect Discord account tokens or passwords, automate account changes, impersonate clients, spoof fingerprints, or evade Discord rate limits. Discord availability is shown as UNKNOWN unless verified in Discord itself. A username appearing available in an unverified source is not a guarantee it can be claimed.
