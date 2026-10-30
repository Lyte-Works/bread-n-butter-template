---
name: sales-entry
description: Turn one night's POS sales export (Toast Product Mix or Item Selection Details, Square item sales, Clover item sales, or any CSV with item, quantity and net columns) into the restaurant's Sales data through its Bread 'n' Butter MCP — one sales report per source, business date and location and every line as printed (item, POS key, menu group, quantity, net, kind item · modifier · comp · void, a modifier under its item), reconciled to the printed net to the cent, in one all-or-nothing write — then match each new POS item once in pos_items (a dish to its recipe, a modifier to its effect), and report the night's net, portions, Kitchen vs Bar food cost, top dishes, what is unmatched and any dish over the food-cost alert. Use whenever someone sends, drops or forwards a POS sales report, product mix, item sales export or "last night's sales" and asks to enter, load, add, log or re-enter it, and when the "Run a skill" job is handed `{ source, business_date, file_url }` for the nightly sales. It never writes a cost.
kind: procedure
---

# Sales Entry

<!-- Restaurant skill. It reaches the restaurant's data ONLY through the
restaurant's own Bread 'n' Butter MCP (`.mcp.json` → /api/restaurants/<slug>/mcp,
verbs list_tables · list_rows · get_row · create_row · update_row ·
upsert_row · delete_row · write_rows · upload_vendor_file · recipe_cost). It
never holds a database address. The tables and views are the restaurant
database's (supabase/restaurant/0013_sales.sql, 0016's sales_by_station,
0019's sales_dish_totals in the app repo); when a migration renames a column,
update this file in the same change. `list_tables` is the live truth. The
export is read by read-export.cjs beside this file; the write checker
(invoice-intake/hooks/check-write.cjs) re-checks every sales row stored. -->

A sales report is what **went out** of the kitchen and bar on one night. It
is not a cost and never moves one: recipe costs come from invoices, and the
sales views read those costs, they never store one. The night's job is the
same discipline as an invoice — keep every line the POS printed, invent
nothing, close the lines to the printed total to the cent — and then let the
views do the rest: `sales_by_station`, `sales_dish_totals`,
`theoretical_usage` and the sold movement in `stock_on_hand` all follow from
the lines and the POS items they match, on their own.

**Matching is done once per POS item, not once per night.** A `pos_items`
row says "Toast item 400101 is the Hangar Steak Frites" or "the Medium Rare
modifier moves nothing", and every line with that key — tonight's, last
week's, next month's — links to it by itself (`sales_line_matches`). So the
first night with a POS is a matching session with the owner, and every night
after it is a write and a read-back.

## Base Structure

Write by **column name**; you choose the uuids so the lines can name their
report, and a modifier its item line, in the same batch.

```
recipes (dish) ←── pos_items (once per POS item: a dish, or a modifier's effect)
                       ↑ by key (POS key, else the name ignoring case and spaces)
sales_reports ──→ sales_lines (one per line as printed; a modifier → its item line)
      ↓ views, never written
sales_report_summary · sales_line_matches · sales_dish_totals · sales_by_station · theoretical_usage
```

### `sales_reports` — one row per POS, business date and location

| Column | Fill with |
|---|---|
| `source` | `toast` · `square` · `clover` · `other` (an unknown layout) |
| `business_date` | The night, from the export's header ("Business date 10/28/2026", the rows' order date). The payload's date only when the file prints none; the two disagreeing is a stop |
| `location_id` | Empty for a one-location restaurant (no `locations` rows). Otherwise the `locations` row whose name is the export's location; none matches → ask (headless: park and stop) |
| `net_sales` | The export's **printed** net total, as printed. No printed total (Item Selection Details, some Square exports) → the lines' own sum, and the report says so |
| `item_count` | Items sold: the sum of the item lines' quantities (not modifiers, comps or voids) |
| `file_path` | The stored export: the payload's `file_path`, or what `upload_vendor_file` answered (step 6) |
| `entered_by` | `assistant` with someone present; `sales-entry (headless)` in the job |
| `note` | One line: the export's title ("Toast Product Mix - Items, TEST RESTAURANT, business date 10/28/2026"), the layout when it was read by its headers, anything odd |

