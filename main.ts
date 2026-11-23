// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// the V4A patch format, text-editor tool calls as JSON) and applies it to the
// tree in the working directory: every file changes, or nothing does. The
// behaviour is the written specification in SPEC.md, sentence by sentence.
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse fault: the CLI answers `error: parse <n>` and exits 2. */
class ParseErr extends Error {
  readonly n: number;
  constructor(n: number) {
    super(`error: parse ${n}`);
    this.n = n;
  }
}

/** One edit failed: the CLI answers `error: <code> <path>` and exits 1. */
class EditFail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const trimTail = (s: string): string => s.replace(/[ \t]+$/, '');

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** A file as lines: its own break, its lines, whether it ends with a break. */
interface FileState {
  eol: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  const nl = text.indexOf('\n');
  const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { eol, lines: [], final: false };
  const parts = text.split(eol);
  const fin = text.endsWith(eol);
  if (fin) parts.pop();
  return { eol, lines: parts, final: fin };
}

function dumpFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.eol) + (f.final ? f.eol : '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private seen = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  orig(p: string): string | null {
    if (!this.seen.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.seen.set(p, v);
    }
    return this.seen.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.orig(p);
  }

  put(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

/** One edit: apply it to the tree, or throw EditFail; a move edit names its pair. */
interface Edit {
  apply: (tree: Tree) => void;
  movePair?: [string, string];
}

type Tier = 0 | 1 | 2;

function normed(s: string, tier: Tier): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

function tiersFor(strict: boolean): Tier[] {
  return strict ? [0] : [0, 1, 2];
}

/** Every 0-based position where pat occurs in hay at one tier; occurrences may overlap. */
function findAll(hay: string[], pat: string[], tier: Tier): number[] {
  const out: number[] = [];
  if (pat.length === 0 || pat.length > hay.length) return out;
  const np = pat.map((l) => normed(l, tier));
  outer: for (let i = 0; i + pat.length <= hay.length; i++) {
    for (let j = 0; j < pat.length; j++) {
      if (normed(hay[i + j]!, tier) !== np[j]) continue outer;
    }
    out.push(i);
  }
  return out;
}

/** The first tier at which pat occurs at least once, with every occurrence there. */
function locate(hay: string[], pat: string[], strict: boolean): { tier: Tier; at: number[] } | null {
  for (const t of tiersFor(strict)) {
    const at = findAll(hay, pat, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of an old/new pair: its text, and whether it is a context line. */
interface SegLine {
  text: string;
  ctx: boolean;
}

/**
 * The lines that replace a matched run: context lines are the file's own
 * matched lines, never the patch's; at tier 2 every other line is re-indented
 * from the old lines' leading whitespace to the file's.
 */
function buildNew(fileLines: string[], at: number, o: SegLine[], n: SegLine[], tier: Tier): string[] {
  const ctxLines: string[] = [];
  o.forEach((e, idx) => {
    if (e.ctx) ctxLines.push(fileLines[at + idx]!);
  });
  let ci = 0;
  const f = o.length > 0 ? leadWs(fileLines[at]!) : '';
  const p = o.length > 0 ? leadWs(o[0]!.text) : '';
  return n.map((e) => {
    if (e.ctx) return ctxLines[ci++]!;
    if (tier !== 2) return e.text;
    const t = e.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    return t.startsWith(p) ? f + t.slice(p.length) : t;
  });
}

function hunkParts(body: BodyLine[]): { o: SegLine[]; n: SegLine[] } {
  const o: SegLine[] = [];
  const n: SegLine[] = [];
  for (const b of body) {
    if (b.kind === 'c') {
      o.push({ text: b.text, ctx: true });
      n.push({ text: b.text, ctx: true });
    } else if (b.kind === 'o') o.push({ text: b.text, ctx: false });
    else if (b.kind === 'n') n.push({ text: b.text, ctx: false });
  }
  return { o, n };
}

/** A body line: c context, o old, n new, m the `\` marker line. */
interface BodyLine {
  kind: string;
  text: string;
  raw: string;
}

/** Whether a `\` line follows the body's last context or `+` line. */
function markAfterLast(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === 'c' || body[k]!.kind === 'n') last = k;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.kind === 'm';
}

/** The format `--format=auto` detects, or null when none of section 4 holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => trimTail(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  oldP: string | null;
  newP: string | null;
  pair: boolean;
  diffOld: string | null;
  diffNew: string | null;
  from: string | null;
  to: string | null;
  fresh: boolean;
  gone: boolean;
  header: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `--- ` or `+++ ` line names, or null for /dev/null. */
function headPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** A hunk's body, from the line after its header; empty lines at its end are not part of it. */
function readBody(lines: string[], from: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let j = from;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') body.push({ kind: 'c', text: '', raw: l });
    else if (l[0] === ' ') body.push({ kind: 'c', text: l.slice(1), raw: l });
    else if (l[0] === '-') body.push({ kind: 'o', text: l.slice(1), raw: l });
    else if (l[0] === '+') body.push({ kind: 'n', text: l.slice(1), raw: l });
    else if (l[0] === '\\') body.push({ kind: 'm', text: l, raw: l });
    else break;
    j++;
  }
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  return { body, next: j };
}

function parseUnified(lines: string[]): Section[] {
  const secs: Section[] = [];
  const freshSection = (diffOld: string | null, diffNew: string | null): Section => ({
    oldP: null,
    newP: null,
    pair: false,
    diffOld,
    diffNew,
    from: null,
    to: null,
    fresh: false,
    gone: false,
    header: true,
    hunks: [],
  });
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (m === null) throw new ParseErr(i + 1);
      if (cur !== null) secs.push(cur);
      cur = freshSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const op = headPath(line);
      const np = headPath(lines[i + 1]!);
      if (cur !== null && cur.header && !cur.pair) {
        cur.oldP = op;
        cur.newP = np;
        cur.pair = true;
      } else {
        if (cur !== null) secs.push(cur);
        cur = freshSection(null, null);
        cur.oldP = op;
        cur.newP = np;
        cur.pair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.header) throw new ParseErr(i + 2);
      i++;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new ParseErr(i + 1);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new ParseErr(i + 1);
      cur.header = false;
      const r = readBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), body: r.body });
      i = r.next;
      continue;
    }
    if (cur.header) {
      if (line.startsWith('rename from ')) cur.from = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.to = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.fresh = true;
      else if (line.startsWith('deleted file mode')) cur.gone = true;
      i++;
      continue;
    }
    i++;
  }
  if (cur !== null) secs.push(cur);
  return secs;
}

