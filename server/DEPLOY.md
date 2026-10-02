# Noctra server – VPS setup

Run behind nginx (TLS via Cloudflare). Environment variables (systemd `Environment=` or `.env`):

| Variable | Purpose |
|---|---|
| `NOCTRA_DATA_DIR` | Where the SQLite DB, skins and media are stored |
| `NOCTRA_TRUST_PROXY=1` | Trust `X-Real-IP` from nginx |
| `NOCTRA_SITE_KEY` | Long random secret shared with the website (`openssl rand -hex 32`). When set, requests from the website carrying `X-Noctra-Site-Key` may pass the visitor's IP in `X-Noctra-Client-IP`, so rate limits apply per visitor. Leave unset to disable. |

nginx must forward the custom headers (it does by default) and set `X-Real-IP`.

After changing env: `sudo systemctl restart noctra-server` (use your unit name).
Set the same `NOCTRA_SITE_KEY` as an env var on the website host, then redeploy the website.
