# architect — Journal

<!-- Dated raw entries, newest last: ## YYYY-MM-DD — Title, opening with the trace line (workers/boot-sequence.md §3). The Keeper synthesizes. -->

## 2026-10-21 — The template moved to the restaurant MCP
<!-- trace | task: rebuild lane E (bread-n-butter PR #69) in the template | status: PR open (Lyte-Works/bread-n-butter-template#2) | skills: none invoked (invoice-intake, recipe-entry, menu-import, recipe-costing copied in) | tools: Bash, git, keeper-sync | notes: logged by the backend-developer lane that edited this role's files -->

The design this role works on changed under it. The restaurant's data is now reached only through its own Bread 'n' Butter MCP (`.mcp.json` → `restaurant`; verbs list_tables · list_rows · get_row · create_row · update_row · recipe_cost · list_connections · call_service). Costs are database views computed on read, so the re-cost job, its scripts and the ids file are gone. A human gate is parked as a `decisions` row, not on the Task Board. A new table is a migration in the app's restaurant schema, never a key in a file here. This role's quality gate and principles were updated to match, and the Lyte-only `add-lytes` lesson was retired.
