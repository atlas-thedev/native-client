'use strict';
/**
 * A tiny read-only SQLite reader: enough to list the rows of one table from another app's database
 * (the Modrinth App keeps its instance list in app.db). Pages written to the -wal file but not yet
 * checkpointed are read too, so a profile created a minute ago still shows up. Never writes anything.
 *
 *   readTable('/path/app.db', 'instances') -> [{ path: 'Fabulously Optimized', name: 'FO', ... }]
 *   readTables('/path/app.db', ['instances', 'settings']) -> { instances: [...], settings: [...] }
 *
 * Pages are read from disk when needed (the Modrinth app.db also holds a large API cache we never touch).
 */
const fs = require('fs');

function varint(buf, at) {
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    const byte = buf[at + i];
    value = (value << 7n) | BigInt(byte & 0x7f);
    if (!(byte & 0x80)) return [value, i + 1];
  }
  return [(value << 8n) | BigInt(buf[at + 8]), 9];
}

/** Pages from the WAL that belong to its last committed transaction (page number -> Buffer). */
function walPages(walPath, pageSize) {
  const pages = new Map();
  let wal;
  try { wal = fs.readFileSync(walPath); } catch { return pages; }
  if (wal.length < 32) return pages;
  const magic = wal.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return pages;
  if (wal.readUInt32BE(8) !== pageSize) return pages;
  const salt1 = wal.readUInt32BE(16), salt2 = wal.readUInt32BE(20);
  let pending = new Map();
  for (let at = 32; at + 24 + pageSize <= wal.length; at += 24 + pageSize) {
    if (wal.readUInt32BE(at + 8) !== salt1 || wal.readUInt32BE(at + 12) !== salt2) break; // an older generation
    pending.set(wal.readUInt32BE(at), wal.subarray(at + 24, at + 24 + pageSize));
    if (wal.readUInt32BE(at + 4) !== 0) { // commit frame
      for (const [n, page] of pending) pages.set(n, page);
      pending = new Map();
    }
  }
  return pages;
}

