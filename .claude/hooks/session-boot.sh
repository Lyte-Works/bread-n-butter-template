#!/bin/bash
# IS: The SessionStart hook — boots the ASSISTANT (prints its context.md, the
#     always-on layer every session starts from) and computes the session's
#     boot preconditions (git self-heal, repo-mode probe, boot facts). Whatever
#     it prints to stdout, Claude Code adds to the session's context.
# IS NOT: Role boot — a role's context.md is read (or printed by the role hook)
#     when the work calls for that role.
#
# Bread 'n' Butter's copy, kept in this repo: the template carries it, and
# .lyte/field.json's "framework": "mcp" means the platform's updates never
# write it.
#
# Inputs:
#   stdin            — the SessionStart JSON; its `source` (startup | resume |
#                      clear | compact) decides whether the checkout may be
#                      reset (`resume` never is, so a resumed session isn't
#                      wiped mid-task). Parsed without jq; a miss = startup.
#   LYTE_REPO_ROOT   — optional repo-root override; defaults to two levels
#                      above this script (.claude/hooks/ → repo root).
# Outputs:
#   stdout — the assistant context and the "## Boot facts" block, or NOTHING
#            when all is clear.
#   exit 0 always (fail-soft: boot facts must never block a session).
#
# The framework used to ask the model to check synthesis flags, and
# boot-sequence.md asks each worker to notice stale context files.
# Those are computable facts being delegated to model discipline — which
# degrades exactly when context is long or the task is engaging. This hook
# makes them deterministic: the model reads a report instead of remembering
# to run checks.
#
# It also (1) self-heals the checkout so stranded commits can't accumulate and
# (2) probes repo-mode (is `main` branch-protected?) so the session knows
# whether to route file-writes through branches and PRs.

SESSION_INPUT="$(cat 2>/dev/null || true)"
SOURCE="$(printf '%s' "$SESSION_INPUT" \
  | grep -o '"source"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')"
SOURCE="${SOURCE:-startup}"
REPO_ROOT="${LYTE_REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
MEMORY_DIR="$REPO_ROOT/.lyte/memory"
WORKERS_DIR="$REPO_ROOT/workers"
# Standalone-line flags only — see keeper lesson flag-self-reference-trap.
FLAG_REGEX='^[[:space:]]*<!-- keeper-synthesis-needed -->[[:space:]]*$'

# --- Item 1: keep the checkout current (mode-safe, runs before any fact check) ---
# Push-first disambiguates the two repo modes with one code path, no per-mode
# variant:
#   basic mode:     push succeeds -> local commits reach origin -> ff is a no-op.
#   protected mode: push rejected -> local commits are an unpushable strand ->
#                   ff fails -> hard-reset to origin (the assistant's `main` is a
#                   MIRROR of origin; real work lives in lanes/PRs).
# main-only (never clobber a deliberately checked-out branch); fail-soft
# (|| true — a network hiccup never blocks the session); reset skipped on
# `resume` so an in-progress resumed session isn't wiped.
if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ "$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ]; then
    git -C "$REPO_ROOT" fetch origin --quiet 2>/dev/null || true
    git -C "$REPO_ROOT" push origin main --quiet 2>/dev/null || true
    if ! git -C "$REPO_ROOT" merge --ff-only origin/main -q 2>/dev/null; then
      if [ "$SOURCE" != "resume" ]; then
        git -C "$REPO_ROOT" reset --hard origin/main -q 2>/dev/null || true
      fi
    fi
  fi
fi

# --- Item 2: repo-mode awareness (is `main` branch-protected?) ---
# Probe GitHub's branch-protection endpoint. gh substitutes {owner}/{repo} from
# the current repo's git remote. 200 => protected; a clean 404 ("Branch not
# protected" / "Not Found") => basic; anything ambiguous (no gh, no auth,
# network, rate-limit) => treat as PROTECTED (fail toward PR-safety, never
# toward stranding commits). Only PROTECTED emits a note; basic stays silent.
REPO_PROTECTED=0
if command -v gh >/dev/null 2>&1; then
  GH_OUT="$(gh api "repos/{owner}/{repo}/branches/main/protection" 2>&1)"
  GH_RC=$?
  if [ "$GH_RC" -eq 0 ]; then
    REPO_PROTECTED=1
  elif printf '%s' "$GH_OUT" | grep -qiE 'branch not protected|not found|http 404'; then
    REPO_PROTECTED=0
  else
    REPO_PROTECTED=1
  fi
