// IK Play — EPG pre-pack generator ("ikdb").
// Reads an XMLTV (.xml or .xml.gz), builds per-channel programme blobs in exactly the format the app's
// IkEpgPack writes into EPGDB.channels.prg (gzip of {"epg_data":[...]} JSON), and stores them in a small SQLite
// file the app can ATTACH and copy with INSERT ... SELECT (no XML parse / pack on the box).
//
// usage: node ikdb_gen.js <in.xml[.gz]> <out.ikdb> [--now=YYYYMMDDHHMM] [--keep=7] [--ahead=8] [--level=9]
'use strict';
const fs = require('fs'), zlib = require('zlib');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const inFile = args[0], outFile = args[1];
if (!inFile || !outFile) { console.error('usage: node ikdb_gen.js <in.xml[.gz]> <out.ikdb> [--now=YYYYMMDDHHMM] [--keep=7] [--ahead=8]'); process.exit(2); }
const KEEP = +opt('keep', 7), AHEAD = +opt('ahead', 8), LEVEL = +opt('level', 9);
const nowArg = opt('now', '');
const now = nowArg ? new Date(+nowArg.slice(0, 4), +nowArg.slice(4, 6) - 1, +nowArg.slice(6, 8), +nowArg.slice(8, 10) || 0, +nowArg.slice(10, 12) || 0) : new Date();
const z2 = (n) => (n < 10 ? '0' : '') + n;
const ymd = (d) => '' + d.getFullYear() + z2(d.getMonth() + 1) + z2(d.getDate());
// same thresholds as the app: minStop = (today - KEEP days) 00:00 ; maxStart = (now + AHEAD days) date 00:00
const dMin = new Date(now); dMin.setHours(0, 0, 0, 0); dMin.setDate(dMin.getDate() - KEEP);
const MIN_STOP = KEEP >= 0 ? ymd(dMin) + '000000' : '';
const MAX_START = AHEAD > 0 ? ymd(new Date(now.getTime() + AHEAD * 864e5)) + '000000' : '';

