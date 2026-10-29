---
name: recipe-entry
description: Enter what goes into a dish — from a recipe card, a spreadsheet, a photo or a recipe someone dictates — as its recipe lines in the restaurant's database, through its Bread 'n' Butter MCP, each linked to an existing ingredient in that ingredient's unit or to a prep recipe in its yield unit (a breakdown prep for a cut the kitchen trims, a $0 by-product for the trim it reuses), creating an ingredient only with the owner's say-so, flagging every line whose ingredient has no price yet, then explain the dish's cost with recipe-costing. Use whenever someone gives a dish's recipe, build, spec or ingredient list and asks to add, enter, build out, map or fix it, and after menu-import has created dishes with no lines.
kind: procedure
---

# Recipe Entry

<!-- Restaurant skill. It reaches the restaurant's data ONLY through the
restaurant's own Bread 'n' Butter MCP (`.mcp.json`; verbs list_tables ·
list_rows · get_row · create_row · update_row · upsert_row · delete_row ·
write_rows · recipe_cost). Column names
are the restaurant database's (supabase/restaurant/ in the app repo); when a
migration changes one, update the tables here in the same change.
`list_tables` is the live truth. Costing belongs to the database's views
(recipe_costs, recipe_line_costs): this skill writes the structure only. -->

A recipe card says what the cook does; the database needs what the dish is made
of, in units it can cost. The job is to turn the card into lines that each
point at one thing the restaurant buys (or one thing it preps), in that
thing's own unit, so the dish's cost follows from the invoices without anyone
doing arithmetic by hand. Nothing is invented: a line is on the card, an
ingredient is in the database, a price came from an invoice.

## Base Structure

```
recipes (dish or prep)  ◀──recipe_id──  recipe_lines  ──ingredient_id──▶  ingredients (unit)
                                              │
                                              └──sub_recipe_id──▶  recipes (is_prep, yield_unit)
```

### `recipe_lines` — one row per line of the recipe

| Column | Fill with |
|---|---|
| `recipe_id` | The dish (or prep) this line belongs to |
| `ingredient_id` | The purchased ingredient — **or** `sub_recipe_id`, never both, never neither (the database refuses either) |
| `sub_recipe_id` | A prep recipe (`is_prep` true) used in this dish. Never the recipe itself |
| `quantity` | How much, in `unit` |
| `unit` | **The source's unit**: the ingredient's `unit`, or the prep's `yield_unit` — exactly, character for character. A different unit is costed as *unit mismatch*, never converted by the database |

There is no cost column. Each line's cost and its working
(`3 oz × $0.3005 per oz (Baby Arugula — US Foods 2023-06-26) = $0.9015`)
are the view `recipe_line_costs`, computed on read.

### `recipes`

The dish already exists (menu-import made it, or the person did). A **prep
recipe** the card needs and the database lacks (a house sauce, a dough) is
created as a `recipes` row: `name`, `is_prep` `true`, `yield_quantity` and
`yield_unit` from the card (`40` · `fl oz`), no `menu_price`. Its own lines are
entered by this same procedure, **before** the dish that uses it.

### Breakdown preps and by-products

Much of what a kitchen buys is cut down before it is used: hangar steak is
trimmed, chickens broken down, onions peeled. And the trim often feeds
another recipe: the fat into bone broth, the carcasses into stock.

- **A breakdown prep** is a prep with **exactly one line: the raw
  ingredient**, in the ingredient's unit. `Hangar Steak, Trimmed` —
  `is_prep` true, `yield_quantity` 1.6, `yield_unit` `lb`, one line 2 lb
  Hangar Steak. That line and yield are its **standard**: the database uses
  them only until the kitchen logs a real yield against a delivery
  (kitchen-log), and then costs it from that delivery. Anything added to it —
  a seasoning, a marinade — goes in a **further prep** that uses the
  breakdown prep as a line (`Hangar Steak, Marinated`: 1.6 lb Hangar Steak,
  Trimmed + the marinade), never as a second line on the breakdown prep.
