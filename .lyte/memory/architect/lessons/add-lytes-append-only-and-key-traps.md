---
description: Adding lytes or writing entries on a ray and hitting 500s, refused display keys, or stray backslashes
triggers: add_lytes, new lyte, lyte key, 500 error add_lytes, relation display_lyte, create_entry title, rename lyte, retype lyte
rule: Confirm the lyte key and type before `add_lytes` because it is append-only (no rename or retype), and retry under a different key if a bare 500 comes back, since some keys are taken by retired or reserved lytes.
tags: [lytes, rays, mcp]
touches: [workers/skills/invoice-intake/SKILL.md]
worker: architect
---
- `add_lytes` returned a bare 500 for `invoice_number` and `status` on Invoices (keys already taken); the same label under another key (`invoice_no`, `invoice_status`) worked.
- A relation's `display_lyte` must be a real lyte key; `title` is refused (400). Invoice Items got a `name` lyte for this.
- `\"` inside a `create_entry` title is stored literally; write inch marks as "in".
- The connection's live policy can differ from the session banner (cached); `list_connections` is authoritative.
- When a PDF Read returns no text, `pdftotext -layout` gives clean line-by-line output.
