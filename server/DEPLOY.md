# Native server – VPS setup

Run behind nginx (TLS via Cloudflare). Environment variables (systemd `Environment=` or `.env`):

| Variable | Purpose |
|---|---|
| `NATIVE_DATA_DIR` | Where the SQLite DB, skins and media are stored |
| `NATIVE_TRUST_PROXY=1` | Trust `X-Real-IP` from nginx |
| `NATIVE_SITE_KEY` | Long random secret shared with the website (`openssl rand -hex 32`). When set, requests from the website carrying `X-Native-Site-Key` may pass the visitor's IP in `X-Native-Client-IP`, so rate limits apply per visitor. Leave unset to disable. |

Older `NOCTRA_*` variables and a `noctra.db` database file from before the rename are still picked up, so existing servers keep working without changes.

nginx must forward the custom headers (it does by default) and set `X-Real-IP`.

After changing env: `sudo systemctl restart native-server` (use your unit name).
Set the same secret on the website host as `NATIVE_SITE_KEY` (the site still accepts the older `NOCTRA_SITE_KEY` too), then redeploy the website.

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
journalctl -u native-deploy -n 50          # what the last deploys did
~/native-server/.deploy/auto-deploy.sh --force   # deploy now
cat ~/native-server/.deploy/deployed-sha   # commit currently live
ls ~/native-server/.deploy/backups         # last 5 code backups (restore: tar -xzf <file> -C ~/native-server)
```

## Native Client mod endpoints

`GET /v1/skins/directory`, `GET /v1/skins/stream` (SSE), `POST /v1/auth/game-ticket`, `GET /v1/mod/me`
(see `mod-routes.js`). Game tickets are signed with `NATIVE_TICKET_SECRET` (optional; otherwise a random
secret is generated once into `data/ticket.secret`). nginx must not buffer `/v1/skins/stream`
(`proxy_buffering off;` – the server also sends `X-Accel-Buffering: no`).