/**
 * Apply one hunk to a file's lines. Returns N's length minus O's length, the
 * hunk's contribution to d. Throws EditFail('no-match', path) when O is nowhere.
 */
function runHunk(st: FileState, h: Hunk, d: number, strict: boolean, path: string): number {
  const { o, n } = hunkParts(h.body);
  if (o.length === 0) {
    const pos = Math.min(Math.max(h.a + d, 0), st.lines.length);
    const ins = n.map((e) => e.text);
    st.lines.splice(pos, 0, ...ins);
    if (pos === st.lines.length - ins.length) st.final = !markAfterLast(h.body);
    return n.length;
  }
  const found = locate(st.lines, o.map((e) => e.text), strict);
  if (found === null) throw new EditFail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.at[0]!;
  let bd = Math.abs(best - target);
  for (const p of found.at) {
    const dd = Math.abs(p - target);
    if (dd < bd) {
      bd = dd;
      best = p;
    }
  }
  const rep = buildNew(st.lines, best, o, n, found.tier);
  const touchesEnd = best + o.length === st.lines.length;
  st.lines.splice(best, o.length, ...rep);
  if (touchesEnd) st.final = !markAfterLast(h.body);
  return n.length - o.length;
}

/** Whether a `\` line follows the last `+` line of any of the section's hunks. */
function markAfterLastPlus(hunks: Hunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const body = hunks[hi]!.body;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.kind === 'n') return body[k + 1] !== undefined && body[k + 1]!.kind === 'm';
    }
  }
  return false;
}