// ---------- text rules (mirror of IkXmltv/handler + IkEpgPack.esc) ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlDecode(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') { const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(cp); } catch (x) { return m; } }
    return ENT[e] !== undefined ? ENT[e] : m;
  });
}
function cdata(s) { return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'); }
function textOf(inner) { return xmlDecode(cdata(inner)); }
// IkEpgPack.esc: '\' -> '\\', control (<0x20) -> ' ', everything else verbatim UTF-8 (lone surrogates -> '?')
function esc(s) {
  if (s === null || s === undefined) return 'null';
  let o = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) o += '\\\\';
    else if (c < 0x20) o += ' ';
    else if (c >= 0xd800 && c <= 0xdfff) {
      if (c <= 0xdbff && i + 1 < s.length) { const d = s.charCodeAt(i + 1); if (d >= 0xdc00 && d <= 0xdfff) { o += s[i] + s[i + 1]; i++; continue; } }
      o += '?';
    } else o += s[i];
  }
  return o;
}
// what the app stores for user-visible text (vendor: quotes become &quot; so the JSON stays valid)
// (verified against the app's own EPGDB: "\\" pairs are dropped, \" -> ", single \ kept (esc doubles it), " -> &quot;, @ -> &commat;)
function bs(s) { return s.indexOf('\\') < 0 ? s : s.replace(/\\\\/g, '').replace(/\\"/g, '"'); }
function sanitize(s) { return bs(s).replace(/"/g, '&quot;').replace(/@/g, '&commat;'); }
// desc (IkEpgPack.rawSeg): bytes <= 0x20 trimmed at both ends, same backslash rule, " -> &quot;, @ -> &commat;, < > -> U+2039 U+203A
function descSanitize(s) { return bs(s.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')).replace(/"/g, '&quot;').replace(/@/g, '&commat;').replace(/</g, '‹').replace(/>/g, '›'); }

// "yyyyMMddHHmmss Z" -> epoch seconds (IkEpgPack.sec / secFast)
function sec(t) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})/.exec(t || '');
  if (!m) {
    const m2 = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(t || ''); if (!m2) return 0;
    return Math.floor(new Date(+m2[1], +m2[2] - 1, +m2[3], +m2[4], +m2[5], +m2[6]).getTime() / 1000);
  }
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  const off = (+m[8] * 3600 + +m[9] * 60) * (m[7] === '-' ? -1 : 1);
  return utc - off;
}

// ---------- streaming XMLTV scan ----------
const channels = new Map();   // id -> {names:[], icon:''}
const chOrder = [];
const progs = new Map();      // id -> [record strings]
let nProg = 0, nKept = 0;

function attr(tag, name) { const m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag); return m ? xmlDecode(m[1]) : null; }
function onChannel(block) {
  const head = block.slice(0, block.indexOf('>') + 1);
  const id = attr(head, 'id'); if (id === null) return;
  if (channels.has(id)) return;
  const names = []; let m; const re = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
  while ((m = re.exec(block))) { const nm = textOf(m[1]).trim(); if (nm) names.push(nm); }   // the app trims display-names and drops empty ones (verified on EPGDB)
  const ic = /<icon\s[^>]*src="([^"]*)"/.exec(block);
  channels.set(id, { names, icon: ic ? xmlDecode(ic[1]) : '' });
  chOrder.push(id);
}
function first(block, tag) { const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>').exec(block); return m ? textOf(m[1]) : null; }
function onProgramme(block) {
  nProg++;
  const head = block.slice(0, block.indexOf('>') + 1);
  const start = attr(head, 'start') || '', stop = attr(head, 'stop') || '', ch = attr(head, 'channel');
  if (ch === null) return;
  if (MIN_STOP && stop.length >= 14 && stop.slice(0, 14) < MIN_STOP) return;
  if (MAX_START && start.length >= 14 && start.slice(0, 14) > MAX_START) return;
  nKept++;
  const title = first(block, 'title');
  const sub = first(block, 'sub-title');
  const desc = first(block, 'desc');
  const ic = /<icon\s[^>]*src="([^"]*)"/.exec(block);
  const icon = ic ? xmlDecode(ic[1]) : '';
  let r = '{"name":"' + esc(title === null ? null : sanitize(title)) + '","time":' + sec(start) + ',"time_to":' + sec(stop) + ',"descr":"';
  const hasSub = sub !== null && sub !== '';
  if (hasSub) r += esc(sanitize(sub)) + ' ||' + (desc === null ? 'null' : esc(descSanitize(desc)));
  else r += esc(desc === null ? null : descSanitize(desc));
  if (icon) r += '","icon":"' + esc(icon);
  r += '"}';
  if (ch !== curCh) flushCur();
  if (curCh === null) curCh = ch;
  cur.push(r);
}
// programmes of a channel usually come in one run: keep the run as JS strings, then compact it into one UTF-8 Buffer
let curCh = null, cur = [];
function flushCur() {
  if (curCh !== null && cur.length) {
    // the app keeps only the LAST run of a channel id (a later, non-contiguous run replaces the earlier row) — verified on EPGDB
    progs.set(curCh, { chunks: [Buffer.from(cur.join(',\n'), 'utf8')], n: cur.length });
  }
  curCh = null; cur = [];
}

function run() {
  return new Promise((resolve, reject) => {
    let src = fs.createReadStream(inFile);
    if (/\.gz$/i.test(inFile)) src = src.pipe(zlib.createGunzip());
    src.setEncoding('utf8');   // multi-byte UTF-8 chars split across chunks must be decoded with a StringDecoder
    let rest = '';
    src.on('data', (b) => {
      const s = rest + b; let i = 0;
      while (true) {
        const a = s.indexOf('<programme', i), c = s.indexOf('<channel', i);
        if (c >= 0 && (a < 0 || c < a)) { const e = s.indexOf('</channel>', c); if (e < 0) { i = c; break; } onChannel(s.slice(c, e + 10)); i = e + 10; continue; }
        if (a < 0) { i = Math.max(i, s.length - 20); break; }
        const j = s.indexOf('</programme>', a); if (j < 0) { i = a; break; }
        onProgramme(s.slice(a, j + 12)); i = j + 12;
      }
      rest = s.slice(i);
    });
    src.on('end', () => { flushCur(); resolve(); }); src.on('error', reject);
  });
}

