#!/usr/bin/env node
'use strict';
// IS: sales-entry's export reader — one POS sales export (CSV text) → the
//     night's lines as the skill writes them: item name, POS key, menu group,
//     quantity, net, kind (item · modifier · comp · void), a modifier's item
//     line, the printed net and whether the lines reconcile to it to the
//     cent. Knows Toast's Product Mix (Items) and Item Selection Details,
//     Square's item sales and Clover's item sales by their columns; any
//     other layout is read by its headers (item, quantity, net) and says so.
//     Pure: no network, no database, no credential.
// IS NOT: matching (pos_items is the skill's, through the restaurant MCP),
//     the write, or a cost — nothing here reads or computes one.
//
// Run:  node read-export.cjs <file.csv> [--source toast|square|clover|other] [--business-date YYYY-MM-DD]
//       → one JSON object on stdout; exit 1 when the file can't be read
//       (then `error` says why). `--self-test` runs the built-in cases.

var fs = require('fs');

// ─── CSV ────────────────────────────────────────────────────────────────────

// RFC 4180 rows: quoted fields, doubled quotes, CRLF, a leading BOM.
function parseCsv(text) {
  var rows = [], row = [], field = '', q = false, i = 0;
  text = String(text).replace(/^﻿/, '');
  for (; i < text.length; i++) {
    var c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (f) { return f.trim() !== ''; }); });
}

