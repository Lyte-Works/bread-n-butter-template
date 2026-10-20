# Doors & planes — how to reach this field's own data

Field-owned orientation, shipped and kept current by the "Lyteworks updates" PR
(alongside `.lyte/mcp-manifest.md`). It answers one question with zero
introspection: **where does my field's data live, which door reaches it, and how
do I read the structure laid over it?** Read it before reaching for a raw
database connection — most of the time you don't need one.

This doc is stable canon: the doors and planes are the same for every field, so
there is no `## Field Extension` here. What differs field to field — which
tables exist — is the field's own generated table catalog (`workers/stack.md`
the generated catalog `.lyte/deliverables/report/db-catalog.md`), not here. What *else* differs field to field — which prisms and rays
exist — is read live, never filed (§Reading the structure live below).

## The two planes

A field's data lives in **two** places, and conflating them is the usual
confusion:

1. **`public` — the product plane.** The field's own outward-facing data: a
   storefront's products, a research field's papers, whatever an external site
   or app reads directly. Crystallized source tables live here too. This is the
   plane a field's *own* application code talks to.
2. **The control plane — a per-field schema named `lyte_<slug>`.** The
   framework's own rows: the Task Board (`tasks`), Documents, Lanes, and the
   prisms / rays / lytes / ray_entry registry that back the dashboard. This is
   "the folder for this field" — its board and structure, kept out of `public`
   so it never collides with product data.

**The schema name is READ, never computed.** It is stored on the field record
(`fields.schema_name`; a BYO field reads it from
`connected_accounts.metadata.schema`). Do not assume `lyte_<slug>` — HQ's is
`lyte_lyteworks`, others vary, and a hand-computed name silently misses. The
runtime resolves the right plane for you (`resolveFieldDb`); the doors below
inherit that resolution.

**Own-project (BYO) vs shared (hosted).** A field on its **own** Supabase
project puts product data in `public` and its framework plane in
`lyte_<slug>` — the tables may exist ONLY in that per-field schema, with no
`public` copy. A **hosted** field shares the platform project; its control
plane is still its own `lyte_<slug>` schema, scoped by a `field_id` column.
Either way the plane is the field's own — the difference is only which database
it sits in. On a BYO field the owner admits their own `public` tables as ray
sources from Settings → Connections (the data-plane connection's Manage panel →
Tables), picking the columns the dashboard may read and write; on a hosted
field that admission stays a reviewed migration. The field's AI can LIST what
is admitted and UNREGISTER a table no active ray names (`list_source_tables`,
`unregister_source_table` on the field MCP, surface 1.18.0); only the OWNER
registers, because admitting a table widens what every session can read while a
withdrawal only narrows.

## The three doors

| Door | What it is | Reaches | Who holds it |
| --- | --- | --- | --- |
| **1 — Field MCP entry tools** | `list_prisms` / `list_rays` / `list_entries` / `get_entry` / `create_entry` / `update_entry` on the field connector | The field's own board — JSONB (`ray_entry`) rays **and** source-table rays (Task Board, Documents, Lanes), read and write. Contract-bounded, field-scoped, audited. | **Every** session with the field connector |
| **2 — Field `supabase` connection** | `supabase__request` (PostgREST) through the broker | Any table in the field's database, at the SQL level. Reaching a non-`public` schema needs a schema profile: `supabase__request({ method, path, schema: "lyte_<slug>" })` (sets `Accept-Profile` / `Content-Profile`). Brokered, policy-fenced, audited. | **Admin only** |
| **3 — Account-level management connection** | The broad Supabase / management connection reaching every project and schema | Everything, everywhere — ungoverned, not field-scoped, not brokered. | Break-glass; avoid |

### Which door to use

- **Reading or editing your own board (tasks, docs, lanes, any ray):** Door 1.
  It is the clean door — it resolves the right plane for you, respects the
  ray's contract (mapped columns plus your own custom "dark" lytes via the
  sidecar), and is audited in `field_mcp_calls`. You almost never need more.
- **Admin, ad-hoc SQL against your own database:** Door 2, with the `schema`
  profile when the rows live in the control plane. Audited in `broker_calls`.
- **Door 3 is not the answer.** It is the ungoverned account-level connection —
  it works across every field precisely because it is scoped to none. If you
  find yourself reaching for it to see your own Task Board, that's the bug:
  use Door 1. Door 3 is for platform administration, not field work.

## Reading the structure live

