---
name: morning-order
description: Draft the morning order — when the chef says "get every vendor's prices for today for my menu and draft my order" (or "what should I order where", "price out tomorrow's order", "who's cheapest today") — through the restaurant's Bread 'n' Butter MCP: work out every ingredient the menu uses down through its prep recipes, check each vendor's price for freshness, ask for today's order-guide export or draft quote-request emails for the stale ones, pick the best fresh price (for a cut the kitchen trims, the best cost per usable pound at each vendor's usual yield) within each vendor's minimum, cutoff and delivery days, draft one order email per vendor from the chef's own quantities, and report what to order where, the totals, the savings and every price's source and age. Drafts only: it never sends anything, never uses the browser, and never changes a recipe cost.
kind: procedure
---

# The Morning Order

<!-- Restaurant skill. Read-only on the kitchen but for one column: it
reaches the restaurant's data ONLY through the restaurant's own Bread 'n'
Butter MCP (`.mcp.json`; verbs list_tables · list_rows · get_row ·
recipe_cost, and update_row for `vendors.kind` alone). The prices are the
view `ingredient_vendor_prices`; freshness rules are `price_freshness`;
ordering details are on `vendors` (spec "Vendor prices and the morning order"
§Data contract, supabase/restaurant/0010 and 0011 in the app repo). It writes
nothing else, except through price-list-intake when the chef hands over a
document. -->

A chef ordering for tomorrow wants three answers: **what does each vendor
charge today, where should each thing come from, and what do I send.** This
skill answers them from what the database knows, says exactly how old each
price is, and hands the chef drafts. The chef sends every email from their
own inbox; nothing leaves the restaurant from here.

**Three lines it never crosses.**
- **It sends nothing.** Every email is a draft: to, subject, body, shown to
  the chef. No email tool, no connection, no "I've sent it".
- **It never uses the browser.** The `browser_*` tools are never opened on a
  vendor portal — not to read prices, not to place an order, not to download
  the export. A broadline's prices come from the export the chef drops.
- **It never changes a recipe cost.** A quote is what a vendor *says*; recipe
  costs stay what the restaurant *paid*. Nothing here writes an ingredient,
  a recipe, an invoice or a price — the one thing it writes is a vendor's
  `kind`, once the chef has said it.

## What the database answers

| Where | What it gives |
|---|---|
| `list_rows` `recipes` `{ is_prep: false }` | the menu: every dish (`menu_price` set) |
| `recipe_cost` `{ recipe_id }` | a dish's lines — each `ingredient_id` or `sub_recipe_id`, quantity, unit |
| `list_rows` `ingredient_vendor_prices` | per ingredient × vendor item × source (`invoice` · `price_list`), the latest: `price_per_unit` in the ingredient's `unit`, `source_kind` (invoice status or price-list kind), `source_id` and `source_line_id` (the invoice or price list, and its line), `file_path` (the original), `as_of`, `age_days`, `max_age_days` (its freshness limit), `is_fresh`, `is_cheapest_fresh`. The invoice side counts only what was received — an `ordered` or `disputed` invoice is not a price paid |
| `list_rows` `price_freshness` | how many days a price stays fresh, by ingredient `category` (`*` = everything else) — the owner's setting |
| `list_rows` `vendors` | `kind` (`broadline` · `purveyor`, null until the chef says), `rep_name`, `rep_email`, `order_cutoff` (as the vendor wrote it), `delivery_days` (lower-case weekday names), `order_minimum` ($) |
| `list_rows` `vendor_items` | each vendor's product: code, description, pack, `base_units_per_case` |
| `get_row` `price_list_lines` / `invoice_lines` on `source_line_id` | the printed line behind a row: its price as printed, its `unit` (`CS` · `EA` · `LB`), its pack |
| `list_rows` `ingredient_costs` | the **usual vendor**: who the ingredient was last bought from, and at what |
| `list_rows` `yield_by_vendor` | for an ingredient **broken down before use** (`ingredients.broken_down`: hangar trimmed, chickens broken down): per vendor, `logs`, `usual_yield` (usable out per raw unit in) and `usual_yield_pct`, `lowest_yield_pct`, `highest_yield_pct`, `latest_price` and **`cost_per_usable_unit`** — that latest paid price ÷ the usual yield, per unit of the trimmed prep |
| `list_rows` `locations` | the restaurant's name, for the emails |

