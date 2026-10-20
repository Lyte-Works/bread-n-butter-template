#!/bin/bash
# IS: The Stop hook — the session loop-closer. Three passes, in order:
#       a. CURATION  — silently run the field-local mechanical keeper
#                      (scripts/keeper-sync.cjs). Nothing printed either way.
#                      Unconditional since 2026-09-25: it used to run only if
#                      the file carried a `keeper-sync:local-edition` sentinel,
#                      a guard for a second edition that does not exist (the
#                      broker edition went with the runtime-less keeper-sync,
#                      2026-09-06). Its only observed effect was the opposite
#                      of its purpose — the token was missing from the
#                      delivered script until 2026-09-15, so the pass was a
#                      silent no-op in every field. What the guard was standing
#                      in for is now checked where it can be: keeper-sync's
#                      contract test fails on any credential-shaped env read.
#       b. KNOWLEDGE — if a transcript path was provided and readable: every
#                      role BOOTED this session (its .lyte/memory/<role>/
#                      context.md read as a DIRECT TARGET) must have LOGGED (its
#                      knowledge.md touched, by any tool). The roles that did
#                      not are printed on ONE machine-readable line —
#                      `KNOWLEDGE-MISSING: <role> <role> — <message>` — so an
#                      adapter can refuse the stop until the entries exist
#                      (2026-09-25: a conversation that booted three roles and
#                      logged one used to pass; a lane never skips because its
#                      protocol ends in the log — this makes a session behave
#                      the same). Per role, not "any": the assistant is exempt
#                      (it is booted every session and does no role work).
#                      Conservative: if the transcript format defeats the
#                      grep, skip silently rather than false-positive.
#       c. SYNTHESIS — scan worker knowledge files for the standalone
#                      Keeper-synthesis flag and print ONE line per flagged
#                      worker, naming the FILE and both resolution paths (a
#                      session, or a keeper lane briefed with the protocol).
#                      A standing flag is never silent at Stop: the mechanical
#                      keeper only SETS it, so a session that ends without
#                      naming it hands the debt to whatever notices next.
#     Findings go to stderr, where Claude Code shows them at session end. The
#     ONE hard edge: a `KNOWLEDGE-MISSING:` finding refuses the stop (exit 2 —
#     Claude Code shows stderr to the agent and lets it continue), so a session
#     that booted a role and never logged for it writes the entry before it may
#     end (2026-09-25). Once per stop, never a loop: when Claude Code re-runs
#     the Stop hooks after a refusal it sets `stop_hook_active: true`, and the
#     hook then only nudges.
# IS NOT: The synthesis itself — that is Keeper judgment work; this only closes
#     the loop that triggers it.
#
# One file since 2026-10-15 (it was an adapter over
# a separate core — one harness, so one file).
#
# Inputs:
#   stdin          — the Stop JSON: `transcript_path` (enables pass b) and
#                    `stop_hook_active`. Parsed without jq; a miss disables
#                    pass b, never wedges the stop.
#   LYTE_REPO_ROOT — optional repo-root override; defaults to two levels
#                    above this script (.claude/hooks/ → repo root).
# Exit: 2 on KNOWLEDGE-MISSING when the stop has not been refused yet, else 0.
#   Fail-soft everywhere: no pass may wedge the session.

REPO_ROOT="${LYTE_REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
MEMORY_DIR="$REPO_ROOT/.lyte/memory"

STOP_INPUT="$(cat 2>/dev/null || true)"
TRANSCRIPT="$(printf '%s' "$STOP_INPUT" \
  | grep -o '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')"
STOP_HOOK_ACTIVE=0
if printf '%s' "$STOP_INPUT" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  STOP_HOOK_ACTIVE=1
fi

