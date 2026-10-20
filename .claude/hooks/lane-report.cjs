'use strict';

// IS: The Lanes v2 outbox for the CLOUD venue (spec-lanes-v2-cloud-venue-
//     2026-09-02): a Claude Code hook that reports a lane conversation's
//     lifecycle to the platform so the dashboard's lanes board and SSE
//     bridge see a claude.ai/code session exactly the way they see every
//     other lane. One script, three hook events, session-keyed: when the
//     environment carries the field wiring (FIELD_SLUG + FIELD_SERVICE_TOKEN
//     — on this arm the token may be a scoped field token, lfs1.…, carrying
//     lanes:write), one small POST to /lanes/report per event, carrying the
//     CLI's own session_id:
//       SessionStart      → session_start (source startup|resume)
//       UserPromptSubmit  → prompt (a turn is starting)
//       Stop              → stop + the last reply as the summary
//     The app resolves the lane by claude_session_id; a session no lane
//     claims gets 204 and nothing is written. create_session cannot inject
//     env, so the ROW (stamped with the session id by the spawner) is what
//     makes a session a lane.
// IS NOT: a headless job's reporter. The agent job (.github/workflows/
//     agent-job.yml) sets LANE_REPORT=off and this hook stands down.
//     Not blocking: every failure is logged to stderr and exits 0 —
//     telemetry must never gate the conversation. Inert outside a field:
//     without the field wiring it exits immediately, so sessions on this
//     repo elsewhere pay one process spawn and nothing else.
//
// Env contract: FIELD_SLUG + FIELD_SERVICE_TOKEN (activation + auth),
// APP_URL (default https://app.lyte.works), LANE_REPORT=off (stand down).

var fs = require('fs');

var APP_URL_DEFAULT = 'https://app.lyte.works';
var FETCH_TIMEOUT_MS = 8000;

// Pure: last assistant text out of a Claude Code transcript (JSONL). Tolerant
// of unknown line shapes — a parse failure of one line skips it, an overall
// miss returns null and the caller falls back to a generic detail.
function lastAssistantText(jsonl) {
  if (!jsonl || typeof jsonl !== 'string') return null;
  var lines = jsonl.split('\n');
  var last = null;
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    var entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (!entry || entry.type !== 'assistant' || !entry.message) continue;
    var content = entry.message.content;
    if (typeof content === 'string') { last = content; continue; }
    if (Array.isArray(content)) {
      var texts = content
        .filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string'; })
        .map(function (b) { return b.text; });
      if (texts.length > 0) last = texts.join('\n');
    }
  }
  return last;
}

// Pure: the report one hook event produces. Null when the event is not one
// we report or the payload carries
// no session id — nothing to key the lane by. The summary is the full last
// reply (the app caps the progress detail itself and keeps the full text for
// the conversation), bounded so a runaway transcript cannot become a payload.
var REPORT_EVENTS = { SessionStart: 'session_start', UserPromptSubmit: 'prompt', Stop: 'stop' };
var SUMMARY_MAX = 20000;

// Pure: the Claude Code Remote session id a cloud container knows itself by.
// The env carries it as `cse_<id>`; the API (and so the spawner's attach)
// names the same session `session_<id>` — normalize to the API form so the
// lane row matches. Null outside a cloud container.
function remoteSessionId(env) {
  var raw = env && env.CLAUDE_CODE_REMOTE_SESSION_ID;
  if (!raw || typeof raw !== 'string') return null;
  var m = /^(?:cse|session)_(.+)$/.exec(raw.trim());
  return m ? 'session_' + m[1] : raw.trim();
}

function buildReport(eventName, hookInput, assistantText, env) {
  var event = REPORT_EVENTS[eventName];
  if (!event) return null;
  var sessionId = hookInput && hookInput.session_id;
  if (!sessionId || typeof sessionId !== 'string') return null;
  var report = { event: event, claude_session_id: sessionId };
  var remote = remoteSessionId(env);
  if (remote) report.remote_session_id = remote;
  if (event === 'session_start') report.source = hookInput.source === 'resume' ? 'resume' : 'startup';
  if (event === 'stop' && assistantText) report.summary = String(assistantText).slice(0, SUMMARY_MAX);
  if (hookInput && typeof hookInput.model === 'string' && hookInput.model) report.model = hookInput.model;
  return report;
}

// Returns true when a lane claimed the session, false on the app's 204 (not
// a lane — the quiet, expected answer for an ordinary conversation).
async function postReport(appUrl, slug, token, report) {
  var res = await fetch(appUrl + '/api/fields/' + encodeURIComponent(slug) + '/lanes/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-field-token': token },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 204) return false;
  if (!res.ok) {
    var text = '';
    try { text = await res.text(); } catch { /* the status alone is the report */ }
    throw new Error('report ' + report.event + ' -> HTTP ' + res.status + (text ? ': ' + text.slice(0, 200) : ''));
  }
  return true;
}

// Pure: whether this environment reports at all — the field wiring is
// present and the runtime venue has not switched the hook off.
function shouldReport(env) {
  var e = env || {};
  if (e.LANE_REPORT === 'off') return false;
  return !!(e.FIELD_SLUG && e.FIELD_SERVICE_TOKEN);
}

async function main() {
  // The runtime venue reports for itself (lane-runner.cjs) and switches this
  // hook off for its turns; a report from here would double every row.
  if (!shouldReport(process.env)) return; // off, or not wired — inert by contract
  var slug = process.env.FIELD_SLUG;
  var token = process.env.FIELD_SERVICE_TOKEN;

  var raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin — hookInput stays null */ }
  var hookInput = null;
  try { hookInput = JSON.parse(raw); } catch { /* malformed stdin — proceed without it */ }
  var eventName = (hookInput && hookInput.hook_event_name) || process.argv[2] || '';

  var assistantText = null;
  if (eventName === 'Stop' && hookInput && hookInput.transcript_path) {
    try { assistantText = lastAssistantText(fs.readFileSync(hookInput.transcript_path, 'utf8')); }
    catch (err) { console.error('[lane-report] transcript read failed: ' + err.message); }
  }
  var appUrl = process.env.APP_URL || APP_URL_DEFAULT;

  // One POST; the app decides whether this session is a lane. A 204 is the
  // ordinary answer and stays silent.
  var report = buildReport(eventName, hookInput, assistantText, process.env);
  if (!report) return;
  try {
    await postReport(appUrl, slug, token, report);
  } catch (err) {
    console.error('[lane-report] ' + err.message);
  }
}

if (require.main === module) {
  // Always exit 0: a non-zero hook exit blocks the CLI's flow, and telemetry
  // must never do that. Failures are already on stderr.
  main().catch(function (err) {
    console.error('[lane-report] ' + err.message);
  });
}

module.exports = { lastAssistantText: lastAssistantText, buildReport: buildReport, remoteSessionId: remoteSessionId, shouldReport: shouldReport };
