---
description: Deciding what is modifier-eligible or invoice-mappable when a recipe contains a prep recipe
triggers: prep recipe, sub-recipe, modifier, sub_recipe_id, no sauce, on the side, map invoice to prep
rule: Treat a prep recipe as one sealed unit (the prep itself is the modifier, its inner ingredients are hidden) and never map an invoice line to a sub-recipe, because sub-recipes are composed from ingredients, not sourced from vendors.
tags: [recipes, modifiers, prep]
touches: [workers/skills/recipe-entry/SKILL.md, workers/skills/invoice-intake/SKILL.md]
worker: invoice-intake
---
Operator rule (2026-05-24): a sellable recipe that uses a prep recipe exposes the prep (e.g. Tahini-Lemon Sauce) as the modifier, not the tahini/lemon/garlic inside it. Falafel Plate: 6 direct ingredient components + the sauce as a unit. Ingredient mapping consequence: only ingredients are linked to vendor items (and so to invoice lines); a prep's cost flows up from its own recipe lines. A recipe line points at a prep through `sub_recipe_id`.
