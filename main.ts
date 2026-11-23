// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- section 5: tiered matching ----------

// A file's lines, its line break, and whether it ends with one (section 3).
interface Doc { lines: string[]; br: string; final: boolean; }
function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// Positions where o occurs in file at the given tier (overlapping allowed).
function occurrences(file: string[], o: string[], tier: number): number[] {
  const pos: number[] = [];
  if (o.length === 0 || o.length > file.length) return pos;
  const on = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(file[i + j]!, tier) !== on[j]) { ok = false; break; }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

// First tier (0..2, or 0 only when strict) with at least one occurrence.
function findTier(file: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(file, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

// First tier with an occurrence at or after `from`; when eof, only occurrences
// whose last line is the file's last line. Returns the first such position.
function findTierFrom(file: string[], o: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (const p of occurrences(file, o, t)) {
      if (p < from) continue;
      if (eof && p + o.length !== file.length) continue;
      return { tier: t, pos: p };
    }
  }
  return null;
}

// Replace o at position pos with n. nCtx[j] is the index into o of the context
// line that n[j] is (or null when n[j] is not a context line). Context lines
// are written as the file's own matched line; at tier 2 every other line of n
// is re-indented from o's first line's leading whitespace to the file's.
function spliceLines(file: string[], pos: number, o: string[], n: string[], tier: number, nCtx: (number | null)[]): string[] {
  const out = file.slice(0, pos);
  const f0 = file[pos] ?? '';
  const p0 = o[0] ?? '';
  const F = /^[ \t]*/.exec(f0)![0];
  const P = /^[ \t]*/.exec(p0)![0];
  for (let j = 0; j < n.length; j++) {
    const ci = nCtx[j];
    if (ci !== null && ci !== undefined) { out.push(file[pos + ci]!); continue; }
    let line = n[j]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(P)) {
      line = F + line.slice(P.length);
    }
    out.push(line);
  }
  out.push(...file.slice(pos + o.length));
  return out;
}

// ---------- section 6: unified diff ----------

type BodyLine = { t: 'ctx' | 'old' | 'new' | 'bs'; text: string; e: boolean };
interface Hunk { a: number; body: BodyLine[]; }
interface Section {
  oldPath: string | null; // null means /dev/null
  newPath: string | null;
  renFrom: string | null;
  renTo: string | null;
  dgX: string | null;
  dgY: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function parseUnifiedPath(line: string): string {
  // Text after the four characters, up to the first tab, surrounding spaces removed.
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return '/dev/null';
  if (p.startsWith('a/')) p = p.slice(2);
  if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseDiffGit(line: string, i: number): { x: string; y: string } {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  return { x: m[1]!, y: m[2]! };
}

function parseHunkHeader(line: string, i: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  return parseInt(m[1]!, 10);
}

function classifyBody(line: string): BodyLine {
  if (line === '') return { t: 'ctx', text: '', e: true };
  if (line.startsWith(' ')) return { t: 'ctx', text: line.slice(1), e: false };
  if (line.startsWith('-')) return { t: 'old', text: line.slice(1), e: false };
  if (line.startsWith('+')) return { t: 'new', text: line.slice(1), e: false };
  return { t: 'bs', text: line.slice(1), e: false };
}

// O and N of a hunk, plus for each line of N the index into O of the context
// line it is (null when it is not a context line).
function hunkON(h: Hunk): { o: string[]; n: string[]; nCtx: (number | null)[] } {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: (number | null)[] = [];
  for (const b of h.body) {
    if (b.t === 'ctx') { nCtx.push(o.length); o.push(b.text); n.push(b.text); }
    else if (b.t === 'old') o.push(b.text);
    else if (b.t === 'new') { nCtx.push(null); n.push(b.text); }
  }
  return { o, n, nCtx };
}

// Whether a `\` line follows the hunk's last context or `+` line.
function hunkHasBs(h: Hunk): boolean {
  let last = -1;
  for (let j = 0; j < h.body.length; j++) {
    if (h.body[j]!.t === 'ctx' || h.body[j]!.t === 'new') last = j;
  }
  return last >= 0 && h.body[last + 1]?.t === 'bs';
}

// Apply a section's hunks in order to a document. Throws Fail on a hunk miss.
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): Doc {
  let d = 0;
  for (const h of hunks) {
    const { o, n, nCtx } = hunkON(h);
    const bs = hunkHasBs(h);
    if (o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, doc.lines.length));
      const atEnd = pos === doc.lines.length;
      doc.lines = [...doc.lines.slice(0, pos), ...n, ...doc.lines.slice(pos)];
      if (atEnd) doc.final = !bs;
    } else {
      const found = findTier(doc.lines, o, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) { best = p; bestDist = dist; }
      }
      const atEnd = best + o.length === doc.lines.length;
      doc.lines = spliceLines(doc.lines, best, o, n, found.tier, nCtx);
      if (atEnd) doc.final = !bs;
    }
    d += n.length - o.length;
  }
  return doc;
}

