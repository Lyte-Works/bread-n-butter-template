# Doors & planes — how to reach this restaurant's data

One question, answered without introspection: **where does this restaurant's
data live, and which door reaches it?**

**One plane.** The restaurant's own kitchen database, run by Bread 'n' Butter.
Its tables hold what was written (invoices and their lines, vendor items,
ingredients, recipes and their lines, decisions, invoice readings); its views
compute every price and cost on read. Nothing of it is copied into this repo.

**One door.** The restaurant's Bread 'n' Butter MCP — the `restaurant` server
in `.mcp.json`, described in `.lyte/mcp-manifest.md`. Every read and every
write goes through its verbs, authorized by the restaurant's scoped token.

**No other door.** No database address, no direct database connection, no
account-level database connector, no other restaurant's token. A refusal at
the door (401/403) means the token is missing, revoked or read-only — stop and
say so. A table or column you need that `list_tables` does not show is a change
to the app's restaurant schema, proposed to the operator — never worked around
here.

**Files.** An invoice the owner drops is stored by the app; the "Run a skill"
job receives a short-lived signed link to it and downloads it before the skill
runs. The skill never needs storage access of its own.