**Freshness is the view's, never yours.** Quote `age_days` and `is_fresh` as
the view gives them; never re-judge a price fresh because it "looks right".

## Procedure

0. **Settle the order.** The delivery day (tomorrow unless the chef says), and
   the chef's **quantities** — the chef states them in v1 ("2 cases salmon,
   10 lb arugula"); there are no pars or counts to read. Ask for any you
   don't have; a menu ingredient with no quantity is reported, never ordered.
   Note the time now: cutoffs depend on it.
1. **Work out the menu's ingredients.** Every menu dish → `recipe_cost` → its
   lines; every prep line → `recipe_cost` on its `sub_recipe_id`, down to the
   last ingredient (as recipe-costing walks it). Keep, per ingredient, which
   dishes use it. An ingredient the chef asked for that no dish uses is still
   ordered — the chef's list wins — and marked "not on the menu".
2. **Read every vendor's price** for those ingredients from
   `ingredient_vendor_prices`. Per ingredient, sort its rows: fresh first,
   then by `price_per_unit`. An ingredient with **no fresh row** is **stale**;
   one with no row at all is **unpriced** (no vendor item, or one with no
   conversion — invoice intake fixes that).
3. **Ask for what is stale**, per vendor of the stale rows, by the vendor's
   `kind`:
   - **`kind` null** → ask the chef once, naming the vendor: "Is <vendor> a
     broadline distributor (an ordering portal with an order guide) or a
     purveyor (you get prices from a rep)?" Write the answer with
     `update_row` `vendors` `{ kind }` — that column and nothing else — so
     the question is never asked again. No answer (or a headless run) →
     treat it as a purveyor for today, write nothing, and say so.
   - **`broadline`**: ask the chef to **export today's order guide and drop
     it** — one export refreshes every item at once. Never open the portal.
   - **`purveyor`** (the fish guy, the produce house, the dairy): draft a
     **quote-request email** to its rep (Drafts). No `rep_email` → draft it
     with `to` blank and say so.
   - Whichever arrives — the export, a pasted reply, a photo of the sheet — is
     read in by **price-list-intake**, then re-read step 2. If the chef wants
     the order now, go on with what is fresh and carry the rest as stale.
4. **Pick the vendor for each item.**
   1. The cheapest **fresh** `price_per_unit` (`is_cheapest_fresh`) — among
      vendors that **deliver on the delivery day** (`delivery_days`) and whose
      **cutoff has not passed** (`order_cutoff`, read against now and the
      delivery day; a cutoff you can't read is stated, not assumed). A vendor
      that can't make the day is out, and the report says why.
   2. **No fresh price** → the usual vendor (from `ingredient_costs`), at its
      newest price on file (paid or quoted, whichever is later), marked
      *price to confirm*. Never pick a stale price over a
      fresh one, and never call a stale price a saving.
   3. **Minimums.** Total each vendor's basket (below). Under its
      `order_minimum` → try moving its items to their next-best fresh vendor
      that can make the day, or moving items to it from vendors that are well
      over; take the cheapest whole plan, and say what meeting the minimum
      cost against splitting. An item moved onto a stale price to meet a
      minimum is the one exception to 4.2: it is marked *price to confirm*,
      it goes on that vendor's quote request, and the report names the move
      and what it costs. When no plan meets it, keep the cheapest one
      and flag "under minimum by $X — add to it, take the fee, or skip"; the
      chef decides.
   4. A price is per the ingredient's unit; compare only those. Two vendors
      more than **2×** apart on the same ingredient → flag it as a likely
      conversion error before saving anything on it.
   5. **Broken down before use** (`ingredients.broken_down`): what the
      kitchen pays for is the usable meat, not the raw weight. Compare its
      vendors on **cost per usable unit** too, shown beside the raw price:
      `yield_by_vendor.cost_per_usable_unit` when the vendor's fresh price is
      the paid one it was worked from (`latest_price`), else the fresh raw
      price ÷ that vendor's `usual_yield` (rounded to 4 places, the working
      shown): "US Foods $14.00/lb raw · 85% · $16.47/lb usable;
      Harbor $13.20/lb raw · 72% · $18.33/lb usable". Pick on the usable cost
      when **both** vendors have yield logs; a vendor with none has no usable
      cost ("no yield logged yet"), so the raw price decides and the report
      says so. A cheaper raw price that is the dearer usable meat is named in
      the report as the reason for the pick.
