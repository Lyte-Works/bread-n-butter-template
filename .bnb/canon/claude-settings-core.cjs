'use strict';
// IS: Bread 'n' Butter's `.claude/settings.json` core — ONE definition of the
//     two GENERATED regions of a restaurant repo's settings file (the hook
//     wiring, and the restaurant-MCP read tools in `permissions.allow`), and the
//     pure splices that install them. scripts/keeper-sync.cjs (step 3e)
//     applies both on every run, so a restaurant repo tracks this file instead
//     of freezing at what it was born with. The settings-file twin of
//     claude-md-core.cjs beside it.
// IS NOT: The restaurant's own allows, its `autoMode`, or any other key —
//     applyHooks replaces the `hooks` key alone and applyAllows touches only
//     the allow entries named here; every other byte comes back as it was
//     found. Not the hooks themselves (`.claude/hooks/*`). Pure Node builtins,
//     no I/O: the callers read and write the file.
//
// OWNERSHIP INSIDE `hooks`: this file owns the EVENT KEYS it names below,
// whole — a hand-edited SessionStart is restored, not merged. An event key it
// does NOT name is left alone. Retiring an event therefore means defining it
// here with the wiring it should end at (`[]` to wire nothing), not deleting
// it from CANON_HOOKS.

// Each command points at a hook in `.claude/hooks/`, except the write checker,
// which lives with the skill it serves (workers/skills/invoice-intake/hooks/)
// and is always wired: it re-does the per-row arithmetic on every row the
// restaurant MCP stores (`create_row` / `update_row`).
// `CLAUDE_PROJECT_DIR` is Claude Code's repo-root variable; the `:-.}` fallback
// keeps the command valid if it is ever unset. A `.claude/hooks/` script the
// repo does not carry is not wired (applyHooks' `present` filter): wiring a
// script that is not there is a hook that fails on every event.
var CANON_HOOKS = {
  SessionStart: [
    {
      hooks: [
        {
          type: 'command',
          command: '"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/session-boot.sh"',
        },
        {
          type: 'command',
          command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/lane-report.cjs" SessionStart',
        },
      ],
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [
        // The role boot (2026-10-15): a prompt opening `Role: <slug>` or
        // `/dispatch <slug>` gets that role's context.md. Before recall, so
        // the role's orientation reads ahead of the lessons.
        {
          type: 'command',
          command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/role-boot.cjs"',
        },
        {
          type: 'command',
          command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/memory-recall.cjs"',
        },
        {
          type: 'command',
          command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/lane-report.cjs" UserPromptSubmit',
        },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: 'mcp__.*__(create_row|update_row)',
      hooks: [
        {
          type: 'command',
          command: 'node "${CLAUDE_PROJECT_DIR:-.}/workers/skills/invoice-intake/hooks/check-write.cjs"',
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: 'command',
          command: '"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/cleanup-worktrees.sh"',
        },
        {
          type: 'command',
          command: '"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/check-synthesis.sh"',
        },
        {
          type: 'command',
          command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/lane-report.cjs" Stop',
        },
      ],
    },
  ],
};

var CANON_EVENTS = Object.keys(CANON_HOOKS);

// The ONE canon key of the settings file's `env` block (2026-10-15): pin
// Claude Code's short built-in system prompt. It is the default on current
// models already, but the default moves by model and version; pinned, every
// session starts from the same ~12k-character prompt. A STRING, never a
// number — a settings value that fails Claude Code's schema is silently
// dropped in headless runs. Every other `env` key is the field's.
var CANON_ENV = {
  CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: '1',
};

// The repo-relative script a hook command runs, or null.
function hookScript(entry) {
  var m = /\.claude\/hooks\/[\w.-]+/.exec(String(entry && entry.command || ''));
  return m ? m[0] : null;
}

// CANON_HOOKS with every command whose script `present(rel)` denies removed,
// and any group left empty dropped. No `present` → all of it (the scaffold,
// which ships every hook).
function canonHooksFor(present) {
  if (typeof present !== 'function') return CANON_HOOKS;
  var out = {};
  CANON_EVENTS.forEach(function (event) {
    out[event] = CANON_HOOKS[event].map(function (group) {
      var copy = Object.assign({}, group);
      copy.hooks = group.hooks.filter(function (h) {
        var rel = hookScript(h);
        return !rel || present(rel);
      });
      return copy;
    }).filter(function (group) { return group.hooks.length > 0; });
  });
  return out;
}

// --- A minimal JSON span scanner ------------------------------------------
// Why not parse, mutate and re-stringify the whole file: a settings file is
// the FIELD's, and round-tripping it through JSON.stringify rewrites every
// key's formatting — a `"//"` documentation key, a three-space indent on
// `autoMode` — and a step that "only updates the hooks"
// must not quietly reflow those. So the object is parsed for VALIDATION and
// for the merge, and the file is edited as TEXT at one span.

// src[i] is the opening quote; returns the index just past the closing quote.
function scanString(src, i) {
  i++;
  while (i < src.length) {
    var c = src.charAt(i);
    if (c === '\\') { i += 2; continue; }
    if (c === '"') return i + 1;
    i++;
  }
  return -1;
}

// Returns the index just past the value starting at src[i].
function scanValue(src, i) {
  var c = src.charAt(i);
  if (c === '"') return scanString(src, i);
  if (c === '{' || c === '[') {
    var depth = 0;
    while (i < src.length) {
      var d = src.charAt(i);
      if (d === '"') {
        i = scanString(src, i);
        if (i < 0) return -1;
        continue;
      }
      if (d === '{' || d === '[') depth++;
      else if (d === '}' || d === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return -1;
  }
  // A primitive — number, true, false, null — ends at the next structural
  // character or whitespace.
  var j = i;
  while (j < src.length && ',}] \t\r\n'.indexOf(src.charAt(j)) === -1) j++;
  return j;
}

// Every top-level key of the root object, with the text span of its value,
// plus the index of the root object's closing brace. Returns null when the
// text is not a single object (the caller has already JSON.parsed it, so this
// only fires on shapes JSON.parse accepts and this does not — a bare array or
// scalar at the top level).
function objectSpans(src, open) {
  if (src.charAt(open) !== '{') return null;
  var i = open + 1;
  var depth = 1;
  var keys = [];
  while (i < src.length) {
    var c = src.charAt(i);
    if (c === '"') {
      var strStart = i;
      var strEnd = scanString(src, i);
      if (strEnd < 0) return null;
      if (depth === 1) {
        var j = strEnd;
        while (j < src.length && ' \t\r\n'.indexOf(src.charAt(j)) !== -1) j++;
        if (src.charAt(j) === ':') {
          var vStart = j + 1;
          while (vStart < src.length && ' \t\r\n'.indexOf(src.charAt(vStart)) !== -1) vStart++;
          var vEnd = scanValue(src, vStart);
          if (vEnd < 0) return null;
          keys.push({
            name: JSON.parse(src.slice(strStart, strEnd)),
            keyStart: strStart,
            valueStart: vStart,
            valueEnd: vEnd,
          });
          i = vEnd;
          continue;
        }
      }
      i = strEnd;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return { open: open, keys: keys, close: i };
    }
    i++;
  }
  return null;
}

// The root object's spans — the same scan, anchored at the first `{`.
function topLevelSpans(src) {
  var open = src.indexOf('{');
  if (open === -1) return null;
  return objectSpans(src, open);
}

// One named key's span inside a scanned object, or null.
function keyIn(spans, name) {
  if (!spans) return null;
  for (var i = 0; i < spans.keys.length; i++) {
    if (spans.keys[i].name === name) return spans.keys[i];
  }
  return null;
}

// Every ELEMENT of the array whose `[` is at src[open], with its text span,
// plus the index of the closing bracket. The allow list is edited element by
// element for the same reason `hooks` is edited as one span: the array is the
// FIELD's, and re-stringifying it would reflow entries nobody asked us to
// touch. Returns null when the span does not scan.
function arrayElementSpans(src, open) {
  if (src.charAt(open) !== '[') return null;
  var i = open + 1;
  var elements = [];
  while (i < src.length) {
    var c = src.charAt(i);
    if (' \t\r\n,'.indexOf(c) !== -1) { i++; continue; }
    if (c === ']') return { open: open, close: i, elements: elements };
    var end = scanValue(src, i);
    if (end < 0 || end <= i) return null;
    elements.push({ start: i, end: end, raw: src.slice(i, end) });
    i = end;
  }
  return null;
}

// `permissions.allow`, scanned — null when the file has no such array (a
// settings file with no permissions block at all is a real shape; see
// applyAllows).
function findAllowArray(src) {
  var perms = keyIn(topLevelSpans(src), 'permissions');
  if (!perms || src.charAt(perms.valueStart) !== '{') return null;
  var allow = keyIn(objectSpans(src, perms.valueStart), 'allow');
  if (!allow || src.charAt(allow.valueStart) !== '[') return null;
  return arrayElementSpans(src, allow.valueStart);
}

// The element's own string value, or null when it is not a JSON string (a
// field is free to put an object in its allow list; we only reason about
// strings).
function elementString(el) {
  try {
    var v = JSON.parse(el.raw);
    return typeof v === 'string' ? v : null;
  } catch {
    // The caller has already parsed the whole file, so a span that will not
    // parse means the SCAN is wrong, not the file. Treating it as "not a rule
    // we reason about" leaves it exactly where it is, which is the safe read.
    return null;
  }
}

// The whitespace between the previous newline and `pos`, or null when
// something else sits there (a one-line array). This is the indent a new
// sibling element gets.
function indentBefore(src, pos) {
  var nl = src.lastIndexOf('\n', pos - 1);
  if (nl === -1) return null;
  var run = src.slice(nl + 1, pos);
  return /^[ \t]*$/.test(run) ? run : null;
}

// The leading whitespace of the line `pos` sits on — the base indent an empty
// array is re-rendered against.
function lineIndent(src, pos) {
  var nl = src.lastIndexOf('\n', pos - 1);
  var line = src.slice(nl + 1);
  var m = line.match(/^[ \t]*/);
  return m ? m[0] : '';
}

// --- The splice -----------------------------------------------------------

// Canon's events, whole; the file's own events, in the positions it had them.
function mergeHooks(existing, present) {
  var canon = canonHooksFor(present);
  var out = {};
  var src = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  Object.keys(src).forEach(function (event) {
    out[event] = Object.prototype.hasOwnProperty.call(canon, event)
      ? canon[event]
      : src[event];
  });
  CANON_EVENTS.forEach(function (event) {
    if (!Object.prototype.hasOwnProperty.call(out, event)) out[event] = canon[event];
  });
  return out;
}

// JSON.stringify(value, null, 2) renders from column zero; the `hooks` value
// sits one level inside the root object, so every line after the first is
// shifted by one indent step. This is the one place canon imposes formatting:
// two spaces, matching what the scaffold generator emits.
function renderHooksValue(hooks) {
  return JSON.stringify(hooks, null, 2)
    .split('\n')
    .map(function (line, i) { return i === 0 ? line : '  ' + line; })
    .join('\n');
}

function ensureTrailingNewline(s) {
  return s.replace(/\n*$/, '\n');
}

/**
 * Install the canon hook wiring in a `.claude/settings.json`.
 *   { content, action, error? }   action: 'unchanged' | 'updated' | 'malformed'
 * - 'malformed' returns the input untouched, with `error` set: a settings file
 *   the caller cannot parse is a file whose `hooks` span cannot be located
 *   either, and rewriting it from scratch would destroy the field's
 *   permissions. Fail soft, warn, leave it for a human.
 * - Every key but `hooks` is returned byte-for-byte, including the whitespace
 *   around it. `hooks` is replaced in place; a file with no `hooks` key gains
 *   one as its last key.
 * - `opts.present(rel)` — does the repo carry `.claude/hooks/<x>`? A canon
 *   command whose script is absent is not wired. Omitted → everything is.
 */
function applyHooks(settingsJsonText, opts) {
  var src = String(settingsJsonText == null ? '' : settingsJsonText);
  var parsed;
  try {
    parsed = JSON.parse(src);
  } catch (e) {
    return { content: src, action: 'malformed', error: e.message };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { content: src, action: 'malformed', error: 'top level is not a JSON object' };
  }
  var spans = topLevelSpans(src);
  if (!spans) {
    return { content: src, action: 'malformed', error: 'could not locate the root object' };
  }
  var rendered = renderHooksValue(mergeHooks(parsed.hooks, opts && opts.present));

  var hooksSpan = null;
  for (var i = 0; i < spans.keys.length; i++) {
    if (spans.keys[i].name === 'hooks') hooksSpan = spans.keys[i];
  }

  var out;
  if (hooksSpan) {
    out = src.slice(0, hooksSpan.valueStart) + rendered + src.slice(hooksSpan.valueEnd);
  } else if (spans.keys.length > 0) {
    var last = spans.keys[spans.keys.length - 1];
    out = src.slice(0, last.valueEnd) + ',\n  "hooks": ' + rendered + src.slice(last.valueEnd);
  } else {
    out = src.slice(0, spans.open) + '{\n  "hooks": ' + rendered + '\n}' + src.slice(spans.close + 1);
  }
  out = ensureTrailingNewline(out);
  return { content: out, action: out === src ? 'unchanged' : 'updated' };
}

/**
 * Install CANON_ENV in a `.claude/settings.json`'s `env` block.
 *   { content, action, error? }   action: 'unchanged' | 'updated' | 'malformed'
 * Every key but `env` comes back byte-for-byte; inside `env`, the field's own
 * keys are kept and canon's are set. A file with no `env` gains one as its
 * last key.
 */
function applyEnv(settingsJsonText) {
  var src = String(settingsJsonText == null ? '' : settingsJsonText);
  var parsed;
  try {
    parsed = JSON.parse(src);
  } catch (e) {
    return { content: src, action: 'malformed', error: e.message };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { content: src, action: 'malformed', error: 'top level is not a JSON object' };
  }
  var env = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env) ? parsed.env : {};
  var needs = Object.keys(CANON_ENV).some(function (k) { return env[k] !== CANON_ENV[k]; });
  if (!needs && parsed.env === env) return { content: src, action: 'unchanged' };
  var merged = Object.assign({}, env, CANON_ENV);
  var spans = topLevelSpans(src);
  if (!spans) return { content: src, action: 'malformed', error: 'could not locate the root object' };
  var rendered = renderHooksValue(merged);
  var envSpan = null;
  for (var i = 0; i < spans.keys.length; i++) {
    if (spans.keys[i].name === 'env') envSpan = spans.keys[i];
  }
  var out;
  if (envSpan) {
    out = src.slice(0, envSpan.valueStart) + rendered + src.slice(envSpan.valueEnd);
  } else if (spans.keys.length > 0) {
    var last = spans.keys[spans.keys.length - 1];
    out = src.slice(0, last.valueEnd) + ',\n  "env": ' + rendered + src.slice(last.valueEnd);
  } else {
    out = src.slice(0, spans.open) + '{\n  "env": ' + rendered + '\n}' + src.slice(spans.close + 1);
  }
  out = ensureTrailingNewline(out);
  return { content: out, action: out === src ? 'unchanged' : 'updated' };
}

// --- The allow list -------------------------------------------------------
// The SECOND generated region of the settings file, and the reason it needs
// generating is the same as `hooks`: the file is the restaurant's, so no
// update can deliver it whole, and a repo born before a list changed would
// keep the old one forever.
//
// Three acts, and only three (applyAllows):
//   (a) DROP a rule that pre-approves a tool no session here holds: a whole
//       retired server (RETIRED_SERVER_PREFIXES, a LIST matched literally —
//       a prefix is added when a server is retired, never inferred), or one
//       of the retired Lyte field-MCP reads (RETIRED_FIELD_READ_TOOLS) under
//       the template's `<slug>` placeholder or this restaurant's own slug.
//   (b) SEED the restaurant MCP's read tools under its fixed server name,
//       `restaurant` (.mcp.json) — no slug needed, so the template's own file
//       carries them too.
//   (c) nothing else. Every other allow in the list is the RESTAURANT's — its
//       own Bash patterns, its own connectors — and is left exactly where it is.

// The server name .mcp.json gives the restaurant's Bread 'n' Butter MCP.
var RESTAURANT_MCP_SERVER = 'restaurant';

// The restaurant MCP's READ surface. Write tools (create_row, update_row) and
// call_service are deliberately absent: they ask.
var RESTAURANT_MCP_READ_TOOLS = [
  'list_tables',
  'list_rows',
  'get_row',
  'recipe_cost',
  'list_connections',
];

// The non-MCP allows a restaurant is born with.
var BASE_ALLOWS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
];

// The placeholder the template once shipped for the Lyte field server.
var SETTINGS_SLUG_PLACEHOLDER = '<slug>';

// MCP server segments no session here holds any more. Each entry is a whole
// `mcp__<server>__` prefix, matched literally against the start of a rule.
//
// `mcp__claude_ai_Supabase__`: the account-level Supabase connector, which a
// restaurant session must not use — its database is reached through its own
// restaurant MCP.
var RETIRED_SERVER_PREFIXES = ['mcp__claude_ai_Supabase__'];

// The Lyte field MCP's read tools, which the template seeded as
// `mcp__<slug>__<tool>` before the restaurant MCP replaced that door.
var RETIRED_FIELD_READ_TOOLS = [
  'list_prisms',
  'list_rays',
  'get_ray',
  'list_entries',
  'get_entry',
  'list_views',
  'get_interface',
  'list_connections',
  'list_lanes',
  'get_approval',
];

// A slug we are willing to match a rule against. Deliberately strict: it is
// read from a file on disk, and a bad read must leave the list alone.
var SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function normalizeSlug(slug) {
  if (typeof slug !== 'string') return null;
  var s = slug.trim();
  if (!s || s === SETTINGS_SLUG_PLACEHOLDER) return null;
  return SLUG_RE.test(s) ? s : null;
}

/** The restaurant-MCP allow rules. */
function restaurantMcpToolAllows() {
  return RESTAURANT_MCP_READ_TOOLS.map(function (t) { return 'mcp__' + RESTAURANT_MCP_SERVER + '__' + t; });
}

/** The whole `permissions.allow` list a restaurant is born with. */
function buildAllowList() {
  return BASE_ALLOWS.concat(restaurantMcpToolAllows());
}

/**
 * Which restaurant a CHECKOUT belongs to — pure, given the texts. The caller
 * reads the files (keeper-sync does).
 *
 * PRECEDENCE, and why:
 *   1. `.lyte/field.json` → `.slug`. The committed identity the hand-off
 *      writes, so a session needs no env to know which restaurant it is.
 *   2. `.lyte/mcp-manifest.md` → the first `…/api/restaurants/<slug>/mcp`
 *      (or, in a repo from before the restaurant MCP, `…/api/fields/<slug>/mcp`)
 *      URL with a real slug in it.
 *   3. `RESTAURANT_SLUG` (or the older `FIELD_SLUG`) in the environment. LAST:
 *      the slug is a property of the checkout being edited, not of the process
 *      editing it, and keeper-sync's own tests run against temp trees.
 *
 * Returns `{ slug, source }`, both null when nothing resolves — a legitimate
 * answer: applyAllows still converges, it only cannot recognise rules written
 * under this restaurant's own slug.
 */
function resolveFieldSlug(sources) {
  var s = sources || {};
  if (typeof s.fieldJson === 'string' && s.fieldJson) {
    try {
      var identity = JSON.parse(s.fieldJson);
      var fromJson = normalizeSlug(identity && identity.slug);
      if (fromJson) return { slug: fromJson, source: '.lyte/field.json' };
    } catch {
      // A field.json we cannot parse is not a reason to guess — fall through
      // to the manifest, which is a source in its own right.
    }
  }
  if (typeof s.mcpManifest === 'string' && s.mcpManifest) {
    var m = s.mcpManifest.match(/https?:\/\/[^\s)]+\/api\/(?:restaurants|fields)\/([^/\s)]+)\/mcp\b/);
    var fromManifest = m ? normalizeSlug(m[1]) : null;
    if (fromManifest) return { slug: fromManifest, source: '.lyte/mcp-manifest.md' };
  }
  var env = s.env || {};
  var fromEnv = normalizeSlug(env.RESTAURANT_SLUG) || normalizeSlug(env.FIELD_SLUG);
  if (fromEnv) return { slug: fromEnv, source: normalizeSlug(env.RESTAURANT_SLUG) ? 'RESTAURANT_SLUG' : 'FIELD_SLUG' };
  return { slug: null, source: null };
}

