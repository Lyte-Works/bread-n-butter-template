---
description: Any change to an ingredient cost, recipe quantity, yield or menu price leaves copied numbers stale
triggers: recost, re-cost, last cost changed, new invoice, cost_math, unit_cost, line_cost, food cost percent, cost history, sub-recipe cost
rule: After any cost, quantity, yield or price change, re-cost every affected recipe sub-recipes first (use the recipe-costing skill) and rewrite unit_cost, line_cost, cost_math and name together, because every cost on a component is a copy made at write time.
tags: [costing, recipes]
touches: [workers/skills/recipe-costing/recost.cjs, workers/skills/recipe-costing/SKILL.md, workers/skills/invoice-intake/hooks/check-write.cjs]
worker: recipe-costing
---

Component unit_cost is copied from the source at write time, so it goes stale when an ingredient's last cost moves or a sub-recipe's cost changes. Cascade order is topological over sub_recipe_id (garlic, then confit, then spread, then wrap in the mock set).

cost_math is a text stand-in for a formula field (no formula lyte type exists); it shows the working per line and must be rewritten in the same pass as the line cost. The check-write hook validates components, recipes and Recipe Cost History rows (qty x unit_cost, cost/yield, food cost %, alert at >30% or +2 pts).

A relation chip needs a real display_lyte on the target, which is why Recipe Components carries a `name` field.

Cost basis is last cost (operator's choice). Protein recipes read low because chicken is costed at raw purchased weight with no yield or trim loss yet.