Which prisms and rays this field has is **read, not looked up.** A field's
structure changes as people build it, so a checked-in list of it is stale the
day after it is written. Three Door-1 calls answer it, in this order:
**`list_prisms`** (the field's top-level surfaces) → **`list_rays`** (the tables
inside them — optionally `{ prism_id }`) → **`get_ray({ ray_id })`** (one ray's
lytes: `key`, `label`, `type`, `options`). A ray with `prism_id: null` is real
but unpinned — it reads and writes, it just has no home surface.

**`source_table` — a name or `null`.** This is the one distinction worth
knowing. A name (`tasks`, `documents`, `lanes`) means a **source-table ray**: it
projects a real, typed table whose columns are fixed by a participation contract
and catalogued in `.lyte/deliverables/report/db-catalog.md`. `null` means a **JSONB ray**
(`ray_entry`) — flexible entries the ray defines itself, schema-light, good for
a list a field shapes on the fly. Both read and write through the same Door-1
entry tools, so the distinction tells you what you are looking at, not which
call to make.

**`source_filter` — the lens.** A scalar equality that narrows one table to a
slice, which is how one table backs several rays that each look like their own
thing (`documents` → Notes `{type: "note"}`, Reports `{type: "report"}`, Specs
`{type: "spec"}`). A row created *through* a lens is born matching it, and the
lens wins over a conflicting value; `{}` means the ray shows the whole table.

**Dark lytes.** On a source-table ray a lyte usually maps to a real column
(`source_column`), and the contract bounds which of those a write may set. A
field can also add lytes that map to **no** column — they ride a JSONB sidecar
on the row, which is how a field extends a crystallized table with its own
fields without a migration. Reading and writing go through the same entry tools;
the sidecar is invisible from outside.

## What this field takes from HQ

`.lyte/field.json` is this repo's own file. Beside the field identity it carries
three keys that decide how much of the Lyteworks framework this repo receives
and on whose say-so it lands. They are read **from this repo**, at delivery
time, by the channel that opens the standing `lyte/updates` pull request — so
you change your mind by editing this file and merging, and the next delivery
obeys it. Nothing else has to happen.

| Key | Values | What it means |
| --- | --- | --- |
| `framework` | `"mcp"` \| `"loop"` \| `"full"` | How much of the framework arrives. `loop` is the default and the product. |
| `guides` | `["coding-guide", …]` | The guide set you want, by filename stem. Absent or empty = all of them. |
| `auto_merge` | `true` | Let a canon-only delivery merge itself. Absent = it waits for a human here. |

**The three framework levels.**

- **`mcp`** — the door and nothing in the repo. You receive `.lyte/mcp-manifest.md`
  (which names your MCP) and this file. Nothing under `workers/`, `.lyte/hooks/`
  or `.claude/` is ever written. Choose it when the repo is your own codebase and
  the MCP is all you want from Lyte Works.
- **`loop`** — the essentials, and what a new field is born with. The memory loop
  (`.lyte/memory/`, the four hooks, the keeper's sync), the entry point, the
  roster files, the primordials, orientation (`.lyte/codebase-map.md`,
  `workers/stack.md`, this file) and the guides.
- **`full`** — everything HQ has, which is what every field received before this
  setting existed: the above plus the spectrum role library, connection-tied
  skills, the protocols that assume a scheduled cadence, the enforcement hooks
  and the table-catalog scripts.

**Taking less never deletes anything.** A level you move *down* to stops new
deliveries of what it excludes; the files you already have stay, and keep
getting their universal bodies refreshed, exactly as the role library has worked
since 2026-09-15. Deleting is a separate, named act on HQ's side, and only ever
of a file HQ itself retired.

**Every one of these settings fails OPEN.** If this file is missing, unreadable,
or carries a value the channel does not recognize, you receive what you received
before — never nothing. The field whose settings cannot be read is exactly the
field that would otherwise silently receive an empty framework.

**`auto_merge` decides when, not what.** Canon is reviewed at HQ before it is
canon; this key decides only whether the standing pull request lands here on its
own once everything in it is canon. A delivery carrying anything else — a
database migration, a deploy workflow, a file you pushed onto the branch
yourself — waits for a person regardless, and always has.

## The short version

Your board is a Door-1 call away: `list_prisms` → `list_rays` → `get_ray` tells
you live what this field is made of, then `list_entries` / `create_entry` /
`update_entry` reach the rows. Don't keep a copy of any of that in a file — it
moves; read it when you need it. If a tool says a ray is empty when you know it
isn't, or a write 400s, it's a seam — say so; don't route around it through a
raw database connection. The whole point of the doors is that a field reaches
its own data through a governed, audited path, and never has to hold the keys
to the whole platform to do it.