**One a night.** The database refuses a second report for the same source,
date and location (`sales_reports_one_a_day`). Re-entering a night is a
delete of its report — lines and comments go with it — and the new report,
in the **same** `write_rows`: the night is never missing, never doubled.

### `sales_lines` — one row per line, as printed

| Column | Fill with |
|---|---|
| `report_id` | The report's uuid |
| `item_name` | The item or modifier as printed, verbatim |
| `pos_key` | The POS's own id for it (Toast Item ID / Master ID, a SKU or PLU) as printed; empty when the export prints none (Toast prints none on a modifier row) |
| `menu_group` | The menu group or category as printed |
| `quantity` | As printed, more than 0 |
| `net_sales` | As printed; `0` when the row prints $0.00 |
| `kind` | `item` (sold) · `modifier` (a choice on an item) · `comp` (given away) · `void` (rung and taken back) |
| `parent_line_id` | A modifier's item line (the line its "Modifier Of" names). Only a modifier has one |

**Kinds, as the POS prints them.** One export row can be three lines: Toast's
"Brûléed Banana, Qty Sold 6, Comp Qty 1, Net $60" is an `item` of 6 at $60
and a `comp` of 1 at $0 (the comp's $10 is in Discounts, already out of the
net). "Margarita, Qty Sold 18, Void Qty 1" is an `item` of 18 and a `void` of
1 at $0. A comp counts toward what the kitchen used; a void never does, and
a modifier on a void is not counted either. A void's net never counts toward
the total.

### `pos_items` — a POS item, matched once

| Column | Fill with |
|---|---|
| `source` | The report's source |
| `pos_key` · `item_name` | The line's POS key and item name (the key is computed from them; never type `match_key`) |
| `recipe_id` | A **dish's** recipe (a menu dish, never a prep). Empty for a modifier |
| `effect` | A modifier's: `add` (it adds an ingredient or prep) · `remove` (it leaves out an ingredient or prep the dish uses) · `none` (it moves nothing: "Medium Rare", "No Ice") |
| `ingredient_id` · `sub_recipe_id` | What an `add` adds or a `remove` leaves out — exactly one |
| `quantity` · `unit` | An `add`'s amount **per modifier**, in that ingredient's unit or that prep's yield unit (the database refuses another unit) |
| `matched_by` | Who said so: the owner's email or name, or `assistant: unmistakable` (headless) |

