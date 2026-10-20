---
name: recipe-costing
description: Re-cost the field's recipes when anything under them changes — an ingredient's last cost after an invoice, a recipe's quantities or yield, a menu price, a corrected weight — cascading bottom-up through prep recipes, rewriting every affected component and recipe, and appending a Recipe Cost History row per recipe that moved, with food-cost alerts. Use after invoice intake updates ingredient costs, or whenever someone changes a recipe, a component, a yield or a menu price, or asks what a dish costs now.
kind: procedure
---

# Recipe Costing

<!-- Restaurant-repo skill. Carries exact lyte keys on purpose,
like invoice-intake; table and view ids live in
workers/skills/_shared/food-costs-ids.json and are read from there by key. The arithmetic is done by recost.cjs beside
this file — never by hand — and every write is re-checked by the invoice-intake
write checker (it covers these rays too). -->

A recipe's cost is a copy of numbers that live elsewhere — ingredient costs,
sub-recipe costs, yields, prices. The moment one of those changes, every recipe
above it is wrong until it's re-costed. This skill keeps them true and keeps a
record of every move, so a dish's cost can be followed invoice by invoice.

## Base Structure

All in the **Food Costs** prism. Write by lyte **key**. Ray and saved-view ids
are in `workers/skills/_shared/food-costs-ids.json` (`rays.recipes`,
`rays.recipe_components`, `rays.recipe_cost_history`, `rays.ingredients`;
`views.recipes_menu_dishes`, `views.recipes_prep_recipes`) — read them from
there, never from memory.

**Computed columns are read-only** — never put a `_calc` key in `properties`.
Each stored key it replaces is marked *Retiring*: keep writing it (the
calculator plans it, the checker compares it) until the operator archives it,
then **stop writing that key** — the `_calc` column is the number from then on,
and the write checker reads it in the stored key's place. The cascade itself
(`total_cost`, `unit_cost`, `line_cost`, `cost_math`) stays stored: it is
many hops deep and only recost.cjs computes it.

### Recipes — `rays.recipes`

| Key | Meaning |
|---|---|
| `name` | Dish or prep name |
| `is_prep` | true for a prep recipe (used inside other recipes) |
| `yield_quantity` · `yield_unit` | Batch size for prep (40 · `fl oz`); `1` · `portion` for a menu dish. A prep's `yield_unit` is the unit every parent must use it in |
| `menu_price` | Menu dishes only |
| `total_cost` | Σ component `line_cost` |
| `cost_per_yield_unit` | *Retiring.* total_cost ÷ yield_quantity (4 dp) — what a parent pays per unit of this prep |
| `food_cost_pct` | *Retiring.* cost_per_yield_unit ÷ menu_price × 100 (1 dp); empty on prep |
| `cost_per_yield_unit_calc` | **read-only formula** — round(total_cost ÷ yield_quantity, 4). Replaces `cost_per_yield_unit` |
| `food_cost_pct_calc` | **read-only formula** — round(that ÷ menu_price × 100, 1); blank on prep. Replaces `food_cost_pct` |
| `components` | relation (many) → its Recipe Components |

### Recipe Components — `rays.recipe_components`

| Key | Meaning |
|---|---|
| `recipe_id` | the recipe this line belongs to |
| `ingredient_id` **or** `sub_recipe_id` | exactly one — a purchased ingredient or a prep recipe |
| `quantity` · `unit` | in the SOURCE's unit: the ingredient's `unit`, or the sub-recipe's `yield_unit` |
| `unit_cost` | ingredient `last_cost`, or sub-recipe `cost_per_yield_unit` (4 dp) |
| `line_cost` | quantity × unit_cost (4 dp) |
| `name` | label: `Baby Arugula · 3 oz · $0.90` |
| `cost_math` | the working: `3 oz × $0.3005 per oz (Baby Arugula last cost — US Foods 2023-06-26) = $0.9015`; a sub-recipe shows `(<prep> prep: $<batch total> batch ÷ <yield>)` |

### Recipe Cost History — `rays.recipe_cost_history`

Append-only. One row per recipe each time its cost or food cost % moves.
Never edit a row — a correction is a new row.