// Money and counts as printed: "$1,234.50", "(12.00)" → cents / numbers.
function cents(v) {
  var s = String(v === undefined || v === null ? '' : v).trim();
  if (s === '') return null;
  var neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[()$,\s-]/g, '');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return NaN;
  var n = Math.round(Number(s) * 100);
  return neg ? -n : n;
}
function qty(v) {
  var s = String(v === undefined || v === null ? '' : v).replace(/,/g, '').trim();
  if (s === '') return 0;
  var n = Number(s);
  return isFinite(n) ? n : NaN;
}
function usd(c) { return c === null ? null : (c / 100).toFixed(2); }
function norm(h) { return String(h || '').toLowerCase().replace(/[^a-z0-9#?]+/g, ' ').trim(); }
function nameKey(s) { return String(s || '').toLowerCase().replace(/\s+/g, ''); }

// MM/DD/YYYY, M/D/YY or YYYY-MM-DD (a time after it is ignored) → YYYY-MM-DD.
function isoDate(s) {
  var m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  var y = m[3].length === 2 ? '20' + m[3] : m[3];
  return y + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
}

// ─── layouts ────────────────────────────────────────────────────────────────

// Each column a layout reads, by the header names its exports have used.
var COLS = {
  group: ['menu group', 'category', 'categories', 'item category', 'sales category', 'menu subgroup s'],
  name: ['menu item', 'item', 'item name', 'name'],
  key: ['item id', 'master id', 'sku', 'plu', 'item sku', 'item code', 'item guid'],
  parent: ['modifier of', 'parent item', 'parent menu item'],
  variation: ['price point name', 'item variation', 'variation'],
  sold: ['qty sold', 'item qty', 'items sold', 'units sold', '# sold', 'quantity sold', 'sold', 'qty', 'quantity', 'count'],
  comp: ['comp qty', 'comped qty', 'comps qty'],
  void: ['void qty', 'voided qty', 'voids qty'],
  net: ['net sales', 'net amount', 'net price', 'net', 'item revenue', 'revenue'],
  gross: ['gross sales', 'gross amount', 'gross price'],
  discount: ['discounts', 'discount amount', 'discount', 'discounts comps'],
  voided: ['void?', 'voided', 'void'],
  date: ['order date', 'business date', 'date', 'sent date', 'opened'],
  modifiers: ['modifiers applied'],
  event: ['event type'],
  order: ['order id', 'item selection id', 'transaction id', 'payment id'],
};

function columns(header) {
  var h = header.map(norm), at = {};
  Object.keys(COLS).forEach(function (k) {
    for (var j = 0; j < COLS[k].length; j++) {
      var i = h.indexOf(COLS[k][j]);
      if (i >= 0 && Object.keys(at).every(function (o) { return at[o] !== i; })) { at[k] = i; return; }
    }
  });
  return at;
}

function detect(header, meta) {
  var h = header.map(norm);
  var hasAll = function () { return Array.prototype.every.call(arguments, function (x) { return h.indexOf(x) >= 0; }); };
  if (/product mix/i.test(meta) || hasAll('menu item', 'qty sold') || hasAll('menu item', 'item qty', 'net amount')) return 'toast-product-mix';
  if (h.indexOf('item selection id') >= 0 || hasAll('menu item', 'net price', 'void?')) return 'toast-item-selection-details';
  if (hasAll('item', 'net sales') && (h.indexOf('price point name') >= 0 || h.indexOf('item variation') >= 0 || h.indexOf('items sold') >= 0 || h.indexOf('transaction id') >= 0)) return 'square-item-sales';
  if (hasAll('name') && (h.indexOf('# sold') >= 0 || h.indexOf('quantity sold') >= 0 || h.indexOf('item revenue') >= 0)) return 'clover-item-sales';
  return 'headers';
}

var SOURCE_OF = { 'toast-product-mix': 'toast', 'toast-item-selection-details': 'toast', 'square-item-sales': 'square', 'clover-item-sales': 'clover', headers: null };

// A "Total" / "Grand Total" row: the printed net, never a line.
function isTotal(r, at) {
  return [at.group, at.name].some(function (i) { return i !== undefined && /^(grand )?totals?:?$/i.test(String(r[i] || '').trim()); });
}

// Rows of a summary layout (one row per item, modifiers under their item).
function summaryLines(rows, at, out) {
  var printed = null;
  var byName = {};
  rows.forEach(function (r) {
    if (isTotal(r, at)) { printed = cents(r[at.net]); return; }
    var name = String(r[at.name] || '').trim();
    if (!name) return;
    if (at.variation !== undefined) {
      var v = String(r[at.variation] || '').trim();
      if (v && !/^regular$/i.test(v)) name += ' (' + v + ')';
    }
    var base = {
      item_name: name,
      pos_key: at.key !== undefined && String(r[at.key] || '').trim() || null,
      menu_group: at.group !== undefined && String(r[at.group] || '').trim() || null,
    };
    var sold = qty(r[at.sold]), net = cents(r[at.net]);
    var comp = at.comp !== undefined ? qty(r[at.comp]) : 0, voids = at.void !== undefined ? qty(r[at.void]) : 0;
    if ([sold, comp, voids].some(isNaN) || isNaN(net)) throw new Error('row "' + name + '": a quantity or amount is not a number');
    if (sold < 0 || comp < 0 || voids < 0) throw new Error('row "' + name + '": a negative quantity (a refund?) — read it with the owner');
    var parentName = at.parent !== undefined ? String(r[at.parent] || '').trim() : '';
    if (parentName) {
      var p = byName[nameKey(parentName)];
      if (!p) out.notes.push('modifier "' + name + '" names "' + parentName + '", which has no item line above it — written without its item');
      out.lines.push(Object.assign(base, { quantity: sold, net_sales: usd(net === null ? 0 : net), kind: 'modifier', parent: p ? p.position : null, position: out.lines.length + 1 }));
      return;
    }
    if (sold > 0 || (comp === 0 && voids === 0)) {
      var item = Object.assign({}, base, { quantity: sold, net_sales: usd(net === null ? 0 : net), kind: 'item', parent: null, position: out.lines.length + 1 });
      out.lines.push(item);
      if (!byName[nameKey(name)]) byName[nameKey(name)] = item;
      out.item_count += sold;
    } else if (net) {
      throw new Error('row "' + name + '": $' + usd(net) + ' net with nothing sold — read it with the owner');
    }
    if (comp > 0) out.lines.push(Object.assign({}, base, { quantity: comp, net_sales: '0.00', kind: 'comp', parent: null, position: out.lines.length + 1 }));
    if (voids > 0) out.lines.push(Object.assign({}, base, { quantity: voids, net_sales: '0.00', kind: 'void', parent: null, position: out.lines.length + 1 }));
  });
  return printed;
}

// Rows of a detail layout (one row per selection or sale) summed per item and
// kind, in first-seen order. A voided selection is a void; a selection
// discounted to $0 is a comp; Square's "Modifiers Applied" become modifier
// lines under their item, $0 (their money is in the item's net).
function detailLines(rows, at, out, layout) {
  var groups = {}, order = [], dates = {};
  function add(kind, base, q, net, parentKey) {
    var k = [kind, base.item_name, base.pos_key, base.menu_group, parentKey || ''].join('\u0000');
    if (!groups[k]) { groups[k] = Object.assign({}, base, { kind: kind, quantity: 0, net: 0, parentKey: parentKey || null, key: k }); order.push(k); }
    groups[k].quantity += q; groups[k].net += net;
    return k;
  }
  rows.forEach(function (r) {
    if (isTotal(r, at)) return;
    var name = String(r[at.name] || '').trim();
    if (!name) return;
    if (at.variation !== undefined) {
      var v = String(r[at.variation] || '').trim();
      if (v && !/^regular$/i.test(v)) name += ' (' + v + ')';
    }
    if (at.date !== undefined) { var d = isoDate(r[at.date]); if (d) dates[d] = true; }
    var base = {
      item_name: name,
      pos_key: at.key !== undefined && String(r[at.key] || '').trim() || null,
      menu_group: at.group !== undefined && String(r[at.group] || '').trim() || null,
    };
    var q = at.sold !== undefined ? qty(r[at.sold]) : 1;
    var net = cents(r[at.net]), gross = at.gross !== undefined ? cents(r[at.gross]) : null, disc = at.discount !== undefined ? cents(r[at.discount]) : null;
    if (isNaN(q) || isNaN(net)) throw new Error('row "' + name + '": a quantity or amount is not a number');
    if (at.event !== undefined && /refund/i.test(String(r[at.event]))) out.notes.push('refund row for "' + name + '" summed into its item, as the POS prints it');
    var voided = at.voided !== undefined && /^(true|yes|y|1)$/i.test(String(r[at.voided]).trim());
    var kind = voided ? 'void' : (net === 0 && gross > 0 && disc !== null && Math.abs(disc) >= gross) ? 'comp' : 'item';
    var k = add(kind, base, q, kind === 'void' ? 0 : (net || 0));
    if (at.modifiers !== undefined && kind !== 'void') {
      String(r[at.modifiers] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (m) {
        add('modifier', { item_name: m, pos_key: null, menu_group: base.menu_group }, q, 0, k);
      });
    }
  });
  var pos = {};
  order.forEach(function (k) {
    var g = groups[k];
    if (g.quantity < 0) throw new Error('"' + g.item_name + '" sums to ' + g.quantity + ' sold — read it with the owner');
    var line = { item_name: g.item_name, pos_key: g.pos_key, menu_group: g.menu_group, quantity: +g.quantity.toFixed(4),
      net_sales: usd(g.net), kind: g.kind, parent: g.parentKey ? pos[g.parentKey] : null, position: out.lines.length + 1 };
    pos[k] = line.position;
    out.lines.push(line);
    if (g.kind === 'item') out.item_count += g.quantity;
  });
  var ds = Object.keys(dates).sort();
  if (ds.length > 1) throw new Error('the export spans ' + ds.length + ' days (' + ds[0] + ' … ' + ds[ds.length - 1] + ') — one report is one business date');
  if (ds.length === 1) out.dates.push(ds[0]);
  if (layout === 'toast-item-selection-details') out.notes.push('Item Selection Details carries no modifiers (they are in Modifiers Selection Details) and prints no total');
  return null;
}

// ─── the reading ────────────────────────────────────────────────────────────

function read(text, opts) {
  opts = opts || {};
  var rows = parseCsv(text);
  var out = { ok: true, layout: null, source: null, business_date: null, location: null, printed_net: null,
    lines: [], item_count: 0, lines_net: null, reconciles: null, difference: null, notes: [], dates: [] };
  // A title row before the header (Toast's "Toast,Product Mix - Items,<location>,Business date …").
  var meta = '';
  var hi = rows.findIndex(function (r) { var at = columns(r); return at.name !== undefined && at.net !== undefined; });
  if (hi < 0) return fail(out, 'no header row with an item column and a net sales column');
  meta = rows.slice(0, hi).map(function (r) { return r.join(','); }).join('\n');
  var header = rows[hi], at = columns(header), body = rows.slice(hi + 1);
  out.layout = detect(header, meta);
  out.source = SOURCE_OF[out.layout] || (/^toast\b/i.test(meta) ? 'toast' : null);
  if (out.layout === 'headers') out.notes.push('unknown layout, read by its headers: ' + header.filter(Boolean).join(' · '));
  if (at.sold === undefined && !/details|square/.test(out.layout)) return fail(out, 'no quantity column');
  var mdate = meta.match(/business date[^0-9]*([0-9/\-]+)/i);
  if (mdate) out.dates.push(isoDate(mdate[1]));
  var mrow = rows.slice(0, hi)[0];
  if (mrow && /^toast$/i.test(String(mrow[0]).trim()) && mrow[2]) out.location = String(mrow[2]).trim();
  try {
    var detail = at.order !== undefined || out.layout === 'toast-item-selection-details';
    out.printed_net = detail ? detailLines(body, at, out, out.layout) : summaryLines(body, at, out);
  } catch (e) { return fail(out, e.message); }
  if (!out.lines.length) return fail(out, 'no lines');
  // The night's date: the file's, else the payload's; the two must agree.
  var fileDate = out.dates[0] || null;
  if (fileDate && opts.business_date && fileDate !== opts.business_date) return fail(out, 'the file is for ' + fileDate + ', not ' + opts.business_date);
  out.business_date = fileDate || opts.business_date || null;
  if (!out.business_date) return fail(out, 'no business date on the file and none given');
  if (opts.source && out.source && opts.source !== out.source) return fail(out, 'the file is a ' + out.source + ' export, not ' + opts.source);
  out.source = out.source || opts.source || 'other';
  var sum = out.lines.filter(function (l) { return l.kind !== 'void'; }).reduce(function (s, l) { return s + cents(l.net_sales); }, 0);
  out.lines_net = usd(sum);
  if (out.printed_net === null) {
    out.notes.push('no printed total: the net is the lines\' own sum');
    out.printed_net = sum;
  }
  out.difference = usd(sum - out.printed_net);
  out.reconciles = sum === out.printed_net;
  out.printed_net = usd(out.printed_net);
  out.item_count = +out.item_count.toFixed(4);
  delete out.dates;
  return out;
}

function fail(out, why) { delete out.dates; out.ok = false; out.error = why; return out; }

// ─── self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  var assert = require('assert');
  var path = require('path');
  var night = read(fs.readFileSync(path.join(__dirname, 'references', 'toast-product-mix-2026-10-28.csv'), 'utf8'));
  assert.ok(night.ok, night.error);
  assert.strictEqual(night.layout, 'toast-product-mix');
  assert.strictEqual(night.source, 'toast');
  assert.strictEqual(night.business_date, '2026-10-28');
  assert.strictEqual(night.location, 'TEST RESTAURANT (mock)');
  assert.strictEqual(night.printed_net, '2373.00');
  assert.strictEqual(night.lines_net, '2373.00');
  assert.strictEqual(night.reconciles, true);
  assert.strictEqual(night.lines.length, 20);
  assert.strictEqual(night.item_count, 157);
  var by = function (n, k) { return night.lines.find(function (l) { return l.item_name === n && l.kind === k; }); };
  assert.deepStrictEqual([by('Brûléed Banana', 'item').quantity, by('Brûléed Banana', 'item').net_sales, by('Brûléed Banana', 'comp').quantity], [6, '60.00', 1]);
  assert.deepStrictEqual([by('Margarita', 'item').quantity, by('Margarita', 'void').quantity, by('Margarita', 'void').net_sales], [18, 1, '0.00']);
  var steak = by('Hangar Steak Frites', 'item');
  assert.strictEqual(by('Medium Rare', 'modifier').parent, steak.position);
  assert.deepStrictEqual([by('Extra Shallot Cream', 'modifier').quantity, by('Extra Shallot Cream', 'modifier').net_sales], [3, '6.00']);
  assert.strictEqual(by('Bread Service', 'item').pos_key, '400901');

  var off = read('Menu Group,Menu Item,Item ID,Modifier Of,Qty Sold,Comp Qty,Void Qty,Gross Sales,Discounts,Net Sales\nMains,Steak,1,,2,0,0,60,0,60\n,Total,,,,,,,,61.00\n', { business_date: '2026-10-28' });
  assert.deepStrictEqual([off.ok, off.reconciles, off.difference], [true, false, '-1.00'], 'a cent off the printed total does not reconcile');
  assert.ok(!read('Toast,Product Mix - Items,X,Business date 10/28/2026\nMenu Item,Qty Sold,Net Sales\nSteak,1,30\n', { business_date: '2026-10-29' }).ok, 'the file\'s date wins over a wrong payload date');
  assert.ok(!read('Menu Item,Qty Sold,Net Sales\nSteak,1,30\n').ok, 'no date anywhere stops');

  var tsd = read('Order Id,Order Date,Item Selection Id,Item Id,Menu Item,Menu Group,Gross Price,Discount,Net Price,Qty,Void?\n' +
    'o1,10/28/2026 7:01 PM,s1,400101,Hangar Steak Frites,Mains,34,0,34,1,false\n' +
    'o1,10/28/2026 7:01 PM,s2,400101,Hangar Steak Frites,Mains,34,0,34,1,false\n' +
    'o2,10/28/2026 8:10 PM,s3,400501,Brûléed Banana,Desserts,10,10,0,1,false\n' +
    'o3,10/28/2026 9:00 PM,s4,500101,Margarita,Cocktails,14,0,14,1,true\n');
  assert.ok(tsd.ok, tsd.error);
  assert.strictEqual(tsd.layout, 'toast-item-selection-details');
  assert.deepStrictEqual(tsd.lines.map(function (l) { return [l.item_name, l.kind, l.quantity, l.net_sales]; }),
    [['Hangar Steak Frites', 'item', 2, '68.00'], ['Brûléed Banana', 'comp', 1, '0.00'], ['Margarita', 'void', 1, '0.00']]);
  assert.strictEqual(tsd.business_date, '2026-10-28');

  var sq = read('Date,Time,Category,Item,Qty,Price Point Name,SKU,Modifiers Applied,Gross Sales,Discounts,Net Sales,Transaction ID,Event Type\n' +
    '2026-10-28,18:01,Coffee,Latte,1,Large,L-1,"Oat Milk, Extra Shot",$6.50,$0.00,$6.50,t1,Payment\n' +
    '2026-10-28,18:05,Coffee,Latte,2,Large,L-1,Oat Milk,$13.00,$0.00,$13.00,t2,Payment\n' +
    '2026-10-28,18:09,Food,Croissant,1,Regular,C-1,,$4.00,$0.00,$4.00,t3,Payment\n');
  assert.ok(sq.ok, sq.error);
  assert.deepStrictEqual([sq.layout, sq.source, sq.lines_net], ['square-item-sales', 'square', '23.50']);
  var latte = sq.lines[0];
  assert.deepStrictEqual([latte.item_name, latte.quantity], ['Latte (Large)', 3]);
  assert.deepStrictEqual(sq.lines.filter(function (l) { return l.kind === 'modifier'; }).map(function (l) { return [l.item_name, l.quantity, l.parent]; }),
    [['Oat Milk', 3, latte.position], ['Extra Shot', 1, latte.position]]);

  var cl = read('Name,SKU,Category,# Sold,Gross Sales,Discounts,Net Sales\nBurger,B1,Mains,"1,204","$14,448.00",$0.00,"$14,448.00"\nTotal,,,,,,"$14,448.00"\n', { business_date: '2026-10-28' });
  assert.deepStrictEqual([cl.ok, cl.layout, cl.lines[0].quantity, cl.reconciles], [true, 'clover-item-sales', 1204, true]);

  var odd = read('Product,Units,Amount\nSoup,3,36.00\n', { business_date: '2026-10-28', source: 'other' });
  assert.ok(!odd.ok, 'a layout with no item and net column stops');
  var hdr = read('Item Name,Quantity,Net\nSoup,3,36.00\n', { business_date: '2026-10-28', source: 'other' });
  assert.deepStrictEqual([hdr.ok, hdr.layout, hdr.source, hdr.lines_net], [true, 'headers', 'other', '36.00']);
  assert.ok(/unknown layout/.test(hdr.notes[0]), 'an unknown layout says so');
  console.log('read-export: self-test passed');
}

if (require.main === module) {
  var argv = process.argv.slice(2);
  if (argv[0] === '--self-test') { selfTest(); process.exit(0); }
  var opts = {}, file = null;
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') opts.source = argv[++i];
    else if (argv[i] === '--business-date') opts.business_date = argv[++i];
    else file = argv[i];
  }
  if (!file) { console.error('usage: read-export.cjs <file.csv> [--source …] [--business-date YYYY-MM-DD]'); process.exit(2); }
  var res = read(fs.readFileSync(file, 'utf8'), opts);
  process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  process.exit(res.ok ? 0 : 1);
}

module.exports = { read: read, parseCsv: parseCsv };