- **A by-product** is a prep that is the trim of a breakdown prep:
  `recipes` row with `name` (`Hangar Fat Trim`), `is_prep` true,
  `yield_unit` (`lb`), and **`byproduct_of`** the breakdown prep's id. **No
  lines** (the database refuses them), no `yield_quantity`, no
  `menu_price`; it costs **$0** per yield unit — the trim was paid for once,
  in the steak — and `credit_per_unit` is left alone.
- **A recipe uses a by-product like any prep**: a `sub_recipe_id` line in the
  by-product's yield unit. `Bone Broth` gets the line 0.3 lb Hangar Fat Trim,
  costed $0.0000.
- **Trim is never an ingredient.** An ingredient is what the restaurant buys,
  and only an invoice prices it; nobody buys fat trim, so a "Fat Trim"
  ingredient would never get a price and every recipe using it would stay
  cost incomplete. A card line of trim, bones, carcass, rinds or scraps the
  kitchen makes itself is a by-product line — when its breakdown prep
  doesn't exist yet, it is created first (with the owner's say-so, as any
  new prep).

Worked example — the card says *Bone Broth: 5 lb beef bones, 0.3 lb hangar
fat trim, water; makes 4 qt*, and the kitchen trims its own hangar:

| Write | Row |
|---|---|
| 1 | `recipes` Hangar Steak, Trimmed · prep · yields 1.6 lb (uuid T) — only if it isn't there |
| 2 | `recipe_lines` T ← 2 lb Hangar Steak (the ingredient, unit `lb`) |
| 3 | `recipes` Hangar Fat Trim · prep · `yield_unit` lb · `byproduct_of` T (uuid F) |
| 4 | `recipes` Bone Broth · prep · yields 4 qt (uuid B) — only if it isn't there |
| 5 | `recipe_lines` B ← 5 lb Beef Bones |
| 6 | `recipe_lines` B ← 0.3 lb Hangar Fat Trim (`sub_recipe_id` F) — $0.0000 |

One `write_rows`, preps before the lines that use them. Water is not a
line. The fat line holds nothing back: a by-product is always priced.

### `ingredients`

Read only, except a new ingredient the owner confirmed: `name` (kitchen
name, no brand), `category`, `storage`, `unit` (the base unit recipes measure
it in: `oz`, `fl oz` or `each`) — by the invoice-intake rules for those
columns. Never a price: that only ever comes from an invoice. The price, when
there is one, is the view `ingredient_costs` (`cost_per_unit`, `priced_on`,
`vendor`).

## Procedure

1. **Read the card.** Text, spreadsheet, photo (say quantities are read from an
   image) or dictation (repeat it back as a list). List every line as written:
   quantity, unit, item, and any prep note ("minced", "toasted").
2. **Read the database live**: the dish's `recipes` row and its existing
   `recipe_lines` (`list_rows` filter `recipe_id`); all `ingredients` (`name`,
   `unit`, `each_weight_oz`, `density_oz_per_floz`) with their
   `ingredient_costs`; all prep recipes (`recipes` filter `is_prep` true:
   `name`, `yield_unit`) with their `recipe_costs` (`cost_per_yield_unit`,
   `status`).
3. **Match each line** to one source — an existing ingredient, or a prep
   recipe — by what the kitchen uses, not by spelling ("EVOO" is Olive Oil,
   Extra Virgin). Apply the modifier rule below to decide whether an item is
   its own line or lives inside a prep.
4. **Convert each quantity to the source's unit** (Conversions below). A
   conversion that crosses kinds without `each_weight_oz` / `density_oz_per_floz`
   on the ingredient **stops that line** — ask for the weight, never guess it.
