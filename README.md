# Bread 'n' Butter — restaurant repo

Every restaurant on Bread 'n' Butter gets its own private copy of this repository, generated from this template when the restaurant is set up. **Owners never open it** — they use the Bread 'n' Butter app. Bread 'n' Butter operates the repo for them.

## What a restaurant repo is for

- **The AI's memory** — `.lyte/memory/`: what the assistant has learned about this restaurant, plus the kitchen lessons every restaurant starts with (how to read a vendor's split price, why recipe costs go stale, why a prep recipe is one sealed unit). Maintained by `scripts/keeper-sync.cjs`.
- **The skills** — `workers/skills/`: the procedures the AI follows for kitchen work. `menu-import` (a menu → its dishes), `recipe-entry` (a recipe card → what goes in each dish), `invoice-intake` (a vendor invoice → its lines, mapped and costed), `recipe-costing` (every dish re-costed when anything under it changes). `workers/skills/README.md` is the contract.
- **The re-cost job** — `.github/workflows/recost.yml`: re-costs every recipe, bottom-up, with no person involved; runs hourly and on demand. Deterministic, no AI.
- **The agent job** — `.github/workflows/agent-job.yml` ("Run a skill"): runs a skill headlessly with Claude Code on the restaurant's own API key — the first is reading an invoice — then fires the re-cost. Anything that needs the owner's decision is left as a task in the app, never guessed.
- **Optional site code** — a restaurant's website can live here too; nothing in the template depends on it.

The roster the AI works as is short: keeper, guide, architect and content-writer (`AGENTS.md`).

## What the hand-off fills in

A repo fresh from the template does not know its restaurant, and everything refuses to run until it does (on purpose — a job must never write to the wrong restaurant):

| File | Filled with |
|---|---|
| `.lyte/field.json` | `slug` and `name` of the restaurant (`app_url` is already set) |
| `.lyte/mcp-manifest.md` | the `<slug>` in the MCP address (or leave it: `.lyte/field.json`'s slug fills it at boot) |
| `workers/skills/_shared/food-costs-ids.json` | every blank id — the restaurant's tables, saved views, Task Board and automation entries |

`node workers/skills/_shared/food-costs-ids.cjs --check` says what is still blank.

## Repository secrets (Settings → Secrets and variables → Actions)

The operator sets these at hand-off:

| Secret | What it is | Needed by |
|---|---|---|
| `FIELD_SERVICE_TOKEN` | the restaurant's scoped access token (read and write on its food-costs tables and Task Board, read on its files) | both jobs |
| `ANTHROPIC_API_KEY` | the restaurant's AI key. The job runs Claude Code, which reads this; to use another provider, set that provider's key the way Claude Code reads it and adjust the job's "Check the secrets exist" step | agent job |
| `RECOST_WEBHOOK_SECRET` | the secret on the restaurant's "Re-cost recipes — webhook" automation. Optional: without it the agent job starts the re-cost directly, it just isn't recorded as an automation run | agent job |

Optional repository **variables** override the files: `FIELD_SLUG`, `FIELD_APP_URL`, `RECOST_WEBHOOK_ID`.

## Checking a copy works

```
node workers/skills/recipe-costing/recost.cjs --self-test
node workers/skills/recipe-costing/recost-job.cjs --self-test
node workers/skills/invoice-intake/hooks/check-write.cjs --self-test
node workers/skills/_shared/food-costs-ids.test.cjs
node scripts/keeper-sync.cjs        # twice — the second run changes nothing
```

Later framework updates reach restaurant repos as a pull request from this template — see `TODO.md`.