| Key | Meaning |
|---|---|
| `name` | `<Recipe> · <date> · $<cost>[/<unit>] · <food cost %>` |
| `recipe_id` · `invoice_id` | what was costed, and the invoice that caused it (empty if none) |
| `trigger` | `baseline` (first row for a recipe) · `invoice` · `recipe_change` · `cost_correction` |
| `costed_on` | the invoice's delivery date, or today for edits |
| `total_cost` · `yield_quantity` · `yield_unit` · `cost_per_yield_unit` · `menu_price` · `food_cost_pct` | the snapshot |
| `prev_snapshot_id` | relation → this ray: the recipe's latest earlier row (the plan carries it as `prev_snapshot_id`); empty on a baseline |
| `prev_cost_per_yield_unit` | vs that row; empty on a baseline |
| `change_amount` · `change_pct` · `food_cost_change_pts` | *Retiring.* vs that row; empty on a baseline |
| `change_amount_calc` · `change_pct_calc` · `food_cost_change_pts_calc` | **read-only formulas** — cost − prev (4 dp), (cost ÷ prev − 1) × 100 (1 dp), food_cost_pct − `{prev_snapshot_id.food_cost_pct}` (1 dp); blank on a baseline |
| `drivers` | what moved it: `Baby Arugula $0.3005 → $0.3359/oz (+11.8%); menu price $13.00 → $14.00` |
| `alert` | set when food cost is **over 30%** or up **2+ points** in one re-cost; empty otherwise |

## When to run

- **After every invoice** — invoice-intake fires the "Re-cost recipes" webhook with: the invoice id, its delivery date, its vendor + date as the cost source. Trigger `invoice`.
- **After any recipe edit** — quantity, unit, yield, a component added or removed, a menu price. Trigger `recipe_change`. The hourly job catches these on its own; fire the webhook to not wait.
- **After a cost correction** — an each_weight filled in, a wrong last_cost fixed. Trigger `cost_correction`.
- When someone asks what a dish costs now — run it; a stale number is worse than none.
- **Every hour regardless** — the scheduled job re-reads the field and writes nothing when nothing moved.

Cost basis is the ingredient's **last cost** (what was actually paid on the
latest invoice). invoice-intake's 15% cost-move flag is the guard against one
odd invoice spreading into every recipe — read it before you re-cost.

## The job is the normal path

Re-costing runs with no person involved. `recost-job.cjs` beside this file is
the whole procedure below as one headless run — read through the entries API
(`GET /api/fields/{slug}/rays/{id}/entries`, scoped field token; the slug and
app URL from `.lyte/field.json` or the `FIELD_SLUG` / `FIELD_APP_URL` repo variables),
plan with `recost.cjs`, apply in order with `return_row: true` and a
landed-as-sent check on every row, re-read, re-run, **fail unless the second
plan has zero writes**. `.github/workflows/recost.yml` runs it on GitHub
Actions with the `FIELD_SERVICE_TOKEN` repo secret, and the field's
Automations workspace fires that workflow:

