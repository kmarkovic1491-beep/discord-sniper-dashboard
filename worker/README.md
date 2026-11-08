# Apify checker backend

The GitHub Pages site is static, so it must not contain the Apify API token. This Cloudflare Worker keeps the token server-side and forwards one username at a time to the Apify Store actor.

## Deploy

1. Create a Cloudflare account and open Workers & Pages.
2. Create a Worker named `snipers-apify-checker`.
3. Paste the contents of `worker/apify-proxy.js` into the Worker editor and deploy.
4. In the Worker settings, add a **secret** named `APIFY_TOKEN` containing a newly generated Apify API token. Do not put the token in GitHub or the dashboard.
5. In Worker settings, confirm the deployed Worker URL ends in `.workers.dev`.
6. Open the dashboard, go to **Settings**, paste that Worker URL into **Apify checker Worker URL**, and save preferences.

The Worker only accepts browser requests from this dashboard's GitHub Pages origin and exposes `POST /check`. It calls `maged120~discord-username-checker` through Apify's synchronous dataset endpoint. The actor's input is `{ "usernames": ["name"] }`; see its [Apify API page](https://apify.com/maged120/discord-username-checker/api).

## Security notes

- Revoke any Apify token that has been pasted into chat, a public repository, or any other exposed location. Generate a replacement and add it only as the Cloudflare Worker secret.
- The Worker never returns or logs the token.
- Origin checks reduce casual cross-site use, but Origin headers are not authentication; for a public production service, add Cloudflare rate limiting or Turnstile before sharing the Worker URL.
- The actor's result schema may evolve. The Worker normalizes common `status`, `availability`, and boolean availability fields and returns an error rather than guessing if the response is ambiguous.
- A successful availability check is point-in-time only; verify in Discord before claiming a username.
