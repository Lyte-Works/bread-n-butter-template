# This restaurant's MCP — the one door

One fact for whatever AI opens this repo: which Bread 'n' Butter MCP this
restaurant's data lives behind. The repo itself holds none of that data.

**Restaurant MCP:** https://bread-n-butter.lyte.works/api/restaurants/<slug>/mcp

It is the `restaurant` server in `.mcp.json`:

```
url:     ${BNB_APP_URL:-https://bread-n-butter.lyte.works}/api/restaurants/${RESTAURANT_SLUG}/mcp
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
| `update_row` | write | Change columns of one row by id. There is no delete |
| `recipe_cost` | read | What a recipe costs and why — its total, food cost % and every line's working; `as_of` a date for the prices known then |
| `list_connections` | services | Every connection the owner added — any outside API (POS, AI receptionist, email, …) by name, the host it is locked to, what it may do and the tool that calls it — never a key |
| `call_service` | services | One request to a connection by its name (`connection`), with the restaurant's key added on the server; the connection's own rules decide which methods and paths are allowed (403 otherwise) |
| `<name>__request` | services | The same call, as one tool per connection (`tools/list` shows them to a token that may call services) |

A token carries the scopes its owner gave it: a read-only token is refused
(403) on `create_row` / `update_row`; a revoked one, or another restaurant's,
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