(async () => {
  const t0 = Date.now();
  await run();
  const t1 = Date.now();
  try { fs.unlinkSync(outFile); } catch (e) {}
  const db = new Database(outFile);
  db.pragma('journal_mode = OFF'); db.pragma('synchronous = OFF'); db.pragma('page_size = 4096');
  db.exec('CREATE TABLE channels(id INTEGER PRIMARY KEY, chnl_id VARCHAR, icon_src VARCHAR, prg BLOB, n INTEGER);' +
          'CREATE TABLE channelsname(id INTEGER, disp_name VARCHAR);' +
          'CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);');
  const insC = db.prepare('INSERT INTO channels(id, chnl_id, icon_src, prg, n) VALUES (?,?,?,?,?)');
  const insN = db.prepare('INSERT INTO channelsname(id, disp_name) VALUES (?,?)');
  let id = 0, nCh = 0, rawBytes = 0, gzBytes = 0;
  const HEAD = Buffer.from('{"epg_data":[\n'), SEP = Buffer.from(',\n'), TAIL = Buffer.from('\n]}\n');
  // channels that have programmes but no <channel> element still get a row (the app keys rows by programme channel id)
  // programmes whose channel has no <channel> element are not stored by the app
  db.transaction(() => {
    for (const ch of chOrder) {
      const p = progs.get(ch); if (!p || !p.n) continue;
      const parts = [HEAD]; p.chunks.forEach((b, k) => { if (k) parts.push(SEP); parts.push(b); }); parts.push(TAIL);
      const buf = Buffer.concat(parts); rawBytes += buf.length;
      const gz = zlib.gzipSync(buf, { level: LEVEL }); gzBytes += gz.length;
      id++; nCh++;
      const c = channels.get(ch) || { names: [], icon: '' };
      insC.run(id, ch, c.icon || null, gz, p.n);
      for (const nm of c.names) insN.run(id, nm);
    }
    const ins = db.prepare('INSERT INTO meta(k, v) VALUES (?,?)');
    ins.run('format', 'ikdb1'); ins.run('source', inFile.replace(/\\/g, '/').split('/').pop());
    ins.run('generated', new Date().toISOString()); ins.run('min_stop', MIN_STOP); ins.run('max_start', MAX_START);
    ins.run('channels_total', '' + channels.size); ins.run('channels', '' + nCh); ins.run('programs', '' + nKept);
  })();
  db.close();
  const sz = fs.statSync(outFile).size;
  // --gz: the app opens every EPG download through GZIPInputStream, so the published file is <out>.gz
  if (args.includes('--gz')) {
    await new Promise((res, rej) => fs.createReadStream(outFile).pipe(zlib.createGzip({ level: 6 })).pipe(fs.createWriteStream(outFile + '.gz')).on('finish', res).on('error', rej));
    console.log('gz', outFile + '.gz', fs.statSync(outFile + '.gz').size);
  }
  console.log(JSON.stringify({ channels_total: channels.size, channels: nCh, programmes: nProg, kept: nKept, MIN_STOP, MAX_START, jsonMB: +(rawBytes / 1048576).toFixed(1), gzMB: +(gzBytes / 1048576).toFixed(1), fileMB: +(sz / 1048576).toFixed(1), parseS: (t1 - t0) / 1000, totalS: (Date.now() - t0) / 1000 }));
})().catch((e) => { console.error(e); process.exit(1); });
