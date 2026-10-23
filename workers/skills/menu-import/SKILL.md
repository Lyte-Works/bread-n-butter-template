---
name: menu-import
description: Read a restaurant's menu (a website URL, a PDF, a photo of the printed menu, or a POS menu export) and create one recipe per dish in the restaurant's database, through its Bread 'n' Butter MCP — name, category, menu price as printed, marked as a menu dish yielding 1 portion — with every dish on the menu counted and nothing invented, then hand off to recipe-entry. Use whenever someone shares a menu and asks to import, load, add, enter, set up or start costing their dishes.
kind: procedure
---

# Menu Import

<!-- Restaurant skill. It reaches the restaurant's data ONLY through the
restaurant's own Bread 'n' Butter MCP (`.mcp.json`; verbs list_tables ·
list_rows · get_row · create_row · update_row · upsert_row · delete_row ·
write_rows · recipe_cost). Column names are
the restaurant database's (supabase/restaurant/ in the app repo); when a
migration changes one, update the table here in the same change. There is no
separate menu-items table: a menu dish is a recipe with `is_prep` false and a
`menu_price`. -->

A menu is the restaurant's promise of what it sells and for how much. The job
is to turn that promise into the list of dishes the database will cost — every
dish on the page, at the price on the page, and not one dish more. A menu row
here is an empty recipe: it carries the name and the price; what goes into it
is recipe-entry's job.

## Base Structure

### `recipes` — one row per dish the guest can order

| Column | Fill with |
|---|---|
| `name` | The dish name as printed, title-cased, menu jargon kept ("Falafel Plate", "The Hangover Burger"). Descriptions stay out of the name |
| `category` | The menu's own section heading as printed, title-cased ("Mezze", "Mains", "Brunch Cocktails"). No section on the menu → empty, not a guess. When a heading matches a category the restaurant already uses, ignoring case, reuse that spelling; otherwise keep the heading as printed |
| `menu_price` | The printed price, as a number (`14.00` for "$14" or "14"). Never rounded, never adjusted |
| `is_prep` | `false` — always. A menu dish is never a prep recipe |
| `yield_quantity` | `1` |
| `yield_unit` | `portion` |

Never written by this skill: `location_id` (leave empty). There is no cost
column — a dish's cost is the view `recipe_costs`, and it reads *cost
incomplete* until recipe-entry gives the dish its lines.

## Procedure

1. **Get the menu's text out.** A URL: fetch the page and read the menu itself,
   not the nav, footer or a "popular items" strip; a menu split over sub-pages
   (Lunch, Dinner) is read page by page and each page named in the report. A
   PDF: extract text with its layout kept. A photo: read it directly and say the
   prices are read from an image. A POS export: read its item list, skipping
   modifiers, add-ons and inactive items.