function open(dbPath) {
  const fd = fs.openSync(dbPath, 'r');
  const head = Buffer.alloc(100);
  fs.readSync(fd, head, 0, 100, 0);
  if (head.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') { fs.closeSync(fd); throw new Error('Not an SQLite database'); }
  let pageSize = head.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  const reserved = head[20];
  const wal = walPages(dbPath + '-wal', pageSize);
  const cache = new Map();
  const page = (n) => {
    const fromWal = wal.get(n);
    if (fromWal) return fromWal;
    let buf = cache.get(n);
    if (!buf) {
      buf = Buffer.alloc(pageSize);
      fs.readSync(fd, buf, 0, pageSize, (n - 1) * pageSize);
      if (cache.size > 4096) cache.clear();
      cache.set(n, buf);
    }
    return buf;
  };
  const close = () => { try { fs.closeSync(fd); } catch { /* already closed */ } };
  const usable = pageSize - reserved;

  /** The full payload of a cell, following overflow pages. */
  function payload(buf, at, size, isTable) {
    const maxLocal = isTable ? usable - 35 : Math.floor(((usable - 12) * 64) / 255) - 23;
    if (size <= maxLocal) return buf.subarray(at, at + size);
    const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
    let local = minLocal + ((size - minLocal) % (usable - 4));
    if (local > maxLocal) local = minLocal;
    const parts = [buf.subarray(at, at + local)];
    let left = size - local;
    let next = buf.readUInt32BE(at + local);
    while (left > 0 && next) {
      const ov = page(next);
      const take = Math.min(left, usable - 4);
      parts.push(ov.subarray(4, 4 + take));
      left -= take;
      next = ov.readUInt32BE(0);
    }
    return Buffer.concat(parts);
  }

  function record(buf) {
    const [headerSize, hn] = varint(buf, 0);
    const types = [];
    let at = hn;
    while (at < Number(headerSize)) {
      const [t, n] = varint(buf, at);
      types.push(Number(t));
      at += n;
    }
    const values = [];
    at = Number(headerSize);
    for (const t of types) {
      if (t === 0) values.push(null);
      else if (t >= 1 && t <= 6) {
        const len = [0, 1, 2, 3, 4, 6, 8][t];
        let v = 0n;
        for (let i = 0; i < len; i += 1) v = (v << 8n) | BigInt(buf[at + i]);
        const bits = BigInt(len * 8);
        if (len && v >= 1n << (bits - 1n)) v -= 1n << bits;
        values.push(Number(v));
        at += len;
      } else if (t === 7) { values.push(buf.readDoubleBE(at)); at += 8; }
      else if (t === 8) values.push(0);
      else if (t === 9) values.push(1);
      else if (t >= 12) {
        const len = t % 2 === 0 ? (t - 12) / 2 : (t - 13) / 2;
        const slice = buf.subarray(at, at + len);
        values.push(t % 2 === 0 ? Buffer.from(slice) : slice.toString('utf8'));
        at += len;
      } else values.push(null);
    }
    return values;
  }

  /** Every row of a table b-tree, in rowid order: [rowid, values[]]. */
  function scan(root, out = [], depth = 0) {
    if (depth > 40) return out;
    const buf = page(root);
    const base = root === 1 ? 100 : 0;
    const kind = buf[base];
    const cells = buf.readUInt16BE(base + 3);
    const headerLen = kind === 0x05 ? 12 : 8;
    for (let i = 0; i < cells; i += 1) {
      const cell = buf.readUInt16BE(base + headerLen + i * 2);
      if (kind === 0x05) scan(buf.readUInt32BE(cell), out, depth + 1);
      else if (kind === 0x0d) {
        const [size, a] = varint(buf, cell);
        const [rowid, b] = varint(buf, cell + a);
        out.push([Number(rowid), record(payload(buf, cell + a + b, Number(size), true))]);
      }
    }
    if (kind === 0x05) scan(buf.readUInt32BE(base + 8), out, depth + 1);
    return out;
  }
  return { scan, close };
}

/** CREATE TABLE text without SQL comments (Modrinth's migrations keep -- comments inside the column list). */
function stripComments(sql) {
  let out = '', quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) { out += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i += 1; out += ' '; continue; }
    if (ch === '/' && sql[i + 1] === '*') { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 1; out += ' '; continue; }
    out += ch;
  }
  return out;
}

/** Column definitions of a CREATE TABLE statement (table constraints skipped). */
function columnDefs(sql) {
  const text = stripComments(String(sql || ''));
  const body = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'));
  const parts = [];
  let depth = 0, cur = '', quote = null;
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts
    .map((part) => part.trim())
    .filter((part) => part && !/^(primary|unique|foreign|check|constraint)\b/i.test(part))
    .map((part) => ({ name: (part.match(/^["`[]?([^"`\]\s]+)/) || [])[1], intKey: /\binteger\s+primary\s+key\b/i.test(part) }));
}

const columnsOf = (sql) => columnDefs(sql).map((c) => c.name);

function rowsOf(db, master, table) {
  const entry = master.find((row) => row.type === 'table' && row.name === table);
  if (!entry) return [];
  const columns = columnDefs(entry.sql);
  return db.scan(entry.root).map(([rowid, values]) => {
    const row = {};
    columns.forEach((col, i) => { row[col.name] = col.intKey && values[i] == null ? rowid : values[i] ?? null; });
    return row;
  });
}

/** Rows of several tables in one pass over the file: { [table]: rows[] } (a missing table gives []). */
function readTables(dbPath, tables) {
  const db = open(dbPath);
  try {
    const master = db.scan(1).map(([, v]) => ({ type: v[0], name: v[1], root: v[3], sql: v[4] }));
    return Object.fromEntries(tables.map((table) => {
      try { return [table, rowsOf(db, master, table)]; } catch { return [table, []]; }
    }));
  } finally {
    db.close();
  }
}

const readTable = (dbPath, table) => readTables(dbPath, [table])[table];

module.exports = { readTable, readTables, columnsOf };
