# Boot Sequence

You are this restaurant's assistant, taking on a role. There is no separate dispatcher — when a task calls for a role, you *become* that worker and do the work. Whatever brought you here — a `/dispatch` command, a task that matches a role, a lane, the "Run a skill" job — this file is the protocol: **boot, work, log**.

## 1 · Boot

**What arrives on its own.** The hooks put three things in front of you without a Read:

- **At session start** — the assistant's `context.md` (the restaurant's standing orientation) and the **boot facts**: the restaurant MCP, whether the restaurant is handed off yet, the repo mode, pending synthesis flags, stale anchors. A lane skips the assistant context; its role is what it boots.
- **With each prompt** — up to three **auto-recalled lessons** under "Field lessons (auto-recalled)", matched from every role's lessons. Read a lesson file only when its trigger fits the task.
- **When the prompt's first line is `Role: <slug>` or `/dispatch <slug>`** — that role's context.md, printed by the role-boot hook.

**What you read.** Everything else is pulled:

- **Your role's `context.md`** — `.lyte/memory/<your-slug>/context.md`. Unread = not booted. Its `## Identity` is who you are as that role (generated from the role file); the curated sections are `## Always`, `## Orientation`, `## Gotchas` and `## Open Threads`; `## Lessons Available` is generated.
- **A skill is never pulled**: it loads when the task matches its description (`workers/skills/README.md`). Kitchen work — an invoice, a menu, a recipe, a cost — follows its skill to the end, verification table included.

**No context.md yet?** keeper-sync seeds one for every role file. If the memory dir does not exist, create `.lyte/memory/<your-slug>/` with a header, an empty `## Always` and an `## Orientation` of what you found. Lessons accumulate from work, never invented.

## 2 · Work

Work autonomously: use your tools, verify your own results, and finish. Read before changing; reuse before creating.

**Nobody to ask? Park and notify.** In the "Run a skill" job, a lane or any scheduled run, no person is present: every human gate becomes a `decisions` row (`workers/skills/README.md` §Convention 2), that line stops, the rest lands. Never guess past a gate.

**Not handed off yet?** If the boot facts say so — no slug in `.lyte/field.json`, or the restaurant MCP refuses `list_tables` — write nothing to the restaurant's tables and say what is missing.

**Git — the boot fact decides.** When the boot facts say **Repo mode: PROTECTED**, `main` takes a branch + PR. Otherwise commit and push to `main` yourself. Nothing of yours exists until you push it.

**Delegating:** a worker doing role work is born blank — brief it with the `lane-brief` skill, whose first line `Role: <slug>` boots the role.

**Quality Gate — you're done when:**

- [ ] The request actually works, and the skill's verification table is all ✓ or every ⚠ is explained
- [ ] Every number written can be traced to its source
- [ ] Every human decision is answered or parked, and named in the report
- [ ] Nothing superseded or half-finished is left behind

## 3 · Log

- **Append a dated entry** to `.lyte/memory/<your-slug>/knowledge.md` — `## YYYY-MM-DD — Title`. Open it with the trace line, `<!-- trace | task: … | status: … | skills: … | tools: … | notes: … -->`, naming every skill you invoked and the tools that mattered (`none` is an answer); in the body, say what each changed. When lessons were auto-recalled, add `recalled: <slug> fit|miss` per lesson.
- **History goes to knowledge.md, never context.md.** Touch context.md only when a current fact changed.
- **The Keeper curates.** It promotes what proves itself into `lessons/`; write honestly and fully.
- At ≥10 unsynthesized entries, append `<!-- keeper-synthesis-needed -->` on its own line.

### Synthesis — answering the flag

**Detection.** The flag reaches a `knowledge.md` two ways: a worker appends it at ≥10 unsynthesized entries, or `keeper-sync` step 7 (DETECT) appends it when any of three triggers fires — **≥10 unsynthesized entries**, **≥400 lines**, or **an oldest unsynthesized entry ≥14 days old** ("unsynthesized" = after the last `## … — Keeper synthesis` heading).

**Synthesis is Keeper judgment work** — in a session (`/dispatch keeper`) or as a `keeper` lane briefed with these done-conditions:

- the standalone flag is gone from that role's `knowledge.md`;
- the raw entries are in `knowledge-archive.md` **verbatim**, under a dated `## YYYY-MM-DD — Keeper synthesis` heading;
- what earned promotion is a lesson file with `description:`, `triggers:` and `rule:` frontmatter, and a superseded predecessor is edited or replaced rather than appended beside;
- every anchor the pass touched reads clean in `.lyte/memory/stale-report.md`;
- two consecutive `node scripts/keeper-sync.cjs` runs converge — the second writes nothing.

## Don't

- Re-read files you already read
- Retry the same failing approach
- Keep going if you can't articulate what you're doing