fi

# --- Boot facts: synthesis flags + stale/over-cap worker contexts ---
flags=""
stale=""
overcap=""
now="$(date +%s)"
if [ -d "$MEMORY_DIR" ]; then
  while IFS= read -r file; do
    if grep -Eq "$FLAG_REGEX" "$file" 2>/dev/null; then
      flags+="$(basename "$(dirname "$file")") "
    fi
  done < <(find "$MEMORY_DIR" -name knowledge.md -type f 2>/dev/null)

  for ctx in "$MEMORY_DIR"/*/context.md; do
    [ -f "$ctx" ] || continue
    worker="$(basename "$(dirname "$ctx")")"
    def="$(find "$WORKERS_DIR" -name "$worker.md" -not -path "*/node_modules/*" 2>/dev/null | head -1)"
    # Use git commit times, not filesystem mtimes. `git checkout` stamps every
    # file with the checkout time — and writes the role .md a beat after the
    # context .md — so an mtime `-nt` test marks EVERY worker "def-changed" on a
    # fresh clone, and the skip-boot path never engaged. Commit times reflect
    # real edit history and survive checkout. Fall back to mtime only when a
    # file isn't tracked yet (a brand-new, uncommitted context.md).
    # Full Boot is retired (2026-09-09): a role's identity is a block
    # keeper-sync regenerates INSIDE context.md from the role file, so a
    # role-file edit lands on the next sync and no age or def-changed trigger
    # is needed. What still needs a hand: a memory dir whose context.md is
    # missing AND has no role file for keeper-sync to seed from.
    if [ -z "$def" ] && [ "$worker" != "assistant" ]; then
      stale+="$worker(no role file) "
    fi
    lines=$(wc -l < "$ctx" | tr -d ' ')
    cap=300; [ "$worker" = "assistant" ] && cap=120
    if [ "$lines" -gt "$cap" ]; then
      overcap+="$worker($lines/$cap) "
    fi
  done
fi

# --- The assistant boots first: print its context (the always-on layer) ---
# One assistant, many roles (AGENTS.md is the only entry point). The
# assistant's context.md is the restaurant's standing orientation — field state, stack, roster, active work,
# connections — and every session starts from it, before any role is
# dispatched. It is INJECTED here rather than left to model discipline for
# the same reason the boot facts are: a computable "read this first" degrades
# exactly when the task is engaging. Kept short by keeper-sync's 120-line cap;
# a role's own context.md is still pulled by the role when dispatched (the
# guide-read gate treats the assistant context as not-a-role on purpose).
# A LANE is never the assistant: it boots a role, its prompt already carries
# that role's context, and this block would spend ~4 KB of its first request on
# an orientation it must not adopt. LANE_ID is the lane env every lane turn
# carries (lane-report.cjs reads the same wiring).
# The boot FACTS below still print — repo mode and the synthesis flags matter to
# a lane as much as to anyone.
ASSISTANT_CTX="$MEMORY_DIR/assistant/context.md"
[ -n "${LANE_ID:-}" ] && ASSISTANT_CTX=""
assistant_ctx=""
if [ -n "$ASSISTANT_CTX" ] && [ -f "$ASSISTANT_CTX" ]; then
  # Everything before the generated lessons index — the index is served by
  # memory-recall per prompt, so it never rides the boot payload.
  assistant_ctx="$(awk '/^## Lessons Available/{exit} {print}' "$ASSISTANT_CTX" 2>/dev/null)"
fi

# --- Boot facts: this restaurant's MCP (from the manifest + .lyte/field.json) ---
# A restaurant has ONE door: its field MCP. The manifest is a pointer to that
# URL; read as the FIRST `https://…/mcp` in the file. When the URL still
# carries the template's `<slug>` placeholder, the slug in .lyte/field.json
# fills it; when neither knows the restaurant (a repo before its hand-off), the
# boot fact says so instead of printing a URL that goes nowhere.
mcp=""
MCP_MANIFEST="$REPO_ROOT/.lyte/mcp-manifest.md"
if [ -f "$MCP_MANIFEST" ]; then
  mcp="$(grep -oE 'https://[^[:space:]]+/mcp' "$MCP_MANIFEST" 2>/dev/null | head -1)"
fi
FIELD_JSON="$REPO_ROOT/.lyte/field.json"
field_slug=""
if [ -f "$FIELD_JSON" ]; then
  field_slug="$(grep -oE '"slug"[[:space:]]*:[[:space:]]*"[a-z0-9][a-z0-9-]*"' "$FIELD_JSON" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
fi
not_handed_off=""
case "$mcp" in
  *'<slug>'*)
    if [ -n "$field_slug" ]; then mcp="${mcp//<slug>/$field_slug}"; else mcp=""; not_handed_off=1; fi ;;
esac
# The table ids: blank until the hand-off fills them.
IDS_FILE="$REPO_ROOT/workers/skills/_shared/food-costs-ids.json"
if [ -f "$IDS_FILE" ] && grep -qE '"recipes"[[:space:]]*:[[:space:]]*""' "$IDS_FILE" 2>/dev/null; then not_handed_off=1; fi

# --- Boot facts: stale lesson anchors (keeper-sync DETECT report) ---
# Count of lessons whose `touches:` path anchors no longer resolve — a Keeper
# review cue (update, retire, or mark the anchor deliberate), surfaced here so
# it isn't only visible to whoever reads the report file.
stale_lessons=0
STALE_REPORT="$MEMORY_DIR/stale-report.md"
if [ -f "$STALE_REPORT" ]; then
  # grep -c prints the count even when it exits 1 (zero matches) — an
  # `|| echo 0` here doubled the value into "0\n0" and broke the -gt test.
  stale_lessons=$(grep -c '^- ' "$STALE_REPORT" 2>/dev/null)
  [ -n "$stale_lessons" ] || stale_lessons=0
fi

# --- Boot facts: live field connections (runtime sessions only) ---
# On a field runtime every session carries FIELD_ID + FIELD_SERVICE_TOKEN, and
# the broker's alias catalog (GET /api/fields/by-id/{id}/broker/aliases) is the
# model-facing list of what this field's AI may CALL. Print it at boot so a
# session starts with the current dashboard connections in front of it rather
# than trusting a tool list cached at MCP connect time (a connection added on
# the dashboard mid-session is otherwise invisible until reconnect). Off the
# runtime (no token in env) this prints nothing — the field MCP's connect-time
# announcement covers those sessions. Fail-soft: 5s cap, any error → silent.
conns=""
if [ -n "${FIELD_ID:-}" ] && [ -n "${FIELD_SERVICE_TOKEN:-}" ] && command -v curl >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  APP_BASE="${APP_URL:-${LYTE_API_BASE:-https://app.lyte.works}}"
  APP_BASE="${APP_BASE%/}"
  conns_json="$(curl -sS -m 5 -H "x-field-token: ${FIELD_SERVICE_TOKEN}" "${APP_BASE}/api/fields/by-id/${FIELD_ID}/broker/aliases" 2>/dev/null || true)"
  if [ -n "$conns_json" ]; then
    conns="$(printf '%s' "$conns_json" | node -e '
      let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
        try {
          const rows = (JSON.parse(d).connections || []).filter(r => r && r.alias);
          process.stdout.write(rows.map(r => r.alias + " (" + r.provider + (r.status && r.status !== "active" ? ", " + r.status : "") + ")" + (r.scope_summary ? " — " + r.scope_summary : "")).join("; "));
        } catch { /* not the catalog — stay silent */ }
      });' 2>/dev/null || true)"
  fi
