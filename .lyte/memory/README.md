# Restaurant Memory

This directory is the restaurant's AI memory: files in this repo, nothing phoned home.

```
.lyte/memory/
  patterns.md              what every role reads at boot (the owner's standing preferences)
  assistant/context.md     printed at every session start
  <role>/                  keeper, guide, architect, content-writer
    context.md             the role's current facts (generated blocks + four curated sections)
    knowledge.md           dated raw journal: ## YYYY-MM-DD — Title
    knowledge-archive.md   journal entries the Keeper has synthesized
    lessons/<slug>.md      lessons the Keeper promoted
  <skill>/lessons/         kitchen lessons that belong to a skill (invoice-intake, recipe-entry, recipe-costing)
  stale-report.md, dormancy-report.md, recall-report.md   written by keeper-sync step 7
```

Every restaurant starts with the kitchen lessons Bread 'n' Butter learned on its pilot — how to read a vendor's split price, what an order email is, why costs are copies that go stale, why a prep recipe is one sealed unit. The recall hook (`.claude/hooks/memory-recall.cjs`) injects a lesson's `rule:` when a prompt matches its `triggers:`.

`scripts/keeper-sync.cjs` maintains it (Node builtins only, no credentials, no network): run by the Stop hook and by hand. Synthesis is the Keeper's judgment — `workers/boot-sequence.md` §3.
