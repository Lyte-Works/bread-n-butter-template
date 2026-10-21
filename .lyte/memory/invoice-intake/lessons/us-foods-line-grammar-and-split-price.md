---
description: Reading a US Foods order or invoice line — pack grammar, Full/Part, and what the CS/EA prices mean
triggers: US Foods, EA price, split case, split price, case price, 0/1 line, partial case, pack 9/3 LB, split premium, upcharge
rule: Treat US Foods "$Y EA" as the vendor's split-case price (case price / pack count x a per-item upcharge), not case divided by count, and cost a full-case line at CS, because EA only applies to a partial `0/1` line.
tags: [invoices, us-foods, pricing]
touches: [workers/skills/invoice-intake/references/us-foods.md, workers/skills/invoice-intake/SKILL.md]
worker: invoice-intake
---
Line grammar: `#code - DESCRIPTION(pack) | BRAND`, then `Ordered Full/Part: c/e` and `$X CS / $Y EA`. A `0/1` line is a partial case billed at the EA price. Description tokens carry storage: REF = refrigerated, FROZEN = frozen, SHELF STABLE = dry. Pack `9/3 LB` = 9 x 3 lb.

EA is what one inner pack costs if bought alone: (CS / pack count) x upcharge, and the upcharge varies per item (observed 1.1x scallions, 1.2x blackberries, 1.35x grated parm, 1.45x tortillas, 1.5x arugula/garlic/salt). Single-pack items show EA = CS. Real cost per pack = CS / count.

Read the description for the real "each", not the parenthesised pack: mozzarella "LOG IN BRINE 11.45 OZ (5 LB)" is 7 logs x 11.45 oz. Where the vendor's EA is the whole pack (EA = CS), no split applies even if the kitchen re-breaks it.

On `invoice_lines`, `unit` is `CS` or `EA` and `unit_price` is what was paid per that unit: the CS price on a full-case line, the EA price on a `0/1` split line. The base-unit price then follows from the vendor item's `base_units_per_case` (÷ `pack_count` for an EA line). The table's current columns are read live with `list_tables`, not from here.