function unifiedEdits(secs: Section[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  for (const s of secs) {
    const oldP = s.pair ? s.oldP : (s.from ?? s.diffOld);
    const newP = s.pair ? s.newP : (s.to ?? s.diffNew);
    if (s.fresh || oldP === null) {
      const target = newP;
      edits.push({
        apply(tree) {
          if (target === null) throw new EditFail('unsafe', '/dev/null');
          if (!isSafe(target)) throw new EditFail('unsafe', target);
          if (tree.get(target) !== null) throw new EditFail('exists', target);
          const plus: string[] = [];
          for (const h of s.hunks) for (const b of h.body) if (b.kind === 'n') plus.push(b.text);
          tree.put(target, dumpFile({ eol: '\n', lines: plus, final: !markAfterLastPlus(s.hunks) }));
        },
      });
    } else if (s.gone || newP === null) {
      const target = oldP;
      edits.push({
        apply(tree) {
          if (target === null) throw new EditFail('missing', '/dev/null');
          if (!isSafe(target)) throw new EditFail('unsafe', target);
          if (tree.get(target) === null) throw new EditFail('missing', target);
          tree.put(target, null);
        },
      });
    } else if (oldP !== newP) {
      const from = oldP;
      const to = newP;
      const edit: Edit = {
        apply(tree) {
          if (!isSafe(from)) throw new EditFail('unsafe', from);
          if (!isSafe(to)) throw new EditFail('unsafe', to);
          const cur = tree.get(from);
          if (cur === null) throw new EditFail('missing', from);
          if (tree.get(to) !== null) throw new EditFail('exists', to);
          const st = parseFile(cur);
          let d = 0;
          for (const h of s.hunks) d += runHunk(st, h, d, strict, from);
          tree.put(from, null);
          tree.put(to, dumpFile(st));
        },
      };
      edit.movePair = [from, to];
      edits.push(edit);
    } else {
      const target = oldP;
      edits.push({
        apply(tree) {
          if (!isSafe(target)) throw new EditFail('unsafe', target);
          const cur = tree.get(target);
          if (cur === null) throw new EditFail('missing', target);
          const st = parseFile(cur);
          let d = 0;
          for (const h of s.hunks) d += runHunk(st, h, d, strict, target);
          tree.put(target, dumpFile(st));
        },
      });
    }
  }
  return edits;
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdit(path: string, oldL: string[], newL: string[], strict: boolean): Edit {
  return {
    apply(tree) {
      if (!isSafe(path)) throw new EditFail('unsafe', path);
      if (oldL.length === 0) {
        if (tree.get(path) !== null) throw new EditFail('exists', path);
        tree.put(path, dumpFile({ eol: '\n', lines: [...newL], final: true }));
        return;
      }
      const cur = tree.get(path);
      if (cur === null) throw new EditFail('missing', path);
      const st = parseFile(cur);
      const found = locate(st.lines, oldL, strict);
      if (found === null) throw new EditFail('no-match', path);
      if (found.at.length > 1) throw new EditFail('ambiguous', path);
      const at = found.at[0]!;
      const o: SegLine[] = oldL.map((t) => ({ text: t, ctx: false }));
      const n: SegLine[] = newL.map((t) => ({ text: t, ctx: false }));
      const rep = buildNew(st.lines, at, o, n, found.tier);
      st.lines.splice(at, oldL.length, ...rep);
      tree.put(path, dumpFile(st));
    },
  };
}

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let floor = 0;
  let i = 0;
  while (i < lines.length) {
    if (trimTail(lines[i]!) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= floor; j--) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseErr(sNo);
      path = prevPath;
    }
    let k = i + 1;
    while (k < lines.length && trimTail(lines[k]!) !== '=======') k++;
    if (k >= lines.length) throw new ParseErr(sNo);
    const oldL = lines.slice(i + 1, k);
    let m = k + 1;
    while (m < lines.length && trimTail(lines[m]!) !== '>>>>>>> REPLACE') m++;
    if (m >= lines.length) throw new ParseErr(sNo);
    const newL = lines.slice(k + 1, m);
    edits.push(srEdit(path, oldL, newL, strict));
    prevPath = path;
    floor = m + 1;
    i = m + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOV = '*** Move to: ';

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function isVSectionStart(l: string): boolean {
  return l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);
}

interface VLine {
  text: string;
  no: number;
}

/** A section's lines, with their numbers, up to the next section or End Patch. */
function collectV(lines: string[], from: number, last: number): { items: VLine[]; next: number } {
  const items: VLine[] = [];
  let j = from;
  while (j < last && !isVSectionStart(lines[j]!)) {
    items.push({ text: lines[j]!, no: j + 1 });
    j++;
  }
  return { items, next: j };
}

/** Blank lines at the end of a section are not part of it. */
function stripVTrail(items: VLine[]): VLine[] {
  let end = items.length;
  while (end > 0 && isBlank(items[end - 1]!.text)) end--;
  return items.slice(0, end);
}

/** Apply one V4A chunk; returns the cursor just after the lines written. */
function runVChunk(st: FileState, ch: VChunk, cursor: number, strict: boolean, path: string): number {
  if (ch.anchor !== null) {
    const a = ch.anchor;
    let foundAt = -1;
    for (const t of tiersFor(strict)) {
      for (let i = cursor; i < st.lines.length; i++) {
        if (normed(st.lines[i]!, t) === normed(a, t)) {
          foundAt = i;
          break;
        }
      }
      if (foundAt >= 0) break;
    }
    if (foundAt < 0) throw new EditFail('no-match', path);
    cursor = foundAt + 1;
  }
  const { o, n } = hunkParts(ch.body);
  if (o.length === 0) {
    const pos = ch.eof ? st.lines.length : cursor;
    st.lines.splice(pos, 0, ...n.map((e) => e.text));
    return pos + n.length;
  }
  for (const t of tiersFor(strict)) {
    const at = findAll(st.lines, o.map((e) => e.text), t).filter(
      (p) => p >= cursor && (!ch.eof || p + o.length === st.lines.length),
    );
    if (at.length > 0) {
      const pos = at[0]!;
      const rep = buildNew(st.lines, pos, o, n, t);
      st.lines.splice(pos, o.length, ...rep);
      return pos + rep.length;
    }
  }
  throw new EditFail('no-match', path);
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith(V_ADD)) {
      const path = line.slice(V_ADD.length).trim();
      const sec = collectV(lines, i + 1, last);
      const body = stripVTrail(sec.items);
      const fileLines: string[] = [];
      for (const it of body) {
        if (it.text === '') fileLines.push('');
        else if (it.text.startsWith('+')) fileLines.push(it.text.slice(1));
        else throw new ParseErr(it.no);
      }
      edits.push({
        apply(tree) {
          if (!isSafe(path)) throw new EditFail('unsafe', path);
          if (tree.get(path) !== null) throw new EditFail('exists', path);
          tree.put(path, dumpFile({ eol: '\n', lines: fileLines, final: true }));
        },
      });
      i = sec.next;
      continue;
    }
    if (line.startsWith(V_DEL)) {
      const path = line.slice(V_DEL.length).trim();
      const sec = collectV(lines, i + 1, last);
      const body = stripVTrail(sec.items);
      for (const it of body) {
        if (!isBlank(it.text)) throw new ParseErr(it.no);
      }
      edits.push({
        apply(tree) {
          if (!isSafe(path)) throw new EditFail('unsafe', path);
          if (tree.get(path) === null) throw new EditFail('missing', path);
          tree.put(path, null);
        },
      });
      i = sec.next;
      continue;
    }
    if (line.startsWith(V_UPD)) {
      const path = line.slice(V_UPD.length).trim();
      const updNo = i + 1;
      const sec = collectV(lines, i + 1, last);
      const items = stripVTrail(sec.items);
      let moveTo: string | null = null;
      let k = 0;
      if (items.length > 0 && items[0]!.text.startsWith(V_MOV)) {
        moveTo = items[0]!.text.slice(V_MOV.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunk = true;
      while (k < items.length) {
        const it = items[k]!;
        const t = it.text;
        if (t.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          firstChunk = false;
          k++;
          continue;
        }
        if (t.trim() === '*** End of File') {
          if (cur === null) throw new ParseErr(it.no);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          k++;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (!firstChunk) throw new ParseErr(it.no);
            cur = { anchor: null, body: [], eof: false };
            firstChunk = false;
          }
          cur.body.push({
            kind: t === '' || t[0] === ' ' ? 'c' : t[0] === '-' ? 'o' : 'n',
            text: t === '' ? '' : t.slice(1),
            raw: t,
          });
          k++;
          continue;
        }
        throw new ParseErr(it.no);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new ParseErr(updNo);
      const edit: Edit = {
        apply(tree) {
          if (!isSafe(path)) throw new EditFail('unsafe', path);
          if (moveTo !== null && !isSafe(moveTo)) throw new EditFail('unsafe', moveTo);
          const curText = tree.get(path);
          if (curText === null) throw new EditFail('missing', path);
          if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
          const st = parseFile(curText);
          let cursor = 0;
          for (const ch of chunks) cursor = runVChunk(st, ch, cursor, strict, path);
          if (moveTo !== null) {
            tree.put(path, null);
            tree.put(moveTo, dumpFile(st));
          } else {
            tree.put(path, dumpFile(st));
          }
        },
      };
      if (moveTo !== null) edit.movePair = [path, moveTo];
      edits.push(edit);
      i = sec.next;
      continue;
    }
    throw new ParseErr(i + 1);
  }
  return edits;
}

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return {
      apply(tree) {
        if (!isSafe(p)) throw new EditFail('unsafe', p);
        if (tree.get(p) !== null) throw new EditFail('exists', p);
        tree.put(p, text);
      },
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      apply(tree) {
        if (!isSafe(p)) throw new EditFail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new EditFail('missing', p);
        const nl = before.indexOf('\n');
        const crlf = nl > 0 && before[nl - 1] === '\r';
        const plain = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
        const t = plain(before);
        const old = plain(oldStr);
        let count = 0;
        for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count++;
        if (count === 0) throw new EditFail('no-match', p);
        if (count > 1) throw new EditFail('ambiguous', p);
        const at = t.indexOf(old);
        let out = t.slice(0, at) + plain(newStr) + t.slice(at + old.length);
        if (crlf) out = out.replaceAll('\n', '\r\n');
        tree.put(p, out);
      },
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = splitPatch(o.new_str);
    return {
      apply(tree) {
        if (!isSafe(p)) throw new EditFail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new EditFail('missing', p);
        const st = parseFile(before);
        if (lineNo < 0 || lineNo > st.lines.length) throw new EditFail('no-match', p);
        st.lines.splice(lineNo, 0, ...add);
        tree.put(p, dumpFile(st));
      },
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseErr(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseErr(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseErr(i + 1);
    edits.push(e);
  });
  return edits;
}

// ---- Running the patch (SPEC.md sections 1, 2 and 10) ----

interface Outcome {
  code: number;
  out: string[];
}

/** The output rows for exit 0: one line per path whose state changed, in byte order. */
function outputRows(tree: Tree, moves: [string, string][]): string[] {
  const rows: { key: string; line: string }[] = [];
  const used = new Set<string>();
  for (const [o, n] of moves) {
    if (tree.orig(o) !== null && tree.get(o) === null && tree.orig(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      used.add(o);
      used.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (used.has(p)) continue;
    const was = tree.orig(p);
    const now = tree.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return rows.map((r) => r.line);
}

function run(argv: string[]): Outcome {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice(9);
        if (format !== null || !FORMAT_NAMES.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(parseUnified(lines), strict);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseErr(1);
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [`error: parse ${e.n}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  const moves: [string, string][] = [];
  for (const ed of edits) {
    const snap = new Map(tree.now);
    try {
      ed.apply(tree);
      if (ed.movePair !== undefined) moves.push(ed.movePair);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of snap) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows = outputRows(tree, moves);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.orig(p);
      const now = tree.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
