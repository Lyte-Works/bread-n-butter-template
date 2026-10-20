'use strict';
// IS: The one reader of food-costs-ids.json — every skill script, the write
//     checker and the re-cost job get their table ids through load(), which
//     FAILS LOUDLY when an id it was asked for is blank. A restaurant repo is
//     born from the template with every id "" and the new-restaurant hand-off
//     fills them; a job that ran before the hand-off must stop and say so, not
//     read an empty table and report "nothing to do".
// IS NOT: A place ids are written (the hand-off writes the JSON), nor a
//     fallback — there are no built-in ids anywhere in this repo.
//
// Usage:
//   var ids = require('../../_shared/food-costs-ids.cjs').load(['rays.recipes', 'rays.ingredients']);
//   ids.rays.recipes  // → the uuid, guaranteed non-empty
//   node food-costs-ids.cjs --check [key …]   (exit 1 and name what is blank)

var fs = require('fs');
var path = require('path');

var FILE = path.join(__dirname, 'food-costs-ids.json');
var REL = 'workers/skills/_shared/food-costs-ids.json';
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function IdsMissingError(missing, file) {
  var e = new Error(
    'table ids missing in ' + (file === FILE ? REL : file) + ': ' + missing.join(', ') +
    ' — this restaurant has not been handed off yet (the new-restaurant hand-off fills that file). ' +
    'Nothing was read or written.');
  e.name = 'IdsMissingError';
  e.code = 'IDS_MISSING';
  e.missing = missing;
  return e;
}

function get(obj, dotted) {
  return dotted.split('.').reduce(function (o, k) { return o && typeof o === 'object' ? o[k] : undefined; }, obj);
}

// Every "<group>.<key>" leaf the file declares (the `_about` note and the
// `prism` label are not ids).
function declaredKeys(json) {
  var out = [];
  Object.keys(json || {}).forEach(function (g) {
    var v = json[g];
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.keys(v).forEach(function (k) { out.push(g + '.' + k); });
  });
  return out;
}

/**
 * Read the ids file and assert the named keys hold uuids.
 *   keys — ['rays.recipes', …]; omitted → every key the file declares.
 *   opts.file — another path (tests).
 * Throws IdsMissingError naming every blank or malformed key.
 */
function load(keys, opts) {
  var file = (opts && opts.file) || FILE;
  var json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw IdsMissingError(['(the file itself: ' + e.message + ')'], file); }
  var want = keys && keys.length ? keys : declaredKeys(json);
  var missing = want.filter(function (k) { var v = get(json, k); return typeof v !== 'string' || !UUID.test(v.trim()); });
  if (missing.length) throw IdsMissingError(missing, file);
  return json;
}

module.exports = { load: load, declaredKeys: declaredKeys, FILE: FILE, REL: REL };

if (require.main === module) {
  var args = process.argv.slice(2);
  if (args[0] === '--check') {
    try { load(args.slice(1)); console.log('food-costs ids: ok'); process.exit(0); }
    catch (e) { console.error('✗ ' + e.message); process.exit(1); }
  }
  console.error('usage: node food-costs-ids.cjs --check [rays.recipes …]');
  process.exit(2);
}
