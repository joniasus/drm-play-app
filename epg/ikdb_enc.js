// IKE1 шифрлаш/ечиш (spec: docs/superpowers/specs/2026-11-06-ikdb-protection-design.md).
//   IKDB_MASTER=<64 hex> node ikdb_enc.js enc <plain.ikdb> <out.ikdb>
//   IKDB_MASTER=<64 hex> node ikdb_enc.js dec <enc.ikdb>   <out.db>      (синов учун)
// Формат: 0..3 "IKE1", 4..15 fid (тасодифий), 16.. AES-256-CTR(K, IV) — K = HMAC(MASTER, "k"‖fid), IV = HMAC(K, "iv")[0..16].
// Ҳажм плайн билан бир хил. MASTER env'дан ёки (локал) ../.secrets'дан.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const MAGIC = Buffer.from('SQLite format 3\0', 'latin1'), TAG = Buffer.from('IKE1');

function master() {
    let h = process.env.IKDB_MASTER || '';
    if (!h) { try { h = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.secrets'), 'utf8')).master; } catch (e) { h = ''; } }
    if (!/^[0-9a-f]{64}$/i.test(h)) throw new Error('IKDB_MASTER missing');
    return Buffer.from(h, 'hex');
}
function keys(m, fid) {
    const k = crypto.createHmac('sha256', m).update(Buffer.concat([Buffer.from('k'), fid])).digest();
    const iv = crypto.createHmac('sha256', k).update('iv').digest().subarray(0, 16);
    return {k, iv};
}
function xform(inFile, outFile, head, fid) {
    const {k, iv} = keys(master(), fid);
    const c = crypto.createCipheriv('aes-256-ctr', k, iv);
    const fi = fs.openSync(inFile, 'r'), fo = fs.openSync(outFile, 'w');
    try {
        fs.writeSync(fo, head, 0, 16, 0);
        const buf = Buffer.allocUnsafe(1 << 20); let pos = 16, n;
        while ((n = fs.readSync(fi, buf, 0, buf.length, pos)) > 0) { const o = c.update(buf.subarray(0, n)); fs.writeSync(fo, o, 0, o.length, pos); pos += n; }
        const f = c.final(); if (f.length) throw new Error('ctr final');
    } finally { fs.closeSync(fi); fs.closeSync(fo); }
}
function readHead(f) { const fd = fs.openSync(f, 'r'), b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd); return b; }

const [mode, a, b] = process.argv.slice(2);
if (mode === 'enc') {
    if (!readHead(a).equals(MAGIC)) throw new Error('input is not a plain SQLite file');
    const fid = crypto.randomBytes(12);
    xform(a, b, Buffer.concat([TAG, fid]), fid);
    console.log('IKE1 written: ' + path.basename(b) + ' (' + fs.statSync(b).size + ' B, fid ' + fid.toString('hex').slice(0, 8) + '…)');
} else if (mode === 'dec') {
    const h = readHead(a);
    if (!h.subarray(0, 4).equals(TAG)) throw new Error('input is not IKE1');
    xform(a, b, MAGIC, h.subarray(4, 16));
    console.log('decrypted: ' + path.basename(b));
} else { console.error('usage: node ikdb_enc.js enc|dec <in> <out>'); process.exit(2); }
