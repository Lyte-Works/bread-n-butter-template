'use strict';

/**
 * keeper-sync.cjs — The Mechanical Keeper (Bread 'n' Butter's copy)
 *
 * IS: mechanical maintenance of a restaurant repo's memory layer — run by the
 *     Stop hook (.claude/hooks/check-synthesis.sh) and by hand. No AI
 *     dependency for any file step.
 * IS NOT: a network client of any kind. It reads no credential, which is what
 *     lets a Stop hook run it unattended.
 *
 * Steps:
 *   2. INDEX     — scan lessons, build lesson index                  [file]
 *   3. CONTEXT   — regenerate context.md's Identity / Field Orientation /
 *                  Recent / Lessons blocks; seed a missing context.md [file]
 *  3b. GUIDES    — resolve role guides → context.md (a restaurant repo
 *                  carries no guides, so this writes `none`)        [file+llm]
 *  3c. SKILLS    — generate .claude/skills/ copies from workers/skills/ [file]
 *  3d. ENTRY     — splice the framework block into AGENTS.md from
 *                  .bnb/canon/claude-md-core.cjs                    [file]
 *  3e. SETTINGS  — wire .claude/settings.json's hooks and read allows from
 *                  .bnb/canon/claude-settings-core.cjs              [file]
 *   7. DETECT    — synthesis trigger-flag + dormancy + stale anchors +
 *                  recall report                                     [file]
 *
 * FILE-ONLY. Worker memory is repo files, period. The step numbering keeps
 * its historical gaps so run logs stay comparable.
 *
 * DETECT (step 7) FLAGS synthesis and never performs it. On any of the three
 * triggers (entries, lines, age) it appends a standalone
 * keeper-synthesis-needed marker; the archive, the lessons and the dropped
 * flag are the Keeper's judgment pass (workers/boot-sequence.md §3).
 *
 * The two framework cores this script splices from live in `.bnb/canon/` in
 * this repo; the template's updates channel (TODO.md) is how a new version of
 * them, or of this script, reaches a restaurant repo.
 *
 * Environment:
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY — step 3b (LLM); optional, soft-skips
 */

var fs = require('fs');
var path = require('path');

// --- Configuration ---

var MEMORY_ROOT = path.resolve('.lyte/memory');
var ARCHIVE_DAYS = 3; // entries older than this get archived

// §7 synthesis triggers. When any ONE of them fires on a worker's
// knowledge.md, DETECT mechanically appends a standalone
// `keeper-synthesis-needed` marker so the session-boot fact and the assistant
// loop see it even when the worker forgot to flag. Three triggers, because lines alone measured the
// wrong thing (2026-10-07 memory-loop assessment): a busy role tripped the
// 250-line size flag every ~4 days while five quiet roles carried entries from
// May that nothing would ever flag.
//   entries — ≥10 unsynthesized entries. The SAME number the worker is told to
//             count by hand (workers/boot-sequence.md §3 · Log).
//   lines   — ≥400 lines. Still a backstop for a journal of few huge entries;
//             raised from 250 because that fired on healthy cadence.
//   age     — the oldest unsynthesized entry is ≥14 days old. The one trigger
//             that sees a SMALL journal nobody has curated in months.
// "Unsynthesized" = the entries after the last `## … — Keeper synthesis`
// heading (unsynthesizedEntries). Docs and script must agree on all three:
// workers/boot-sequence.md §3 and workers/primordials/keeper.md.
var SYNTHESIS_ENTRY_THRESHOLD = 10;
var SYNTHESIS_LINE_THRESHOLD = 400;
var SYNTHESIS_AGE_DAYS = 14;
var SYNTHESIS_FLAG = '<!-- keeper-synthesis-needed -->';

// --- Utility Functions ---

function log(step, msg) {
  console.log('[keeper-sync][' + step + '] ' + msg);
}

function warn(step, msg) {
  console.warn('[keeper-sync][' + step + '] WARN: ' + msg);
}

// contentHash is a memory-core primitive (scripts/lib/memory-core.cjs,
// required lazily below).

function parseDate(dateStr) {
  var d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// --- Worker Discovery ---

function discoverWorkers() {
  if (!fs.existsSync(MEMORY_ROOT)) return [];
  var entries = fs.readdirSync(MEMORY_ROOT, { withFileTypes: true });
  return entries
    .filter(function (e) { return e.isDirectory(); })
    .map(function (e) { return e.name; });
}

// --- The journal parser ---
// Shared by the §7 trigger count and the dormancy
// derivation. It lived under step 1 (SPLIT) until that step was removed with
// the per-entry mirrors (2026-10-07); the parse was always the useful half.

function parseKnowledgeEntries(content) {
  // Entries are delimited by `## ` headings, not `---` separators (the old
  // splitter assumed `---` and silently parsed zero entries out of files
  // written in the current style). Heading formats seen in the wild:
  //   ## 2026-06-01 — Title      (em-dash, current style)
  //   ## 2026-06-01: Title       (colon, original style)
  //   ## Title (2026-06-10)      (date-suffix)
  var lines = content.split('\n');
  var entries = [];
  var current = null;

  function flush() {
    if (!current) return;
    var body = current.lines.join('\n').replace(/\n---\s*$/, '').trim();
    if (body) entries.push({ date: current.date, title: current.title, content: body });
    current = null;
  }

  for (var i = 0; i < lines.length; i++) {
    var h = lines[i].match(/^##\s+(.+)$/);
    if (h) {
      flush();
      var heading = h[1].trim();
      var date = null;
      var title = heading;
      var m = heading.match(/^(\d{4}-\d{2}-\d{2})\s*[:—–-]\s*(.+)$/);
      if (m) {
        date = m[1];
        title = m[2].trim();
      } else {
        m = heading.match(/^(.+?)\s*\((\d{4}-\d{2}-\d{2})\)$/);
        if (m) {
          date = m[2];
          title = m[1].trim();
        }
      }
      current = { date: date, title: title, lines: [lines[i]] };
    } else if (current) {
      current.lines.push(lines[i]);
    }
    // Lines before the first `## ` heading (file H1, synthesized comments)
    // are intentionally dropped — they're file chrome, not entries.
  }
  flush();

  return entries;
}

// --- Step 2: INDEX ---
// (parseFrontmatter is a memory-core primitive, required lazily below.)

// Generate YAML frontmatter string
function buildFrontmatter(meta) {
  var lines = ['---'];
  if (meta.tags && meta.tags.length > 0) lines.push('tags: [' + meta.tags.join(', ') + ']');
  if (meta.touches && meta.touches.length > 0) lines.push('touches: [' + meta.touches.join(', ') + ']');
  if (meta.applies_during && meta.applies_during.length > 0) lines.push('applies_during: [' + meta.applies_during.join(', ') + ']');
  if (meta.applies_when && meta.applies_when.length > 0) lines.push('applies_when: [' + meta.applies_when.join(', ') + ']');
  if (meta.worker) lines.push('worker: ' + meta.worker);
  lines.push('---');
  return lines.join('\n');
}

// Infer metadata from lesson content. Composes the memory-core primitives
// (inferTags for the tag pass, mineAnchors for touches — one definition each,
// required lazily below); the applies_during / applies_when heuristics are
// keeper-only and stay here.
function inferLessonMeta(content, slug, worker) {
  var lower = content.slice(0, 1000).toLowerCase();
  var appliesDuring = [];
  var appliesWhen = [];

  // Tags: what is this lesson about (memory-core inferTags — same 1000-char
  // window, same keyword list as every other write path).
  var tags = inferTags(content);

  // applies_during: what kind of task would this lesson be relevant for
  if (tags.includes('deploy') || lower.includes('ci')) appliesDuring.push('deployment');
  if (tags.includes('data') || lower.includes('schema')) appliesDuring.push('schema-design');
  if (lower.includes('debug') || lower.includes('error') || lower.includes('fix')) appliesDuring.push('debugging');
  if (lower.includes('refactor') || lower.includes('architecture')) appliesDuring.push('refactoring');
  if (tags.includes('components') || lower.includes('ui') || lower.includes('page')) appliesDuring.push('ui-development');
  if (tags.includes('security')) appliesDuring.push('security-review');

  // applies_when: situational triggers
  if (lower.includes('error') || lower.includes('fail') || lower.includes('crash')) appliesWhen.push('build-failure');
  if (lower.includes('new worker') || lower.includes('first time') || lower.includes('onboard')) appliesWhen.push('new-worker-entry');
  if (lower.includes('performance') || lower.includes('slow') || lower.includes('timeout')) appliesWhen.push('performance-issue');

  // touches: exact artifact anchors mined from the FULL content (not the
  // 1000-char tag window) — authored lessons carry them as curated frontmatter,
  // like tags (design §5.3). mineAnchors is hoisted (declared below).
  return { tags: tags, applies_during: appliesDuring, applies_when: appliesWhen, worker: worker, touches: mineAnchors(content) };
}

// Historical export name for the frontmatter-wins tag resolution — kept for
// back-compat (module.exports consumers pass slug/worker); the definition is
// memory-core resolveTags (required lazily below). Behaviour unchanged: the
// old body was parseFrontmatter tags || inferLessonMeta().tags, and
// inferLessonMeta's tag pass IS inferTags.
function resolveUnitTags(content) {
  return resolveTags(content);
}

// Historical export name for the frontmatter-wins anchor resolution — kept for
// back-compat (backfill-memories-touches.cjs, tests); the definition is
// memory-core resolveTouches (required lazily below).
function resolveUnitTouches(content) {
  return resolveTouches(content);
}

// --- Memory hash/tag/anchor primitives ---
// ONE definition, scripts/lib/memory-core.cjs (shared with the recall hook),
// required LAZILY so a checkout missing it fails only the steps that need it,
// with a message naming the file rather than a bare MODULE_NOT_FOUND.
var MEMORY_CORE_PATH = path.join(__dirname, 'lib', 'memory-core.cjs');
var _memoryCore = null;
function memoryCore() {
  if (_memoryCore === null) {
    if (!fs.existsSync(MEMORY_CORE_PATH)) {
      throw new Error(
        'memory-core.cjs missing at ' + MEMORY_CORE_PATH +
        ' — it ships with the template; restore it from Lyte-Works/bread-n-butter-template' +
        ' (or merge the template\'s pending updates PR) before rerunning.');
    }
    _memoryCore = require(MEMORY_CORE_PATH);
  }
  return _memoryCore;
}
function contentHash(content) { return memoryCore().contentHash(content); }
function inferTags(content) { return memoryCore().inferTags(content); }
function parseFrontmatter(content) { return memoryCore().parseFrontmatter(content); }
function resolveTags(content) { return memoryCore().resolveTags(content); }
function mineAnchors(content) { return memoryCore().mineAnchors(content); }
function resolveTouches(content) { return memoryCore().resolveTouches(content); }

function scanLessons(worker) {
  var lessonsDir = path.join(MEMORY_ROOT, worker, 'lessons');
  if (!fs.existsSync(lessonsDir)) return [];

  var files = fs.readdirSync(lessonsDir).filter(function (f) {
    return f.endsWith('.md');
  });

  var lessons = [];
  for (var i = 0; i < files.length; i++) {
    var filePath = path.join(lessonsDir, files[i]);
    var content = fs.readFileSync(filePath, 'utf8');
    var slug = files[i].replace('.md', '');

    // Parse existing frontmatter or infer + write it (Phase 4)
    var parsed = parseFrontmatter(content);
    var meta;

    if (parsed.frontmatter && parsed.frontmatter.tags) {
      // Already has frontmatter — use it
      meta = parsed.frontmatter;
    } else {
      // No frontmatter — infer and write it
      meta = inferLessonMeta(content, slug, worker);
      var newContent = buildFrontmatter(meta) + '\n' + (parsed.body || content);
      fs.writeFileSync(filePath, newContent, 'utf8');
      content = newContent;
    }

    lessons.push({
      slug: slug,
      tags: meta.tags || [],
      // Curated retrieval keys, carried so the index rebuild derives from
      // the Keeper's own words (2026-08-30 audit finding #2: deriving index
      // lines from coarse inferred tags clobbered every hand-curated line).
      triggers: meta.triggers || '',
      description: meta.description || '',
      appliesDuring: meta.applies_during || [],
      appliesWhen: meta.applies_when || [],
      path: filePath,
      content: content
    });
  }

  return lessons;
}

// The framework cores (claude-md-core.cjs, claude-settings-core.cjs) live in
// Bread 'n' Butter's own canon directory, `.bnb/canon/`, in this repo. Looked
// up beside this script first, then in the cwd; the require is lazy, so a
// checkout without a core degrades its one step to a warning.
var CANON_CORE_DIRS = [
  ['.bnb', 'canon'],
];
function canonCorePath(name) {
  var candidates = [];
  for (var d = 0; d < CANON_CORE_DIRS.length; d++) {
    var dir = CANON_CORE_DIRS[d];
    candidates.push(path.join.apply(path, [__dirname, '..'].concat(dir, [name])));
    candidates.push(path.join.apply(path, [process.cwd()].concat(dir, [name])));
  }
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) return candidates[i];
  }
  return candidates[0] + ' (nor ' + candidates.slice(1).join(', nor ') + ')';
}

// --- The `## Lessons Available` index ---
// Slugs only: a lesson's operative rule lives in its own `rule:` frontmatter
// and the recall hook injects it when its triggers match a prompt, so the
// index only has to say what exists. One paragraph, sorted, every lesson named.
// Lessons: [{ slug }].
function buildLessonIndex(lessons) {
  if (lessons.length === 0) return '';
  var slugs = lessons.map(function (l) { return l.slug; }).sort();
  return [
    '## Lessons Available (' + lessons.length + ')',
    '',
    'Recall injects a lesson\'s rule when its triggers match the prompt; open `lessons/<slug>.md` for the story behind it.',
    '',
    slugs.join(' · '),
  ].join('\n');
}

// --- Step 3: CONTEXT ---

