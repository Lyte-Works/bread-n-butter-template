# Skills

*What a skill is in a restaurant repo, the two conventions every skill here keeps, and how to add one.*

A skill is a procedure the AI loads when the task matches its `description`: read an invoice, import a menu, enter a recipe, explain what a dish costs. It lives in `workers/skills/<name>/SKILL.md`; keeper-sync copies each one into `.claude/skills/<name>/SKILL.md` (step 3c) so Claude Code finds it. Never hand-edit `.claude/skills/` — the copy is regenerated on every run.

## The skills in this repo

| Skill | What it does | Hands off to |
|---|---|---|
| `menu-import` | A menu (URL, PDF, photo, POS export) → one `recipes` row per dish | `recipe-entry` |
| `recipe-entry` | A recipe card, sheet or dictated build → the dish's `recipe_lines` | `recipe-costing` |
| `invoice-intake` | A vendor invoice → `invoices` + `invoice_lines`, each line linked to its vendor item; finishes an invoice whose parked decisions were answered | `recipe-costing` (to report what moved) |
| `recipe-costing` | Explains what a dish costs now (or on a date) and why, from `recipe_cost` and `cost_alerts`; never computes or writes a cost | — |
| `lane-brief` | The six-part brief for a dispatched worker | — |

The script beside them: `invoice-intake/hooks/check-write.cjs`, the write checker — it re-does the per-row arithmetic on every `create_row` / `update_row` the restaurant MCP stores (`--self-test` runs its cases).

Nothing is costed by hand and nothing is re-costed: an ingredient's price and every recipe's cost are views in the restaurant's database, computed on read from the latest invoice lines.

## Convention 1 — the restaurant MCP is the only door

Every skill reaches the restaurant's data through its own Bread 'n' Butter MCP, the `restaurant` server in `.mcp.json`:

```
${BNB_APP_URL:-https://bread-n-butter.tech}/api/restaurants/${RESTAURANT_SLUG}/mcp
Authorization: Bearer ${BNB_RESTAURANT_TOKEN}
```

Its verbs: `list_tables` · `list_rows` · `get_row` · `create_row` · `update_row` · `recipe_cost` · `list_connections` · `call_service`. `list_tables` is the live truth about tables and columns; there is no delete. The token is the restaurant's scoped `bnb_…` token (a repo secret); it is never printed, never committed and never typed into a file. Rows are found by name with `list_rows` — never an id from memory or from another restaurant.

So, before the first call of any skill: `list_tables` once. No `RESTAURANT_SLUG` (this repo is not handed off yet), or a 401/403 (the token is missing, wrong or read-only) → stop, write nothing, and say what is missing. Never look for another way in: no database address, no other restaurant's token.

## Convention 2 — park and notify: a job never asks a person

Most skill runs are headless: the "Run a skill" job (`.github/workflows/agent-job.yml`) runs `claude -p` with nobody at the keyboard. So every human gate a skill names is **park-and-notify**, never a question:

1. **Write the pending decision as a `decisions` row** (`create_row`):
   - `kind` — `new_product` · `each_weight` · `reconcile` · `recipe_lines` · `menu_import` · `other`
   - `invoice_id` / `invoice_line_id` / `recipe_id` — what it belongs to
   - `title` — what is needed, in the owner's words (`Confirm new product: Parmesan, Shaved — 4/5 LB → 320 oz`)
   - `notes` — what you found, what you propose and why, **what it blocks**, and **what clears it**
   - `status` `open`
2. **Stop that line, not the run.** Everything the gate does not block still lands.
3. **Name every parked decision in the report**, by title.

The owner answers the decision in the app (`status` `answered`, with `answer`), which hands the invoice back to the job with `{ "invoice_id": … }`; the resumed run applies each answered row and marks it `done`. Never guess past a gate to keep going — a guessed conversion or an invented ingredient is a wrong cost on every dish that uses it.

**When a person is present** (an interactive session, someone answering), the same gate is asked instead: show the proposal as a table, write after they confirm, park nothing.

## Adding a skill

1. Create `workers/skills/<name>/SKILL.md` with frontmatter `name` (= the directory), `description` (what it is for AND when to use it — this is the trigger) and `kind: procedure`.
2. Keep both conventions: every read and write through the restaurant MCP, and every human gate written as a `decisions` row when nobody is present.
3. Run `node scripts/keeper-sync.cjs`; the `.claude/skills/<name>/` copy appears. Commit both.
