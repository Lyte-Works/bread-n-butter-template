# US Foods

Learned from orders #949308 (Hearth Food Garden, 2023-06-26, 19 lines, $1,252.07)
and #930383 (2023-06-15, 21 lines, $2,181.62).

## Document types

- **"Online Order Submitted" email** (from `subscriptions@makeit.usfoods.com`,
  subject `<CUSTOMER> (<cust #>) - Online Order Submitted - Order Total $X`).
  This is an **order confirmation** → `invoice_status: ordered`. It shows what
  was ordered and reserved, not what was delivered.
- A delivery invoice (with driver/received signature, catch weights, shorts)
  has not been seen yet — when one arrives, extend this file.

## Header → Invoices

| On the paper | Lyte |
|---|---|
| `Order #:` | `invoice_no` |
| Email sent date / order date | `invoice_date` |
| `Expected Delivery Date:` (fallback `Requested Delivery Date:`) | `delivery_date` |
| `Total Extended Price:` (also in the subject line) | `invoice_total` |
| `Total Line Items:` | the line count to reconcile against |
| `Order Status: Submitted` | → `ordered` |

Vendor is always `US Foods`.

## Line grammar

```
#<code> - <DESCRIPTION>(<pack>) | <BRAND>          Extended Price:
Ordered Full/Part: <c>/<e>   Reserved Full / Part: <c>/<e>   $<case> CS / $<each> EA      $<extended>
```

- `#<code>` → `item_code` (drop the `#`).
- Description runs up to the `(`; the pack is inside the parentheses; the
  brand follows `|`. The description and brand often wrap onto a second line —
  join them. The extended price can sit on either line, and `$X EA` can wrap
  (`$126.59 CS / $126.59` then `EA` alone).
- `Ordered Full/Part: c/e` — `c` full cases, `e` eaches (split packs).
  `2/0` → `quantity 2, unit CS`. `0/1` → `quantity 1, unit EA`.
- `$X CS` is the case price, `$Y EA` the split price. Prices may print with one
  decimal (`$74.3`) — store as numbers.
- `unit_price` = X on a CS line, Y on an EA line. Check `quantity × unit_price
  = extended`.

## Split pricing

EA is the price of one inner pack bought alone, marked up over case ÷ count.
Seen: 1.5× (arugula 2/2 LB, garlic 4/5 LB, kosher salt 9/3 LB),
1.15× (shallots 4/5 LB), 1.5× (pepperoni 2/5 LB), 1.45× (honey 6/5 LB),
1.45× (tortillas 10/12 EA), 1.35× (grated parmesan 4/5 LB),
1.2× (blackberries 12/.5 PT), 1.1× (scallions 4/2 LB). Single-pack cases show
EA = CS.

## Description tokens

- Storage: `REF` → refrigerated · `FROZEN` → frozen · `SHELF STABLE` / `SS` /
  `DRY` → dry (but "DRY BAG REF" on grated parmesan is refrigerated — REF wins).
- Containers: `BAG`, `BOX`, `JUG`, `TUB`, `CN` (can), `RL` (roll),
  `PACKET`, `STICK`, `BAG-IN-BOX`, `LOG`.
- `PACKER` as brand = generic / packer's label.
- `#10 CN` = a #10 can (≈ 6–7 lb); keep `#10 can` as the each unit.
- Leading word is the product family, reversed: `CHEESE, PARMESAN SHAVED` →
  ingredient name "Parmesan, Shaved"; `ONION, GREEN … SCALLION` → "Scallions, Trimmed".

## Traps hit

- A plain PDF read of the email returned no text; layout-mode text
  extraction gave every line cleanly.
- Mozzarella `LOG IN BRINE 11.45 OZ … (5 LB)` — the real each is the 11.45 oz
  log (7 per 5 lb), not the 5 lb pack.
- **Catch weight priced per pound.** Chèvre log `(3/2.2-2.2#A)` printed
  `$9.2 CS / $9.2 EA` with 2 cases extended at $121.44: $9.20 is per **lb**
  (2 × 3 × 2.2 lb = 13.2 lb × $9.20). When quantity × price ≠ extended and
  the pack is in pounds (`#A` = average pounds), divide extended by the
  price: a whole number of pounds that matches the pack means per-lb
  pricing. Write `unit_price` = extended ÷ cases ($60.72) and park a
  `reconcile` decision for the delivered weight. `PR` (random weight) on
  chicken breast is the same family — costed at nominal weight.
- **An order confirmation sets no price** while its status is `ordered`
  (migration 0008). When the owner confirms the goods arrived — or the order
  is plainly in the past — write `received` and say so in a decision.