/** True when `rule` is one this core retires, given the restaurant's slug (or null). */
function isRetiredRule(rule, slug) {
  for (var i = 0; i < RETIRED_SERVER_PREFIXES.length; i++) {
    if (rule.indexOf(RETIRED_SERVER_PREFIXES[i]) === 0) return true;
  }
  var servers = [SETTINGS_SLUG_PLACEHOLDER];
  if (slug && slug !== RESTAURANT_MCP_SERVER) servers.push(slug);
  for (var j = 0; j < servers.length; j++) {
    var prefix = 'mcp__' + servers[j] + '__';
    if (rule.indexOf(prefix) === 0 && RETIRED_FIELD_READ_TOOLS.indexOf(rule.slice(prefix.length)) >= 0) return true;
  }
  return false;
}

/**
 * Converge a `.claude/settings.json`'s `permissions.allow` list on canon.
 *   { content, action, added, filled, removed, slug, error? }
 *   action: 'unchanged' | 'updated' | 'malformed'
 * - 'malformed' returns the input untouched with `error` set — both for input
 *   this cannot parse and for the (unreachable, therefore checked) case of a
 *   splice that would have written invalid JSON. The allow list is the one
 *   thing in the file nobody else holds a copy of; fail soft, warn, leave it.
 * - Every byte outside the elements it adds or drops is returned as it was,
 *   `permissions` order included. A file with no `permissions.allow` array is
 *   returned untouched: canon maintains that list, it does not invent one.
 * - `filled` is always 0 (kept for callers that sum it).
 */
