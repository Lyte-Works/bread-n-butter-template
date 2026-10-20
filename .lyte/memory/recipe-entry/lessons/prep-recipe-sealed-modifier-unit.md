---
description: Deciding whether an ingredient is a direct recipe line or lives inside a prep recipe, which also decides whether a guest can modify it
triggers: modifier, no sauce, on side, prep recipe, sub-recipe, sealed unit, falafel plate, structural ingredient
rule: Put anything a guest might say "no" or "on the side" to as a top-level component of the sellable recipe, and keep structural ingredients (flour, yeast, leavener, salt in dough) inside prep recipes, because a prep recipe is a sealed unit and only its own name is modifier-eligible.
tags: [recipes, modifiers]
touches: [workers/skills/recipe-entry/SKILL.md]
worker: recipe-entry
---

Operator rule (2026-05-24): when a sellable recipe uses a prep recipe as a component, the prep recipe itself is the modifier-eligible thing ("no sauce", "extra sauce"). Its inner ingredients are hidden by the prep boundary and can never be modifiers.

Test for a direct component: could a guest sensibly say "no X" or "X on the side"? Tomato, cucumber, pickled onion, olive-oil drizzle, herbs, pita, sauces: yes. Flour, yeast, baking soda: no, so they live inside a prep recipe.

Inverse: a sauce the operator wants guests to swap belongs as a prep recipe at the top level, not inlined as raw ingredients. Falafel Plate example: 6 direct ingredients plus Tahini-Lemon Sauce as a unit are modifier-eligible; the tahini, lemons and garlic inside the sauce are not.
