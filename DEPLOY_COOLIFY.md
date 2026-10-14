# Deploying autorender with Coolify

Step-by-step guide for self-hosting the full autorender stack (web platform + Discord bot + database) on a [Coolify](https://coolify.io) v4 instance.

- [What gets deployed](#what-gets-deployed)
- [Prerequisites](#prerequisites)
- [Step 1 — Create the Discord application](#step-1--create-the-discord-application)
- [Step 2 — Push the repository to your own Git remote](#step-2--push-the-repository-to-your-own-git-remote)
- [Step 3 — Create the resource in Coolify](#step-3--create-the-resource-in-coolify)
- [Step 4 — Attach the domain](#step-4--attach-the-domain)
- [Step 5 — Set the environment variables](#step-5--set-the-environment-variables)
- [Step 6 — Deploy](#step-6--deploy)
- [Step 7 — First login and admin permissions](#step-7--first-login-and-admin-permissions)
- [Step 8 — Set up render clients](#step-8--set-up-render-clients)
- [Step 9 — Verify end-to-end](#step-9--verify-end-to-end)
- [Ongoing operations](#ongoing-operations)
- [Troubleshooting](#troubleshooting)

## What gets deployed

The stack is defined in [`docker-compose.coolify.yml`](./docker-compose.coolify.yml) and runs three containers on the Coolify host:

| Service    | Built from                       | Role                                                                       |
| ---------- | -------------------------------- | -------------------------------------------------------------------------- |
| `server`   | `Dockerfile` target `server`     | Web platform + API + WebSocket hub (port 8001, exposed via Coolify/Traefik) |
| `bot`      | `Dockerfile` target `bot`        | Discord bot, connects to the server over the internal Docker network        |
| `database` | `Dockerfile` target `database`   | MariaDB 11 with the schema/seed SQL baked in (runs automatically on first boot) |

Not part of this stack: **render clients**. Those are gaming PCs (with Portal 2 installed) that connect *out* to your server over WebSocket, claim queued renders, record the video in-game, and upload the result. They can live anywhere with internet access — see [Step 8](#step-8--set-up-render-clients).

Differences from the original p2sr production setup, so you know what you are *not* missing:

- **No nginx container.** Coolify's built-in Traefik proxy terminates TLS and routes your domain to the server container. The static-file duty nginx used to have is handled by the server itself (`AUTORENDER_SERVE_STORAGE=true`, already set in the compose file). The app trusts `X-Forwarded-*` headers (Oak `proxy: true`), so OAuth redirects and secure cookies work behind Traefik.
- **No Docker Hub images.** The p2sr images on Docker Hub don't contain this fork's changes (filters, trending, etc.), so Coolify builds the images from this repository on every deploy.
- **No mounted `.env` / `entrypoint.sh` files.** Everything is configured through environment variables in the Coolify UI.
- **Named volumes** hold all state (`storage`, `mysql`, `bot-kv`, logs, `backups`) and survive redeploys.

## Prerequisites

1. A server running **Coolify v4** (any VPS works; 2 vCPU / 4 GB RAM is comfortable — video files pass through the server, so give it disk space or enable Backblaze B2 later).
2. A **domain** (e.g. `autorender.example.com`) with a DNS **A record** pointing at the Coolify server's IP. Coolify/Traefik will get the Let's Encrypt certificate automatically.
3. A **Git host** (GitHub etc.) where you can push this repository — see Step 2.
4. A **Discord account** to create the application, and Developer Mode enabled in Discord (Settings → Advanced) so you can copy your user ID.

## Step 1 — Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **OAuth2** page:
   - Copy the **Client ID** and **Client Secret** (you'll need both).
   - Under **Redirects**, add: `https://autorender.example.com/login/discord/authorize` (your real domain — it must exactly match `AUTORENDER_PUBLIC_URI` + `/login/discord/authorize`).
3. **Bot** page:
   - Copy (or reset and copy) the **Bot Token**.
   - Enable **Message Content Intent** under Privileged Gateway Intents.
4. Invite the bot to your Discord server using (replace `<CLIENT_ID>`):

   ```
   https://discord.com/api/oauth2/authorize?client_id=<CLIENT_ID>&permissions=117760&scope=bot%20applications.commands
   ```

5. Copy your own **Discord user ID** (right-click your name → Copy User ID). This account becomes the platform admin.

## Step 2 — Push the repository to your own Git remote

The local repo's `origin` still points at `p2sr/autorender`, which you can't push to. Create an empty repository on your Git host, then:

```bash
git remote rename origin upstream
git remote add origin git@github.com:<your-org>/autorender.git
git push -u origin main
```

If the repository is private, connect Coolify to it via a **GitHub App** or a **deploy key** (Coolify → *Sources*) before the next step.

## Step 3 — Create the resource in Coolify

1. In Coolify: **Projects → your project → Add Resource → Docker Compose** (choose *Public Repository* or your GitHub App source).
2. Repository URL: your repo from Step 2. Branch: `main`.
3. **Docker Compose Location**: `/docker-compose.coolify.yml`
4. Save. Coolify parses the file and lists the three services (`server`, `bot`, `database`).

## Step 4 — Attach the domain

1. Open the resource → the `server` service → **Domains**.
2. Set: `https://autorender.example.com` (if Coolify asks for a port or doesn't pick one up, use `https://autorender.example.com:8001` — the app listens on 8001).
3. Leave `bot` and `database` without domains — they must not be publicly reachable.

## Step 5 — Set the environment variables

Coolify detects the `${...}` placeholders from the compose file and lists them under **Environment Variables**. Fill in:

**Required:**

| Variable                | Value                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `AUTORENDER_PUBLIC_URI` | `https://autorender.example.com` — must match the domain from Step 4, **no trailing slash** |
| `DISCORD_USER_ID`       | Your Discord user ID (Step 1.5)                                                        |
| `DISCORD_CLIENT_ID`     | Discord application Client ID                                                          |
| `DISCORD_CLIENT_SECRET` | Discord application Client Secret                                                      |
| `DISCORD_BOT_TOKEN`     | Discord bot token                                                                      |
| `AUTORENDER_BOT_TOKEN`  | Shared secret between server and bot — generate: `openssl rand -base64 24`             |
| `COOKIE_SECRET_KEY`     | Session cookie encryption key — generate: `openssl rand -base64 24`                    |
| `MARIADB_ROOT_PASSWORD` | Random password — `openssl rand -base64 24`                                            |
| `MARIADB_PASSWORD`      | Random password — `openssl rand -base64 24`                                            |

**Optional (sensible defaults are baked into the compose file):**

| Variable                                          | Default            | Purpose                                        |
| ------------------------------------------------- | ------------------ | ---------------------------------------------- |
| `MARIADB_USER` / `MARIADB_DATABASE`               | `p2render`         | DB user/database name                          |
| `AUTORENDER_MAX_DEMO_FILE_SIZE`                   | `6` (MB)           | Max demo upload size                           |
| `AUTORENDER_MAX_VIDEO_FILE_SIZE`                  | `350` (MB)         | Max video upload size                          |
| `B2_ENABLED` + `B2_BUCKET_ID`/`B2_KEY_ID`/`B2_KEY_NAME`/`B2_APP_KEY` | disabled | Store finished videos on Backblaze B2 instead of local disk |
| `BUNNY_CDN_VIDEOS_*`                              | disabled           | Bunny CDN video hosting                        |
| `BOARD_*` / `MEL_BOARD_*`                         | disabled           | board.portal2.sr leaderboard integration       |
| `DISCORD_BOARD_INTEGRATION_WEBHOOK_URL`           | disabled           | Webhook for board.portal2.sr WR renders        |
| `DISCORD_MEL_BOARD_INTEGRATION_WEBHOOK_URL`       | disabled           | Webhook for Mel board WR renders               |
| `DISCORD_LPHUB_BOARD_INTEGRATION_WEBHOOK_URL`     | disabled           | Webhook for LP Hub WR renders                  |

> Note: every unused integration must stay at its `none`/`false` default rather than being empty — the server reads these variables unconditionally at startup. The compose file already takes care of this; only override them when you actually configure the integration.

## Step 6 — Deploy

Hit **Deploy**. The first deployment takes a few minutes:

- Docker builds the three images (Deno caches all dependencies into the image).
- MariaDB initializes an empty data volume and runs the baked-in SQL (`_create.sql`, `_init.sql`, `_populate.sql`, `migrate_mel_board.sql`) — **this happens only when the `mysql` volume is empty**, i.e. the very first boot.
- The server waits for the database healthcheck before starting.

Verify in the container logs (Coolify → resource → *Logs*):

- `server`: a line like `Server listening at http://0.0.0.0:8001`
- `bot`: connects to Discord and to the server WebSocket; the bot appears **online** in your Discord server.
- Visit `https://autorender.example.com` — the site should load with a Discord login button.

## Step 7 — First login and admin permissions

1. Visit the site and **log in with Discord** using the account whose ID you put in `DISCORD_USER_ID`. This creates your user row.
2. Open a terminal into the `server` container (Coolify → resource → `server` → *Terminal*) and run:

   ```bash
   deno task perm
   ```

   This grants all permissions to the `DISCORD_USER_ID` account.
3. Log out and log back in to refresh the session.

## Step 8 — Set up render clients

Render clients are the machines that actually run Portal 2 and record the videos. Without at least one connected client, render requests will queue forever.

1. **Point the client at your server.** The production URLs are hardcoded in [`src/client/constants.ts`](./src/client/constants.ts) — change both `prod` values to your domain and commit:

   ```ts
   export const AutorenderConnectUri = {
     dev: 'wss://autorender.portal2.local/connect/client',
     prod: 'wss://autorender.example.com/connect/client',
   };

   export const AutorenderBaseApi = {
     dev: 'https://autorender.portal2.local',
     prod: 'https://autorender.example.com',
   };
   ```

   Also add your domain to the `--allow-net` list of the `compile` task in [`src/client/deno.json`](./src/client/deno.json) — the compiled binary's Deno network permissions are fixed at compile time, and a domain missing from that list causes a permission error when the client connects.

2. **Compile the client binaries** (on any machine with [Deno](https://deno.com) installed, from the repo root):

   ```bash
   deno task compile --all --release
   ```

   This produces `src/client/bin/autorenderclient` (Linux) and `src/client/bin/autorenderclient.exe` (Windows).

3. **Create an access token**: log in to the platform (as a user with token permissions — the admin from Step 7 works), generate a new client token, and copy it.

4. **On the render machine** (needs Steam + Portal 2 installed): run the binary and follow the interactive setup — paste the access token, pick the max render quality and supported games, and point it at your Steam `common` directory. Then run a benchmark:

   ```
   autorenderclient.exe benchmark
   ```

5. Pre-flight checklist for a machine going into "production" rendering:
   - Steam Overlay disabled, Steam in offline mode
   - OS sleep/power-off disabled
   - Stable network connection

## Step 9 — Verify end-to-end

1. In your Discord server, run `/bot info` — the bot should respond.
2. Upload a short demo with `/render demo` (test demos live in `src/server/tests/demos/`, e.g. `short.dem`).
3. The queued render should be picked up by your client, rendered in-game, uploaded, and the bot should reply with a video link on your domain.

## Ongoing operations

### Updates

Push to `main` and click **Redeploy** in Coolify (or enable the resource's **auto-deploy webhook** so every push deploys automatically). Volumes are untouched by redeploys; the `/storage/files` seed assets are re-copied from the image on every container start, which is harmless.

### Database backups

From the `database` container terminal in Coolify:

```bash
mariadb-dump -u root -p"$MARIADB_ROOT_PASSWORD" --hex-blob --routines \
  --databases "$MARIADB_DATABASE" | gzip -8 > /backups/p2render_$(date +%F).sql.gz
```

Dumps land in the `backups` named volume. Also consider:

- Coolify's scheduled backup features / host-level snapshots of `/var/lib/docker/volumes/`.
- The `bot-kv` volume (Deno KV) and the `storage` volume (demos/videos/thumbnails) are the other stateful pieces worth backing up.
- The repo's `backup.ts` can push dumps to Backblaze B2 + a Discord webhook if you want to recreate the old off-site backup flow.

### Disk usage

Finished videos accumulate in the `storage` volume. The original production setup uploaded videos to Backblaze B2 (`B2_ENABLED=true`), after which the local copies are cleaned by the processing task, keeping only thumbnails/previews locally. Recommended once traffic is non-trivial.

## Troubleshooting

| Symptom                                             | Likely cause / fix                                                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Discord login fails with `redirect_uri` mismatch    | The redirect in the Discord Developer Portal must be exactly `AUTORENDER_PUBLIC_URI` + `/login/discord/authorize`.       |
| Bot is offline in Discord                           | Wrong `DISCORD_BOT_TOKEN`, or Message Content Intent not enabled. Check `bot` container logs.                             |
| Bot online but renders never start                  | Bot ↔ server WebSocket auth failing: `AUTORENDER_BOT_TOKEN` must be identical for both services (it is, if you set it once in the Coolify UI). |
| Server crashes at startup with an env error         | A variable from the list in Step 5 is missing/empty — the server reads all of them unconditionally.                       |
| 502 from the domain                                 | Server container still starting (waits for DB healthcheck) or build failed — check deployment logs.                       |
| Schema changes / want a fresh DB                    | The init SQL only runs on an **empty** `mysql` volume. Stop the stack, delete the `mysql` volume in Coolify, redeploy.     |
| Client can't connect                                | Client binaries carry the server URL from compile time — recompile after changing `src/client/constants.ts` (Step 8.1).   |
| Large demo/video uploads rejected                   | Check `AUTORENDER_MAX_DEMO_FILE_SIZE` / `AUTORENDER_MAX_VIDEO_FILE_SIZE`. Traefik itself does not limit body size by default. |
