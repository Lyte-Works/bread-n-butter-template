# This restaurant's MCP — the one door

One fact for whatever AI opens this repo: which Bread 'n' Butter MCP this
restaurant's data lives behind. The repo itself holds none of that data.

**Restaurant MCP:** https://bread-n-butter.tech/api/restaurants/<slug>/mcp

It is the `restaurant` server in `.mcp.json`:

```
url:     ${BNB_APP_URL:-https://bread-n-butter.tech}/api/restaurants/${RESTAURANT_SLUG}/mcp
header:  Authorization: Bearer ${BNB_RESTAURANT_TOKEN}
```

- `RESTAURANT_SLUG` — the restaurant's slug: `slug` in `.lyte/field.json`, or
  the `RESTAURANT_SLUG` repo variable (which wins in the "Run a skill" job).
- `BNB_RESTAURANT_TOKEN` — the restaurant's scoped `bnb_…` token, minted by the
  owner in Bread 'n' Butter (Settings → Connect your AI). A repo secret; never
  printed, never committed, never typed into a file.
- `BNB_APP_URL` — only when the app lives somewhere other than the default.

A session without those in its environment has no door. Say so; never reach
for another way in (a database address, another restaurant's token, the
account's own database connectors).

## The verbs

| Verb | Scope | What it does |
|---|---|---|
| `list_tables` | read | Every table and view with its columns; tables are writable, views are not. The live truth — call it first |
| `list_rows` | read | Rows of a table or view, filtered and sorted, a page at a time |
| `get_row` | read | One row by id |
| `create_row` | write | Insert one row into a table (never a view) |
| `update_row` | write | Change columns of one row by id |
| `upsert_row` | write | Update the one row matching every `match` column, or insert it when none matches (409 when more than one does) — a re-run writes no duplicates |
| `delete_row` | write | Delete one row by id; refused for a view, the recipe history, or a row other rows still point at (409, naming the table) |
| `write_rows` | write | Up to 200 creates / updates / upserts / deletes in one transaction, in order — all or none; a create may carry its own id so later writes can point at it (an invoice, then its lines). A refusal names the failing write's index |
| `upload_invoice_file` | write | Store an invoice's original file (PDF or photo) with the restaurant: inline (`content_base64`, up to 3 MB) or by a signed `upload_url` (up to 50 MB); `invoice_id` puts it on that invoice |
| `recipe_cost` | read | What a recipe costs and why — its total, food cost % and every line's working; `as_of` a date for the prices known then |
| `list_connections` | services | Every connection the owner added — any outside API (POS, AI receptionist, email, …) by name, the host it is locked to, what it may do and the tool that calls it — never a key |
| `call_service` | services | One request to a connection by its name (`connection`), with the restaurant's key added on the server; the connection's own rules decide which methods and paths are allowed (403 otherwise) |
| `<name>__request` | services | The same call, as one tool per connection (`tools/list` shows them to a token that may call services) |

A token carries the scopes its owner gave it: a read-only token is refused
(403) on every write verb; a revoked one, or another restaurant's,
is refused at the door (401/403).

## What is behind it

One plane: the restaurant's own kitchen database. Tables (`vendors`,
`vendor_items`, `ingredients`, `invoices`, `invoice_lines`, `recipes`,
`recipe_lines`, `decisions`, `invoice_readings`, …) hold what was written;
views (`ingredient_costs`, `recipe_costs`, `recipe_line_costs`, `cost_alerts`)
compute every price and cost on read, so nothing is ever costed by hand or
re-costed. `list_tables` names them all with their columns — read it, don't
remember it.

Maintenance: the session-boot hook prints the first `https://…/mcp` URL in this
file as its `Restaurant MCP:` boot fact, filling `<slug>` from
`.lyte/field.json`. Keep it the first URL in the file.
