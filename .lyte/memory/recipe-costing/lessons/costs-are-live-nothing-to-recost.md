---
description: An ingredient price, recipe quantity, yield or menu price changed and the dish costs seem to need updating
triggers: recost, re-cost, last cost changed, new invoice, food cost percent, cost history, sub-recipe cost, stale cost, cost alert
rule: Never re-cost or write a cost: write the invoice line, recipe line, yield or menu price itself, then read the result with `recipe_cost` (or `as_of` a date for before/after), because every cost is a database view computed on read.
tags: [costing, recipes]
touches: [workers/skills/recipe-costing/SKILL.md, workers/skills/invoice-intake/SKILL.md]
worker: recipe-costing
---

An ingredient's price is `ingredient_costs` — the latest dated invoice line linked to it through its vendor item, per base unit. A recipe's cost is `recipe_costs` / `recipe_line_costs`, computed on every read through its prep recipes and its yield. Nothing stores a copy, so nothing goes stale: an invoice line written a minute ago is already in every dish above it.

So the costing work is getting the inputs right — the line linked to the right vendor item, the vendor item's `base_units_per_case`, the recipe line in the ingredient's unit or the prep's yield unit — and then explaining the result. "What moved" is `recipe_cost` today against `recipe_cost` `as_of` the day before the delivery; `cost_alerts` names dishes over 30% food cost or up 2+ points.

Cost basis is the latest price paid. Protein recipes read low until a yield or trim loss is entered, because chicken is priced at raw purchased weight.
