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

## Tiered Memory Architecture

OpenBrain organizes knowledge into two tiers backed by separate PostgreSQL tables.

### Tier 1 — Thoughts (raw captures, append-only)

The `thoughts` table stores every raw capture exactly as received. Nothing is ever deleted or modified. Each row has a `content` text field, a `VECTOR(1536)` embedding for semantic search, and a `metadata` JSONB blob with extracted `type`, `topics`, `people`, and `action_items`.

MCP tools for Tier 1: `capture_thought`, `search_thoughts`, `list_thoughts`, `thought_stats`

### Tier 2 — Memory Objects (synthesized knowledge)

The `memory_objects` table stores distilled, synthesized knowledge derived from raw thoughts. Three object types are supported:

| `object_type` | Purpose |
|---|---|
| `synthesis` | Distilled understanding of a topic, project, or situation as of a date. Example: "Minneapolis competitive situation as of March 2026." |
| `profile` | Synthesized understanding of a person — role, relationship, what to watch for. |
| `principle` | A durable truth, mental model, or hard-won lesson that doesn't expire. |

Each memory object has a `domain` (`work`, `personal`, or `general`), a `title`, `content`, optional `source_thought_ids` (UUIDs of thoughts it was derived from), optional `supersedes_ids` (UUIDs of older objects it replaces), and a `valid_as_of` timestamp.

### New MCP Tools (Tier 2)

**`capture_memory_object`** — Save a new synthesized memory object.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `object_type` | `synthesis` \| `profile` \| `principle` | ✓ | Type of object |
| `domain` | `work` \| `personal` \| `general` | ✓ | Domain |
| `title` | string | ✓ | Short descriptive title |
| `content` | string | ✓ | Full synthesized content, written as a standalone briefing |
| `source_thought_ids` | string[] | — | UUIDs of source thoughts |
| `supersedes_ids` | string[] | — | UUIDs of older memory objects this replaces |
| `valid_as_of` | ISO date string | — | Knowledge currency date, defaults to now |

Returns the saved object ID and confirmation.

**`search_memory`** — Unified semantic search across both tiers.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | — | Natural language query |
| `limit` | number | 10 | Total results to return |
| `tier` | `all` \| `thoughts` \| `objects` | `all` | Restrict to one tier |
| `object_type` | `synthesis` \| `profile` \| `principle` | — | Filter memory objects by type |
| `domain` | `work` \| `personal` \| `general` | — | Filter by domain |
| `threshold` | number | 0.5 | Cosine similarity threshold |

When `tier` is `all`, memory objects receive a **+0.05 similarity boost** before sorting. This ensures synthesized, distilled knowledge surfaces above raw captures when both are relevant to a query. Each result includes a `tier` label (`THOUGHT` or `MEMORY: <type>`) so callers know what they retrieved.

**`list_memory_objects`** — Browse memory objects with optional filters.

| Parameter | Type | Description |
|---|---|---|
| `object_type` | optional | Filter by type |
| `domain` | optional | Filter by domain |
| `limit` | number (default 10) | Max results |
| `days` | number | Only objects updated within last N days |

Returns sorted by `updated_at` descending.

**`memory_stats`** — Combined stats summary across both tiers.

Returns: total thoughts by type (Tier 1), total memory objects by `object_type` and `domain` (Tier 2), most recent memory object per type, and date ranges for both tiers.

### Tier 2 Cleanup Tools

Consolidate and clean up synthesized knowledge as it grows.

**`retire_memory_object`** — Soft-delete a memory object. Retired objects stay in the database (recoverable) but are excluded from default search and list results.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `memory_object_id` | UUID | ✓ | Object to retire |
| `reason` | string | — | Why it was retired, e.g. `"duplicate of {id}"`, `"stale Q1 2026 snapshot"` |

**`update_memory_object`** — Edit an existing memory object in place for small fixes (typos, title tweaks, correcting a stale fact inside an otherwise-current object). Only provided fields are updated; `supersedes_ids` is not touched and no new row is created. If `title` or `content` change, the embedding is regenerated.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `memory_object_id` | UUID | ✓ | Object to update |
| `title` | string | — | New title |
| `content` | string | — | New content |
| `domain` | `work` \| `personal` \| `general` | — | New domain |
| `valid_as_of` | ISO date | — | New currency date |

**`merge_memory_objects`** — Atomic merge: create a new consolidated object and retire every source in one transaction. If any step fails, the whole operation rolls back.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `object_type` | `synthesis` \| `profile` \| `principle` | ✓ | Type of the new consolidated object |
| `domain` | `work` \| `personal` \| `general` | ✓ | Domain of the new object |
| `title` | string | ✓ | Title of the new object |
| `content` | string | ✓ | Full synthesized content |
| `source_object_ids` | UUID[] | ✓ | Sources to merge and retire. Become `supersedes_ids` on the new object. |
| `valid_as_of` | ISO date | — | Currency date for the new object |
| `source_thought_ids` | UUID[] | — | Raw thoughts the new object was derived from |
| `retirement_reason` | string | — | Defaults to `"merged into {new_object_id}"` |

**`delete_memory_object`** — Hard-delete a memory object. Irreversible. Only use on already-retired objects that will not be brought back.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `memory_object_id` | UUID | ✓ | Object to delete |

All of `search_memory`, `search_thoughts`, and `list_memory_objects` accept an optional `include_retired` boolean (default `false`). When `false`, retired memory objects are filtered out. Retired objects are still resolvable via `supersedes_ids` for lineage queries.

### Applying the Migration to an Existing Database

If you already have the `thoughts` table deployed and want to add `memory_objects` without re-running the full schema:

```bash
DB_URL=$(grep '^DATABASE_URL=' /var/www/openbrain/.env | cut -d= -f2-)
psql "$DB_URL" -v ON_ERROR_STOP=1 -f /var/www/openbrain/sql/migrations/001_memory_objects.sql
psql "$DB_URL" -v ON_ERROR_STOP=1 -f /var/www/openbrain/sql/migrations/002_retirement.sql
```

Migration 002 adds `retired_at` and `retirement_reason` columns to `memory_objects`. Existing rows are backfilled with `NULL` (i.e. still active).

### Tests

```bash
DATABASE_URL=postgres://... npm test
```

Integration tests seed rows with a unique per-run prefix, exercise the cleanup tools, and clean up after themselves. Tests skip if `DATABASE_URL` is not set.

## Security Notes

- Use HTTPS in production.
- Keep `MCP_ACCESS_KEY` secret and rotate it if leaked.
- Keep `.env` permissions restrictive (`chmod 600`).

