---
description: Building mock recipes on a field whose ingredient registry is born from invoices
triggers: mock recipes, build recipes, menu items, recipe builder, ingredient registry, missing ingredient
rule: Build recipes only from ingredients that already exist with a cost, and name dishes for what the ingredients really make, because inventing ingredients or costs breaks the traceable rollup.
tags: [recipes, ingredients]
worker: recipe-entry
---

The registry was invoice-born (18 items from one US Foods invoice, 2023 prices), with no dough, sauce, lemon or tahini, so pizza and true hummus were out and the spread was named for what it is. Partial ingredient lists make food cost % low overall; say so rather than tune it. Menu recipe rows carry total_cost, cost_per_yield_unit and food_cost_pct; every number must be re-readable from live rows.
