# Skills

*What a skill is in a restaurant repo, the two conventions every skill here keeps, and how to add one.*

A skill is a procedure the AI loads when the task matches its `description`: read an invoice, import a menu, enter a recipe, re-cost the dishes. It lives in `workers/skills/<name>/SKILL.md`; keeper-sync copies each one into `.claude/skills/<name>/SKILL.md` (step 3c) so Claude Code finds it. Never hand-edit `.claude/skills/` — the copy is regenerated on every run.

## The skills in this repo

| Skill | What it does | Hands off to |
|---|---|---|
| `menu-import` | A menu (URL, PDF, photo, POS export) → one Recipes row per dish | `recipe-entry` |
| `recipe-entry` | A recipe card, sheet or dictated build → the dish's Recipe Components | `recipe-costing` |
| `invoice-intake` | A vendor invoice → Invoices + Invoice Items, mapped to Vendor Items, ingredient costs updated | `recipe-costing` (fires the re-cost) |
| `recipe-costing` | Re-cost every recipe bottom-up and keep the cost history | — |
| `lane-brief` | The six-part brief for a dispatched worker | — |

Scripts beside them: `invoice-intake/hooks/check-write.cjs` (the write checker — re-does the arithmetic on every stored row), `recipe-costing/recost.cjs` (the calculator) and `recipe-costing/recost-job.cjs` (the headless re-cost the `recost.yml` job runs). Each has a `--self-test`.

## Convention 1 — table ids come from one file, and a blank one stops the work

Every table id lives in `workers/skills/_shared/food-costs-ids.json`, read by key (`rays.recipes`, `rays.task_board`, `workflows.recost_webhook`…). A repo born from the template has every id blank; the new-restaurant hand-off fills them. So, before the first call of any skill:

```
node workers/skills/_shared/food-costs-ids.cjs --check
```

Exit 1 means this restaurant is not handed off yet: stop, write nothing, and say which ids are missing. The scripts enforce the same thing on their own — the write checker blocks every food-costs write and the re-cost job exits 1, naming the file (`food-costs-ids.test.cjs` proves all three). Never type an id from memory or from another restaurant.

## Convention 2 — park and notify: a job never asks a person

Most skill runs are headless: the "Run a skill" job (`.github/workflows/agent-job.yml`) runs `claude -p` with nobody at the keyboard. So every human gate a skill names is **park-and-notify**, never a question:

1. **Write the pending decision as a Task Board row** (`rays.task_board` in the ids file):
   - `title` — what is needed, in the owner's words (`Confirm new vendor item: Parmesan, Shaved — 4/5 LB → 320 oz`)
   - `human_needed` true · `status` "Not started" · `priority` "high"
   - `notes` — what you found, what you propose and why, **what it blocks**, and **what clears it**
2. **Stop that line, not the run.** Everything the gate does not block still lands.
3. **Name every parked row in the report**, by title.

The owner answers the row in the app, which re-fires the job; the next run picks the decision up. Never guess past a gate to keep going — a guessed conversion or an invented ingredient is a wrong cost on every dish that uses it.

**When a person is present** (an interactive session, someone answering), the same gate is asked instead: show the proposal as a table, write after they confirm, park nothing.

## Adding a skill

1. Create `workers/skills/<name>/SKILL.md` with frontmatter `name` (= the directory), `description` (what it is for AND when to use it — this is the trigger) and `kind: procedure`.
2. Keep both conventions: ids from the ids file (add a key there, blank, if the skill needs a new table), and every human gate written as park-and-notify.
3. Run `node scripts/keeper-sync.cjs`; the `.claude/skills/<name>/` copy appears. Commit both.