5. **Sort the lines** into: ready (source exists, unit converts, price known) ·
   **no price** (ingredient exists, `ingredient_costs.cost_per_unit` empty) ·
   **new ingredient** (nothing in the database is it) · **blocked** (unit
   can't convert).
6. **The human gate — show the table before the first write**: card line →
   source → quantity in source unit → price per unit → line cost, with every
   no-price, new-ingredient and blocked line marked, and every new prep recipe
   with its yield. Write after the person confirms. A new ingredient is created
   **only** on that confirmation. **When no person is present** (a lane, the
   repo's agent job): write the ready lines only, and park everything that
   needs a person as **one decision per dish** — a `decisions` row, written in
   the same `write_rows` as the dish's ready lines (step 8), with `kind` `recipe_lines`, `recipe_id` the dish, `status` `open`, `title`
   `Recipe entry needs you — <dish>`, and in `notes` each held line with its
   quantity, unit and what would clear it ("create ingredient Lemons, unit
   each?", "each weight for Limes"). Then stop.
7. **Preps first.** A new prep recipe goes in as one `write_rows`: the
   `recipes` row with a uuid you chose, then its lines pointing at that uuid
   (and any new ingredient the owner confirmed for it, before the lines that
   use it). Check it with `recipe_cost` (its `status` is `costed`) before a
   dish line points at it.
8. **Write the dish's lines in one go**: every ready line as a `create` on
   `recipe_lines` in ONE `write_rows` — with, ahead of them, any new
   ingredient the owner confirmed (its uuid chosen by you, so the line can
   name it). A dish is never left with half its card. Check the stored rows
   in the reply against what was sent (links, quantity, unit).
   **Refused** → nothing was written; the refusal names the failing write's
   index — read that line, fix it (both sources set, a unit that isn't the
   source's), and re-send the whole batch. Never drop the line to get the
   rest through: a line not written is held, with its reason, at the gate.
9. **Verify** — every check below. Fix, re-run, then report.
10. **Explain the cost** with **recipe-costing**: `recipe_cost` on each dish
    touched — its total, cost per portion, food cost % and every line's
    `working` go in your report.

## Resuming

When the owner answers a parked `recipe_lines` decision in Bread 'n' Butter
(Food costs → To check → Decisions), the app writes the answer onto the
`decisions` row (`status` `answered`, `answer`, `answered_by`,
`answered_at`) and runs this skill with:

```
{ "decision_id": "<decisions.id>" }
```

The answer is `Approved as proposed.` (create what the notes propose — each
new ingredient as listed — and write the held lines) or `Edit before
adding: <note>` (apply the note first). ("Leave it as it is." never reaches
you: the app settles it.)

1. **Load the decision** (`get_row` on `decisions`) and its dish
   (`recipe_id`). Not `answered`, or not `recipe_lines` → write nothing;
   report why.
2. **Re-sort the held lines** in `notes` by step 5 against the database as it
   is now — an invoice may have priced an ingredient since it was parked.
3. **Apply the answer** in one `write_rows`: an approved new ingredient is
   created as proposed (the owner's say-so is this answer), every line whose
   ingredient now has a price is written (steps 7–8), and the decision is
   closed at the end of the same batch — everything landed → `status` `done`,
   adding one line to `notes` (applied by the job, with the date); anything
   still held → `status` `open`, `notes` rewritten to the lines still held and
   what clears each. A line still without a price, or a note that doesn't
   settle a line on its own, stays held. A refused batch leaves the decision
   `answered` and nothing half-applied: fix the named write and re-send.
4. **Verify and explain** as steps 9–10.

## Rules

These are the restaurant's lessons, held as rules. Each lesson file keeps the story.

**Priced ingredients only** (`mock-recipes-use-costed-ingredients-only`). A
line is written only on an ingredient that exists **with a price** in
`ingredient_costs`. A line whose ingredient has no price is **flagged and
held** — listed in the report and the parked decision, not written — because a
line with no price makes the whole dish *cost incomplete* in `recipe_costs`.
Say plainly that the dish's food cost is missing those lines until they land,
and that they can land the day an invoice prices the ingredient. Never invent
an ingredient, a price, or a line the card doesn't have; name a dish for what
its lines really make.

**Unit matches the source** (`component-unit-matches-source`). A line's `unit`
is the ingredient's `unit` or the prep's `yield_unit`, exactly. A card in cups
against an ingredient in oz is converted through `density_oz_per_floz`; a card
in pieces against an ingredient in oz through `each_weight_oz`. Empty → stop
that line and ask. A silent coercion makes every later cost wrong.

**A prep recipe is a sealed modifier unit** (`prep-recipe-sealed-modifier-unit`).
Anything a guest could sensibly say "no" or "on the side" to — tomato, pickled
onion, a sauce, pita, a drizzle — is a **top-level line** of the dish.
Structural ingredients — flour, yeast, leavener, the salt in a dough — live
**inside a prep recipe**. A sauce the guest can drop or swap is a prep recipe
line on the dish, not its raw ingredients inlined: the prep's own name is the
modifier; what's inside it never is.

**Trim is a by-product, never an ingredient** (Breakdown preps and
by-products). A breakdown prep has one line, the raw ingredient; a
by-product has none. A line the card gives as "fat trim (from the hangar)"
points at the by-product prep, never at a new ingredient — and never as a
0 lb line on the fat (a stopgap that is tied to nothing).

**One source per line.** Exactly one of `ingredient_id` / `sub_recipe_id`. A
recipe never uses itself. A prep that would contain itself is a loop — stop
(the database would cost it *cost incomplete: loop or too deep*).

**Supplies aren't ingredients.** Foil, the to-go box, gloves: not lines.

**Delete only your own mistake.** `delete_row` on `recipe_lines` removes a
line **this session wrote wrongly** — the wrong ingredient picked, a line
written twice — and nothing else. A line that was on the dish before this
session is the owner's: changing or removing it waits for the owner's word
in this conversation (or an answered decision that says so), and an owner's
line that looks wrong is shown and asked about, never quietly fixed. Say in
the report every line you deleted and why. A wrong value on a line you wrote
is usually an `update_row`, not a delete and a re-create.

## Conversions

Within a kind, convert and say so in the line's report row:

| Card unit | To | Factor |
|---|---|---|
| lb · g · kg | oz | × 16 · × 0.03527 · × 35.274 |
| tsp · tbsp · cup · pt · qt · gal · mL · L | fl oz | × 1/6 · × 0.5 · × 8 · × 16 · × 32 · × 128 · × 0.033814 · × 33.814 |
| dozen | each | × 12 |

Across kinds — volume ↔ weight needs the ingredient's `density_oz_per_floz`;
count ↔ weight needs `each_weight_oz`. Empty → the line is **blocked**: ask.
A "pinch", "to taste" or "a drizzle" has no quantity — ask for the real amount;
if the person says it's negligible, leave it off and say so.

## Verification

**Before writing**

| # | Check | Pass when |
|---|---|---|
| 1 | Every card line accounted for | ready + no price + new ingredient + blocked + left off (with reason) = lines on the card |
| 2 | One source each | every ready line has exactly one of ingredient / prep, and that source exists live |
| 3 | Unit = source unit | every ready line's `unit` = its ingredient's `unit` / prep's `yield_unit`; every conversion shown with its factor |
| 4 | Price known | every ready line's source has a price (`ingredient_costs` / a `costed` prep — a by-product always is, at $0); every line without one is in the held list |
| 4b | Breakdown shape | a breakdown prep has exactly one line, its raw ingredient; a by-product has `byproduct_of` set and no lines; no trim is an ingredient |

**After writing**

| # | Check | Pass when |
|---|---|---|
| 5 | Read-back | listing the dish's `recipe_lines` returns every written line with the values sent, and every line it had before |
| 6 | Costed | `recipe_cost` on the dish: every written line's `status` is `costed` (a `unit mismatch` or `cost incomplete` line is a ⚠ with its cause) |

Report it as a table, every time — ✓ or ⚠ per check with the numbers, e.g.
`✓ 1 Lines 11/11 · 8 ready · 2 no price · 1 new ingredient` ·
`⚠ 4 Lemons: no price yet — held, parked for the next invoice`. A ⚠ is never
silent: say what it blocks and what would clear it.

## Report

The Verification table first, then per dish: lines written (source, quantity,
unit, line cost from `recipe_cost`), lines held and why (no price · new
ingredient · blocked unit), conversions applied, prep recipes created with
their yield, any decision parked (its title), and the dish's cost per portion
and food cost % from `recipe_cost` — called **incomplete** while any line is
held.