function sectionPaths(sec: Section): { oldP: string | null; newP: string | null } {
  // /dev/null means no file, whichever header named it.
  const norm = (p: string | null): string | null => (p === '/dev/null' ? null : p);
  const oldP = norm(sec.oldPath ?? sec.renFrom ?? sec.dgX);
  const newP = norm(sec.newPath ?? sec.renTo ?? sec.dgY);
  return { oldP, newP };
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const { oldP, newP } = sectionPaths(sec);
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.isCreate;
    const isDelete = newP === null || sec.isDelete;
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.t === 'new') plus.push(b.text);
      if (plus.length === 0) { tree.now.set(newP, ''); return; }
      let lastPlusBs = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        let lastNew = -1;
        for (let j = 0; j < h.body.length; j++) if (h.body[j]!.t === 'new') lastNew = j;
        if (lastNew >= 0) { lastPlusBs = h.body[lastNew + 1]?.t === 'bs'; break; }
      }
      tree.now.set(newP, plus.join('\n') + (lastPlusBs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('missing', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (oldP === null) throw new Fail('missing', '');
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const doc = applyHunks(parseDoc(tree.get(oldP)!), sec.hunks, strict, oldP);
      tree.now.set(newP, writeDoc(doc));
      tree.now.set(oldP, null);
      tree.moves.push({ old: oldP, new: newP });
      return;
    }
    if (oldP === null) throw new Fail('missing', '');
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    const doc = applyHunks(parseDoc(tree.get(oldP)!), sec.hunks, strict, oldP);
    tree.now.set(oldP, writeDoc(doc));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const newSection = (dgX: string | null, dgY: string | null): Section => {
    const sec: Section = {
      oldPath: null, newPath: null, renFrom: null, renTo: null,
      dgX, dgY, isCreate: false, isDelete: false, hunks: [],
    };
    sections.push(sec);
    cur = sec;
    inHeader = true;
    return sec;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const dg = parseDiffGit(l, i);
      newSection(dg.x, dg.y);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.oldPath = parseUnifiedPath(l);
        cur.newPath = parseUnifiedPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      const sec = newSection(null, null);
      sec.oldPath = parseUnifiedPath(l);
      sec.newPath = parseUnifiedPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(l, i);
      inHeader = false;
      i++;
      const body: BodyLine[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(classifyBody(b));
          i++;
          continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it: a body line that
      // is blank (a context line whose text is empty) at the end is dropped.
      let trim = 0;
      for (let k = body.length - 1; k >= 0 && body[k]!.t === 'ctx' && body[k]!.text === ''; k--) trim++;
      if (trim > 0) body.splice(body.length - trim, trim);
      cur.hunks.push({ a, body });
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) cur.renFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.isCreate = true;
      else if (l.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

// ---------- section 7: SEARCH/REPLACE ----------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const doc = parseDoc(text);
    const found = findTier(doc.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    doc.lines = spliceLines(doc.lines, found.pos[0]!, oldLines, newLines, found.tier, oldLines.map(() => null));
    tree.now.set(path, writeDoc(doc));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (true) {
    let s = -1;
    for (let j = prevEnd; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') { s = j; break; }
    }
    if (s < 0) break;
    // Path: nearest line before the SEARCH line, after the previous block's
    // REPLACE line, that is not blank and does not start with three backticks.
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { eq = j; break; }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') { rep = j; break; }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
  }
  return edits;
}

// ---------- section 8: V4A ----------

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseDoc(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTierFrom(doc.lines, [ch.anchor], cursor, strict, false);
        if (!found) throw new Fail('no-match', path);
        cursor = found.pos + 1;
      }
      const { o, n, nCtx } = hunkON({ a: 0, body: ch.body });
      if (o.length === 0) {
        const pos = ch.eof ? doc.lines.length : cursor;
        doc.lines = [...doc.lines.slice(0, pos), ...n, ...doc.lines.slice(pos)];
        cursor = pos + n.length;
      } else {
        const found = findTierFrom(doc.lines, o, cursor, strict, ch.eof);
        if (!found) throw new Fail('no-match', path);
        doc.lines = spliceLines(doc.lines, found.pos, o, n, found.tier, nCtx);
        cursor = found.pos + n.length;
      }
    }
    const out = writeDoc(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const fileLines: string[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        const b = lines[i]!;
        if (b === '') { fileLines.push(''); i++; continue; }
        if (b.startsWith('+')) { fileLines.push(b.slice(1)); i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      edits.push(v4aDeleteEdit(path));
      i++;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const startLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      while (i < last && !isSectionStart(lines[i]!)) {
        const b = lines[i]!;
        if (b.startsWith('@@')) {
          cur = { anchor: b.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          i++;
          continue;
        }
        if (b === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          i++;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) {
              if (b === '') { i++; continue; } // blank line after an end-of-file chunk: not part of any chunk
              throw new Exit2(`error: parse ${i + 1}`);
            }
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push(classifyBody(b));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        // Blank lines at the end of a section are not part of it: a body line
        // that is blank (a context line whose text is empty) at the end is dropped.
        let trim = 0;
        for (let k = lastChunk.body.length - 1; k >= 0 && lastChunk.body[k]!.t === 'ctx' && lastChunk.body[k]!.text === ''; k--) trim++;
        if (trim > 0) lastChunk.body.splice(lastChunk.body.length - trim, trim);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface OutRow { key: string; line: string; }
  const rows: OutRow[] = [];
  const covered = new Set<string>();
  // A file moved by a move edit that succeeded, when <old> existed before the
  // patch and does not after it, and <new> did not exist before it and does
  // after it, is one R line (replacing that pair's D and A lines), sorted by <new>.
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