5. **Size the lines.** The chef's quantity in cases, or converted to cases
   through the vendor item's `base_units_per_case` and rounded **up** to a
   whole case — or to splits (`EA`) when the vendor's price list prices them
   and the chef wants less than a case. A `LB` line orders pounds. Line total
   = quantity × the printed price on that unit (the line `source_line_id`
   names), so the total matches what the vendor will bill; catch-weight lines are estimates at nominal weight, and say so.
6. **Draft one order email per vendor** (Drafts).
7. **Report** (below), then show the drafts.

After the chef sends: the vendor's confirmation is an **order
confirmation** — invoice intake records it as `ordered`, never `received`.
Only the delivery invoice is what was paid.

## Drafts

Every draft is shown as **To / Subject / Body**, plain text, signed with the
chef's name if known, never with the AI's. One per vendor, never a combined
email.

**Quote request** (a purveyor's stale prices):

```
To: <rep_email>
Subject: Prices for <weekday, date> delivery — <restaurant>
Body:
Hi <rep_name>,
Could you send today's prices for these, for delivery <weekday, date>?
  <item_code> <description> (<pack>) — last <$price> <unit> on <date>
  …
And let me know if anything's short. Order goes in by <the earlier of their
cutoff and when the chef wants to decide>.
Thanks, <chef>
```

**Order** (one per vendor, from the chef's quantities):

```
To: <rep_email>
Subject: Order for <weekday, date> delivery — <restaurant>
Body:
Hi <rep_name>,
Please deliver <weekday, date>:
  <qty> <CS|EA|LB>  <item_code>  <description> (<pack>)  @ <$price> — <quoted <date> | last paid <date> | to confirm>
  …
Expected total about <$total>. Please confirm, and flag any substitutions
or shorts before you load.
Thanks, <chef>
```

## Report

In this order, every number with its source:

1. **What to order where** — per vendor: lines (qty, item, price, source and
   age), basket total, minimum (met / short by $X), cutoff and delivery day.
2. **Total** across vendors.
3. **Savings against the usual vendor** — per line where the pick differs from
   the usual vendor: (usual vendor's price − picked price) × quantity in the
   ingredient's unit, both prices fresh. For an ingredient broken down before
   use picked on usable cost, the saving is on the usable meat: (usual's
   usable cost − picked usable cost) × the quantity × the picked vendor's
   usual yield, and both the raw and the usable prices are shown. Usual vendor stale → "can't say
   until <vendor> confirms", never a number. Then the total saved.
4. **Still stale** — every item whose price is not fresh: vendor, last price,
   `age_days` against its freshness limit, and what was asked (quote request
   drafted / export requested).
5. **Every price's source and age** — a table: ingredient, vendor, price per
   unit (and, for an ingredient broken down before use, its usual yield and
   cost per usable unit), `source` + `source_kind` (paid on invoice, order guide, price sheet,
   quote), `as_of`, `age_days` against `max_age_days`, fresh or stale. No price appears anywhere in
   the report without its source and age.
6. **Not ordered** — menu ingredients with no quantity from the chef, and
   unpriced ones (what fixes each).

Name any vendor whose `kind` was written this run. Close with one line:
drafts ready, nothing sent, recipe costs unchanged.
