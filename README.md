# OpenBrain (DigitalOcean)

OpenBrain is a lightweight Node.js service that:

- accepts Discord slash-command captures at `POST /ingest`
- exposes an authenticated MCP endpoint at `GET/POST /mcp`
- stores thoughts in PostgreSQL with pgvector embeddings

This repo is designed for a single Ubuntu droplet on DigitalOcean with nginx + PM2.

## Requirements

- DigitalOcean droplet running Ubuntu 22.04 or 24.04
- A domain name pointed at the droplet (optional but recommended for SSL)
- OpenRouter API key
- Discord Application Public Key
- SSH access with sudo privileges

## Quick Install (Recommended)

Run these commands on your droplet:

```bash
curl -fsSL "https://raw.githubusercontent.com/itsMattShull/openbrain-do/master/setup.sh?ts=$(date +%s)" -o /tmp/openbrain-setup.sh
chmod +x /tmp/openbrain-setup.sh
sudo bash /tmp/openbrain-setup.sh
```

Why this method: downloading first avoids shell-pipe prompt issues and ensures you can inspect/re-run the exact script.

The installer will:

- install system packages (Node.js 20, PostgreSQL, nginx, certbot, PM2)
- install pgvector
- create DB/user/database
- create the `vector` extension
- clone/update this repo at `/var/www/openbrain`
- write `/var/www/openbrain/.env`
- apply `sql/schema.sql`
- configure nginx
- start the app with PM2

## Non-Interactive Install

If you want no prompts:

```bash
export DOMAIN="brain.example.com"
export PORT=3000
export DB_PASS="$(openssl rand -hex 16)"
export OPENROUTER_API_KEY="sk-or-v1-..."
export DISCORD_PUBLIC_KEY="your_discord_public_key_hex"
export MCP_ACCESS_KEY="$(openssl rand -hex 32)"
curl -fsSL "https://raw.githubusercontent.com/itsMattShull/openbrain-do/master/setup.sh?ts=$(date +%s)" -o /tmp/openbrain-setup.sh
sudo -E bash /tmp/openbrain-setup.sh
```

## Verify Deployment

Replace `<domain-or-ip>`:

```bash
curl -i http://<domain-or-ip>/health
pm2 status
```

Expected health response:

```json
{"ok":true}
```

Useful URLs:

- Ingest endpoint: `https://<domain>/ingest` (or `http://<ip>/ingest`)
- MCP endpoint: `https://<domain>/mcp`
- Health endpoint: `https://<domain>/health`

## Configure Discord

In Discord Developer Portal:

1. Create a slash command named `capture` with one required string option named `thought`.
2. Set Interactions Endpoint URL to:
   - `https://<domain>/ingest` (preferred)
   - `http://<ip>/ingest` (only for testing)
3. Copy your Application Public Key into `DISCORD_PUBLIC_KEY`.

## MCP Authentication

MCP requests must include your access key:

- header: `x-brain-key: <MCP_ACCESS_KEY>`
- or query param: `?key=<MCP_ACCESS_KEY>`

## Operations

```bash
pm2 status
pm2 logs openbrain
pm2 restart openbrain
pm2 save
sudo systemctl status nginx
```

Environment file:

```bash
sudo cat /var/www/openbrain/.env
```

## Troubleshooting

### `Peer authentication failed for user "openbrain"`

Use TCP for `psql` so password auth is used:

```bash
DB_URL=$(grep '^DATABASE_URL=' /var/www/openbrain/.env | cut -d= -f2-)
psql "$DB_URL" -v ON_ERROR_STOP=1 -f /var/www/openbrain/sql/schema.sql
```

### `permission denied to create extension "vector"`

Create extension as postgres superuser:

```bash
sudo -u postgres psql -d openbrain -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

Then re-run schema:

```bash
DB_URL=$(grep '^DATABASE_URL=' /var/www/openbrain/.env | cut -d= -f2-)
psql "$DB_URL" -v ON_ERROR_STOP=1 -f /var/www/openbrain/sql/schema.sql
```

### `bash: line 1: $: command not found` after `pm2 startup ... | tail -1 | bash`

Ignore that old pattern and run:

```bash
pm2 save
pm2 startup systemd -u root --hp /root
systemctl enable pm2-root
systemctl restart pm2-root
```

## Security Notes

- Use HTTPS in production.
- Keep `MCP_ACCESS_KEY` secret and rotate it if leaked.
- Keep `.env` permissions restrictive (`chmod 600`).

