---
description: Writing the unit on a recipe component line
triggers: recipe component unit, unit mismatch, each_weight, density, sub-recipe yield unit, write components
rule: Write each component's unit in its source's unit (the ingredient's base unit, or the sub-recipe's yield_unit) and stop if they differ, because a mismatch needs each_weight or density and a silent guess makes wrong costs.
tags: [recipes, units]
worker: recipe-entry
---

Each component points at exactly one ingredient or one sub-recipe. line_cost = quantity x unit_cost, where unit_cost is the ingredient's last cost or the sub-recipe's cost_per_yield_unit. That multiplication is only valid when the component unit equals the source unit. In the mock build all 20 lines matched with no conversion; anything needing conversion should be raised, not coerced.
