---
name: kitchen-log
description: Turn what a chef says about the kitchen into the restaurant's records through its Bread 'n' Butter MCP — a yield or breakdown ("we yielded 1.7 lb of meat and .3 lb of fat off the last hangar", "broke down 3 chickens", "trimmed the tenderloin"), trim going into another recipe ("using the fat for beef tallow"), waste ("dropped a hangar steak", "tossed a quart of stock"), a delivery used up ("we're out of Tuesday's arugula"), or a count ("we have 2 lb of arugula") — matching the delivery it came from, in one all-or-nothing write, and answering in one line with the yield against the usual yield and what it did to the cost. Use whenever someone reports a yield, a trim, a breakdown, waste, a count or that they're out of something, and at the start of a session to bring up deliveries still waiting to be broken down. It never writes a cost.
kind: procedure
---

# Kitchen Log

<!-- Restaurant skill. It reaches the restaurant's data ONLY through the
restaurant's own Bread 'n' Butter MCP (`.mcp.json`; verbs list_tables ·
list_rows · get_row · create_row · update_row · write_rows · recipe_cost).
The tables and views are supabase/restaurant/0012_yield_logs.sql in the app
repo (spec "Yield logs, by-products and lots"); when a migration changes
one, update the tables here in the same change. `list_tables` is the live
truth. Every cost is the database's: this skill writes what happened, never
what it costs. Its writes pass the kitchen skills' write checker
(workers/skills/invoice-intake/hooks/check-write.cjs). -->

A chef talks in deliveries and pans, not in rows: "most recent invoice with
hangar steak we yielded 1.7 lbs of meat and .3 lbs of fat — i am using this
fat for beef tallow". The job is to turn that one sentence into exactly what
happened — this much of *that* delivery went in, this much trimmed steak and
this much fat came out, the fat goes into the tallow — so the database can
cost the trimmed steak from the same box it was cut from, and say so back in
one line.

**It never writes a cost.** The trimmed steak's price per pound, the fat at
$0, the tallow's cost: all are computed on read from the yield logs, the
invoices and the recipes. Writing the yield log IS the costing.

## The shape

```
invoice line  (a delivery of one item — never split)
  └─ ingredient: Hangar Steak            (broken down before use)
        └─ yield log  (weight in, weight out, date, who)
              ├─ main output  → prep: Hangar Steak, Trimmed      (breakdown prep)
              ├─ by-product   → prep: Hangar Fat Trim            (by-product of Trimmed, $0)
              │                       └─ a line on prep: Beef Tallow
              └─ waste = in − main − by-products   (the database works it out)
```

- A **breakdown prep** is a prep with exactly one line: the raw ingredient.
  Its line and yield are only its standard, used when no yield log exists.
- A **by-product** is a prep with `byproduct_of` set to the breakdown prep it
  comes from. It has no lines and costs $0. Recipes use it like any prep.
- **Trim is never an ingredient.** Ingredients are what the restaurant buys;
  nobody buys fat trim, so it would never get a price.

## What the database answers