fi

# Nothing to report on any axis — stay silent.
[ "$REPO_PROTECTED" -eq 0 ] && [ -z "$flags" ] && [ -z "$stale" ] && [ -z "$overcap" ] && [ -z "$mcp" ] && [ -z "$conns" ] && [ "$stale_lessons" -eq 0 ] && [ -z "$assistant_ctx" ] && [ -z "$not_handed_off" ] && exit 0

# THE BYTE BUDGET (2026-10-15). Claude Code hands the model a hook's stdout
# inline only up to 10,000 bytes; past that the model gets a 2 KB preview and a
# path — the Read this print exists to save. The boot facts always print in
# full; the assistant context gets what is left of BUDGET_BYTES, dropping its
# generated `## Recent` block first and cutting the rest only when it must,
# with a line saying where the remainder is. HTML comments are notes to the
# Keeper, not orientation, and never print.
BUDGET_BYTES="${LYTE_HOOK_BUDGET:-9500}"
boot_facts() {
  echo "## Boot facts (computed by session-boot hook)"
  [ -n "$conns" ] && echo "- Field connections (live from the broker, callable as \`<alias>__request\` / \`<alias>__<tool>\` on the field MCP; each shows the scope its policy allows): ${conns}. This list is read fresh at boot; a connection added on the dashboard mid-session is not pushed to an open MCP connection — call \`list_connections\` before saying a service is unavailable."
  [ -n "$not_handed_off" ] && echo "- NOT HANDED OFF YET: \`.lyte/field.json\` has no slug and/or \`workers/skills/_shared/food-costs-ids.json\` has blank ids — this repo does not know its restaurant. The skills, the write checker and both jobs refuse to run until the new-restaurant hand-off fills them; do not invent ids or a slug."
  [ -n "$mcp" ] && echo "- Field MCP: ${mcp} — this restaurant's one door (per .lyte/mcp-manifest.md). Everything the restaurant can reach is a tool on it; \`list_connections\` is the live list."
  [ -n "$mcp" ] && echo "- Documents go to THAT dashboard, as you write them: \`deliver_document\` on the field MCP (\`type\` = the .lyte/deliverables/<type>/ folder; first call creates, \`append: true\` adds each section). The repo file is optional and converges on the same row."
  [ -n "$mcp" ] && echo "- Open work is ASKED FOR, never grepped: \`list_entries\` on the Task Board (\`rays.task_board\` in workers/skills/_shared/food-costs-ids.json) — parked decisions carry \`human_needed\` true; the dashboard row is the record."
  [ "$REPO_PROTECTED" -eq 1 ] && echo "- Repo mode: PROTECTED — \`main\` requires a branch + PR. Do NOT write to the main checkout directly; route file-creating work through lanes (they branch + PR). Direct writes here strand and can't sync."
  [ -n "$flags" ] && echo "- Synthesis flags pending: ${flags% } — Keeper judgment work, answered one of two ways: become the Keeper in a session (/dispatch keeper), or brief a keeper lane with the synthesis protocol AND its done-conditions (raw entries archived verbatim, lessons promoted or extended with their index lines, flag dropped, two keeper-sync runs converging). A lane briefed with nothing but the role name writes a stray report and never clears the flag — boot-sequence.md §3, Synthesis."
  [ -n "$stale" ] && echo "- Memory dirs with no role file to seed from: ${stale% } — keeper-sync cannot generate their Identity block; add the role file or retire the dir."
  [ -n "$overcap" ] && echo "- context.md over its soft cap (lines/cap): ${overcap% } — Keeper should prune before other work."
  [ "$stale_lessons" -gt 0 ] && echo "- Stale anchors: ${stale_lessons} lesson(s) or context claim(s) reference artifacts that no longer exist — see .lyte/memory/stale-report.md. Keeper review cue: fix the claim, update or retire the lesson, or mark the anchor deliberate."
}