findings() {
  # --- a. Silent curation ----------------------------------------------------
  # keeper-sync is file work over .lyte/memory/** and reads no credential,
  # which is what makes it safe to run from a hook. Fail-soft, silent either way.
  KEEPER_SYNC="$REPO_ROOT/scripts/keeper-sync.cjs"
  if [ -f "$KEEPER_SYNC" ]; then
    node "$KEEPER_SYNC" >/dev/null 2>&1 || true
  fi

  # --- b. Knowledge check ----------------------------------------------------
  # Transcript JSONL: one event per line; a tool_use line carries the tool's
  # whole input on that line — a Read's file_path, a Bash command's text. So a
  # role's context.md read through Read OR through `sed`/`cat` in Bash, and a
  # knowledge.md written through Edit OR through a heredoc in Bash, both show up
  # as the path inside a tool_use line. Only tool_use lines are scanned: a
  # hook's own printed findings (a user-role line naming knowledge.md) must
  # never count as a log.
  #
  # A BOOT IS A DIRECT TARGET, NOT A MENTION (2026-10-07). This used to count any
  # tool_use line in which the path appeared at all, so a single `grep` across
  # several roles' context.md files booted all of them — one such sweep flagged
  # devops-engineer as booted-and-unlogged in a session that never became it, and
  # a false KNOWLEDGE-MISSING refuses a stop and asks for an entry about work that
  # was never done. Two shapes count now, both of them "this file is what the tool
  # was pointed at":
  #   (i)  a `"file_path"` value ending in that path — the key only the file tools
  #        (Read/Write/Edit) emit, and always for their one target. A search tool
  #        passes `pattern`/`path`, never `file_path`, so it cannot land here.
  #   (ii) a Bash `"command"` that names the exact path AND runs a plain reader
  #        (cat/sed/head/tail/less/more). A command that also searches (grep, rg,
  #        find, ls) is not a boot, whatever else it does — conservative by
  #        design: a missed boot is a nudge not printed, a false one is a refused
  #        stop. A glob (`.lyte/memory/*/context.md`) carries no role slug to
  #        extract, so it drops out of both shapes on its own.
  #
  #   booted — role slugs whose context.md was a direct target, per (i) or (ii).
  #   logged — role slugs whose .lyte/memory/<role>/knowledge.md appears in a
  #            tool_use line, by any tool (a log is a WRITE; nothing mentions a
  #            knowledge.md path by accident the way a memory-wide grep does).
  #   missing = booted − logged − assistant.
  knowledge_missing=""
  if [ -n "$TRANSCRIPT" ] && [ -r "$TRANSCRIPT" ]; then
    tool_lines=$(grep -E '"type"[[:space:]]*:[[:space:]]*"tool_use"' "$TRANSCRIPT" 2>/dev/null || true)
    if [ -n "$tool_lines" ]; then
      CONTEXT_PATH_RE='\.lyte/memory/[A-Za-z0-9_-]+/context\.md'
      # (i) file-tool targets.
      booted_read=$(printf '%s\n' "$tool_lines" \
        | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"[^"]*'"$CONTEXT_PATH_RE"'"' \
        | grep -oE "$CONTEXT_PATH_RE" || true)
      # (ii) Bash readers pointed at the exact path. The reader must BE the
      # command that names it, not merely appear in the same line, so each
      # `"command"` value is split on &&, ;, | and newline into segments and only a
      # segment whose FIRST word is a reader is read for a path. Anything less is
      # not enough: `git diff -- <role>/context.md | head -40` has a reader and the
      # exact path, and booted that role in the very session that shipped this
      # check — `head` was consuming a pipe, not reading the file (2026-10-07).
      # A `cd x && cat <path>` still counts; its second segment starts with cat.
      booted_bash=$(printf '%s\n' "$tool_lines" \
        | grep -oE '"command"[[:space:]]*:[[:space:]]*"(\\.|[^"\\])*"' \
        | sed -E 's/^"command"[[:space:]]*:[[:space:]]*"//' \
        | sed -E 's/\\n/\n/g; s/&&/\n/g; s/\|\|/\n/g; s/\|/\n/g; s/;/\n/g' \
        | sed -E 's/^[[:space:]]+//' \
        | grep -E '^(cat|sed|head|tail|less|more)[[:space:]]' \
        | grep -oE "$CONTEXT_PATH_RE" || true)
      # (iii) the role-boot hook printed the context (2026-10-15): its marker in
    # a hook_success attachment, never in a line a person typed.
    booted_hook=$(grep -F '"hook_success"' "$TRANSCRIPT" 2>/dev/null \
      | grep -oE 'lyte:role-booted [A-Za-z0-9_-]+' | sed -E 's/^lyte:role-booted //' || true)
    booted=$( { printf '%s\n%s\n' "$booted_read" "$booted_bash" | grep -vE '^$' | sed -E 's#\.lyte/memory/([A-Za-z0-9_-]+)/context\.md#\1#'; printf '%s\n' "$booted_hook"; } | grep -vE '^$' | sort -u)
      logged=$(printf '%s\n' "$tool_lines" | grep -oE '\.lyte/memory/[A-Za-z0-9_-]+/knowledge\.md' | sed -E 's#\.lyte/memory/([A-Za-z0-9_-]+)/knowledge\.md#\1#' | sort -u)
      for role in $booted; do
        [ "$role" = "assistant" ] && continue
        if ! printf '%s\n' "$logged" | grep -qx "$role"; then
          knowledge_missing="$knowledge_missing $role"
        fi
      done
      knowledge_missing="${knowledge_missing# }"
    fi
  fi
  if [ -n "$knowledge_missing" ]; then
    echo "KNOWLEDGE-MISSING: $knowledge_missing — you booted these roles this session and logged nothing for them. Append a dated entry to each role's .lyte/memory/<role>/knowledge.md — what the work was, and the skills and tools that shaped it and what each changed (AGENTS.md, step 5) — then stop."
  fi

  # --- c. Synthesis prompt ---------------------------------------------------
  # Only standalone-line flags count. Matching the token inside prose
  # (framework docs, synthesis session logs, historical entries) produces
  # false positives that would keep the hook permanently red.
  FLAG_REGEX='^[[:space:]]*<!-- keeper-synthesis-needed -->[[:space:]]*$'

  if [ -d "$MEMORY_DIR" ]; then
    while IFS= read -r file; do
      if grep -Eq "$FLAG_REGEX" "$file" 2>/dev/null; then
        worker=$(basename "$(dirname "$file")")
        rel="${file#$REPO_ROOT/}"
        echo "$worker has unsynthesized knowledge: $rel carries a standing keeper-synthesis flag. keeper-sync DETECT only SETS that flag — only the Keeper's judgment pass clears it. Resolve it either way: become the Keeper in this session (/dispatch keeper), or brief a keeper lane with the synthesis protocol (workers/primordials/keeper.md, workers/boot-sequence.md §3) AND its done-conditions — raw entries archived verbatim, lessons promoted or extended with their index lines, the flag dropped, two keeper-sync runs converging."
      fi
    done < <(find "$MEMORY_DIR" -name knowledge.md -type f 2>/dev/null)
  fi
}

FINDINGS="$(findings 2>/dev/null || true)"
[ -n "$FINDINGS" ] && printf '%s\n' "$FINDINGS" >&2

if [ "$STOP_HOOK_ACTIVE" -eq 0 ] && printf '%s\n' "$FINDINGS" | grep -q '^KNOWLEDGE-MISSING:'; then
  exit 2
fi
exit 0
