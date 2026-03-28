# Extension Template

Use this directory as a starting point for new extensions.

## How to Create a New Extension

1. Copy this directory: `cp -r extensions/_template extensions/my-feature`
2. Edit `index.js` — change `name`, update tools, write handlers
3. Edit `schema.sql` — define your tables (all statements must use `IF NOT EXISTS`)
4. Update this `README.md` with your extension's tool table and example prompts
5. Restart the server — your tables are created and tools appear in Edith automatically

## Extension Structure

```
extensions/my-feature/
  index.js    # required — exports { name, tools[], setup? }
  schema.sql  # required — CREATE TABLE IF NOT EXISTS statements
  README.md   # required — document your tools and prompts
```

## Rules

- Directory names starting with `_` are skipped by the loader (use for templates/drafts)
- Every SQL statement in `schema.sql` must use `IF NOT EXISTS` — the file runs on every startup
- Tool names must be globally unique across all extensions and core tools
- Return errors as `{ content: [...], isError: true }` — never throw from a handler
- Access the database via `context.pool`, never import `db.js` directly

## Schema Changes

To add a column to an existing table, add this to `schema.sql` and restart:

```sql
ALTER TABLE my_items ADD COLUMN IF NOT EXISTS category TEXT;
```