2. **List every dish before writing anything**: section, name, price as
   printed, and any note that changes what counts (sizes, market price, "add
   chicken +$4"). Count the dishes on the source as you go — that count is the
   number every check below is held against.
3. **Decide what is a dish** by the judgement rules below.
4. **Read `recipes` live** (`list_rows`, `is_prep` false) and match each dish by name
   (case- and punctuation-insensitive). Already there → it is not created
   again; a price that differs is listed for the person, never overwritten
   silently.
5. **The human gate — show the parsed menu before the first write.** One table:
   section, name, price, and per row `new` · `exists` · `exists, price differs`,
   plus every judgement call (a size split, a market-price dish, an item left
   out and why). Write only after the person confirms it. **When no person is
   present** (a lane, the repo's agent job): do not write. Park the decision as
   one `decisions` row (`create_row`) with `kind` `menu_import`, `status`
   `open`, `title` `Confirm menu import — <restaurant> (<n> dishes)` and the
   full table in `notes` — then stop and report that it is parked.
6. **Write the menu in one go**: every `new` dish of the confirmed table as a
   `create` on `recipes` in ONE `write_rows`, in menu order — the whole menu
   lands or none of it does, never a half-imported menu that looks finished.
   More than 200 dishes → batches of 200, in menu order; each batch is whole,
   and a re-run re-matches by name (step 4), so a batch that already landed
   is never created twice. Check the stored rows in the reply against what
   was sent: every column, `is_prep` false, yield `1 portion`.
   **Refused** → nothing in that batch was written; the refusal names the
   failing write's index — read that dish's row, fix it (a stray column, a
   price that isn't a number), and re-send the whole batch. Never drop the
   dish to make the rest go through: a dish left out is said so at the gate,
   not by the error.
7. **Verify** — every check in Verification below, every import. Fix what
   fails, re-run, then report.
8. **Hand off** to **recipe-entry**: the list of new dish ids and names, in
   menu order. Say plainly that the dishes have no cost yet — food cost appears
   only after their recipes are entered and costed.

## Judgement rules

**Extract, never invent.** Every row traces to a line on the source. A dish
the menu doesn't show doesn't exist, however obvious it seems; a price the menu
doesn't print is blank. Better to miss a dish and say so than to add one.

**What is a dish.** Something a guest orders at its own price. Add-ons ("add
avocado +$2"), sauces on the side, and choice lists inside a dish ("choice of
chicken, lamb or falafel") are not dishes — they are noted for recipe-entry
and later modifiers, not imported. A side sold on its own line at its own price
is a dish.

**Sizes and variants.** A dish printed at two prices for two sizes or
proteins ("Hummus — small 8 / large 12", "Shawarma — chicken 14 / lamb 17")
becomes one row per price, named `<Dish> (<variant>)`, because each is costed
separately. Count them as the menu's dishes in the verification. One price
with free choices stays one row.

**Prices as printed.** "14" → `14.00`; "14.5" → `14.50`. "MP" or "market
price" → `menu_price` blank and flagged; the dish still counts. A price range
or "from $12" → blank and flagged, never the low end. Never add tax, never
round.

**Same name twice.** The same dish under two sections (Lunch and Dinner menus)
at the same price is one row; at different prices it is two rows,
`<Dish> (Lunch)` / `<Dish> (Dinner)`, said so at the gate.

**Categories are the menu's.** Use the restaurant's own section words; don't
map "Shareables" to "Appetizers". No sections → blank.

**Drinks.** Imported like any dish when they're on the menu at a price; a bar
list the person didn't ask for is mentioned at the gate, not imported
unasked.

## Resuming

When the owner answers a parked `menu_import` decision in Bread 'n' Butter
(Food costs → To check → Decisions), the app writes the answer onto the
`decisions` row (`status` `answered`, `answer`, `answered_by`,
`answered_at`) and runs this skill with:

```
{ "decision_id": "<decisions.id>" }
```

The answer is one of `Approved as proposed.` (the parsed table in `notes` is
confirmed) or `Edit before adding: <note>` (apply the note to the table
first). ("Leave it as it is." never reaches you: the app settles it.)

1. **Load the decision** (`get_row` on `decisions`). Not `answered`, or not
   `menu_import` → write nothing; report why.
2. **The table in `notes` is the confirmed gate** (step 5) — re-read
   `recipes` live and re-match by name, so a dish added since is `exists`, not
   created twice. An edit that doesn't settle a row on its own (which dish,
   which price) → set the row back to `open`, adding to `notes` what you need.
3. **Write and verify** as steps 6–7, with the decision's `done` (one line
   added to `notes`: applied by the job, with the date) as an `update` at the
   end of the last batch — so the decision is marked done exactly when its
   dishes are in, and a refused batch leaves it `answered` to run again.
4. **Hand off** as step 8.

A resumed run never asks anyone: what it still can't settle it parks again.

## Verification

**Before writing**

| # | Check | Pass when |
|---|---|---|
| 1 | Count | dishes parsed = dishes counted on the source (per section and in total), size/variant rows counted as the rows they become |
| 2 | Nothing invented | every parsed row points at a line of the source (section + printed text) |
| 3 | Prices as printed | every `menu_price` = the printed number exactly; every blank price has its reason (MP, range, not printed) |
| 4 | No duplicates | no dish both `new` and matching an existing `recipes` row; no two new rows with the same name |

**After writing**

| # | Check | Pass when |
|---|---|---|
| 5 | Read-back | listing `recipes` returns every written row with the values sent — `name`, `category`, `menu_price`, `is_prep false`, `yield_quantity 1`, `yield_unit portion` |
| 6 | Close | rows created + rows already present = dishes on the menu; nothing created that wasn't on the confirmed table |

Report it as a table, every time — ✓ or ⚠ per check with the numbers, e.g.
`✓ 1 Count 32 = 32 (Mezze 9 · Mains 12 · Sides 6 · Desserts 5)` ·
`⚠ 3 Prices: Whole Branzino is MP — menu_price blank`. A ⚠ is never silent:
say what it blocks and what would clear it.

## Report

The Verification table first, then: dishes created, dishes already present
(with any price that differs from the database's row), judgement calls (size
splits, market price, items left out and why), the source and how it was read
(page, PDF, photo, export), and the hand-off line:

```
→ recipe-entry: 32 new dishes, no lines yet — Falafel Plate, Chicken Shawarma (Chicken), …
```