An item with no dish — Bread Service, a gift card, a retail bottle, a
service charge — gets **no** `pos_items` row. It stays unmatched ("not
counted yet"), which is correct: its net is in the night's total and in no
station.

### `decisions` — what you park for the owner (headless)

Sales decisions are `kind` `other`, with no `invoice_id`, `recipe_id` or
`price_list_id` (none applies), `status` `open`, and a title that starts
`Sales (<Source>)`. The app shows them on the Decisions screen; the owner can
only mark them Handled there — see Resuming.

## Procedure

0. **Open the door.** `list_tables` once: `sales_reports`, `sales_lines` and
   `pos_items` writable, `sales_report_summary`, `sales_by_station` and
   `sales_dish_totals` there. A refusal (401/403) means the token is wrong or
   read-only — stop and say so.
1. **Read the export.** `node workers/skills/sales-entry/read-export.cjs
   <file> --source <source> --business-date <date>` (the payload's, when
   given). It prints the layout, source, business date, location, the
   printed net, every line in printed order (each with its `position`, and a
   modifier's item line as `parent`), `item_count`, the lines' net and
   whether they reconcile. A non-zero exit is a stop: its `error` says why
   (no item or net column, a negative quantity, two days in one file, the
   file's date or POS not the payload's). Layouts it knows, by their columns:

   | Layout | Columns read |
   |---|---|
   | Toast **Product Mix (Items)** | Menu Group · Menu Item · Item ID · Modifier Of · Qty Sold · Comp Qty · Void Qty · Gross Sales · Discounts · Net Sales; the title row's business date and location; the `Total` row is the printed net |
   | Toast **Item Selection Details** | one row per selection: Menu Item · Item Id / Master Id · Menu Group · Net Price · Discount · Gross Price · Qty · Void? · Order Date — summed per item; `Void?` true → void; discounted to $0 → comp. No modifiers (they are in Modifiers Selection Details) and no total |
   | Square **item sales** | Item · Price Point Name · SKU · Category · Qty / Items Sold · Modifiers Applied · Gross Sales · Discounts · Net Sales (· Transaction ID on the detail export, summed per item). A price point other than Regular joins the name ("Latte (Large)"); each modifier applied is a $0 modifier line under its item (its money is in the item's net) |
   | Clover **item sales** | Name · SKU · Category · # Sold / Quantity Sold · Gross Sales · Discounts · Net Sales / Item Revenue; a `Total` row when printed |
   | **Anything else** | read by its headers — an item column (Item, Item Name, Name, Menu Item), a quantity, a net — and the report says the layout was unknown, naming its headers |

   A photo or PDF of a sales report has no reader: transcribe it into the same
   lines by hand, say the numbers were read from an image, and hold to the
   same reconcile.
2. **Reconcile, before anything is written.** `reconciles` true: the lines'
   net (voids left out) equals the printed net to the cent. Not true → **stop**.
   Show the difference and the lines (someone present), or (headless) park
   one decision — `Sales (Toast) 10/28: the lines don't add up` with the
   printed net, the lines' net, the difference and the file — write nothing
   else, and finish `failed`. Never adjust a line to make it close.
3. **Refuse a duplicate.** `list_rows` on `sales_reports` `{ source,
   business_date, location_id }`. One exists → it is in: write nothing, say
   which (its net, when it was entered), and stop — **unless the owner says
   re-enter** (in person, or `re_enter: true` in the payload). Re-entering is
   the delete of that report as the first write of step 7's batch.
4. **Match** every distinct POS item (Matching): one `list_rows` on
   `pos_items` `{ source }`, then each line's key against it. What is new is
   proposed to the owner (present) or matched only when unmistakable
   (headless).
5. **Location.** `list_rows` on `locations`. None → `location_id` empty.
   Some → the one named on the export; none named or none matching → ask
   (headless: park `Sales (<Source>) <date>: which location?` and stop).
6. **Keep the original.** No payload `file_path` → `upload_vendor_file`
   (`file_name`, `content_type` `text/csv`, `content_base64`) and use the
   `file_path` it answers. A refusal doesn't stop the night: write it without
   `file_path` and say so.
7. **Write it in one batch.** One `write_rows`, in order: the old report's
   delete (re-entry only), the report, every line in printed order (each
   `create` with the uuid you chose, a modifier naming its item line's uuid),
   every `pos_items` row approved, then any decision parked. All or nothing.
   - **Refused** → nothing landed. Read the failing write's index, fix it,
     re-send the **whole** batch with the same uuids. Never line by line.
   - **No answer** → `get_row` on the report's uuid says whether it landed;
     re-send only if it didn't.
   - **The write checker** re-checks every stored row; fix what it blocks.
   - **More than 200 writes** → `pos_items` and decisions go in a second
     batch after the night. A night of more than 199 lines can't land whole:
     stop and say so (headless: `failed`); never split a night across two
     reports.
8. **Verify** (below), then **report**.

## Matching

**The key.** A line matches the `pos_items` row of the same source with the
same key: its POS key when it has one, else its name ignoring case and
spaces (`pos_match_key`). A modifier with no POS key matches by name, so one
`pos_items` row serves "Medium Rare" under every dish.

**A dish to its recipe.** `list_rows` on `recipes` `{ is_prep: false }`. The
match is the dish the POS item **is** — the same plate at the same size.
Names drift between the POS and the menu ("HANGAR STK 8OZ" is Hangar Steak
Frites); a bottle and a glass of the same wine are two dishes. Never match
an item to a prep, and never to a dish because it is close.

**A modifier to its effect.** Read the item it sits under and that dish's
recipe (`recipe_cost`, its lines):

| The modifier | Effect |
|---|---|
| Cooks it differently, or a note: Medium Rare, No Ice, On the Side, Allergy | `none` |
| Adds something the kitchen portions: Extra Shallot Cream, Add Avocado, Double Shot | `add` — the ingredient or prep, and how much **one** modifier adds, in its own unit (2 fl oz of Shallot Cream Sauce) |
| Leaves out something the dish uses: No Fries, Hold the Cheese | `remove` — the dish line's ingredient or prep (it takes out what the dish's line uses, per portion) |
| A swap: Sub Salad for Fries | two POS items are needed to say it (remove + add); propose the remove and say the add can't be carried by one row |

The amount of an `add` is the owner's portion, never a guess: an add with no
amount the owner has stated is asked about (headless: parked).

**With the owner present**, propose every new POS item at once, as a table,
before the write:

| POS item | Key | Sold | Proposed | Why |
|---|---|---|---|---|
| Hangar Steak Frites | 400101 | 14 | dish: Hangar Steak Frites | same name |
| Medium Rare (on Hangar Steak Frites) | name | 8 | modifier: none | a temperature |
| Extra Shallot Cream (on Hangar Steak Frites) | name | 3 | modifier: add 2 fl oz Shallot Cream Sauce | the dish's own sauce line is 2 fl oz |
| Bread Service | 400901 | 5 | no dish — stays unmatched | $0, complimentary |

The owner approves, edits or leaves any row; the approved ones go in the
night's batch with `matched_by` the owner.

**Headless**, match only what is **unmistakable**: a POS item (not a
modifier) whose name, ignoring case, spaces and punctuation, is exactly one
menu dish's name and no other — `matched_by` `assistant: unmistakable`.
Everything else stays unmatched and goes into **one** standing decision,
`Sales (<Source>): POS items to match`, whose notes list each item as
`- <name> [<key>] · first seen <date> · <quantity> sold · $<net>` (and, for a
modifier, the item it sat under), with what you would propose for each. If
an open one exists, `update_row` its notes with the new items instead of
parking a second. The night is still written: its unmatched lines show as
"not counted yet", and they count the moment their POS items are matched —
the views link by key, so matching later fixes every night already in.

**No dish.** An item the owner says has no dish is left unmatched and named
in every report as "no dish". Headless, an item listed in a `done`
POS-items decision that is still unmatched is a no-dish item (the owner saw
it and marked it Handled without matching it): report it, never park it
again.

## Judgement rules

- **As printed, every line.** Never merge, split, round, rename, re-price or
  skip a line the export prints; never add one it doesn't. A $0 line (Bread
  Service, Medium Rare) is a line.
- **Close to the cent or stop.** No line is "fixed" to reconcile; a total
  that won't close is the owner's, never the skill's.
- **Never writes a cost.** No recipe, recipe line, ingredient, invoice,
  vendor item or price is written or changed, and nothing here stores a
  dollar figure but the POS's own net. Food cost in the report is read from
  `sales_by_station` and `sales_dish_totals`.
- **Matching is the owner's.** A POS item is matched once and every night
  after it follows; a wrong match is wrong on every night, so a close name,
  a guessed modifier effect or a guessed add amount is asked about, never
  written.
- **A void is not a sale; a comp is not a void.** Comps use the food (they
  count toward usage and the station's cost); voids never do.
- **Never use the browser.** The export is the file handed over; the POS's
  back office is never opened.

## Verification

| # | Check | Pass when |
|---|---|---|
| 1 | Reconciles | `sales_report_summary` for the report: `reconciles` true, `net_sales` = the printed net, `lines` = the lines read |
| 2 | Read-back | `list_rows` on `sales_lines` `{ report_id }`: every line came back with its name, key, group, quantity, net and kind, each modifier under its item line |
| 3 | Stations add up | Σ `sales_by_station.net_sales` for the report = the report's net less the net of its uncounted lines (`sales_line_matches` `counted` false, voids left out): unmatched items and modifiers on them |
| 4 | Modifiers counted | `sales_dish_totals` for each dish with counted modifiers: `modifier_lines` is their count and `net_sales` = `item_net` + `modifier_net` |
| 5 | Usage | `theoretical_usage` for the report has rows, and every matched dish with recipe lines is in it (a matched dish with no lines yet is named in the report) |
| 6 | Untouched | `recipe_cost` for one dish sold tonight reads the same before and after the write |

Report it as a table, ✓ or ⚠ per check with the numbers. A ⚠ is never
silent: what it blocks, what clears it.

## Report

The checks, then the night in plain words:

- **The night:** source, business date, location, net (as printed), items
  sold, lines written (items, modifiers, comps, voids), the file.
- **Portions:** Σ `sales_by_station.portions`.
- **Kitchen vs Bar:** each `sales_by_station` row — net, cost, food cost % —
  and a station with `uncosted_dishes` named; "No station" when dishes have
  none.
- **Top dishes:** the five highest `sales_dish_totals.net_sales`, each with
  portions and the night's food cost %.
- **Unmatched:** every POS item not matched, its quantity and net, and
  whether it is no dish (Bread Service) or parked to match.
- **Over the alert:** every dish sold tonight whose night's food cost %
  (`sales_dish_totals.food_cost_pct`) or recipe food cost % is over **30%**
  (the restaurant's food-cost alert, as `cost_alerts` reads it).
- **Parked:** each decision by title.

### Worked example — Toast Product Mix, 10/28/2026

The export is `references/toast-product-mix-2026-10-28.csv`: 18 rows and a
Total of **$2,373.00**. The reader gives 20 lines — Brûléed Banana's comp and
Margarita's void are their own lines, Medium Rare (8) and Extra Shallot Cream
(3, $6.00) sit under Hangar Steak Frites — 157 items sold, reconciled to the
cent. The night matches 15 dishes by key, Medium Rare as `none`, Extra
Shallot Cream as `add` 2 fl oz Shallot Cream Sauce, and leaves Bread Service
(5, $0) unmatched as no dish. Then:

| # | Check | Result |
|---|---|---|
| 1 | Reconciles | ✓ 20 lines, $2,373.00 = $2,373.00 |
| 3 | Stations add up | ✓ Kitchen $1,340.00 + Bar $1,033.00 = $2,373.00 − $0.00 unmatched |
| 4 | Modifiers counted | ✓ Hangar Steak Frites: 2 modifier lines, $476.00 + $6.00 = $482.00 |
| 5 | Usage | ✓ every matched dish with lines is in `theoretical_usage`, Shallot Cream Sauce with the 3 × 2 fl oz added |

Proven end to end, through the MCP and the write checker, by part 6 of
`src/src/lib/restaurant-api.test.ts` in the app repo.

## Resuming

A parked sales decision is `other`: on the Decisions screen the owner can
only mark it **Handled**, which settles it in the app and hands nothing back
to a job. So a sales decision is resumed with someone present: when the
owner asks to match the POS items (or opens a session with open
`Sales (…)` decisions), load each open one, propose its items as the
Matching table, write the approved `pos_items` in one `write_rows` with the
decision set `done` in the same batch, and re-run checks 3–5 over every
report those items appear on (`sales_line_matches` by `match_key`) — the
nights already in now count them. A mismatch decision is resumed by
re-entering that night from a corrected export.

When the app hands sales decisions back (see Running headless, what the app
needs), the job runs this skill with `{ "decision_id": … }`: the night is
already in; write no report or line; apply the answer to the items it lists
and set it `done`, then re-run the checks.

## Running headless

The nightly path: the restaurant repo's `.github/workflows/agent-job.yml`
("Run a skill") runs this skill with `claude -p` on the restaurant's own AI
key against the restaurant MCP, the write checker wired as a hook, from a
`repository_dispatch` `run-skill` or the Actions tab's Run workflow:

```
{ "skill": "sales-entry",
  "payload": { "source": "toast", "business_date": "2026-10-28",
               "file_url": "<a signed, short-lived https link to the export>",
               "file_path": "<its path in the app's storage, when the app stored it>",
               "re_enter": false } }
```

`file_url` is required today: the job downloads it to `job/input/<name>`
before the run (the link itself is withheld from the prompt); `file_path`
alone gives the run nothing to read. `source` and `business_date` are
checked against the file (step 1). `re_enter: true` is the owner's say-so to
replace a night already in; without it a duplicate is refused.

In the run nobody can answer: every gate is park-and-notify — a total that
won't close (step 2, `failed`), a location that isn't clear (step 5,
`failed`), new POS items (the standing POS-items decision; the night is
still written, `done`). The run ends by writing `job/report.md` (the
Verification table, then the Report) and `job/outcome.json`:

```
{ "status": "done" | "duplicate" | "failed", "invoice_id": null,
  "sales_report_id": "<sales_reports.id or null>", "parked": ["<decision title>", …],
  "summary": "Toast 10/28: $2,373.00 net, 157 items; Kitchen 16.7% · Bar 23.0%; 1 unmatched (Bread Service, no dish)" }
```

Never write `invoice_readings`: a sales payload carries no `reading_id`, so
the job's close-out step is skipped.

**What the job already does:** it runs any `workers/skills/<name>/SKILL.md`
in the restaurant repo with any JSON payload, downloads an https `file_url`,
wires the write checker for every write, and treats `done` / `duplicate` as
green and `failed` as red. A CSV needs no text extraction.

**What the app and the template need to add** (none of it is in this
skill's change):

1. **The skill in the restaurant repo.** The template
   (`Lyte-Works/bread-n-butter-template`) keeps a hand-copied
   `workers/skills/`: copy `workers/skills/sales-entry/` and the updated
   `workers/skills/invoice-intake/hooks/check-write.cjs` there and run its
   keeper-sync. Until then the job stops at "Resolve skill and payload":
   unknown skill.
2. **Something that starts it.** Nothing in the app dispatches
   `sales-entry` yet. The nightly trigger (a subscription to the POS's
   emailed report, a schedule, or a Sales drop zone) stores the export as the
   invoice drop does (`src/lib/invoice-files.ts`), signs a read link, and calls
   `dispatchSkill(repo, token, "sales-entry", { source, business_date,
   file_url, file_path })` (`src/lib/repo-dispatch.ts`).
3. **A hand-back for sales decisions.** `decisions` has no `sales_report_id`
   and its kinds have no sales one, so a parked sales decision is `other`:
   shown, answerable only as Handled, never handed back. A migration adding a
   `pos_items` kind (and `sales_report_id`), an answer form for it, and
   `handBackTarget` routing it to `{ skill: "sales-entry", decision_id }`
   (`src/lib/hand-back.ts`) would let the owner match items in the app.
4. **The job's prompt is invoice-worded** (its duplicate rule, the
   decision's link columns, "drop the invoice again" on a failed download).
   The skill's own rules govern the run; one line naming sales in the
   template's prompt would make that explicit.
5. **Nights over 199 lines** can't land as one `write_rows` (its 200-write
   cap): a busy night's full Product Mix with modifiers needs a larger cap
   for the sales tables.
