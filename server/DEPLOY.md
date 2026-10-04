# Native server – VPS setup

Run behind nginx (TLS via Cloudflare). Environment variables (systemd `Environment=` or `.env`):

| Variable | Purpose |
|---|---|
| `NOCTRA_DATA_DIR` | Where the SQLite DB, skins and media are stored |
| `NOCTRA_TRUST_PROXY=1` | Trust `X-Real-IP` from nginx |
| `NOCTRA_SITE_KEY` | Long random secret shared with the website (`openssl rand -hex 32`). When set, requests from the website carrying `X-Native-Site-Key` may pass the visitor's IP in `X-Native-Client-IP`, so rate limits apply per visitor. Leave unset to disable. |

nginx must forward the custom headers (it does by default) and set `X-Real-IP`.

After changing env: `sudo systemctl restart noctra-server` (use your unit name).
Set the same `NOCTRA_SITE_KEY` as an env var on the website host, then redeploy the website.

## Automatic deploys (pull-based)

The VPS checks GitHub every ~3 minutes. When `server/` changes on `main` it downloads that commit,
syntax-checks it, backs up the running code, swaps it in (never touching `data/`, `.env`, `node_modules/`),
reloads pm2 and waits for `/health`. If anything fails it restores the backup and waits for the next commit.
No GitHub secrets or inbound SSH are needed.

One-time install on the VPS (already done for `api.nativelaunch.xyz`):

```bash
git clone --depth 1 https://github.com/atlas-thedev/native-client /tmp/nc && bash /tmp/nc/server/deploy/install.sh
```

Useful commands:

```bash
journalctl -u noctra-deploy -n 50          # what the last deploys did
~/noctra-server/.deploy/auto-deploy.sh --force   # deploy now
cat ~/noctra-server/.deploy/deployed-sha   # commit currently live
ls ~/noctra-server/.deploy/backups         # last 5 code backups (restore: tar -xzf <file> -C ~/noctra-server)
```

## Native Client mod endpoints

`GET /v1/skins/directory`, `GET /v1/skins/stream` (SSE), `POST /v1/auth/game-ticket`, `GET /v1/mod/me`
(see `mod-routes.js`). Game tickets are signed with `NOCTRA_TICKET_SECRET` (optional; otherwise a random
secret is generated once into `data/ticket.secret`). nginx must not buffer `/v1/skins/stream`
(`proxy_buffering off;` – the server also sends `X-Accel-Buffering: no`).
