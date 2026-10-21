# Bread 'n' Butter — restaurant repo

Every restaurant on Bread 'n' Butter gets its own private copy of this repository, generated from this template when the restaurant is set up. **Owners never open it** — they use the Bread 'n' Butter app. Bread 'n' Butter operates the repo for them.

## What a restaurant repo is for

- **The AI's memory** — `.lyte/memory/`: what the assistant has learned about this restaurant, plus the kitchen lessons every restaurant starts with (how to read a vendor's split price, why a prep recipe is one sealed unit, why costs never need re-costing). Maintained by `scripts/keeper-sync.cjs`.
- **The skills** — `workers/skills/`: the procedures the AI follows for kitchen work. `menu-import` (a menu → its dishes), `recipe-entry` (a recipe card → what goes in each dish), `invoice-intake` (a vendor invoice → its lines, linked to vendor items), `recipe-costing` (what a dish costs and why). `workers/skills/README.md` is the contract.
- **The restaurant MCP** — `.mcp.json`: the one door to the restaurant's data, its own Bread 'n' Butter MCP (`.lyte/mcp-manifest.md`). Every skill reads and writes through it; the repo holds no data, no database address and no key.
- **The agent job** — `.github/workflows/agent-job.yml` ("Run a skill"): runs a skill headlessly with Claude Code on the restaurant's own API key against the restaurant MCP. The app starts it when the owner drops an invoice, and again when the owner answers a decision the reading parked. Anything that needs the owner's decision is left as a decision in the app, never guessed.
- **Optional site code** — a restaurant's website can live here too; nothing in the template depends on it.

There is no re-cost job: every price and recipe cost is a view in the restaurant's database, computed on read.

The roster the AI works as (`AGENTS.md`): keeper, guide and architect run the repo; analyst reads the kitchen's numbers; content-writer, marketing-strategist, brand-designer and web-builder carry the restaurant's voice, look and website.

## The restaurant MCP

```
${BNB_APP_URL:-https://bread-n-butter.lyte.works}/api/restaurants/${RESTAURANT_SLUG}/mcp
Authorization: Bearer ${BNB_RESTAURANT_TOKEN}
```

Verbs: `list_tables` · `list_rows` · `get_row` · `create_row` · `update_row` · `recipe_cost` · `list_connections` · `call_service`, plus one `<name>__request` tool per connection the owner added (any API). Claude Code expands the three variables from its environment, so an interactive session needs `RESTAURANT_SLUG` and `BNB_RESTAURANT_TOKEN` exported (the job sets them itself).

## How the app runs a skill

The app sends a GitHub `repository_dispatch` to this repo — event `run-skill`, `client_payload: { skill, payload }` — with its own GitHub token (`BNB_GITHUB_TOKEN` on the app; set the restaurant's repo with App setup → `set-repo`). For a dropped invoice:

```json
{ "skill": "invoice-intake",
  "payload": { "file_url": "<signed 24-hour link>", "file_path": "<slug>/invoices/…", "reading_id": "<invoice_readings.id>" } }
```

The job downloads the file, runs the skill, and closes that `invoice_readings` row through the MCP (`read` · `duplicate` · `failed`, with the invoice, a one-line summary and the run link) — even when the run dies half way. When the owner answers a parked decision, the app sends `{ "invoice_id": "…" }` and the skill applies every answered `decisions` row of that invoice. The Actions tab's Run workflow button takes the same skill + payload by hand.

## What the hand-off fills in

A repo fresh from the template does not know its restaurant, and the job refuses to run until it does (on purpose — a job must never write to the wrong restaurant):

| Where | Filled with |
|---|---|
| `.lyte/field.json` | `slug` and `name` of the restaurant (`app_url` is already set) — or set the `RESTAURANT_SLUG` repo variable instead |
| Repository secrets | the two below |

## Repository secrets and variables (Settings → Secrets and variables → Actions)

The operator sets these at hand-off:

| Name | Kind | What it is |
|---|---|---|
| `BNB_RESTAURANT_TOKEN` | secret | The restaurant's scoped `bnb_…` token with **Read + write** (Bread 'n' Butter → Settings → Connect your AI). The job's bearer on the restaurant MCP |
| `ANTHROPIC_API_KEY` | secret | The restaurant's own AI key. The job runs Claude Code, which reads it |
| `RESTAURANT_SLUG` | variable | The restaurant's slug. Optional when `.lyte/field.json` carries it; wins when both are set |
| `BNB_APP_URL` | variable | Optional — the app's address when it is not `https://bread-n-butter.lyte.works` |

Nothing else: no database URL, no storage key, no field token. The invoice file arrives as a signed link in the dispatch.

## Checking a copy works

```
node workers/skills/invoice-intake/hooks/check-write.cjs --self-test
node scripts/keeper-sync.cjs        # twice — the second run changes nothing
```

Then run "Run a skill" from the Actions tab with skill `recipe-costing` and payload `{"question": "Which dishes are over target?"}`: its "Open the door" step proves the slug and the token reach the restaurant MCP, and the run answers from `cost_alerts`.

Later framework updates reach restaurant repos as a pull request from this template — see `TODO.md`.