// ── Generated Identity block ────────────────────────────────────────────────
// A role's identity used to reach a worker only through the role file, which
// the boot protocol read once (Full Boot) and then never again: this script
// re-stamped every context.md's date on every run, so the ">7 days" trigger
// could not fire, and the "role file changed" trigger cleared itself on the
// next daily commit (2026-09-09 audit). Identity now lives INSIDE context.md
// as a block this script regenerates from the role file — the one file every
// boot reads carries who the role is, and a role-file edit lands on the next
// sync instead of waiting for a Full Boot that never came. Small on purpose:
// the essence line, the Essence-level boundaries, and the role-specific
// quality gate are the parts of identity that change behavior; the rest of
// the role file is workflow the guides already carry. (The July 2026
// skills-at-spawn regression is the standing proof that boot payload weight
// degrades every worker — see observer/assistant lesson
// skills-at-spawn-transition-degraded-worker-boot.)

function bulletLines(block) {
  return String(block || '').split('\n')
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l.indexOf('- ') === 0; })
    .map(function (l) { return l.slice(2).trim(); });
}

// Pure: { essence, boundaries, gate } from a role file's text, or null when
// the file has no `## Essence` section. Boundaries are the `### Boundaries`
// UNDER Essence (the Alignment section carries its own, more abstract set);
// the gate is the `### Quality Gate` list with its `[ ]` checkboxes dropped.
function parseRoleIdentity(roleContent) {
  var em = String(roleContent || '').match(/^## Essence[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/m);
  if (!em) return null;
  var body = em[1];
  var essence = '';
  var lines = body.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (!t || t.charAt(0) === '#' || t.indexOf('<!--') === 0) continue;
    essence = t;
    break;
  }
  var bm = body.match(/^### Boundaries[^\n]*\n([\s\S]*?)(?=\n### |(?![\s\S]))/m);
  var qm = String(roleContent).match(/^### Quality Gate[^\n]*\n([\s\S]*?)(?=\n### |\n## |(?![\s\S]))/m);
  return {
    essence: essence,
    boundaries: bm ? bulletLines(bm[1]) : [],
    gate: (qm ? bulletLines(qm[1]) : []).map(function (g) { return g.replace(/^\[[ xX]\]\s*/, ''); }),
  };
}

var IDENTITY_GENERATED_NOTE = '<!-- generated by keeper-sync from the role file — edit the role file, not this block -->';

// Pure: the `## Identity` block text, or '' when the role file yields nothing.
function buildIdentityBlock(roleContent) {
  var id = parseRoleIdentity(roleContent);
  if (!id || !id.essence) return '';
  var out = ['## Identity', '', id.essence];
  if (id.boundaries.length > 0) {
    out.push('', '**Boundaries**');
    id.boundaries.forEach(function (b) { out.push('- ' + b); });
  }
  if (id.gate.length > 0) {
    out.push('', '**Quality gate** (role-specific, on top of the generic gate in `workers/boot-sequence.md`)');
    id.gate.forEach(function (g) { out.push('- ' + g); });
  }
  out.push('', IDENTITY_GENERATED_NOTE);
  return out.join('\n');
}

// Line-anchored like the lessons splice above: the heading on
// its own line, section end at the next `## ` / `---` / true EOF.
// The lookahead lists the blank-line forms FIRST so a lazy match stops before
// the blank line that separates this block from the next heading — otherwise
// each splice ate one newline and the operation was not a fixed point.
// A `###` heading ends the section too: several contexts open their curated
// body with `### Stack`-style subsections right under Field Orientation, and
// without this the orientation "section" ran to the next `## ` at the bottom
// of the file — and Identity was inserted there.
var IDENTITY_SECTION = /^## Identity\n[\s\S]*?(?=\n\n##+ |\n\n---|\n##+ |\n---|(?![\s\S]))/m;
var FIELD_ORIENTATION_SECTION = /^## Field Orientation\n[\s\S]*?(?=\n\n##+ |\n\n---|\n##+ |\n---|(?![\s\S]))/m;

// Pure: replace the Identity block in place, or insert it — after Field
// Orientation when that block exists (orientation first, identity second,
// the order every regenerated context shares), else after the header
// separator, else after the first line. Idempotent: splicing the same block
// twice is a fixed point.
function spliceIdentityBlock(content, block) {
  if (!block) return content;
  if (content.match(IDENTITY_SECTION)) {
    var replaced = content.replace(IDENTITY_SECTION, function () { return block; });
    // A block sitting at EOF has its trailing newline consumed by the match.
    return content.slice(-1) === '\n' && replaced.slice(-1) !== '\n' ? replaced + '\n' : replaced;
  }
  var fo = content.match(FIELD_ORIENTATION_SECTION);
  if (fo) {
    var end = fo.index + fo[0].length;
    return content.slice(0, end).replace(/\n*$/, '\n') + '\n' + block + '\n' + content.slice(end).replace(/^\n+/, '\n');
  }
  var sep = content.indexOf('\n---\n');
  if (sep > -1) {
    var after = sep + 5;
    return content.slice(0, after) + '\n' + block + '\n' + content.slice(after).replace(/^\n+/, '\n');
  }
  var nl = content.indexOf('\n');
  if (nl === -1) return content + '\n\n' + block + '\n';
  return content.slice(0, nl + 1) + '\n' + block + '\n' + content.slice(nl + 1);
}

// ── Generated Stack block ───────────────────────────────────────────────────
// The same move as the Identity block above, one source over: a technical
// role's `## Stack` section is GENERATED from `workers/stack.md` instead of
// hand-maintained in each context.
//
// Why it had to change (spec-framework-essentials-and-opt-out-2026-09-25 task
// 11). Four contexts carried a hand-written `## Stack (verified <date>)` and a
// fifth carried it as a `### Shared Stack` subsection — five copies of one
// field's stack, each dated independently, each re-verified by whichever role
// happened to boot. That is precisely the failure the keeper's own rule names:
// "a context claim is verified against the tree, not against the last context"
// (2026-09-24) — seven contexts had already drifted onto the same four dead
// facts because each was written from the previous one. One source, regenerated,
// removes the drift by construction.
//
// WHAT IS COPIED: the field's own stack — the bullet lines under stack.md's
// `## Field Extension` heading, which is where a field's concrete values live.
// A field that keeps its stack ABOVE that heading (or has no such heading)
// falls back to the bullets in the body, minus the pointer table.
//
// WHO GETS ONE: the `software-engineering` spectrum, plus the architect. The
// spectrum directory IS the list, so a new technical role gets a Stack slice by
// existing rather than by being added here. The architect is named literally
// for the same reason canon-paths names the three primordials literally: it is
// the one primordial whose work is choosing this stack, and an open form over
// `primordials/` would give the guide and the keeper a stack section neither
// reads. A role outside both keeps whatever it has — this step never REMOVES a
// curated section from a role it does not own.

var STACK_MD_PATH = path.resolve('workers', 'stack.md');
var STACK_GENERATED_NOTE =
  '<!-- generated by keeper-sync from workers/stack.md — edit stack.md, not this block -->';
var STACK_SPECTRUM = 'software-engineering';
var STACK_EXTRA_ROLES = ['architect'];

/** Does this role get a generated Stack slice? */
function roleTakesStack(worker) {
  if (STACK_EXTRA_ROLES.indexOf(worker) !== -1) return true;
  return fs.existsSync(path.resolve('workers', STACK_SPECTRUM, worker + '.md'));
}

// The `## Field Extension` boundary, scanned line by line with fence tracking.
// Two traps are dodged here:
// a heading inside a ``` fence is an example, and the match must be
// line-anchored.
function fieldExtensionStart(lines) {
  var inFence = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (!inFence && /^## Field Extension\b/.test(line)) return i;
  }
  return -1;
}

/**
 * Pure: the `## Stack` block text for a context, or '' when stack.md yields no
 * bullets (a field that has not filled it in yet — better no section than an
 * empty heading a reader has to interpret).
 */
function buildStackBlock(stackContent) {
  var lines = String(stackContent || '').split('\n');
  var start = fieldExtensionStart(lines);
  var body = start === -1 ? lines : lines.slice(start + 1);

  var bullets = [];
  var inFence = false;
  var inTable = false;
  for (var i = 0; i < body.length; i++) {
    var line = body[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    // The pointer table ("Where the platform material went") is navigation, not
    // stack — a context that repeated it would send seven readers the long way
    // round to a file they can reach from stack.md itself.
    if (/^\s*\|/.test(line)) { inTable = true; continue; }
    if (inTable && line.trim() === '') { inTable = false; continue; }
    if (/^- /.test(line)) { bullets.push(line.trimEnd()); continue; }
    // A wrapped continuation of the bullet above it.
    if (bullets.length > 0 && /^\s{2,}\S/.test(line)) { bullets.push(line.trimEnd()); }
  }
  if (bullets.length === 0) return '';
  return ['## Stack', '', STACK_GENERATED_NOTE, ''].concat(bullets).join('\n');
}

// Line-anchored like the Identity splice, and matching the SAME section shapes:
// `## Stack`, `## Stack (verified …)`, `## Stack — verified …`. The date suffix
// is what four contexts carried, so a splice that only matched a bare `## Stack`
// would leave the hand-written section in place and add a second one beside it.
var STACK_SECTION =
  /^## Stack\b[^\n]*\n[\s\S]*?(?=\n\n##+ |\n\n---|\n##+ |\n---|(?![\s\S]))/m;

/**
 * Pure: replace the Stack block in place, or insert it — after Identity when
 * that block exists (orientation, identity, stack: the order every regenerated
 * context shares), else after `## Always`, else before `## Lessons Available`,
 * else appended. Idempotent: splicing the same block twice is a fixed point.
 */
function spliceStackBlock(content, block) {
  if (!block) return content;
  if (content.match(STACK_SECTION)) {
    var replaced = content.replace(STACK_SECTION, function () { return block; });
    return content.slice(-1) === '\n' && replaced.slice(-1) !== '\n' ? replaced + '\n' : replaced;
  }
  var anchors = [IDENTITY_SECTION, /^## Always\n[\s\S]*?(?=\n\n##+ |\n\n---|\n##+ |\n---|(?![\s\S]))/m];
  for (var i = 0; i < anchors.length; i++) {
    var m = content.match(anchors[i]);
    if (!m) continue;
    var end = m.index + m[0].length;
    return content.slice(0, end).replace(/\n*$/, '\n') + '\n' + block + '\n' +
      content.slice(end).replace(/^\n+/, '\n');
  }
  var lessons = content.indexOf('\n## Lessons Available');
  if (lessons > -1) {
    return content.slice(0, lessons) + '\n\n' + block + '\n' + content.slice(lessons);
  }
  return content.replace(/\n*$/, '\n') + '\n' + block + '\n';
}

// --- Step 3: the generated `## Recent` block ---
// The "what happened lately" line a human writes in a journal's margin, made
// mechanical (2026-10-07). A role's context.md is read as current fact at every
// boot, but nothing in it said what the role did LAST — that lived in the
// journal, 100-270 lines long and ordered newest-first in some roles and
// newest-last in others. A hand-written "current:" line would go stale the
// moment a lane finished and nothing updated it, so this block is DERIVED:
// the newest dated entry headings in knowledge.md, rebuilt on every run, never
// edited by hand. The assistant's block spans every role's journal, so the
// context injected at session start carries the field's recent history too.
// Journal order no longer matters to a reader: the block sorts by date.
var RECENT_COUNT = 5;        // per role
var RECENT_FIELD_COUNT = 8;  // the assistant's field-wide block
var RECENT_TITLE_MAX = 100;
var RECENT_SECTION = /^## Recent\n[\s\S]*?(?=\n\n##+ |\n\n---|\n##+ |\n---|(?![\s\S]))/m;
var RECENT_GENERATED_NOTE = '<!-- generated by keeper-sync from knowledge.md: the newest dated journal entries, newest first. ' +
  'Rebuilt on every run — never hand-edited. The entry itself is the depth. -->';

// Pure: the newest dated entries, newest first. Keeper-synthesis notes are
// bookkeeping about the journal, not work, so they are left out. Ties on date
// keep file order (Array.prototype.sort is stable), which is the honest answer
// for same-day entries no journal timestamps.
function recentEntries(entries, count) {
  var dated = (entries || []).filter(function (e) {
    return e.date && !/^keeper synthesis\b/i.test(e.title || '');
  });
  dated.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  return dated.slice(0, count);
}

// Pure: one item per role — the newest — in newest-first order. The field-wide
// block answers "what did each role do last", not "who wrote the most today":
// without this, a role that journals eight times in a day is the whole block
// and fifteen other roles are invisible (observed on the first live run).
function newestPerRole(items) {
  var seen = Object.create(null);
  return items.filter(function (e) {
    if (seen[e.role]) return false;
    seen[e.role] = true;
    return true;
  });
}

// Pure: the block text, or '' when there is nothing dated to show (a context
// with no journal gets no section rather than an empty one). Each item is
// { date, title, role? } — role present only in the assistant's field-wide
// block, where every line must say whose entry it is.
function buildRecentBlock(items) {
  if (!items || items.length === 0) return '';
  var lines = items.map(function (e) {
    var title = String(e.title || '').replace(/\s+/g, ' ').trim();
    if (title.length > RECENT_TITLE_MAX) title = title.slice(0, RECENT_TITLE_MAX - 1).trimEnd() + '\u2026';
    return '- ' + e.date + (e.role ? ' \u00b7 ' + e.role : '') + ' \u2014 ' + title;
  });
  return '## Recent\n\n' + RECENT_GENERATED_NOTE + '\n' + lines.join('\n');
}

// Pure: replace the Recent section in place, or insert it — after Always, else
// after Identity, else before the lessons index, else at EOF — the same anchors
// the Stack splice uses, so the two land in a fixed order (Always, Recent,
// Stack). An empty block REMOVES a stale section (a journal that vanished
// must not leave last month's headlines posing as recent).
function spliceRecentBlock(content, block) {
  if (content.match(RECENT_SECTION)) {
    var replaced = content.replace(RECENT_SECTION, function () { return block; });
    if (!block) replaced = replaced.replace(/\n{3,}/g, '\n\n');
    return content.slice(-1) === '\n' && replaced.slice(-1) !== '\n' ? replaced + '\n' : replaced;
  }
  if (!block) return content;
  var anchors = [/^## Always\n[\s\S]*?(?=\n\n##+ |\n\n---|\n##+ |\n---|(?![\s\S]))/m, IDENTITY_SECTION];
  for (var i = 0; i < anchors.length; i++) {
    var m = content.match(anchors[i]);
    if (!m) continue;
    var end = m.index + m[0].length;
    return content.slice(0, end).replace(/\n*$/, '\n') + '\n' + block + '\n' +
      content.slice(end).replace(/^\n+/, '\n');
  }
  var lessons = content.indexOf('\n## Lessons Available');
  if (lessons > -1) {
    return content.slice(0, lessons) + '\n\n' + block + '\n' + content.slice(lessons);
  }
  return content.replace(/\n*$/, '\n') + '\n' + block + '\n';
}

// fs read-only: the items for one role's block. The assistant's spans every
// role's journal (its own included), labelled by role; any other role reads
// its own knowledge.md alone.
function recentItemsFor(worker) {
  var roles = worker === ASSISTANT_SLUG ? discoverWorkers() : [worker];
  var all = [];
  for (var i = 0; i < roles.length; i++) {
    var p = path.join(MEMORY_ROOT, roles[i], 'knowledge.md');
    if (!fs.existsSync(p)) continue;
    var entries = parseKnowledgeEntries(fs.readFileSync(p, 'utf8'));
    for (var j = 0; j < entries.length; j++) {
      all.push(worker === ASSISTANT_SLUG
        ? { date: entries[j].date, title: entries[j].title, role: roles[i] }
        : { date: entries[j].date, title: entries[j].title });
    }
  }
  if (worker !== ASSISTANT_SLUG) return recentEntries(all, RECENT_COUNT);
  return newestPerRole(recentEntries(all, Infinity)).slice(0, RECENT_FIELD_COUNT);
}

// The mechanical date stamp this script used to rewrite on every run. It
// told a booting worker the file was fresh when only the index had moved,
// and it defeated the Full Boot age trigger. Stripped wherever it survives;
// git carries the real edit history (derive, don't remember).
var MECHANICAL_STAMP = /^\*Last updated: \d{4}-\d{2}-\d{2} \(keeper-sync\)\*\n?/m;

// Pure: a first context.md for a role that has a memory dir but no context
// yet — the mechanical replacement for the Full Boot a worker used to run by
// hand. Generated blocks filled; the curated sections empty but named, so
// the shape every worker reads is the same from the first boot.
// ── The shape of a context: current facts only (2026-10-15) ────────────────
// A context.md is read as current fact at every boot, so what a person curates
// in it is four sections and no more — the rules that always hold, the facts
// that orient, the traps, and what is open. History is the journal's; depth is
// a lesson's. Contexts that grew Session Logs, "HISTORICAL" schema blocks and
// claims about an architecture that no longer exists (bread-n-butter's backend
// was 38% session log) are what this shape prevents. The generated blocks
// (Field Orientation, Identity, Recent, Stack, Lessons Available, Guides) are
// keeper-sync's and sit outside the budget.
var CURATED_SECTIONS = ['Always', 'Orientation', 'Gotchas', 'Open Threads'];
var GENERATED_SECTIONS = ['Field Orientation', 'Identity', 'Recent', 'Stack', 'Lessons Available', 'Guides'];
var CURATED_BUDGET_BYTES = 4096;

/**
 * Pure: how far a context.md is from the shape.
 *   { curatedBytes, extra }  extra: curated headings outside the four.
 */
function contextShape(content) {
  var sections = String(content || '').split(/^(?=## )/m).filter(function (sec) { return sec.indexOf('## ') === 0; });
  var curatedBytes = 0;
  var extra = [];
  sections.forEach(function (sec) {
    var title = sec.split('\n')[0].replace(/^##\s+/, '').replace(/\s*[(—].*$/, '').trim();
    if (GENERATED_SECTIONS.indexOf(title) !== -1) return;
    curatedBytes += Buffer.byteLength(sec.replace(/<!--[\s\S]*?-->/g, ''));
    if (CURATED_SECTIONS.indexOf(title) === -1) extra.push(title);
  });
  return { curatedBytes: curatedBytes, extra: extra };
}

function buildContextStub(roleName, fieldName, fieldOrientation, identityBlock, lessonIndex, opts) {
  var orientationNote = (opts && opts.orientationNote) ||
    '<!-- Keeper-curated. Current facts only — the stack, the contracts, the data shape, where things live — each line dated (YYYY-MM-DD) with the path it was checked against. History belongs in knowledge.md, depth in lessons/. keeper-sync reports any path here that no longer exists (stale-report.md). -->';
  var out = ['# ' + roleName + ' — Field Context: ' + fieldName, '', '---', ''];
  if (fieldOrientation) out.push(fieldOrientation, '');
  if (identityBlock) out.push(identityBlock, '');
  out.push(
    '## Always', '',
    '<!-- Keeper-curated. Rules this role must hold on EVERY session: cross-cutting, index-blind, costly to miss. Scarce by construction — one to three, or none. -->', '',
    '## Orientation', '',
    orientationNote, '',
    '## Gotchas', '',
    '<!-- Keeper-curated. The traps this role walks into in THIS field — one line each, dated, with the path or command that shows it. -->', '',
    '## Open Threads', '',
    '<!-- Keeper-curated. What is open for this role right now, each with its address (task row, PR, spec) — never a log of what closed. -->', ''
  );
  if (lessonIndex) out.push(lessonIndex, '');
  return out.join('\n').replace(/\n+$/, '\n');
}

// The assistant has no role file (it is the posture every session starts in,
// not a role — AGENTS.md), so its Identity cannot be regenerated from one.
// This is the seed: three boundaries, written once into a restaurant's first
// assistant context and then the restaurant's to edit.
// Without it a repo has no .lyte/memory/assistant/context.md at all, and the
// session-boot hook's "assistant boots first" injection has nothing to print.
var ASSISTANT_SLUG = 'assistant';

// The assistant's context is injected at every session start (session-boot
// core), so it pays a flat tax on every turn: a tighter cap than a role's.
var ASSISTANT_CONTEXT_SOFT_CAP = 120;

function buildAssistantIdentityBlock() {
  return [
    '## Identity', '',
    'This restaurant\'s assistant — the standing posture every session starts in. I survey, route and settle; for role work I become the matching role (`AGENTS.md`) and boot it before acting; kitchen work follows the matching skill (`workers/skills/`).', '',
    '**Boundaries**',
    '- I do not do role work as the assistant — a task that matches a role is done as that role, booted.',
    '- I do not touch credentials or the repo\'s secrets — those are the operator\'s, set at hand-off; I surface what is missing, never perform it.',
    '- I do not invent work to justify a wake — a quiet survey is a success.', '',
    '<!-- seeded by keeper-sync: the assistant has no role file, so this block is the field\'s to edit — keeper-sync never regenerates it -->',
  ].join('\n');
}

var ASSISTANT_ORIENTATION_NOTE = '<!-- Keeper-curated. The field\'s standing orientation, printed at EVERY session start: what the field is, its repo and stack, the roster, where open work lives, its connections — each claim dated (YYYY-MM-DD), tight (this file is capped at ' + ASSISTANT_CONTEXT_SOFT_CAP + ' lines). History belongs in knowledge.md; keeper-sync reports any path here that no longer exists (stale-report.md). -->';

// Every field gets an assistant memory dir, so the assistant context can be
// seeded and the boot injection has something to print. Only when the memory
// root exists — a repo with no .lyte/memory/ is not given one here.
function ensureAssistantDir() {
  if (!fs.existsSync(MEMORY_ROOT)) return false;
  var dir = path.join(MEMORY_ROOT, ASSISTANT_SLUG);
  if (fs.existsSync(dir)) return false;
  fs.mkdirSync(dir, { recursive: true });
  return true;
}

function roleNameFrom(roleContent) {
  var m = String(roleContent || '').match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : '';
}

function fieldNameFromAlignment() {
  var alignmentPath = path.resolve('workers/alignment.md');
  if (!fs.existsSync(alignmentPath)) return 'this field';
  var firstLine = fs.readFileSync(alignmentPath, 'utf8').split('\n')[0];
  var m = firstLine.match(/^#\s+(.+?)(?:\s*—\s*(.+))?$/);
  return m ? m[1].trim() : 'this field';
}

/**
 * Build the Field Orientation block from alignment.md and patterns.md.
 * Three lines: alignment, field, patterns — each IS the concept AND points to the source.
 */
function buildFieldOrientation() {
  var alignmentPath = path.resolve('workers/alignment.md');
  var patternsPath = path.join(MEMORY_ROOT, 'patterns.md');

  var orientationLines = ['## Field Orientation', ''];

  // Alignment: first sentence of purpose only — full detail is at the path
  if (fs.existsSync(alignmentPath)) {
    var alignContent = fs.readFileSync(alignmentPath, 'utf8');

    var alignMatch = alignContent.match(/## Alignment\n\n([^\n]+)/);
    var purpose = alignMatch ? alignMatch[1].trim() : '';
    // Take first sentence only
    var firstSentence = purpose.match(/^[^.]+\./);
    if (firstSentence) purpose = firstSentence[0];

    orientationLines.push('**Alignment:** ' + purpose + ' → `workers/alignment.md`');
  }

  // Field: read the first heading to get the field name, or use a generic line
  var heading = '';
  // Try to get field name from alignment.md title
  if (fs.existsSync(alignmentPath)) {
    var firstLine = fs.readFileSync(alignmentPath, 'utf8').split('\n')[0];
    var titleMatch = firstLine.match(/^#\s+(.+?)(?:\s*—\s*(.+))?$/);
    if (titleMatch) {
      heading = titleMatch[1].trim();
    }
  }
  if (heading) {
    orientationLines.push('**Field:** ' + heading);
  }

  // Patterns: extract a few key preferences as a compact summary
  if (fs.existsSync(patternsPath)) {
    var patContent = fs.readFileSync(patternsPath, 'utf8');
    // Extract first few human preference lines
    var prefLines = [];
    var prefMatch = patContent.match(/## Human Preferences\n([\s\S]*?)(?=\n## |\s*$)/);
    if (prefMatch) {
      var pLines = prefMatch[1].split('\n').filter(function(l) { return l.startsWith('- '); });
      for (var pi = 0; pi < Math.min(pLines.length, 4); pi++) {
        var pref = pLines[pi].replace(/^- (Prefers |Prefers?|Never )?/i, '').split('—')[0].trim();
        // Remove trailing detail after em-dash
        prefLines.push(pref.charAt(0).toLowerCase() + pref.slice(1));
      }
    }
    var patternStr = prefLines.length > 0 ? ' ' + prefLines.join(', ') : '';
    orientationLines.push('**Patterns:**' + patternStr + ' → `.lyte/memory/patterns.md`');
  }

  return orientationLines.join('\n');
}

// Replace (or append) the `## Lessons Available` section. Line-anchored so
// prose citing the heading is never the splice site (#908); the section ends
// at the next `\n## ` / `\n---` or the TRUE end of string via `(?![\s\S])` —
// never a bare `$`, which under the `m` flag matches every LINE end and made
// each sync run stack a fresh index above stranded old bullets (2026-08-30).
function spliceLessonIndex(content, lessonIndex) {
  var lessonSection = /^## Lessons Available[\s\S]*?(?=\n## |\n---|(?![\s\S]))/m;
  var out;
  if (content.match(lessonSection)) {
    // Function replacement: an index line containing `$` must land verbatim,
    // not be interpreted as a replacement-pattern reference. The match ends
    // with the newline that closed the last bullet whenever a blank line
    // separated the section from the next heading — keep that newline, or
    // every rebuild eats the blank line before `## Guides`.
    out = content.replace(lessonSection, function (m) {
      return lessonIndex + (lessonIndex && m.slice(-1) === '\n' ? '\n' : '');
    });
  } else if (!lessonIndex) {
    // Zero lessons and no section: nothing to add. Appending an empty index
    // left "\n\n\n" at EOF, which the guides writer (step 3b) trimmed back to
    // one — a two-line flip-flop on every zero-lesson context whose role file
    // changed (research-analyst, 2026-09-10).
    out = content;
  } else {
    out = content.trimEnd() + '\n\n' + lessonIndex + '\n';
  }
  // A section sitting at EOF has its trailing newline consumed by the match;
  // always end the file with exactly one. Without this, a zero-lesson stub
  // context flip-flopped a trailing-newline diff against any other writer that
  // normalizes one on — a perpetual one-line churn that defeats no-op-commit
  // checks (found 2026-08-31, lytepool architect stub).
  return out.replace(/\n*$/, '\n');
}

// --- Step 3d: the entry point (AGENTS.md) ---
// The universal part of the entry point (assistant-boots-first, the five
// steps, the framework rules) is ONE text in the canon core
// claude-md-core.cjs, spliced between markers on every run — so a field's copy
// tracks canon instead of freezing at the wording it was scaffolded with. A
// marker-less file is adopted once (its hand-written steps replaced, framework
// bullets removed from its own rules); a missing file is created from the
// scaffold. Degrades to a warning when the core has not arrived yet (a
// connect-mode field before its first substrate pull).
//
// AGENTS.md is the only entry point (2026-10-15). Claude Code reads it when no
// CLAUDE.md exists, so the CLAUDE.md glue this step wrote from 2026-09-25 is
// deleted here — only the generated one (core.claudeVerdict); a CLAUDE.md a
// person wrote is reported, never removed. A field that never moved has its
// whole CLAUDE.md carried into AGENTS.md first, so nothing of the field's is
// lost. The same step folds the field's workers/router.md roster into the
// AGENTS.md roles table (core.foldRouterRoles) ahead of router.md's
// retirement: the slug and its triggers, for every role whose file exists.
var CLAUDE_MD_CORE_PATH = canonCorePath('claude-md-core.cjs');

function syncEntryPoint(root) {
  if (!fs.existsSync(CLAUDE_MD_CORE_PATH)) return { status: 'no-core' };
  var core = require(CLAUDE_MD_CORE_PATH);
  var agentsFile = path.join(root, 'AGENTS.md');
  var claudeFile = path.join(root, 'CLAUDE.md');
  var routerFile = path.join(root, 'workers', 'router.md');
  var agentsBefore = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, 'utf8') : null;
  var claudeBefore = fs.existsSync(claudeFile) ? fs.readFileSync(claudeFile, 'utf8') : null;
  var r = core.migrateToAgents(claudeBefore, agentsBefore, fieldNameFromAlignment());
  var agents = r.agents;
  var folded = [];
  if (fs.existsSync(routerFile)) {
    var fold = core.foldRouterRoles(agents, fs.readFileSync(routerFile, 'utf8'), function (rel) {
      return fs.existsSync(path.join(root, 'workers', rel));
    });
    agents = fold.content;
    folded = fold.added;
  }
  if (agents !== agentsBefore) fs.writeFileSync(agentsFile, agents, 'utf8');
  if (r.deleteClaude && claudeBefore !== null) fs.unlinkSync(claudeFile);
  return { status: r.action, claude: r.claude, folded: folded };
}

// --- Step 3e: .claude/settings.json hook wiring ---
// The settings file is the restaurant's — it carries its own permission
// allows, so no update may deliver the whole file.
//
// So the wiring is GENERATED, exactly as CLAUDE.md's framework block is:
// applyHooks replaces the `hooks` key from the canon core and returns every
// other key byte-for-byte, and this runs on every keeper-sync — push, daily
// cron and the Stop hook — so a field converges on the current wiring on its
// next run with no delivery of settings.json.
//
// Fail-soft twice over: an ABSENT file is not created (a repo with no settings
// file has no permissions this could be preserving, and inventing one is a
// provisioning act, not a maintenance one), and a MALFORMED one is left
// untouched with a warning — its `hooks` span cannot be located either, and
// rewriting it from scratch would destroy the field's permissions.
var CLAUDE_SETTINGS_CORE_PATH = canonCorePath('claude-settings-core.cjs');

//
// The ALLOW LIST is the second generated region, converged in the same
// read/compare/write (applyAllows, after applyHooks so both edits land in one
// write). It needs the field's SLUG, because a rule's server segment admits no
// wildcard; the core owns the precedence and this reads the two files it names.
// No slug is not a failure: the retired rules still go, and the seeding waits
// for a run that knows the field.

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    // Absent, or unreadable — the same answer either way: this source does not
    // name a field. resolveFieldSlug tries the next one and, failing all of
    // them, says so in the run log rather than guessing a slug.
    return null;
  }
}

function syncClaudeSettings(root) {
  if (!fs.existsSync(CLAUDE_SETTINGS_CORE_PATH)) return { status: 'no-core' };
  var core = require(CLAUDE_SETTINGS_CORE_PATH);
  var file = path.join(root, '.claude', 'settings.json');
  if (!fs.existsSync(file)) return { status: 'absent' };
  var before = fs.readFileSync(file, 'utf8');

  // Wire only the hooks this repo carries — a `loop` field is not delivered
  // the opt-in tier, and a command whose script is missing fails every event.
  var hooked = core.applyHooks(before, {
    present: function (rel) { return fs.existsSync(path.join(root, rel)); },
  });
  if (hooked.action === 'malformed') return { status: 'malformed', error: hooked.error };
  // A core delivered before applyEnv existed has none; the next delivery brings it.
  if (typeof core.applyEnv === 'function') {
    var envd = core.applyEnv(hooked.content);
    if (envd.action === 'malformed') return { status: 'malformed', error: envd.error };
    hooked = { content: envd.content, action: hooked.action === 'updated' || envd.action === 'updated' ? 'updated' : 'unchanged' };
  }

  var resolved = core.resolveFieldSlug({
    fieldJson: readIfPresent(path.join(root, '.lyte', 'field.json')),
    mcpManifest: readIfPresent(path.join(root, '.lyte', 'mcp-manifest.md')),
    env: process.env,
  });
  var allowed = core.applyAllows(hooked.content, resolved.slug);
  if (allowed.action === 'malformed') return { status: 'malformed', error: allowed.error };

  if (allowed.content !== before) fs.writeFileSync(file, allowed.content, 'utf8');
  return {
    status: allowed.content === before ? 'unchanged' : 'updated',
    hooks: hooked.action,
    allows: allowed.action,
    added: allowed.added + allowed.filled,
    removed: allowed.removed,
    slug: resolved.slug,
    slugSource: resolved.source,
  };
}

// The 3e log line's allow half: what changed, and — when nothing could be
// seeded — which half was skipped and why, so a field reading its own run log
// knows the difference between "already current" and "I do not know who you are".
function describeAllows(cs) {
  var change = cs.allows === 'updated'
    ? 'updated (+' + cs.added + ' \u2212' + cs.removed + ')'
    : 'unchanged';
  if (cs.slug) return change + ' [slug ' + cs.slug + ' via ' + cs.slugSource + ']';
  return change + ' \u2014 field-MCP reads skipped (no slug: neither .lyte/field.json nor a field-MCP URL in .lyte/mcp-manifest.md)';
}

// --- Step 3: the context TITLE ---
// `# <Role> — Field Context: <name>`. buildContextStub writes it once at seed
// time and, until 2026-09-15, nothing ever rewrote it: a field that renamed
// itself kept the OLD name in every role's title forever, while the generated
// Field Orientation block three lines below said the new one — the same file
// disagreeing with itself at every boot.
//
// Regenerated from the same source as that block (alignment.md's H1, via
// fieldNameFromAlignment). Surgical by construction: only the segment after
// `Field Context: ` on the FIRST line, only when that line is the generated
// shape, only when the name actually differs — so a hand-written title is left
// alone and an unchanged one is a fixed point. Run unconditionally rather than
// behind the orientation-changed gate: a context already left stale by the old
// behaviour has an unchanged alignment.md, so a gated fix would never reach it.
var CONTEXT_TITLE_RE = /^(#[ \t]+\S.*?[ \t]+—[ \t]+Field Context:[ \t]*)(.*)$/;

function retitleContext(content, fieldName) {
  if (!content || !fieldName) return content;
  var nl = content.indexOf('\n');
  var first = nl === -1 ? content : content.slice(0, nl);
  var m = first.match(CONTEXT_TITLE_RE);
  if (!m) return content;
  if (m[2].trim() === fieldName) return content;
  return m[1] + fieldName + (nl === -1 ? '' : content.slice(nl));
}

function rebuildContext(worker, lessonIndex) {
  var contextPath = path.join(MEMORY_ROOT, worker, 'context.md');
  var roleFile = findRoleFile(worker);
  var roleContent = roleFile ? fs.readFileSync(roleFile, 'utf8') : '';
  var identityBlock = roleContent ? buildIdentityBlock(roleContent) : '';

  // No context yet but a memory dir and a role file: seed the stub here, so
  // the first boot reads the same generated shape as every later one. The
  // assistant has no role file and is seeded from its built-in identity; any
  // other dir with no role file (a retired role) is left alone.
  if (!fs.existsSync(contextPath)) {
    var isAssistant = worker === ASSISTANT_SLUG;
    if (!roleContent && !isAssistant) return false;
    fs.writeFileSync(contextPath, buildContextStub(
      isAssistant ? 'Assistant' : (roleNameFrom(roleContent) || worker), fieldNameFromAlignment(),
      buildFieldOrientation(), isAssistant ? buildAssistantIdentityBlock() : identityBlock, lessonIndex,
      isAssistant ? { orientationNote: ASSISTANT_ORIENTATION_NOTE } : undefined
    ), 'utf8');
    log('3-CONTEXT', '  ' + worker + ': seeded context.md (generated blocks; curated sections empty)');
    return true;
  }

  var content = fs.readFileSync(contextPath, 'utf8');

  // The title carries the field name; keep it with alignment.md (see above).
  content = retitleContext(content, fieldNameFromAlignment());

  // Rebuild Field Orientation only if alignment.md or patterns.md changed
  var fieldOrientation = buildFieldOrientation();
  var existingOrientation = content.match(/## Field Orientation\n(?:\n?(?:\*\*[^\n]*|\s*))*/)
  var existingBlock = existingOrientation ? existingOrientation[0].trim() : '';
  var newBlock = fieldOrientation.trim();
  var orientationChanged = existingBlock !== newBlock;

  if (!orientationChanged && content.includes('## Field Orientation')) {
    // Sources unchanged — skip rebuild, just update lessons + timestamp
  } else {
  // Remove ALL existing Field Orientation blocks (dedup).
  // A block is: "## Field Orientation\n" followed by lines starting with ** or blank,
  // up to the next ## heading or --- separator.
  content = content.replace(/\n*## Field Orientation\n(?:\n?(?:\*\*[^\n]*|\s*))*\n*/g, '\n');

  // Clean up any double --- separators left behind
  content = content.replace(/---\n+---/g, '---');

  // Insert Field Orientation after the --- separator that follows the header
  var insertAfter = content.indexOf('\n---\n');
  if (insertAfter > -1) {
    var afterSep = insertAfter + 5; // length of '\n---\n'
    content = content.slice(0, afterSep) + '\n' + fieldOrientation + '\n' + content.slice(afterSep).replace(/^\n+/, '\n');
  } else {
    // No separator — add one after the first line
    var firstNewline = content.indexOf('\n');
    if (firstNewline > -1) {
      content = content.slice(0, firstNewline + 1) + '\n---\n\n' + fieldOrientation + '\n' + content.slice(firstNewline + 1);
    }
  }
  } // end orientationChanged

  content = spliceIdentityBlock(content, identityBlock);
  // The Stack slice, for the technical roles only (see roleTakesStack). Read
  // once per run would be nicer; read here keeps the function's inputs local
  // and stack.md is one small file.
  if (roleTakesStack(worker)) {
    var stackMd = '';
    try { stackMd = fs.readFileSync(STACK_MD_PATH, 'utf8'); }
    catch { /* no stack.md in this checkout — leave whatever the context has */ }
    if (stackMd) content = spliceStackBlock(content, buildStackBlock(stackMd));
  }
  content = spliceRecentBlock(content, buildRecentBlock(recentItemsFor(worker)));
  content = spliceLessonIndex(content, lessonIndex);
  content = content.replace(MECHANICAL_STAMP, '');
  // The stamp used to sit between the title and the separator; its removal
  // must not leave a run of blank lines under the title.
  content = content.replace(/^(#[^\n]*\n)\n{2,}/, '$1\n');

  // Soft-cap ceiling — inject a note the worker will see on next boot.
  // 300 lines, matching boot-sequence.md §1 and keeper context ("soft cap
  // ~300"); this script said 150 for a while — doctrine drift, audit
  // 2026-08-30. The removal regex matches any old denominator so stale /150
  // notes clear themselves. The assistant's context is injected at every
  // session start, so it carries a tighter cap.
  var CONTEXT_SOFT_CAP = worker === 'assistant' ? ASSISTANT_CONTEXT_SOFT_CAP : 300;
  var lineCount = content.split('\n').length;
  var ceilingNote = '<!-- keeper-sync: context.md is ' + lineCount + '/' + CONTEXT_SOFT_CAP + ' lines. Condense: move verbose sections into lessons, keep this file as orientation + index. -->';
  var existingNote = /<!-- keeper-sync: context\.md is \d+\/\d+ lines\. .* -->/;

  if (lineCount > CONTEXT_SOFT_CAP) {
    warn('3-CONTEXT', worker + '/context.md is ' + lineCount + ' lines (soft cap: ' + CONTEXT_SOFT_CAP + ')');
    if (content.match(existingNote)) {
      content = content.replace(existingNote, ceilingNote);
    } else {
      // Insert after first line
      var firstNl = content.indexOf('\n');
      content = content.slice(0, firstNl + 1) + '\n' + ceilingNote + '\n' + content.slice(firstNl + 1);
    }
  } else {
    // Under limit — remove any existing note
    content = content.replace('\n' + existingNote.source.replace('\\d+', '\\d+') + '\n', '\n');
    content = content.replace(existingNote, '');
  }

  // The shape (2026-10-15): reported, never rewritten — curating is the
  // Keeper's judgment, this only says where it is owed.
  var shape = contextShape(content);
  if (shape.curatedBytes > CURATED_BUDGET_BYTES || shape.extra.length > 0) {
    warn('3-CONTEXT', worker + '/context.md: curated ' + Math.round(shape.curatedBytes / 1024) + ' KB (budget ' +
      Math.round(CURATED_BUDGET_BYTES / 1024) + ' KB)' + (shape.extra.length ? '; sections outside Always/Orientation/Gotchas/Open Threads: ' + shape.extra.join(', ') : '') +
      ' — Keeper: move history to knowledge.md and depth to lessons/');
  }

  fs.writeFileSync(contextPath, content, 'utf8');
  return true;
}

// --- Step 3b: GUIDES ---
// Resolves each worker's convention guides SEMANTICALLY: a cheap classifier
// (same pattern the harness already trusts in agent-loop's autoRoute) reads
// the role file plus the field's guide catalog and picks the guides that are
// that role's working conventions. Portable to any field — guides are
// discovered by glob, workers by role file, no hardcoded table. (Calibration
// 2026-06-11 showed raw embedding cosine can't make this call: whole-file
// similarity reflects shared markdown structure as much as topic —
// backend↔coding 0.574 vs backend↔design 0.577.)
//
// The result is written as a managed `## Guides` section in the worker's
// context.md, cached by role-file content hash — re-resolved only when the
// role changes. Both harnesses consume the same line: worker-boot.cjs inlines
// the listed guides; Claude Code workers read them per boot-sequence.md.
// Soft-skips without an LLM key (worker-boot falls back to its static map).

// The ONE LLM call shape for step 3b: a system prompt, one user turn,
// a short text answer. Anthropic (ANTHROPIC_API_KEY, Haiku) when the runtime
// has it, else OpenAI (OPENAI_API_KEY, gpt-4o-mini); null when neither key is
// set so each caller soft-skips. Throws on any HTTP failure. No SDK — Node
// >=22 fetch, because a field's keeper-sync.yml runs this with no npm install.
var GUIDES_MODEL = process.env.AUTO_ROUTER_MODEL || 'claude-haiku-4-5-20251001';
var OPENAI_FALLBACK_MODEL = 'gpt-4o-mini';

function llmKey() {
  if (process.env.ANTHROPIC_API_KEY) return { wire: 'anthropic', key: process.env.ANTHROPIC_API_KEY };
  if (process.env.OPENAI_API_KEY) return { wire: 'openai', key: process.env.OPENAI_API_KEY };
  return null;
}

async function llmComplete(sys, user, opts) {
  var cred = llmKey();
  if (!cred) return null;
  var maxTokens = (opts && opts.maxTokens) || 300;
  var timeoutMs = (opts && opts.timeoutMs) || 15000;
  var label = (opts && opts.label) || 'llm';
  var res, json, text;
  if (cred.wire === 'anthropic') {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': cred.key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GUIDES_MODEL,
        system: sys,
        messages: [{ role: 'user', content: user }],
        max_tokens: maxTokens,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(label + ' HTTP ' + res.status);
    json = await res.json();
    text = (Array.isArray(json.content) ? json.content : [])
      .map(function (b) { return (b && b.type === 'text' && b.text) || ''; }).join('');
  } else {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cred.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_FALLBACK_MODEL,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        max_tokens: maxTokens,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(label + ' HTTP ' + res.status);
    json = await res.json();
    text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  }
  return (text || '').trim();
}

// A JSON answer, with the ```json fence a model sometimes adds unwrapped.
function parseJsonAnswer(raw) {
  var m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec((raw || '').trim());
  return JSON.parse(m ? m[1] : (raw || '').trim());
}
var WORKER_SPECTRUM_DIRS = [
  'primordials', 'software-engineering', 'strategy', 'communications', 'operations',
];

function discoverGuides() {
  var dirs = ['mechanica', 'prima'];
  var guides = [];
  for (var d = 0; d < dirs.length; d++) {
    var dir = path.resolve('workers', dirs[d]);
    if (!fs.existsSync(dir)) continue;
    var files = fs.readdirSync(dir).filter(function(f) {
      // Include both *-guide.md (authoring guides) and review-checklist.md
      // (the lean reviewer gate surface derived from coding-guide.md).
      return f.endsWith('-guide.md') || f === 'review-checklist.md';
    });
    for (var i = 0; i < files.length; i++) {
      var p = path.join(dir, files[i]);
      var content = fs.readFileSync(p, 'utf8');
      guides.push({
        path: dirs[d] + '/' + files[i],
        intro: content.slice(0, 300).replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return guides;
}

function findRoleFile(worker) {
  for (var i = 0; i < WORKER_SPECTRUM_DIRS.length; i++) {
    var p = path.resolve('workers', WORKER_SPECTRUM_DIRS[i], worker + '.md');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function classifyGuidesForRole(roleContent, guides) {
  if (!llmKey()) return null;
  var catalog = guides.map(function(g) {
    return '- `' + g.path + '` — ' + g.intro;
  }).join('\n');
  var sys = 'You assign working-convention guides to a worker role. ' +
    'Pick a guide ONLY if the role’s day-to-day work directly produces the kind ' +
    'of artifact that guide governs (writing code → coding guide; designing UI/visuals ' +
    '→ design guide; designing data structures → data guide; reviewing code for ' +
    'merge gates → review checklist, NOT the full coding guide). Most non-technical ' +
    'roles get zero guides. Reply strict JSON only: {"guides": ["<path>", ...]} ' +
    'with 0-3 paths chosen from the catalog, exactly as written there.\n\nCatalog:\n' + catalog;
  var raw = await llmComplete(sys, roleContent.slice(0, 3000), {
    maxTokens: 100, timeoutMs: 15000, label: 'guides classifier',
  });
  var parsed = parseJsonAnswer(raw);
  var valid = guides.map(function(g) { return g.path; });
  return (Array.isArray(parsed.guides) ? parsed.guides : [])
    .filter(function(p) { return valid.indexOf(p) !== -1; });
}

// ── Guides: resolution ──────────────────────────────────────────────────────
// Three inputs, unioned, then narrowed to the field's chosen set
// (spec-framework-essentials-and-opt-out-2026-09-25, keeper task):
//
//   1. WHAT THE CONTEXT ALREADY SAYS. Parsed off the existing line and carried
//      forward, so resolution is MONOTONE — a run with no classifier key, or a
//      classifier that answers differently today, can never take a guide away
//      from a role that had it. Losing a guide silently is the failure mode
//      that matters: the role stops reading it and nobody notices.
//   2. WHAT THE ROLE FILE DECLARES. Every catalog guide the role file names
//      literally. This is the half that was missing, and it is why two contexts
//      read `none` while their role file named a guide: `devops-engineer`
//      (coding-guide + data-guide) and `research-analyst` (data-guide), both
//      checked 2026-09-25. It needs NO API KEY, so the fix holds on a run with
//      no LLM key — which is most runs in a field.
//   3. WHAT THE CLASSIFIER PICKS. Unchanged, and now additive rather than
//      authoritative.
//
// Then narrowed by the field's `guides` list in `.lyte/field.json`, read
// FAIL-OPEN: absent, malformed or empty means ALL guides, never none. The
// narrowing is driven by a read of the field's own repo, and the field whose
// setting cannot be read is exactly the field that would otherwise be left
// with no guides at all — backend-developer lesson `opt-in-narrowing-fails-open`,
// the same rule `narrowRoleLibrary` already holds.

/**
 * Pure: the field's chosen guide paths, or null for "all of them". `guides` is
 * added to the field.json schema by the same spec's field.json task; this
 * reader predates it on purpose and treats every absence as "all".
 */
function readFieldGuideSet(fieldJsonPath) {
  var raw;
  try { raw = fs.readFileSync(fieldJsonPath || path.resolve('.lyte', 'field.json'), 'utf8'); }
  catch { return null; }                       // no file → all guides
  var parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }  // unparseable → all
  var chosen = parsed && parsed.guides;
  if (!Array.isArray(chosen)) return null;     // absent or not a list → all
  var paths = chosen.filter(function (g) { return typeof g === 'string' && g.trim(); })
    .map(function (g) { return g.trim(); });
  if (paths.length === 0) return null;         // an empty list is not "no guides"
  return paths;
}

/** Pure: the catalog narrowed to the field's set. An entry naming a guide this
 *  field does not have is ignored, not an error — a field may drop a guide. */
function allowedGuidePaths(guides, chosen) {
  var all = guides.map(function (g) { return g.path; });
  if (!chosen) return all;
  return all.filter(function (p) { return chosen.indexOf(p) !== -1; });
}

/** Pure: the catalog guides a role file names literally. */
function declaredGuidePaths(roleContent, allowed) {
  var text = String(roleContent || '');
  return allowed.filter(function (p) { return text.indexOf(p) !== -1; });
}

/** Pure: the guide paths an existing `**Guides:** …` line already names.
 *  `none` yields []; anything not in `allowed` is dropped by the caller. */
function guidesOnLine(context) {
  var m = String(context || '').match(/^\*\*Guides:\*\*[ \t]*([^\n<]*)/m);
  if (!m) return [];
  var body = m[1].trim();
  if (!body || body === 'none') return [];
  return body.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

/** Pure: the union, in catalog order so the line is stable across runs. */
function resolveGuideSet(allowed, existing, declared, picked) {
  var want = {};
  [existing, declared, picked].forEach(function (list) {
    (list || []).forEach(function (p) { want[p] = true; });
  });
  return allowed.filter(function (p) { return want[p]; });
}

function upsertGuidesSection(contextPath, line) {
  var content = fs.readFileSync(contextPath, 'utf8');
  var section = '## Guides\n\n' + line + '\n';
  var sectionRegex = /## Guides\n[\s\S]*?(?=\n## |\n---|$)/;
  if (content.match(sectionRegex)) {
    content = content.replace(sectionRegex, section);
  } else {
    content = content.trimEnd() + '\n\n' + section;
  }
  fs.writeFileSync(contextPath, content, 'utf8');
}

async function resolveGuides(workers) {
  var guides = discoverGuides();
  if (guides.length === 0) return { resolved: 0, cached: 0, skipped: 0 };
  // The field's chosen set, read ONCE per run and fail-open (null = all).
  var chosen = readFieldGuideSet();
  var allowed = allowedGuidePaths(guides, chosen);
  if (chosen && allowed.length === 0) {
    // Every name in the field's list is unknown to this checkout's catalog.
    // That is a typo or a guide that has not arrived yet, never an instruction
    // to leave every role with no guide — fail open to the whole catalog.
    warn('3b-GUIDES', '.lyte/field.json names ' + chosen.length + ' guide(s), none of which ' +
      'exist here (' + chosen.join(', ') + ') — using the whole catalog instead');
    allowed = allowedGuidePaths(guides, null);
  }
  var resolved = 0;
  var cached = 0;
  var skipped = 0;
  var noKeyReported = false;
  for (var i = 0; i < workers.length; i++) {
    var worker = workers[i];
    if (NON_WORKER_DIRS.indexOf(worker) !== -1) { skipped++; continue; }
    var contextPath = path.join(MEMORY_ROOT, worker, 'context.md');
    var roleFile = findRoleFile(worker);
    if (!fs.existsSync(contextPath) || !roleFile) { skipped++; continue; }

    var roleContent = fs.readFileSync(roleFile, 'utf8');
    // The cache key covers the role file AND the allowed set, so narrowing the
    // field's guides (or a guide arriving) re-resolves every line instead of
    // being masked by a hash that only tracked the role file.
    var roleHash = contentHash(roleContent + '\n' + allowed.join(',')).slice(0, 12);
    var context = fs.readFileSync(contextPath, 'utf8');
    if (context.indexOf('<!-- guides-resolved: ' + roleHash + ' -->') !== -1) {
      cached++;
      continue;
    }

    // The two inputs that need no network. Computed BEFORE the classifier so a
    // run with no API key still fills a `none` line from the role file — which
    // is the whole point of the keeper task.
    var existing = guidesOnLine(context);
    var declared = declaredGuidePaths(roleContent, allowed);
    var picked = [];
    try {
      var classified = await classifyGuidesForRole(roleContent, guides);
      if (classified === null) {
        // No key. Report it ONCE and keep going on the offline inputs, rather
        // than abandoning the step — the old behaviour returned here and left
        // every `none` line as it was, forever, on every keyless run.
        if (!noKeyReported) {
          log('3b-GUIDES', '  no classifier key — resolving from the role files\' own ' +
            'declared guides only (no guide is ever removed by this path)');
          noKeyReported = true;
        }
      } else {
        picked = classified;
      }
    } catch (e) {
      warn('3b-GUIDES', worker + ': classifier failed (' + e.message +
        ') — falling back to the declared guides');
    }

    var set = resolveGuideSet(allowed, existing, declared, picked);
    var line = '**Guides:** ' + (set.length > 0 ? set.join(', ') : 'none') +
      ' <!-- guides-resolved: ' + roleHash + ' -->';
    try {
      upsertGuidesSection(contextPath, line);
    } catch (e) {
      warn('3b-GUIDES', worker + ': ' + e.message);
      continue;
    }
    var added = set.filter(function (g) { return existing.indexOf(g) === -1; });
    log('3b-GUIDES', '  ' + worker + ': ' + (set.length > 0 ? set.join(', ') : 'none') +
      (added.length > 0 ? '  (+' + added.join(', ') + ')' : ''));
    resolved++;
  }
  return { resolved: resolved, cached: cached, skipped: skipped };
}

// --- Step 3c: SKILLS (bridges) ---
// A skill's canonical home is workers/skills/<name>/SKILL.md — model-agnostic
// canon that reaches every field through the updates PR. Claude Code
// discovers skills ONLY under .claude/skills/<name>/SKILL.md, so this step
// derives a bridge there for every skill: the same name + description (the
// trigger the harness matches a task against) and a body that says to read
// the source. Derived output — never hand-edited, regenerated on every run,
// removed when its source is gone (only bridges carrying the generated
// marker are ever removed; a hand-placed skill under .claude/skills/ is left
// alone and reported). The old .lyte/skills/manifest.md registry keyed on a
// boot step that no longer existed; a skill is a file the harness can load.

var SKILLS_DIR = 'workers/skills';
var SKILL_BRIDGE_DIR = path.join('.claude', 'skills');
var SKILL_BRIDGE_MARKER = '<!-- generated by keeper-sync from workers/skills/';

// Pure: { name, description } from a SKILL.md's frontmatter, or null. The
// description may be a single line or a YAML block scalar (| / > with the
// usual chomping suffixes) — ported skills use both shapes.
function parseSkillFrontmatter(content) {
  var m = String(content || '').match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!m) return null;
  var lines = m[1].split('\n');
  var out = {};
  for (var i = 0; i < lines.length; i++) {
    var kv = lines[i].match(/^(name|description|kind):\s*(.*)$/);
    if (!kv) continue;
    var key = kv[1];
    var val = kv[2].trim();
    if (/^[|>][+-]?$/.test(val)) {
      var block = [];
      for (var j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) block.push(lines[j].trim());
      val = block.join(val.charAt(0) === '|' ? '\n' : ' ');
      i += block.length;
    }
    out[key] = val.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  if (!out.name || !out.description) return null;
  return out;
}

// Scan (fs read-only): every workers/skills/<dir>/SKILL.md with usable
// frontmatter. Returns [{ dir, name, description, kind }] sorted by dir.
function discoverSkills(root) {
  var base = path.join(root, SKILLS_DIR);
  if (!fs.existsSync(base)) return [];
  var out = [];
  var entries = fs.readdirSync(base, { withFileTypes: true }).filter(function (e) { return e.isDirectory(); });
  for (var i = 0; i < entries.length; i++) {
    var p = path.join(base, entries[i].name, 'SKILL.md');
    if (!fs.existsSync(p)) continue;
    var raw = fs.readFileSync(p, 'utf8');
    var fm = parseSkillFrontmatter(raw);
    if (!fm) { warn('3c-SKILLS', entries[i].name + '/SKILL.md: no name/description frontmatter — no bridge'); continue; }
    var fmEnd = raw.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
    out.push({
      dir: entries[i].name, name: fm.name, description: fm.description, kind: fm.kind || '',
      body: fmEnd ? raw.slice(fmEnd[0].length).replace(/^\n+/, '') : raw,
      license: fs.existsSync(path.join(base, entries[i].name, 'LICENSE.txt')),
    });
  }
  return out.sort(function (a, b) { return a.dir < b.dir ? -1 : 1; });
}

// Pure: the bridge file — a FULL derived copy of the skill, not a pointer.
// Invoking a skill must deliver the whole skill in one hop: a pointer asked
// the model to take a second step (read the source), which is exactly the
// step a lesser model drops after choosing correctly (2026-09-10). The copy
// cannot drift — it is regenerated from the source on every run. The
// description is emitted as a JSON string, which is valid YAML whatever
// characters the source used; a multi-line one is folded to a single line so
// the harness's trigger surface stays one field. A ported skill's license
// travels with the copy as a pointer to the LICENSE.txt beside the source.
function buildSkillBridge(skill) {
  var desc = String(skill.description).replace(/\s*\n\s*/g, ' ').trim();
  var head = [
    '---',
    'name: ' + skill.name,
    'description: ' + JSON.stringify(desc),
    '---',
    '',
    SKILL_BRIDGE_MARKER + skill.dir + '/SKILL.md — edit the source, not this -->',
    '<!-- source: ' + SKILLS_DIR + '/' + skill.dir + '/SKILL.md (reaches every restaurant repo through the template)' +
      (skill.license ? ' · license: ' + SKILLS_DIR + '/' + skill.dir + '/LICENSE.txt' : '') + ' -->',
    '',
  ];
  var body = String(skill.body || '').replace(/\s+$/, '');
  return head.join('\n') + (body ? body + '\n' : '');
}

// Write changed bridges; remove generated bridges whose source is gone.
// Returns { written: [...], removed: [...], unchanged: n, foreign: [...] }.
function syncSkillBridges(root) {
  var skills = discoverSkills(root);
  var bridgeBase = path.join(root, SKILL_BRIDGE_DIR);
  var result = { written: [], removed: [], unchanged: 0, foreign: [] };
  var live = {};
  for (var i = 0; i < skills.length; i++) {
    var s = skills[i];
    live[s.dir] = 1;
    var dir = path.join(bridgeBase, s.dir);
    var file = path.join(dir, 'SKILL.md');
    var want = buildSkillBridge(s);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === want) { result.unchanged++; continue; }
    ensureDir(dir);
    fs.writeFileSync(file, want, 'utf8');
    result.written.push(s.dir);
  }
  if (fs.existsSync(bridgeBase)) {
    var entries = fs.readdirSync(bridgeBase, { withFileTypes: true }).filter(function (e) { return e.isDirectory(); });
    for (var j = 0; j < entries.length; j++) {
      var name = entries[j].name;
      if (live[name]) continue;
      var bf = path.join(bridgeBase, name, 'SKILL.md');
      var isGenerated = fs.existsSync(bf) && fs.readFileSync(bf, 'utf8').indexOf(SKILL_BRIDGE_MARKER) !== -1;
      if (isGenerated) {
        fs.rmSync(path.join(bridgeBase, name), { recursive: true, force: true });
        result.removed.push(name);
      } else {
        result.foreign.push(name);
      }
    }
  }
  return result;
}

// --- Journal entries, derived in memory ---
// Every DATED entry a worker's journal has ever carried: knowledge.md plus the
// verbatim entries a synthesis pass moved into knowledge-archive.md. Used by
// the step-7 dormancy detection (a worker with no entries anywhere, and no
// lessons, has never accumulated judgment).
//
// This replaces knowledgeFilesFor(), which counted the per-entry mirror FILES
// under knowledge/ + knowledge-archive/ (2026-10-07). Same answer, nothing
// written: the mirrors only ever existed for dated entries (the old SPLIT
// skipped undated ones), so the `entry.date` filter here is what keeps the
// count identical — an undated `## Always` heading in an archive file is file
// chrome, not an entry, and must not make a dormant role look alive.
function knowledgeEntriesFor(worker) {
  var files = [
    path.join(MEMORY_ROOT, worker, 'knowledge.md'),
    path.join(MEMORY_ROOT, worker, 'knowledge-archive.md'),
  ];
  var entries = [];
  for (var f = 0; f < files.length; f++) {
    if (!fs.existsSync(files[f])) continue;
    var parsed = parseKnowledgeEntries(fs.readFileSync(files[f], 'utf8'));
    for (var i = 0; i < parsed.length; i++) {
      if (parsed[i].date) entries.push(parsed[i]);
    }
  }
  return entries;
}

// --- Step 7: DETECT (trigger-flag) ---
// §7 mechanical synthesis trigger: a worker's knowledge.md that fires any of
// the three triggers gets a standalone `keeper-synthesis-needed` marker
// appended — the session-boot fact and the assistant loop then see it without
// depending on the worker remembering to flag (the trigger that under-fired in practice).
// Idempotent: skips when a standalone marker is already present.

// Pure: the entries a Keeper has not passed over yet — everything after the
// LAST `## … — Keeper synthesis` heading. Before the first such heading, the
// whole journal is unsynthesized, which is the honest reading of a journal no
// pass has ever touched.
function unsynthesizedEntries(content) {
  var entries = parseKnowledgeEntries(content);
  var lastPass = -1;
  for (var i = 0; i < entries.length; i++) {
    if (/^keeper synthesis\b/i.test(entries[i].title)) lastPass = i;
  }
  return entries.slice(lastPass + 1);
}

// Pure decision: WHY this journal needs synthesis, or null when it does not.
// Returns the reason so the run log and the flag line name the trigger that
// fired instead of implying the size one always did. Checked in the order the
// canon states them (entries, lines, age); the first match wins, and an undated
// entry can never satisfy the age trigger.
function synthesisTriggerReason(content, opts) {
  opts = opts || {};
  var entryThreshold = opts.entryThreshold !== undefined ? opts.entryThreshold : SYNTHESIS_ENTRY_THRESHOLD;
  var lineThreshold = opts.lineThreshold !== undefined ? opts.lineThreshold : SYNTHESIS_LINE_THRESHOLD;
  var ageDays = opts.ageDays !== undefined ? opts.ageDays : SYNTHESIS_AGE_DAYS;
  var now = opts.now || new Date();

  var unsynth = unsynthesizedEntries(content);
  if (unsynth.length >= entryThreshold) {
    return unsynth.length + ' unsynthesized entries (>=' + entryThreshold + ')';
  }

  var lines = content.split('\n').length;
  if (lines >= lineThreshold) {
    return lines + ' lines (>=' + lineThreshold + ')';
  }

  var oldest = null;
  for (var i = 0; i < unsynth.length; i++) {
    var d = unsynth[i].date ? parseDate(unsynth[i].date) : null;
    if (d !== null && (oldest === null || d < oldest)) oldest = d;
  }
  if (oldest !== null) {
    var age = Math.floor((now.getTime() - oldest.getTime()) / 86400000);
    if (age >= ageDays) {
      return 'oldest unsynthesized entry is ' + age + ' days old (>=' + ageDays + ')';
    }
  }

  return null;
}

// Pure decision: does this knowledge.md need a synthesis flag appended? True iff
// a trigger fires AND it has no standalone marker yet.
function shouldSynthesisFlag(content, opts) {
  if (synthesisTriggerReason(content, opts) === null) return false;
  return !content.split('\n').some(function (l) { return l.trim() === SYNTHESIS_FLAG; });
}

// Returns the trigger reason when it flagged, null when it did not — the caller
// logs it. The appended bytes are unchanged: one blank line, then the flag.
function autoFlagOversizedKnowledge(worker) {
  var knowledgePath = path.join(MEMORY_ROOT, worker, 'knowledge.md');
  if (!fs.existsSync(knowledgePath)) return null;

  var content = fs.readFileSync(knowledgePath, 'utf8');
  if (!shouldSynthesisFlag(content)) return null;

  var sep = content.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(knowledgePath, content + sep + '\n' + SYNTHESIS_FLAG + '\n', 'utf8');
  return synthesisTriggerReason(content);
}

// --- Step 7: DETECT (dormancy) ---
// Mechanical dormancy report: workers with no lessons, no knowledge entries,
// and no archive are roster entries that have never accumulated judgment —
// candidates for merging back into a spectrum generalist. Written to
// .lyte/memory/ so the auto-commit picks it up and humans actually see it
// (Actions logs are not a place anyone reads).

// Memory dirs that aren't individual workers: shared homes and spectrum-level
// dirs. Dormancy is a roster question, and these aren't roster entries.
// Directories under .lyte/memory/ that are not a worker; a repo that has none
// is unaffected — the names just match nothing.
var NON_WORKER_DIRS = [
  'inspiration', 'reports',
  'strategy', 'software-engineering', 'communications', 'operations',
];

function detectDormantWorkers(workers) {
  var dormant = [];
  for (var i = 0; i < workers.length; i++) {
    var w = workers[i];
    if (NON_WORKER_DIRS.indexOf(w) !== -1 || w === ASSISTANT_SLUG) continue;
    var base = path.join(MEMORY_ROOT, w);
    var hasLessons = fs.existsSync(path.join(base, 'lessons')) &&
      fs.readdirSync(path.join(base, 'lessons')).some(function(f) { return f.endsWith('.md'); });
    var hasKnowledge = knowledgeEntriesFor(w).length > 0 ||
      (fs.existsSync(path.join(base, 'knowledge.md')) &&
       fs.readFileSync(path.join(base, 'knowledge.md'), 'utf8').trim().split('\n').length > 3);
    if (!hasLessons && !hasKnowledge) dormant.push(w);
  }
  return dormant;
}

function writeDormancyReport(dormant) {
  var reportPath = path.join(MEMORY_ROOT, 'dormancy-report.md');
  var lines = [
    '# Dormant Workers',
    '',
    'Maintained by keeper-sync (step 7, DETECT). Workers listed here have no',
    'lessons, no knowledge entries, and no archive — they exist in the roster',
    'but have never accumulated judgment. Per the demand-driven roster rule,',
    'they are candidates for merging into a spectrum generalist until work',
    'volume justifies a dedicated worker.',
    '',
  ];
  if (dormant.length === 0) {
    lines.push('None — every instantiated worker has accumulated memory.');
  } else {
    for (var i = 0; i < dormant.length; i++) lines.push('- ' + dormant[i]);
  }
  var content = lines.join('\n') + '\n';

  // Only write on change — keeps keeper-sync commits quiet when nothing moved.
  if (fs.existsSync(reportPath) && fs.readFileSync(reportPath, 'utf8') === content) {
    return false;
  }
  fs.writeFileSync(reportPath, content, 'utf8');
  return true;
}

// --- Step 7: DETECT (stale anchors) ---
// Lessons carry `touches:` anchors naming the exact artifacts they concern.
// A PATH anchor whose file no longer exists is the mechanical staleness
// signal: the artifact the lesson was learned on is gone or renamed, so the
// lesson presumptively describes a world that no longer exists (2026-08-30
// audit — "old things brought up as if still current"). Deterministic, no
// LLM: this REPORTS for Keeper review, it never retires a lesson itself —
// an anchor can be legitimately external (another repo, a historical path
// cited on purpose), so the judgment stays the Keeper's.

// The checkable subset of a unit's anchors. Multi-grain basenames/stems and
// bare symbols can't be existence-checked; only paths (a '/' plus a known
// source extension) and /api routes can. Prose ellipses ("/api/...",
// "foo/.../bar") are shorthand, not references — never checkable.
function checkablePathAnchors(touches) {
  return (touches || []).filter(function (a) {
    if (a.indexOf('...') !== -1 || a.slice(-1) === '/') return false;
    // A segment that is only a dot-EXTENSION (`.tsx/.ts` from prose like
    // "the .tsx/.ts files") is filename shorthand, not a path. Extension
    // names only — dot-DIRECTORIES (`.github/`, `.lyte/`) stay checkable.
    if (/(^|\/)\.(ts|tsx|cjs|mjs|js|sql|md|json|sh)(\/|$)/.test(a)) return false;
    if (a.indexOf('/api/') === 0) return true;
    return a.indexOf('/') > 0 && /\.(ts|tsx|cjs|js|mjs|sql|md|json|sh)$/.test(a);
  });
}

// Every file path in the repo, relative with '/' separators — built once per
// scan so anchors written as PARTIAL paths (lessons cite `lessons/x.md` or
// `commits/route.ts`, not the repo-root form) resolve by suffix instead of
// false-flagging. First live run without this matched from root only and
// flagged 66 lessons, most of them partial-path false positives.
function buildRepoFileList(root) {
  var out = [];
  var SKIP = { 'node_modules': 1, '.git': 1, '.next': 1 };
  (function walkFs(dir, relDir) {
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (SKIP[e.name]) continue;
      var r = relDir ? relDir + '/' + e.name : e.name;
      if (e.isDirectory()) walkFs(path.join(dir, e.name), r);
      else out.push(r);
    }
  })(root, '');
  return out;
}

// Does an /api route anchor still resolve? Mapped under src/app, with a
// trailing file segment (`.../route.ts`) stripped — the walk is over route
// DIRECTORIES. Param spellings differ by intent: `[param]` is Next's literal
// dir shape and matches any bracketed dir at its level; `{param}` is prose
// shorthand ("some value here") and matches ANY dir — an anchor citing
// `/api/fields/[slug]/{platform}/{op}` names the live railway/vercel route
// shape even though no dir is literally named {platform}.
function apiRouteExists(anchor, root) {
  var clean = anchor.replace(/\/[\w.-]+\.(ts|tsx|js)$/, '');
  var segs = ('src/app' + clean).split('/').filter(Boolean);
  var dirs = [root];
  for (var s = 0; s < segs.length; s++) {
    var isBracket = /^\[.*\]$/.test(segs[s]);
    var isBrace = /^\{.*\}$/.test(segs[s]);
    var next = [];
    for (var d = 0; d < dirs.length; d++) {
      var entries;
      try { entries = fs.readdirSync(dirs[d], { withFileTypes: true }); } catch { continue; }
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isDirectory()) continue;
        var name = entries[i].name;
        var hit = isBrace ? true :
          isBracket ? name.charAt(0) === '[' :
          name === segs[s];
        if (hit) next.push(path.join(dirs[d], name));
      }
    }
    if (next.length === 0) return false;
    dirs = next;
  }
  return true;
}

function anchorExists(anchor, root, repoFiles) {
  if (anchor.indexOf('/api/') === 0) return apiRouteExists(anchor, root);
  if (fs.existsSync(path.join(root, anchor))) return true;
  var suffix = '/' + anchor;
  for (var i = 0; i < repoFiles.length; i++) {
    if (repoFiles[i].length > anchor.length && repoFiles[i].slice(-suffix.length) === suffix) return true;
  }
  return false;
}

// Scan (fs read-only): every lesson whose checkable anchors include at least
// one missing path. Returns [{worker, slug, missing: [...]}].
function detectStaleAnchors(workerLessons, root) {
  var repoFiles = buildRepoFileList(root);
  var stale = [];
  var workers = Object.keys(workerLessons).sort();
  for (var w = 0; w < workers.length; w++) {
    var lessons = workerLessons[workers[w]];
    for (var i = 0; i < lessons.length; i++) {
      var anchors = checkablePathAnchors(resolveTouches(lessons[i].content));
      var missing = anchors.filter(function (a) { return !anchorExists(a, root, repoFiles); });
      if (missing.length > 0) {
        stale.push({ worker: workers[w], slug: lessons[i].slug, missing: missing });
      }
    }
  }
  return stale;
}

// Every backticked repo path a context.md asserts. Only the checkable subset
// (checkablePathAnchors) is returned, so prose, symbols and shorthand never
// false-flag. The generated Lessons index and Guides line carry no repo
// paths a curator wrote, so the whole file is scanned.
function extractContextPaths(content) {
  var seen = {};
  var out = [];
  var re = /`([^`\n]+)`/g;
  var m;
  while ((m = re.exec(String(content || '')))) {
    var tok = m[1].trim();
    if (tok.indexOf(' ') !== -1 || seen[tok]) continue;
    // A template, glob or shell form (`{worker}/context.md`, `lessons/*.md`,
    // `$CLAUDE_CONFIG_DIR/...`, `~/.railway/...`, `use-ray-view(s).ts`,
    // `YYYYMMDD_*.sql`, `ADR-NNN-...`) describes a SHAPE, not a file — it
    // can be wrong, but it cannot be existence-checked. `{param}` inside an
    // /api route stays checkable (anchorExists treats it as any segment).
    if (/[*$~<>()]/.test(tok) || /YYYY|NNN/.test(tok)) continue;
    if (tok.indexOf('/api/') !== 0 && /[{}]/.test(tok)) continue;
    seen[tok] = 1;
    out.push(tok);
  }
  return checkablePathAnchors(out);
}

// Scan (fs read-only): every context.md that asserts a repo path which no
// longer exists — the same review cue as a stale lesson anchor, aimed at the
// one file every boot reads. The 2026-09-09 audit found retired CLIs, a
// deleted lane runner and a memory layout two moves old still asserted as
// current in four contexts; nothing checked them because nothing scanned them.
function detectStaleContextPaths(workers, root) {
  var repoFiles = buildRepoFileList(root);
  var stale = [];
  var sorted = workers.slice().sort();
  for (var w = 0; w < sorted.length; w++) {
    var p = path.join(root, '.lyte', 'memory', sorted[w], 'context.md');
    if (!fs.existsSync(p)) continue;
    // The generated Recent block is journal history, not a claim: a title that
    // names a since-deleted path is a true record of the day it was written.
    var ctx = fs.readFileSync(p, 'utf8').replace(RECENT_SECTION, '');
    var anchors = extractContextPaths(ctx);
    var missing = anchors.filter(function (a) { return !anchorExists(a, root, repoFiles); });
    if (missing.length > 0) stale.push({ worker: sorted[w], missing: missing });
  }
  return stale;
}

function writeStaleReport(stale, staleContexts) {
  staleContexts = staleContexts || [];
  var reportPath = path.join(MEMORY_ROOT, 'stale-report.md');
  var lines = [
    '# Stale Lesson Anchors',
    '',
    'Maintained by keeper-sync (step 7, DETECT). Each lesson below carries a',
    '`touches:` path anchor that no longer exists in the tree — the artifact it',
    'was learned on is gone or renamed, so the lesson may describe a world that',
    'no longer exists. REVIEW CUE, not a verdict: an anchor can be legitimately',
    'external or historical. The Keeper, on dispatch, either updates the lesson',
    '(and its anchors), retires it, or marks the anchor deliberate by curating',
    'the frontmatter `touches:` list.',
    '',
  ];
  if (stale.length === 0) {
    lines.push('None — every checkable lesson anchor resolves.');
  } else {
    for (var i = 0; i < stale.length; i++) {
      lines.push('- `' + stale[i].worker + '/lessons/' + stale[i].slug + '.md` — missing: ' +
        stale[i].missing.map(function (m) { return '`' + m + '`'; }).join(', '));
    }
  }
  lines.push(
    '',
    '## Context claims',
    '',
    'A `context.md` below asserts a repo path that no longer exists. It is the',
    'file every boot reads, so a stale claim there is told to the worker as',
    'current fact. Fix the claim (or date it as history) in the curated body.',
    ''
  );
  if (staleContexts.length === 0) {
    lines.push('None — every repo path asserted in a context.md resolves.');
  } else {
    for (var c = 0; c < staleContexts.length; c++) {
      lines.push('- `' + staleContexts[c].worker + '/context.md` — missing: ' +
        staleContexts[c].missing.map(function (m) { return '`' + m + '`'; }).join(', '));
    }
  }
  var content = lines.join('\n') + '\n';
  if (fs.existsSync(reportPath) && fs.readFileSync(reportPath, 'utf8') === content) {
    return false;
  }
  fs.writeFileSync(reportPath, content, 'utf8');
  return true;
}

// --- Step 7: DETECT (recall report) ---
// The recall loop had no measurement. `.claude/hooks/memory-recall.cjs`
// scores lessons against every prompt and the harness injects the top few, and
// nothing anywhere recorded WHICH lesson was injected or whether it then
// mattered — so a lesson that fires on every prompt and is never used looked
// exactly like one that lands every time (2026-10-07 memory-loop assessment).
//
// Two halves, deliberately split:
//   the ADAPTER writes  — .claude/hooks/memory-recall.cjs appends one JSON line
//     per injection to .lyte/memory/recall-log.jsonl. Per-checkout telemetry,
//     gitignored, append-only, and it carries a HASH of the prompt's first 80
//     characters, never the prompt text.
//   this step aggregates — the log, WHEN PRESENT, plus the journals become
//     .lyte/memory/recall-report.md, which IS committed: it is a Keeper review
//     cue like stale-report.md, not telemetry. With no log the file is left
//     untouched rather than rewritten from zeros — see writeRecallReport.
//
// CITED means a journal entry written AFTER the lesson was last touched names
// its slug. "Last touched" is the most recent YYYY-MM-DD the lesson file itself
// carries — the field dates its own claims, which keeps this file-only (a
// checkout's mtimes are all checkout time, and git is not this script's to
// read). A citation before that date is work the current wording never saw.
var RECALL_LOG_NAME = 'recall-log.jsonl';

// One line of the log: { ts, prompt, lessons: [{ worker, slug, score }] }.
// Returns { entries: n, recalled: { '<worker>/<slug>': count } }, or null when
// no log exists in this checkout. A malformed line is skipped, never fatal —
// the log is append-only from a hook that must never wedge a prompt.
function readRecallLog(logPath) {
  if (!fs.existsSync(logPath)) return null;
  var recalled = {};
  var entries = 0;
  var lines = fs.readFileSync(logPath, 'utf8').split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    var row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (!row || !Array.isArray(row.lessons)) continue;
    entries++;
    for (var j = 0; j < row.lessons.length; j++) {
      var l = row.lessons[j];
      if (!l || !l.slug) continue;
      var key = (l.worker || '?') + '/' + l.slug;
      recalled[key] = (recalled[key] || 0) + 1;
    }
  }
  return { entries: entries, recalled: recalled };
}

// Pure: the most recent YYYY-MM-DD anywhere in a lesson file, or null.
function lessonLastTouch(content) {
  var dates = String(content || '').match(/\d{4}-\d{2}-\d{2}/g);
  if (!dates) return null;
  return dates.sort()[dates.length - 1];
}

// Every dated journal entry in the field, from both knowledge.md and
// knowledge-archive.md of every worker — the corpus citations are counted in.
function allJournalEntries(workers) {
  var out = [];
  for (var i = 0; i < workers.length; i++) {
    var entries = knowledgeEntriesFor(workers[i]);
    for (var j = 0; j < entries.length; j++) {
      out.push({ date: entries[j].date, content: entries[j].content });
    }
  }
  return out;
}

// Pure: the report rows. A lesson is cited by a journal entry dated strictly
// after its last touch whose text names its slug.
function buildRecallRows(workerLessons, journalEntries, recalled) {
  var rows = [];
  var workers = Object.keys(workerLessons).sort();
  for (var w = 0; w < workers.length; w++) {
    var lessons = workerLessons[workers[w]];
    for (var i = 0; i < lessons.length; i++) {
      var slug = lessons[i].slug;
      var touched = lessonLastTouch(lessons[i].content);
      var cited = 0;
      for (var j = 0; j < journalEntries.length; j++) {
        var e = journalEntries[j];
        if (touched !== null && !(e.date > touched)) continue;
        if (e.content.indexOf(slug) !== -1) cited++;
      }
      rows.push({
        worker: workers[w],
        slug: slug,
        touched: touched,
        recalled: recalled[workers[w] + '/' + slug] || 0,
        cited: cited,
      });
    }
  }
  // Loudest signal first, then stable by name.
  rows.sort(function (a, b) {
    if (b.recalled !== a.recalled) return b.recalled - a.recalled;
    if (b.cited !== a.cited) return b.cited - a.cited;
    if (a.worker !== b.worker) return a.worker < b.worker ? -1 : 1;
    return a.slug < b.slug ? -1 : 1;
  });
  return rows;
}

// The retire-or-sharpen cue: recalled often enough to be a real pattern, and
// never once cited since it was last written. Either the lesson is not worth
// its slot, or its trigger surface is pulling prompts it cannot help.
var RECALL_UNUSED_FLOOR = 5;

// Pure: the generated report.
function buildRecallReport(rows, logEntries) {
  var lines = [
    '# Lesson Recall vs. Use',
    '',
    'Maintained by keeper-sync (step 7, DETECT). RECALLED counts injections from',
    'this checkout\'s `.lyte/memory/recall-log.jsonl` (per-checkout, gitignored —',
    'the hook writes a hash of the prompt, never its text). CITED counts journal',
    'entries dated AFTER the lesson was last touched that name its slug. REVIEW',
    'CUE, not a verdict: recall is per-checkout, so a lesson can be doing its job',
    'on a machine whose log this is not.',
    '',
  ];
  lines.push(logEntries + ' recorded injection(s) in this checkout\'s log.', '');

  var unused = rows.filter(function (r) { return r.recalled >= RECALL_UNUSED_FLOOR && r.cited === 0; });
  lines.push('## Recalled >=' + RECALL_UNUSED_FLOOR + ' times, never cited', '');
  if (unused.length === 0) {
    lines.push('None — no lesson is being injected without being used.');
  } else {
    lines.push('Retire it, or sharpen its `triggers:` so it stops matching prompts it', 'cannot help.', '');
    for (var u = 0; u < unused.length; u++) {
      lines.push('- `' + unused[u].worker + '/lessons/' + unused[u].slug + '.md` — recalled ' +
        unused[u].recalled + ', cited 0');
    }
  }

  var signal = rows.filter(function (r) { return r.recalled > 0 || r.cited > 0; });
  lines.push('', '## Per lesson', '');
  if (signal.length === 0) {
    lines.push('No lesson has been recalled or cited yet.');
  } else {
    for (var i = 0; i < signal.length; i++) {
      lines.push('- `' + signal[i].worker + '/lessons/' + signal[i].slug + '.md` — recalled ' +
        signal[i].recalled + ', cited ' + signal[i].cited +
        (signal[i].touched ? ' (last touched ' + signal[i].touched + ')' : ''));
    }
  }
  var silent = rows.length - signal.length;
  if (silent > 0) {
    lines.push('', silent + ' further lesson(s) have been neither recalled nor cited — ' +
      'listed nowhere above so the signal stays readable.');
  }
  return lines.join('\n') + '\n';
}

// NO LOG, NO WRITE. The report is committed and the log is per-checkout, so the
// one thing this must not do is let two environments fight over the file: the
// GitHub Action has no log and would blank a human checkout's recall counts on
// every cron run, which is the committed-bookkeeping churn the mirrors were
// deleted for. Only a checkout that actually measured recall writes the numbers;
// everywhere else the file is left exactly as it is (and in a field where recall
// was never logged, it simply does not exist — there is nothing to report).
// Pure: how many injections the committed report was built from — the number
// its own header line states — or 0 when there is no report or no such line.
function reportedInjections(reportText) {
  var m = /^(\d+) recorded injection\(s\)/m.exec(String(reportText || ''));
  return m ? parseInt(m[1], 10) : 0;
}

function writeRecallReport(workerLessons, workers) {
  var log = readRecallLog(path.join(MEMORY_ROOT, RECALL_LOG_NAME));
  if (log === null) return { status: 'no-log', rows: [] };

  var rows = buildRecallRows(workerLessons, allJournalEntries(workers), log.recalled);
  var content = buildRecallReport(rows, log.entries);
  var reportPath = path.join(MEMORY_ROOT, 'recall-report.md');
  var existing = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '';
  if (existing === content) return { status: 'unchanged', rows: rows };
  // The report is committed; the log it is built from is per-checkout and
  // gitignored. So a fresh checkout (one injection in its log) used to
  // overwrite a report built from a richer log, and every cloud session
  // dirtied the file on its first Stop (2026-10-07: 4 → 1, four times in one
  // conversation). Only a log that knows at least as much as the committed
  // report may rewrite it — counts never regress, the richest log wins.
  if (log.entries < reportedInjections(existing)) {
    return { status: 'kept', rows: rows, reason: 'this checkout\'s log (' + log.entries +
      ') knows less than the committed report (' + reportedInjections(existing) + ')' };
  }
  fs.writeFileSync(reportPath, content, 'utf8');
  return { status: 'updated', rows: rows };
}

// --- Main ---

async function main() {
  console.log('');
  console.log('=== keeper-sync.cjs ===');
  console.log('Date: ' + today());
  console.log('');

  // Discover workers — the assistant's dir is guaranteed first, so a field
  // that never had one gets its assistant context seeded in step 3.
  if (ensureAssistantDir()) log('init', 'Created ' + path.join(MEMORY_ROOT, ASSISTANT_SLUG) + ' (assistant memory)');
  var workers = discoverWorkers();
  log('init', 'Found ' + workers.length + ' workers');

  if (workers.length === 0) {
    log('init', 'No workers found in ' + MEMORY_ROOT + '. Nothing to do.');
    return;
  }

  // --- Step 2: INDEX ---
  log('2-INDEX', 'Scanning lessons...');
  var workerLessons = {};
  for (var i = 0; i < workers.length; i++) {
    workerLessons[workers[i]] = scanLessons(workers[i]);
  }
  var totalLessons = Object.values(workerLessons).reduce(function (sum, l) { return sum + l.length; }, 0);
  log('2-INDEX', 'Found ' + totalLessons + ' lessons across all workers.');

  // --- Step 3: CONTEXT ---
  log('3-CONTEXT', 'Rebuilding context.md files...');
  var contextUpdated = 0;
  for (var i = 0; i < workers.length; i++) {
    var lessons = workerLessons[workers[i]];
    var lessonIndex = buildLessonIndex(lessons);
    if (rebuildContext(workers[i], lessonIndex)) {
      contextUpdated++;
    }
  }
  log('3-CONTEXT', 'Updated ' + contextUpdated + ' context files.');

  // --- Step 3b: GUIDES ---
  log('3b-GUIDES', 'Resolving role guides semantically...');
  // `noKey` is gone: the step no longer bails when the classifier is
  // unavailable — it resolves from the role files' own declared guides, which
  // needs no key and is the half that fills a `none` line. resolveGuides logs
  // the keyless path once when it takes it.
  var gr = await resolveGuides(workers);
  log('3b-GUIDES', 'Done. ' + gr.resolved + ' resolved, ' + gr.cached + ' cached, ' + gr.skipped + ' skipped.');

  // --- Step 3c: SKILLS ---
  var sb = syncSkillBridges(path.resolve('.'));
  log('3c-SKILLS', 'Bridges: ' + sb.written.length + ' written' + (sb.written.length ? ' (' + sb.written.join(', ') + ')' : '') +
    ', ' + sb.removed.length + ' removed' + (sb.removed.length ? ' (' + sb.removed.join(', ') + ')' : '') + ', ' + sb.unchanged + ' unchanged.');
  if (sb.foreign.length > 0) {
    warn('3c-SKILLS', 'hand-placed under .claude/skills/ with no workers/skills/ source (left alone): ' + sb.foreign.join(', ') +
      ' — move the skill to workers/skills/<name>/SKILL.md so every harness gets it');
  }

  // --- Step 3d: AGENTS.md (the entry point) ---
  var cm = syncEntryPoint(path.resolve('.'));
  if (cm.status === 'no-core') {
    warn('3d-ENTRY', '.bnb/canon/claude-md-core.cjs is missing — AGENTS.md left as is; restore it from the template');
  } else {
    log('3d-ENTRY', cm.status === 'migrated'
      ? 'entry point MOVED to AGENTS.md — your CLAUDE.md content is there in full, and CLAUDE.md is removed (Claude Code reads AGENTS.md when no CLAUDE.md exists)'
      : 'AGENTS.md framework block: ' + cm.status);
    if (cm.claude === 'deleted' && cm.status !== 'migrated') log('3d-ENTRY', 'removed the generated CLAUDE.md glue — AGENTS.md is the only entry point');
    if (cm.claude === 'shadowing') {
      warn('3d-ENTRY', 'CLAUDE.md is hand-written and SHADOWS AGENTS.md — Claude Code reads CLAUDE.md instead whenever it exists. Move what it says into AGENTS.md and delete it');
    }
    if (cm.folded.length > 0) log('3d-ENTRY', 'roles table: carried ' + cm.folded.length + ' role(s) from workers/router.md (' + cm.folded.join(', ') + ')');
  }

  // --- Step 3e: .claude/settings.json ---
  var cs = syncClaudeSettings(path.resolve('.'));
  if (cs.status === 'no-core') {
    warn('3e-SETTINGS', '.bnb/canon/claude-settings-core.cjs is missing — .claude/settings.json left as is; restore it from the template');
  } else if (cs.status === 'absent') {
    log('3e-SETTINGS', '.claude/settings.json hooks: absent (no settings file in this repo)');
  } else if (cs.status === 'malformed') {
    warn('3e-SETTINGS', '.claude/settings.json is not valid JSON (' + cs.error + ') — left untouched; fix the file and the next run wires it');
  } else {
    log('3e-SETTINGS', '.claude/settings.json hooks: ' + cs.hooks + ' \u00b7 allows: ' + describeAllows(cs));
  }

  // --- Step 7: DETECT ---
  // Flag, never condense (2026-10-15). A journal past a §7 trigger gets the
  // standalone marker; synthesis itself is the Keeper's judgment pass — run by
  // the assistant loop as a keeper lane, or by a Keeper in session
  // (boot-sequence.md §3, Synthesis). Then the dormancy report.
  var flagged = [];
  for (var i = 0; i < workers.length; i++) {
    var reason = autoFlagOversizedKnowledge(workers[i]);
    if (reason) flagged.push(workers[i] + ' (' + reason + ')');
  }
  if (flagged.length > 0) {
    log('7-DETECT', 'Synthesis-flagged: ' + flagged.join(', '));
  }

  var dormant = detectDormantWorkers(workers);
  var reportChanged = writeDormancyReport(dormant);
  log('7-DETECT', dormant.length + ' dormant worker(s)' +
    (dormant.length > 0 ? ': ' + dormant.join(', ') : '') +
    (reportChanged ? ' — report updated' : ' — report unchanged'));

  var stale = detectStaleAnchors(workerLessons, path.resolve('.'));
  var staleContexts = detectStaleContextPaths(workers, path.resolve('.'));
  var staleChanged = writeStaleReport(stale, staleContexts);
  log('7-DETECT', stale.length + ' lesson(s) with stale path anchors, ' +
    staleContexts.length + ' context(s) with stale claims' +
    (staleChanged ? ' — stale-report updated' : ' — stale-report unchanged'));

  var recall = writeRecallReport(workerLessons, workers);
  if (recall.status === 'no-log') {
    log('7-DETECT', 'no recall log in this checkout — recall-report left as is');
  } else if (recall.status === 'kept') {
    log('7-DETECT', 'recall-report kept — ' + recall.reason);
  } else {
    var unusedCount = recall.rows.filter(function (r) {
      return r.recalled >= RECALL_UNUSED_FLOOR && r.cited === 0;
    }).length;
    log('7-DETECT', unusedCount + ' lesson(s) recalled >=' + RECALL_UNUSED_FLOOR +
      ' times with 0 citations — recall-report ' + recall.status);
  }

  console.log('');
  console.log('=== keeper-sync complete ===');
}

// --- Exports ---

module.exports = {
  // Pure helpers exported for tests.
  spliceLessonIndex: spliceLessonIndex,
  buildLessonIndex: buildLessonIndex,
  contextShape: contextShape,
  CURATED_SECTIONS: CURATED_SECTIONS,
  CURATED_BUDGET_BYTES: CURATED_BUDGET_BYTES,
  checkablePathAnchors: checkablePathAnchors,
  detectStaleAnchors: detectStaleAnchors,
  // Step 3 generated Identity block + stub seeding + stale context claims —
  // pure halves exported for the contract tests.
  parseRoleIdentity: parseRoleIdentity,
  buildIdentityBlock: buildIdentityBlock,
  spliceIdentityBlock: spliceIdentityBlock,
  buildContextStub: buildContextStub,
  retitleContext: retitleContext,
  buildAssistantIdentityBlock: buildAssistantIdentityBlock,
  // Step 3b GUIDES — the pure halves of the resolution.
  readFieldGuideSet: readFieldGuideSet,
  allowedGuidePaths: allowedGuidePaths,
  declaredGuidePaths: declaredGuidePaths,
  guidesOnLine: guidesOnLine,
  resolveGuideSet: resolveGuideSet,
  // Step 3 generated Stack block (from workers/stack.md).
  buildStackBlock: buildStackBlock,
  spliceStackBlock: spliceStackBlock,
  roleTakesStack: roleTakesStack,
  STACK_GENERATED_NOTE: STACK_GENERATED_NOTE,
  // Step 3 generated Recent block (from knowledge.md) — pure halves.
  recentEntries: recentEntries,
  newestPerRole: newestPerRole,
  buildRecentBlock: buildRecentBlock,
  spliceRecentBlock: spliceRecentBlock,
  RECENT_SECTION: RECENT_SECTION,
  RECENT_COUNT: RECENT_COUNT,
  RECENT_FIELD_COUNT: RECENT_FIELD_COUNT,
  ensureAssistantDir: ensureAssistantDir,
  syncEntryPoint: syncEntryPoint,
  syncClaudeSettings: syncClaudeSettings,
  describeAllows: describeAllows,
  rebuildContext: rebuildContext,
  extractContextPaths: extractContextPaths,
  detectStaleContextPaths: detectStaleContextPaths,
  MECHANICAL_STAMP: MECHANICAL_STAMP,
  ASSISTANT_CONTEXT_SOFT_CAP: ASSISTANT_CONTEXT_SOFT_CAP,
  // Step 3c skill bridges — pure halves + the fs sync (root-parameterized), for
  // the contract tests.
  parseSkillFrontmatter: parseSkillFrontmatter,
  discoverSkills: discoverSkills,
  buildSkillBridge: buildSkillBridge,
  syncSkillBridges: syncSkillBridges,
  SKILL_BRIDGE_MARKER: SKILL_BRIDGE_MARKER,
  shouldSynthesisFlag: shouldSynthesisFlag,
  unsynthesizedEntries: unsynthesizedEntries,
  synthesisTriggerReason: synthesisTriggerReason,
  SYNTHESIS_ENTRY_THRESHOLD: SYNTHESIS_ENTRY_THRESHOLD,
  SYNTHESIS_LINE_THRESHOLD: SYNTHESIS_LINE_THRESHOLD,
  SYNTHESIS_AGE_DAYS: SYNTHESIS_AGE_DAYS,
  SYNTHESIS_FLAG: SYNTHESIS_FLAG,
  ARCHIVE_DAYS: ARCHIVE_DAYS,
  // Step 7 dormancy: the in-memory entry derivation that replaced the per-entry
  // mirror files, and the roster decision over it (both cwd-relative — the
  // contract tests run them in a fixture tree).
  knowledgeEntriesFor: knowledgeEntriesFor,
  detectDormantWorkers: detectDormantWorkers,
  // Step 7 recall report: the pure halves (the log reader, the last-touch
  // date, the row builder and the renderer), for the contract tests.
  readRecallLog: readRecallLog,
  lessonLastTouch: lessonLastTouch,
  buildRecallRows: buildRecallRows,
  buildRecallReport: buildRecallReport,
  writeRecallReport: writeRecallReport,
  reportedInjections: reportedInjections,
  RECALL_UNUSED_FLOOR: RECALL_UNUSED_FLOOR,
  RECALL_LOG_NAME: RECALL_LOG_NAME,
  parseKnowledgeEntries: parseKnowledgeEntries,
  autoFlagOversizedKnowledge: autoFlagOversizedKnowledge,
  // Memory hash/tag/anchor primitives: ONE definition, scripts/lib/memory-core.cjs,
  // required lazily above. resolveUnitTags/resolveUnitTouches are the historical
  // export names for the core's resolveTags/resolveTouches.
  contentHash: contentHash,
  inferLessonMeta: inferLessonMeta,
  resolveUnitTags: resolveUnitTags,
  mineAnchors: mineAnchors,
  resolveUnitTouches: resolveUnitTouches,
};

// --- Run ---

if (require.main === module) {
  main().catch(function (err) {
    console.error('[keeper-sync] FATAL:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
