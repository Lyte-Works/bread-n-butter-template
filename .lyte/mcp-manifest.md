# This field's MCP — the one door

Field-owned orientation, shipped and kept current by the "Lyteworks updates" PR
(alongside `.lyte/doors-and-planes.md`). It relays
one fact for whatever AI opens this repo: which field MCP this repo belongs to.
The repo itself makes no connections.

**Field MCP:** https://app.lyte.works/api/fields/<slug>/mcp

Connect any MCP-capable AI to that URL — sign in when the client asks, or use a
token minted on the field's Access page.

Everything this field can reach is a tool on that MCP, and `list_connections`
is the live list — call it before telling anyone a service is unavailable.

Connecting prints a capability checklist, not a paragraph: the field's name and
surface version, then one row per scope with an explicit ✓ or ✗, then the
connections this token may use and what each allows. A ✗ means THIS token was
not granted it — never that the platform cannot do it; a ✓ whose tool is
missing from your list means your host cached an older `tools/list` and the
connector needs reconnecting. The checklist is the briefing and stays short on
purpose: each tool's own description is the manual, and the long-form
orientation is this file and `.lyte/doors-and-planes.md`.

A saved view is readable as a slice: `list_views` names a ray's shared views,
and `list_entries({ ray_id, view_id })` returns exactly what the dashboard
shows under that name — filter, sort and hidden columns applied server-side.
Prefer a view over deriving the same slice by hand whenever one already
answers the question being asked.

Structure is writable through that door, not only readable: behind
`prisms:write` a session creates a prism with its rays and lytes in one call
and amends one; behind `rays:write` it adds a ray to a prism, appends lytes to
a ray, and amends one. Archive only — nothing on the MCP surface deletes a
prism, a ray or a lyte, and removing one stays a human ceremony on the
dashboard. A token minted before 2026-09-21 does not carry either scope, and a
connector attached before then will not list the tools until it is reconnected.

A ray that reads a real table needs that table ADMITTED first, and the door
tells you which are. `list_source_tables` (behind `prisms:read`) answers three
things: `registered` — every table this field has admitted, with the only
columns the reader will ever select and the only ones a write will update;
`available` — on a field with its own Supabase project, every table in its
`public` schema with each column's real name and type, so a `source_column` is
picked from what the table has rather than from memory; and `orphaned` — a
registration whose table the project no longer shows. Call it BEFORE pointing a
ray at a table: an unadmitted `source_table` fails at read time, not at create
time, so the ray looks fine and the rows never arrive. `unregister_source_table`
(behind `rays:write`) withdraws one, refused while an active ray still names it
and recorded on the Supabase connection's audit trail with the calling TOKEN as
the actor, so an owner can tell a session's cleanup from their own click.
REGISTERING is not on this surface and will not be: admitting a table widens
what every session holding this field's token can read, so it stays the owner's
tick on the Supabase row's Tables section in Settings → Connections. The AI can
list and withdraw; only the owner admits. Both tools arrived with surface 1.18.0
— a connector attached before then will not list them until it is reconnected.

Documents have one home, and it is the dashboard. A report, a spec, a plan, a
piece of research — anything written for a person to read — goes through
`deliver_document` as it is written — the first call, with `title` and the
opening section, creates it on the field's Documents rays; each next call with
`append: true` adds a section, and the open page grows in front of whoever is
reading it. `type` is the folder it would sit in
under `.lyte/deliverables/` (any word is a type), the first `# H1` is the
title, and (field, type, title) is the identity, so delivering the same title
again updates the row. Writing the same markdown into the repo at the `path`
the receipt names is optional; a push of that file converges on the same row,
never a second one. The repo is the floor (every push still mirrors the
tree), the MCP is the path — a connected session never waits for a push to
put a document in front of someone.

Media has one door too. A photo or video for a post goes through
`upload_media`: it lands in the field's storage under the field's own prefix
and the receipt carries the `url` it is served at — the URL a publisher
fetches, which is exactly what Buffer's `createPost` takes in `assets`
(`{ image: { url } }` or `{ video: { url } }`). The default bucket, `media`,
is public, so that URL is permanent; name `chat-attachments` (or a BYO bucket)
for a private object and the URL is signed and expires. A file of a few MB
rides the call as base64; omit `content` for a large video and the receipt
carries an `upload_url` to PUT the raw bytes to within two hours, after which
the same `url` serves them. Buffer itself is reached as `buffer__request`
(one GraphQL door, mutations by the connection's grant), so upload, then
create the post with the URL — two calls, no key in either. To keep the file
on a ray, give the ray a `media` lyte and write the receipt's `url` into it
(`[{ url, name, content_type }]`); the dashboard shows it as a thumbnail and
lets a person add their own uploads to the same column.

A result costs what you asked for: ask for the columns you need
(`list_entries({ columns: [...] })` returns id, title and those lytes only),
and writes return receipts — `create_entry` and `update_entry` answer with the
row's identity, not a second copy of what you just sent, unless you pass
`return_row: true`. `<alias>__request` takes `accept` for the same reason: a
text upstream can be asked for text instead of base64 inside JSON.

Maintenance: the session-boot hook prints the first `https://…/mcp` URL in this
file as its `Field MCP:` boot fact, and delivery rewrites that URL to carry the
receiving field's slug. Keep it the first URL in the file. Anything the field
itself wants to add goes under `## Field Extension`, which updates never touch.

## Repo channel (the GitHub App — infrastructure, not a connector)

Not a connection the AI calls and not a tool on the field MCP: the platform's
single `lyte-workers` GitHub App is how HQ reaches a field's repo. It mints
short-lived, repo-scoped installation tokens for git push (lanes), repo
provisioning and scaffolding, and opening the `lyte/updates` framework PR,
migration PRs and worker PRs. Capability, not credential — no session holds
the App's key; tokens are minted server-side, scoped to one repo, and expire.
It works only through pull requests on a protected `main`; it does not merge
past review on its own. A field's install state shows on the dashboard
(Connections → Repo card). Listed here so a session understands the repo
channel without mistaking it for an `<alias>__request` tool.

## Field Extension — {{FIELD_NAME}}
<!-- field-extension:unauthored -->
> Authored at onboarding by the Architect for this field. Do not ship generic.
