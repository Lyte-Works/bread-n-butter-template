#!/usr/bin/env node
'use strict';
// IS: The proof that a blank ids file fails LOUDLY everywhere it is read — the
//     loader, the re-cost job's real entry point, and the write checker as the
//     hook Claude Code runs. Each is driven against a blank copy of the file
//     (so the proof holds after the hand-off fills the real one too), and
//     against the repo's own file while it is still blank (the template).
// IS NOT: A test of the arithmetic — recost.cjs, recost-job.cjs and
//     check-write.cjs each carry their own --self-test for that.
//
// Usage: node workers/skills/_shared/food-costs-ids.test.cjs

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var SKILLS = path.join(__dirname, '..');
var ids = require('./food-costs-ids.cjs');

function blankCopy() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnb-ids-'));
  var json = JSON.parse(fs.readFileSync(ids.FILE, 'utf8'));
  ids.declaredKeys(json).forEach(function (k) { var p = k.split('.'); json[p[0]][p[1]] = ''; });
  var file = path.join(dir, 'food-costs-ids.json');
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  return file;
}

var ownIsBlank = (function () { try { ids.load(); return false; } catch (e) { return e.code === 'IDS_MISSING'; } })();
var blank = blankCopy();

// 1. The loader names the file and every blank key.
assert.throws(function () { ids.load(['rays.recipes', 'rays.task_board'], { file: blank }); }, function (e) {
  return e.code === 'IDS_MISSING' && e.missing.join() === 'rays.recipes,rays.task_board' && /hand-off/.test(e.message);
});
// A non-uuid is as blank as "" — a placeholder must never pass.
var junk = blankCopy();
var j = JSON.parse(fs.readFileSync(junk, 'utf8')); j.rays.recipes = 'TODO'; fs.writeFileSync(junk, JSON.stringify(j));
assert.throws(function () { ids.load(['rays.recipes'], { file: junk }); }, /rays\.recipes/);

// 2. The ids CLI the skills tell the AI to run before the first write exits 1.
if (ownIsBlank) {
  var c = cp.spawnSync(process.execPath, [path.join(__dirname, 'food-costs-ids.cjs'), '--check'], { encoding: 'utf8' });
  assert.strictEqual(c.status, 1, 'ids --check must exit 1 on a blank file');
  assert.match(c.stderr, /food-costs-ids\.json/);
}

// 3. The re-cost job's real entry point: exit 1, the file named, no request made.
if (ownIsBlank) {
  var r = cp.spawnSync(process.execPath, [path.join(SKILLS, 'recipe-costing', 'recost-job.cjs'), '--trigger', 'baseline'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { FIELD_SERVICE_TOKEN: 'lfs1.not-a-real-token', FIELD_SLUG: 'test-restaurant', APP_URL: 'https://127.0.0.1:9' }),
  });
  assert.strictEqual(r.status, 1, 'recost-job must exit 1 on a blank ids file');
  assert.match(r.stderr, /table ids missing in workers\/skills\/_shared\/food-costs-ids\.json/);
  assert.doesNotMatch(r.stderr, /HTTP|fetch failed|ECONNREFUSED/, 'it must stop before any request');
}
// …and through the module, against the blank copy, whatever the repo's own file holds.
var job = require('../recipe-costing/recost-job.cjs');
assert.throws(function () { job.loadIds({ file: blank }); }, function (e) { return e.code === 'IDS_MISSING'; });

// 4. The write checker, as the PostToolUse hook: a food-costs write is BLOCKED with the reason.
if (ownIsBlank) {
  var payload = JSON.stringify({ tool_name: 'mcp__restaurant__create_entry', tool_input: { ray_id: 'r', properties: { name: 'x' } },
    tool_response: [{ type: 'text', text: '{"entry":{"id":"e","rayId":"r","title":"x","properties":{}}}' }] });
  var h = cp.spawnSync(process.execPath, [path.join(SKILLS, 'invoice-intake', 'hooks', 'check-write.cjs')], { input: payload, encoding: 'utf8' });
  assert.strictEqual(h.status, 0, 'a hook always exits 0');
  var out = JSON.parse(h.stdout || '{}');
  assert.strictEqual(out.decision, 'block', 'a blank ids file must block the write, not pass it');
  assert.match(out.reason, /food-costs-ids\.json/);
}

console.log('food-costs-ids test: ok' + (ownIsBlank ? ' (this repo\'s ids file is blank — every reader refused, as it must)' : ' (ids filled — blank-copy cases only)'));
