---
description: Turning an invoice line into an ingredient cost per base unit
triggers: last_cost, cost per unit, base unit, base_qty, cost_per_base_unit, oz fl oz each, pack breakdown, each_weight, density, map invoice line to ingredient
rule: Cost an ingredient from what was actually PAID per base unit (weight in oz, volume in fl oz, counts in each), computed as price paid / (pack_count x each_size in base units), because case-vs-split and vendor pack differences make list price misleading.
tags: [costing, ingredients, units]
touches: [workers/skills/invoice-intake/SKILL.md]
worker: invoice-intake
---
Conversions: lb x 16 = oz; L x 33.814 = fl oz; gal = 128 fl oz. Cross-unit use (weight <-> count/volume) needs `each_weight` (oz per base each) or `density`; with `each_weight_source` saying where it came from. Leave blank when the invoice does not print it (blank beats a guess) and flag it.

Operator calls that stuck: cost basis = paid (a split-bought item costs the split rate); items with no clean weight (#10 can, clamshell) are costed per pack; shaved vs grated parm and different sweeteners stay separate ingredients; supplies like foil are not ingredients and stay unlinked.

Vendor Items layer: one row per vendor product (code -> ingredient, pack breakdown, `base_units_per_case`, `base_unit`, `conversion` as readable working, `verified` checkbox operator-only). Map a product ONCE; later lines match on vendor + item code. Compute the conversion two ways before writing. Line and ingredient links exist twice (line `ingredient_id`, ingredient `invoice_items`) - write both and keep them in step.
