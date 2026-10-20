#!/bin/bash
# Clean up stale Claude Agent SDK worktrees to prevent disk exhaustion.
# Triggered by the Stop hook in .claude/settings.json.

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
if ! git rev-parse --is-inside-work-tree &>/dev/null; then exit 0; fi

WORKTREE_DIR="$REPO_ROOT/.claude/worktrees"
if [ ! -d "$WORKTREE_DIR" ]; then exit 0; fi

# Count worktrees before cleanup
COUNT=$(find "$WORKTREE_DIR" -maxdepth 1 -type d -name "agent-*" 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -eq 0 ]; then exit 0; fi

# Remove all agent worktrees — they're ephemeral by design
for wt in "$WORKTREE_DIR"/agent-*; do
  [ -d "$wt" ] || continue
  # Try git worktree remove first (clean), fall back to rm
  git worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"
done

# Prune any dangling worktree references
git worktree prune 2>/dev/null

# Also clean up .lyte/tmp (attachment downloads)
rm -rf "$REPO_ROOT/.lyte/tmp" 2>/dev/null

AFTER=$(find "$WORKTREE_DIR" -maxdepth 1 -type d -name "agent-*" 2>/dev/null | wc -l | tr -d ' ')
echo "Cleaned $((COUNT - AFTER)) worktree(s), $AFTER remaining" >&2
exit 0