| Where | What it gives |
|---|---|
| `list_rows` `lots` | every delivery of an ingredient: `invoice_line_id`, `vendor`, `invoice_no`, `received_on`, `ingredient_id`, `quantity` and `unit` (the ingredient's own), `price_per_unit`, `label` ("US Foods #4471 2026-10-28") |
| `list_rows` `lot_status` | each delivery's breakdown status today: `not needed` · `waiting` · `partly` · `broken down`, `logged_in`, `days_waiting`, `overdue` (waiting 3 days or more) |
| `list_rows` `breakdown_costs` | every breakdown prep today: `method` (`matched` · `estimated` · `standard yield`), `cost_per_yield_unit`, `lot`, `yield_pct`, `label`, `working`, `heads_up` |
| `list_rows` `yield_by_vendor` | per ingredient × vendor × breakdown prep: `logs`, `usual_yield_pct` (last 5 logs), `lowest_yield_pct`, `highest_yield_pct`, `latest_yield_pct`, `latest_price`, `cost_per_usable_unit` |
| `list_rows` `yield_log_results` | each log's `yield_pct`, `waste`, `waste_unit`, `waste_basis` (`actual` · `approx` · `unknown`) and any `warning` |
| `list_rows` `yield_alerts` | a log more than 10 points under the usual yield before it, with `alert` in words |
| `list_rows` `stock_on_hand` | what is left per item and per open lot, or `not tracked yet` |
| `recipe_cost` `{ recipe_id }` | a recipe's cost now, every line's `working`; `as_of` a date for before |

## What it writes

### `yield_logs` — one breakdown of (part of) one delivery

| Column | Fill with |
|---|---|
| `invoice_line_id` | The delivery (Find the lot) |
| `recipe_id` | The breakdown prep |
| `input_quantity` | How much went in, in the **ingredient's** unit (2 lb; 3 each) |
| `input_weight` · `input_weight_unit` | Only for an each-counted input weighed as a whole ("3 chickens, 11.2 lb") — both or neither |
| `output_quantity` | The main output, in the **prep's** yield unit |
| `logged_on` | The day it was broken down (today unless the chef says) |
| `logged_by` | The chef's name, when known |
| `note` | Anything the chef said that the numbers don't hold |

Leave `input_unit` and `output_unit` out: the database fills them with the
ingredient's and the prep's own, and refuses any other.

### `yield_log_outputs` — one row per by-product

`yield_log_id` (the log's uuid), `recipe_id` (the by-product prep),
`quantity` (in its yield unit; the unit fills itself).

### `stock_events` — waste, a delivery used up, a count

| Column | Fill with |
|---|---|
| `kind` | `waste` · `closed` · `count` |
| `ingredient_id` **or** `recipe_id` | The item: an ingredient (raw) or a prep (trimmed steak, stock) — exactly one |
| `invoice_line_id` / `yield_log_id` | The lot, when the chef names one: a delivery for an ingredient, a yield log for a prep. Required for `closed`; never on a `count` |
| `quantity` · `unit` | How much, in the item's own unit. A `count` is the level on hand, not a change. Not on `closed` |
| `happened_on` | Today unless the chef says |
| `logged_by` · `note` | Who, and the chef's words |

### Rows it may create, with the chef's say-so

- **A breakdown prep** (`recipes`): `name` ("Hangar Steak, Trimmed"),
  `is_prep` true, `yield_quantity` and `yield_unit` (the standard: what a
  usual delivery gives), plus its ONE `recipe_lines` row — the raw
  ingredient, in the ingredient's unit.
- **A by-product** (`recipes`): `name` ("Hangar Fat Trim"), `is_prep` true,
  `yield_unit`, `byproduct_of` the breakdown prep. No `yield_quantity`, no
  lines, no `menu_price`, `credit_per_unit` left alone (it is held at 0).
- **The by-product's line** on the recipe it feeds (`recipe_lines`:
  `recipe_id` Beef Tallow, `sub_recipe_id` the by-product, `quantity`, `unit`
  the by-product's yield unit).
- **Each prep it creates goes on a station** like a dish — an existing one
  the chef names, or the one the recipes using it all share (the trim and
  the tallow follow the dish that uses the tallow; a by-product nothing uses
  yet follows its breakdown prep) — by recipe-entry's station rule. Nothing
  agrees → left empty and said so. Never a new station, never one the
  owner set changed.
- **An each weight** (`ingredients.each_weight_oz`) the chef just gave.

## Procedure

0. **Open the session.** `list_tables` once (a 401/403 means the token is
   wrong or read-only — stop and say so). Then `list_rows` `lot_status`
   `{ overdue: true }` and bring up each one before anything else, in the
   chef's words: "You got 2 lb of hangar steak from US Foods Thursday (#4471)
   — how did it yield?" Never more than a short list; nothing overdue → say
   nothing about it.
1. **Sort the sentence**: a **yield**, **waste**, a delivery **used up**, a
   **count** — or several (one sentence can log a yield and a waste). Repeat
   back what you heard only when a number or an item is unclear.
2. **Find the item.** `list_rows` `ingredients` (and `recipes` with
   `is_prep` true) by what the kitchen calls it — "hangar" is Hangar Steak,
   "trimmed hangar" is the breakdown prep, "the tallow" is Beef Tallow. Two
   that fit → ask which.
3. **Find the lot** (Judgement rules: Which delivery).
4. **Match the outputs** (yield only):
   - The **breakdown prep**: a prep whose one line is this ingredient
     (`recipe_lines` `{ ingredient_id }`, then the recipe has no other line).
     More than one ("Chicken Parts" and "Chicken, Spatchcocked") → ask which.
   - Each **by-product**: a prep with `byproduct_of` = that breakdown prep,
     matched by name ("fat" → Hangar Fat Trim).
   - **None exists yet → ask once** before creating it, with the rows you
     would write: "I'll add a prep *Hangar Steak, Trimmed* (2 lb Hangar Steak
     → 1.7 lb) and a by-product *Hangar Fat Trim*, $0 — OK?" Its standard
     yield is this log's numbers unless the chef gives a usual one. Once it
     exists, it is never asked about again.
   - **An each-counted input with no each weight** ("broke down 3
     chickens", Whole Chicken has no `each_weight_oz`) and no whole weight
     given → ask once: "About how much does a whole chicken weigh?" Save the
     answer to `ingredients.each_weight_oz` (in oz) in the same write. No
     answer → log it anyway: yield and cost still work, waste is unknown.
5. **Link the by-product** to where the chef says it goes ("using this fat
   for beef tallow"): find the recipe (`recipes` by name) and its lines.
   - It already has a line on the by-product → confirm it; write nothing.
   - It has none → add one: the quantity is what the chef said goes in, or
     the by-product's output from this log when they didn't say ("the fat"
     = all 0.3 lb).
   - It has a line on the **same thing bought or made another way** (a 0.3
     lb line on a "fat" ingredient with no price, or a 0 lb stopgap line) →
     propose swapping it for the by-product line; it is the owner's line, so
     ask.
   - The recipe doesn't exist → offer to create it as a prep with just that
     line ("Beef Tallow — I'll make it from 0.3 lb Hangar Fat Trim, rendered;
     about how much tallow does that give?"). Its yield comes from the
     chef; no yield → leave the link for recipe-entry and say so.
6. **Check before writing.** In = the lot's `quantity` or less (more →
   ask; it is probably two deliveries, or a wrong unit). Out ≤ in by weight
   when both are weights. Units are the item's own: convert the chef's
   ("1.7 lbs" against an `oz` prep = 27.2 oz) and say the conversion.
7. **Write once.** One `write_rows`, all or nothing, in order: any each
   weight, any new breakdown prep and its one line, any new by-product, the
   yield log (a uuid you chose), its outputs, any new by-product line on the
   recipe it feeds, then any stock events. Each create carries the uuid you
   chose so later writes can point at it.
   - **Refused** → nothing was written. The refusal names the write and says
     why in words ("the outputs weigh 2.1 lb, more than the 2 lb that went
     in"); fix that write and re-send the whole batch. Outputs heavier than
     an actual weight in usually mean the delivered weight is missing on the
     invoice — say so, never shrink the chef's numbers to fit.
   - **No answer** → `get_row` on the log's uuid says whether it landed;
     re-send only when it didn't.
8. **Read it back** (Verification) and **reply in one line** (Report).

### Waste

"Dropped a hangar steak", "tossed a quart of stock", "86'd the old
arugula". A `waste` stock event on the item, in its unit ("a hangar steak"
on the trimmed prep is a portion: ask its weight once if the dish's line
doesn't say — Steak Frites uses 0.5 lb). It names a lot only when the chef
does ("from the 10/21 box"); otherwise the database takes it from the oldest
lot. A whole delivery thrown out is `closed`, not waste of its quantity.

### A delivery used up

"We're out of Tuesday's arugula", "the 10/21 hangar is gone". A `closed`
stock event on that lot (`invoice_line_id`; for a prep, the `yield_log_id`
that made it). A raw ingredient broken down before use and closed without a
log is **broken down** with no yield — ask once "did any of it get trimmed
first?" before closing it.

### A count

"We have 2 lb of arugula", "3 quarts of broth left". A `count` stock event:
the level on hand, in the item's unit, no lot. The database sets the newest
lots to it and closes the older ones. Counting is what turns on tracking for
an item that is not broken down before use.

## Judgement rules

**Which delivery.** "Most recent invoice with X" / "the last X" is the newest
lot of that ingredient (`lots`, filter `ingredient_id`, newest
`received_on`). A vendor ("the US Foods hangar") or a day ("Thursday's",
"the 10/21") narrows it. No pointer at all → the oldest lot still `waiting`
or `partly` in `lot_status` (that is the box on the shelf), and say which one
you picked. A lot already `broken down` is only logged again when the chef
names it.

**The usual yield.** Only the database's: `yield_by_vendor` for this
ingredient, vendor and prep, before and after the write. Never average logs
by hand.

**Ask at most twice per sentence**, and only for the two things above: a
prep or by-product that doesn't exist yet, and an each weight nobody knows.
Everything else is decided from the sentence and the database, and named in
the reply so the chef can correct it.

**Never split an invoice line.** The steak's price stays on the steak's
line; the fat traces back to the delivery through the yield log.

**Never touch a cost.** No price, no `credit_per_unit`, no recipe yield
rewritten from a log. A yield log is its own dated record; the standard on
the breakdown prep changes only when the chef says "our usual is now…".

**Owner's words.** Say recipe, ingredient, invoice, delivery, by-product,
trim, waste, count. Never table, view or column names.

## Verification

| # | Check | Pass when |
|---|---|---|
| 1 | One write | the sentence's rows went in one `write_rows`, and every stored row came back with the values sent |
| 2 | Right delivery | the log's lot is the one the sentence pointed at (vendor, invoice number, date named in the reply) |
| 3 | Status | `lot_status` for that lot is `partly` or `broken down` |
| 4 | Costed from it | `breakdown_costs` for the prep: `method` `matched`, `lot` = that delivery |
| 5 | Waste | `yield_log_results.waste_basis` is `actual` or `approx` with a number, or `unknown` with the reason (no each weight). Any `warning` is said |
| 6 | By-product | its line on the recipe it feeds costs $0.0000 (`recipe_cost`), and that recipe's status is unchanged by it |
| 7 | Alert | `yield_alerts` for this log: named in the reply if there is one |

A ⚠ is never silent: say what it blocks and what clears it.

## Report

One line, then anything that needs the chef:

```
Logged: 2 lb hangar steak from US Foods #4471 (10/28) → 1.7 lb trimmed (85%, usual 82.5%) + 0.3 lb fat trim, no waste.
Trimmed hangar is now $16.4706/lb, from $15.0000 (priced from this delivery); the fat goes into Beef Tallow at $0.
```

- The yield and the usual yield from `yield_by_vendor` (after the write), and
  the lowest/highest when this one is outside them.
- The cost change: `breakdown_costs` `cost_per_yield_unit` before and after
  (read it before the write), with the delivery it is priced from. The dishes
  above it move on their own — name the menu dishes that use it, with
  recipe-costing, only when asked or when one crosses a food-cost alert.
- The by-product's use: "goes into Beef Tallow at $0", "added to Beef Tallow",
  or "not used in a recipe yet".
- A yield alert in its own words: "65%, against US Foods' usual 82.5% — worth
  a word with the rep".
- Waste, count and used-up sentences get one line each: "Logged 6 oz of
  trimmed hangar as waste (from the 10/21 delivery)". "Arugula: 2 lb on
  hand; the 10/21 and 10/24 deliveries are used up."