| Workflows entry | id (in the ids file) | fires |
|---|---|---|
| **Re-cost recipes** | `workflows.recost` | hourly, and it is the dispatch target both entries point at (`script_url` → `recost.yml`) |
| **Re-cost recipes — webhook** | `workflows.recost_webhook` | on demand: `POST <app_url>/api/automations/webhooks/<workflows.recost_webhook>` with `x-webhook-secret` (the entry's `trigger_config.secret`) and a body `{ "trigger", "invoice_id", "costed_on", "cost_source" }` — this is what invoice-intake step 12b fires |

Run twice on an unchanged field, the second run writes nothing and passes;
the Actions run's summary is the report, and the history rows it wrote are
on the Recipe Cost History ray. The job never touches Invoice Items, Vendor
Items or Ingredients. `node recost-job.cjs --self-test` proves the runner
against an in-process copy of the entries API; `--dry-run` prints the plan
without writing.

**The in-session run is the exception** — for a one-off while the secret is
not yet set, to see a plan before it lands (`--dry-run`), or when a step
needs a judgement (a unit mismatch to resolve, a loop to break) that the job
reports as an error and stops on. Then, and only then, the procedure below is
run by hand, with the same calculator and the same convergence proof.

**Nobody to ask — park and notify.** A judgement the calculator cannot make
(a component whose unit will not convert to its source's, a prep recipe that
contains itself, an ingredient with no `last_cost`) is never guessed past. With
a person present, ask. Headless, write it as a Task Board row (`rays.task_board`
in the ids file; `title` what is needed — `Unit mismatch: Salad · Lemon juice
(tbsp vs fl oz)`, `human_needed` true, `status` "Not started", `priority`
"high", `notes` the recipe, the line, what it blocks and what clears it), write
nothing for the plan it stops (never a partial plan), and say so in the report.
The job (`recost-job.cjs`) does the same by failing loudly with the calculator's
errors; the operator reads them in the Actions run. Convention:
`workers/skills/README.md` §Convention 2.

**Before the first call**, in-session or not: `node workers/skills/_shared/food-costs-ids.cjs --check`
— exit 1 means this restaurant is not handed off yet; stop and say which ids are missing.

## Procedure

1. **Read everything live**: Ingredients (`unit`, `last_cost`), Recipes, Recipe
   Components, Recipe Cost History (`id`, `recipe_id`, `costed_on`,
   `cost_per_yield_unit`, `food_cost_pct`, `menu_price`, `createdAt`).
2. **Write the snapshot file** in the shape recost.cjs documents, with
   `trigger`, `invoice_id`, `costed_on` and (for an invoice) `cost_source`
   (`US Foods 2023-07-03`).
3. **Run the calculator**: `node workers/skills/recipe-costing/recost.cjs <snapshot.json>`.
   It re-costs every recipe bottom-up and prints the plan.
4. **Stop on any `errors`** — a unit mismatch, a loop, a missing cost. Fix the
   cause (or ask), re-read, re-run. Never write a partial plan.
5. **Apply the plan in its order**, every write with `return_row: true`:
   `component_updates` → `recipe_updates` → `history_creates`. A recipe's
   `components` list only changes when a component is added or removed.
6. **Re-read and re-run.** The second run must plan **zero** writes — that is
   the proof everything landed and agrees.
7. **Report** (below).

## Rules

- **The calculator does the arithmetic.** Don't hand-compute a cost and write it.
- **Bottom up.** A prep is costed before every recipe that uses it; the
  calculator orders it, and a loop (a prep that contains itself) is an error.
- **Units match the source** or the line stops. Crossing kinds (a recipe in oz,
  an ingredient costed each) needs the ingredient's `each_weight` / `density` —
  convert the component first; never let the cost silently use the wrong unit.
- **Rewrite the whole line together** — `unit_cost`, `line_cost`, `cost_math`,
  the `$` in `name`. A line whose cost moved but whose working didn't is wrong.
- **History is append-only** and written only for recipes that moved; every
  recipe's first row is a `baseline`.
- **Raw weights.** Proteins are costed at purchased weight until ingredients
  carry a cooking/trim yield; say so when a protein dish's food cost is quoted.

## Verification

| # | Check | Pass when |
|---|---|---|
| 1 | Calculator clean | `errors` is empty |
| 2 | Line arithmetic | every written component: quantity × unit_cost = line_cost, `cost_math` ends in it (the write checker enforces this on save) |
| 3 | Recipe totals | every recipe: total_cost = Σ its lines, cost_per_yield_unit = total ÷ yield, food_cost_pct = cost ÷ price |
| 4 | History | one new row per moved recipe, change fields = new − previous, `alert` set exactly when over 30% / +2 pts |
| 5 | Converged | a second calculator run on re-read data plans **0** writes |

## Report

```
Re-costed after US Foods #<no> (2023-07-03) — 4 recipes moved
  Garlic Confit            $0.4011 → $0.4212/fl oz (+5.0%)        ← Garlic, Peeled +20.0%
  Chive & Garlic Spread    $0.1591 → $0.1603/oz   (+0.8%)
  Chicken Wrap             $2.16 → $2.20  food cost 15.4% → 15.7%
  Arugula Salad            $2.56 → $2.68  food cost 19.7% → 20.6%
  ⚠ none over 30% · none up 2+ pts
✓ 1 calculator clean ✓ 2 lines ✓ 3 totals ✓ 4 history ✓ 5 converged (0 writes on re-run)
```

Then anything the operator should act on: alerts, menu dishes nearest the line,
lines costed per piece because a weight is missing, protein at raw weight.