function applyAllows(settingsJsonText, slug) {
  var src = String(settingsJsonText == null ? '' : settingsJsonText);
  var field = normalizeSlug(slug);
  var none = { content: src, action: 'unchanged', added: 0, filled: 0, removed: 0, slug: field };
  var parsed;
  try {
    parsed = JSON.parse(src);
  } catch (e) {
    return { content: src, action: 'malformed', added: 0, filled: 0, removed: 0, slug: null, error: e.message };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { content: src, action: 'malformed', added: 0, filled: 0, removed: 0, slug: null, error: 'top level is not a JSON object' };
  }

  var arr = findAllowArray(src);
  if (!arr) return none;

  var els = arr.elements;
  var vals = els.map(elementString);
  var drop = vals.map(function (v) { return v !== null && isRetiredRule(v, field); });

  var edits = [];
  var removed = 0;
  var added = 0;

  // (a) Retired rules, dropped in RUNS so that a run of neighbours collapses
  // to one span and the edits stay disjoint: a run followed by a survivor eats
  // up to that survivor's first byte; a run at the tail eats back from the
  // previous survivor's last byte; a run that is the whole list leaves `[]`.
  var i = 0;
  while (i < els.length) {
    if (!drop[i]) { i++; continue; }
    var j = i;
    while (j + 1 < els.length && drop[j + 1]) j++;
    removed += j - i + 1;
    if (j + 1 < els.length) edits.push({ from: els[i].start, to: els[j + 1].start, text: '' });
    else if (i > 0) edits.push({ from: els[i - 1].end, to: els[j].end, text: '' });
    else edits.push({ from: arr.open, to: arr.close + 1, text: '[]' });
    i = j + 1;
  }

  edits.sort(function (a, b) { return b.from - a.from; });
  var out = src;
  for (var e = 0; e < edits.length; e++) {
    out = out.slice(0, edits[e].from) + edits[e].text + out.slice(edits[e].to);
  }

  // (b) Seed whatever the restaurant server still lacks, AFTER the drops so the
  // list is re-read in its final shape. Appended after the last rule naming
  // that server — where a reader expects them — or at the end.
  var arr2 = findAllowArray(out);
  if (arr2) {
    var vals2 = arr2.elements.map(elementString);
    var prefix = 'mcp__' + RESTAURANT_MCP_SERVER + '__';
    var missing = restaurantMcpToolAllows().filter(function (rule) { return vals2.indexOf(rule) === -1; });
    if (missing.length > 0) {
      added = missing.length;
      var anchor = null;
      for (var a = 0; a < arr2.elements.length; a++) {
        if (vals2[a] !== null && vals2[a].indexOf(prefix) === 0) anchor = arr2.elements[a];
      }
      if (!anchor && arr2.elements.length > 0) anchor = arr2.elements[arr2.elements.length - 1];
      if (anchor) {
        var indent = indentBefore(out, anchor.start);
        var sep = indent === null ? ', ' : ',\n' + indent;
        var insert = missing.map(function (r) { return sep + JSON.stringify(r); }).join('');
        out = out.slice(0, anchor.end) + insert + out.slice(anchor.end);
      } else {
        // An empty list has no formatting to preserve; render it from the
        // indent of the line its `[` sits on.
        var base = lineIndent(out, arr2.open);
        var body = missing.map(function (r) { return base + '  ' + JSON.stringify(r); }).join(',\n');
        out = out.slice(0, arr2.open) + '[\n' + body + '\n' + base + ']' + out.slice(arr2.close + 1);
      }
    }
  }

  if (out === src) return none;
  out = ensureTrailingNewline(out);
  try {
    JSON.parse(out);
  } catch (e2) {
    return {
      content: src,
      action: 'malformed',
      added: 0,
      filled: 0,
      removed: 0,
      slug: field,
      error: 'the allow-list splice would have produced invalid JSON (' + e2.message + ') — nothing written',
    };
  }
  return { content: out, action: 'updated', added: added, filled: 0, removed: removed, slug: field };
}

module.exports = {
  CANON_HOOKS: CANON_HOOKS,
  CANON_EVENTS: CANON_EVENTS,
  CANON_ENV: CANON_ENV,
  canonHooksFor: canonHooksFor,
  applyHooks: applyHooks,
  applyEnv: applyEnv,
  RESTAURANT_MCP_SERVER: RESTAURANT_MCP_SERVER,
  RESTAURANT_MCP_READ_TOOLS: RESTAURANT_MCP_READ_TOOLS,
  BASE_ALLOWS: BASE_ALLOWS,
  SETTINGS_SLUG_PLACEHOLDER: SETTINGS_SLUG_PLACEHOLDER,
  RETIRED_SERVER_PREFIXES: RETIRED_SERVER_PREFIXES,
  RETIRED_FIELD_READ_TOOLS: RETIRED_FIELD_READ_TOOLS,
  restaurantMcpToolAllows: restaurantMcpToolAllows,
  buildAllowList: buildAllowList,
  resolveFieldSlug: resolveFieldSlug,
  applyAllows: applyAllows,
};