FACTS="$(boot_facts)"
if [ -n "$assistant_ctx" ]; then
  HEAD="## Assistant context (.lyte/memory/assistant/context.md — you are booted as the assistant; become a role for role work)"
  assistant_ctx="$(printf '%s\n' "$assistant_ctx" | awk 'BEGIN{c=0} /<!--/{c=1} {if(!c) print} /-->/{c=0}' | cat -s)"
  room=$(( BUDGET_BYTES - ${#HEAD} - $(printf '%s' "$FACTS" | wc -c) - 8 ))
  if [ "$(printf '%s' "$assistant_ctx" | wc -c)" -gt "$room" ]; then
    assistant_ctx="$(printf '%s\n' "$assistant_ctx" | awk '/^## /{skip=($0 ~ /^## Recent/)} !skip')"
  fi
  if [ "$(printf '%s' "$assistant_ctx" | wc -c)" -gt "$room" ]; then
    TAIL="…cut to fit the hook budget — read .lyte/memory/assistant/context.md for the rest."
    assistant_ctx="$(printf '%s' "$assistant_ctx" | head -c $(( room - ${#TAIL} - 4 )) | sed '$d')"
    assistant_ctx="$assistant_ctx"$'\n\n'"$TAIL"
  fi
  echo "$HEAD"
  echo ""
  printf '%s\n' "$assistant_ctx"
  echo ""
fi

printf '%s\n' "$FACTS"
exit 0
