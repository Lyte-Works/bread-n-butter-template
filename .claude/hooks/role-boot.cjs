#!/usr/bin/env node
'use strict';
// IS: The UserPromptSubmit hook that boots a role from one line. A prompt whose
//     first line is `Role: <slug>` (the lane-brief template) or `/dispatch
//     <slug>` gets that role's `.lyte/memory/<slug>/context.md` printed into
//     the session — what AGENTS.md step 2 asks for, without the Read. The print
//     carries a marker, `<!-- lyte:role-booted <slug> -->`, which the
//     guide-read gate and the Stop check read in the transcript as "this role
//     was booted": a boot is a boot whether it arrived by Read or by this hook.
// IS NOT: Routing — it never guesses a role from the task; a prompt without the
//     line prints nothing. Not the guides either: those are still read before
//     the first edit in their domain.
//
// Why a hook (2026-10-15): a cloud lane is created by `create_session`, which
// cannot set an environment variable, so it boots as the assistant and has to
// remember to read the role's file — and the gate counted only a Read. One line
// in the brief now does it in every venue, and `/dispatch <slug>` works in a
// field whose `.claude/commands/` never received the command.
//
// THE BYTE BUDGET. Claude Code hands the model a hook's stdout inline only up to
// 10,000 bytes; past that the model gets a 2 KB preview and a file path, which
// is the extra Read this hook exists to remove (measured on CC 2.1.278). The
// print therefore stays under BUDGET_BYTES: generated blocks the session can
// do without go first (`## Recent`, then `## Lessons Available` — recall
// injects the matching rules per prompt), and only then is the rest cut, with a
// line saying where the remainder is.
//
// Exit 0 always — a boot aid, never a wedge.

const fs = require('fs');
const path = require('path');

const BUDGET_BYTES = 9500;
const DROP_FIRST = ['Recent', 'Lessons Available'];
const LINE_RE = /^\s*(?:Role:\s*|\/dispatch\s+)([a-z0-9][\w-]*)\b/i;
const MARKER = (slug) => '<!-- lyte:role-booted ' + slug + ' -->';

// Pure: the role slug a prompt's FIRST non-empty line names, or null.
function roleFromPrompt(prompt) {
  const first = String(prompt || '').split('\n').find((l) => l.trim() !== '');
  const m = first ? LINE_RE.exec(first) : null;
  return m ? m[1].toLowerCase() : null;
}

// Pure: context.md as it is printed — HTML comments out (they are notes to the
// Keeper, not orientation), then cut to the budget.
function renderContext(slug, contextText, budget) {
  const limit = typeof budget === 'number' ? budget : BUDGET_BYTES;
  const head = '## Role context (.lyte/memory/' + slug + '/context.md — you are booted as ' + slug + ')\n' + MARKER(slug) + '\n\n';
  let body = String(contextText || '').replace(/<!--[\s\S]*?-->\n?/g, '').replace(/\n{3,}/g, '\n\n');
  const size = () => Buffer.byteLength(head + body);
  for (const title of DROP_FIRST) {
    if (size() <= limit) break;
    body = body.replace(new RegExp('^## ' + title + '\\b[^\\n]*\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))', 'm'), '');
  }
  if (size() > limit) {
    const tail = '\n\n…cut to fit the hook budget — read .lyte/memory/' + slug + '/context.md for the rest.\n';
    let cut = Buffer.from(body).subarray(0, limit - Buffer.byteLength(head + tail)).toString('utf8');
    cut = cut.slice(0, cut.lastIndexOf('\n') > 0 ? cut.lastIndexOf('\n') : cut.length).replace(/�+$/, '');
    body = cut + tail;
  }
  return head + body.replace(/\s*$/, '\n');
}

function main() {
  try {
    const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    const slug = roleFromPrompt(payload.prompt);
    if (!slug) return;
    const repoRoot = path.resolve(__dirname, '..', '..'); // this hook lives at .claude/hooks/
    const file = path.join(repoRoot, '.lyte', 'memory', slug, 'context.md');
    if (fs.existsSync(file)) {
      process.stdout.write(renderContext(slug, fs.readFileSync(file, 'utf8')));
    } else if (fs.existsSync(path.join(repoRoot, '.lyte', 'memory', slug))) {
      process.stdout.write('## Role context — ' + slug + '\n\nNo context.md for ' + slug + ' yet: write the stub per workers/boot-sequence.md §1, then read it.\n');
    }
  } catch {
    // fail-soft: bad stdin, unreadable file — the session can still Read it
  }
}

module.exports = { BUDGET_BYTES, MARKER, roleFromPrompt, renderContext };

if (require.main === module) {
  main();
  process.exit(0);
}
