// main.ts is mend, the CLI SPEC.md specifies: it reads a patch in one of four formats — a unified diff,
// SEARCH/REPLACE blocks, a V4A patch or JSON edits — finds the lines each edit names at the first of three
// matching tiers, and writes every change or none, printing what it changed or why it failed.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch the reader refuses: exit 2 with this one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: exit 1 names its code and the path it concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed, no empty piece after a final `\n` (section 3). */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it names a file below the root (section 3). */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------- files, line breaks and matching (sections 3 and 5) ----------

interface Model {
  lines: string[];
  final: boolean;
  br: string;
}

/** How a file's text is read: its break, its lines, and whether it ends with that break. */
function readModel(text: string): Model {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], final: false, br };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, final, br };
}

/** The text a file's model writes back (section 3: no lines writes empty). */
function writeModel(m: Model): string {
  return m.lines.length === 0 ? '' : m.lines.join(m.br) + (m.final ? m.br : '');
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const stripTail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');

/** A line as one matching tier reads it: 0 exact, 1 without trailing spaces and tabs, 2 without either. */
function tierText(line: string, tier: number): string {
  return tier === 0 ? line : tier === 1 ? stripTail(line) : stripBoth(line);
}

/** The positions O occurs at, at the first tier that holds one; null when no tier does (section 5). */
function occurrences(O: string[], lines: string[], strict: boolean): { tier: number; at: number[] } | null {
  const last = strict ? 0 : 2;
  for (let tier = 0; tier <= last; tier += 1) {
    const key = O.map((l) => tierText(l, tier));
    const at: number[] = [];
    for (let i = 0; i + O.length <= lines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < O.length; j += 1) {
        if (tierText(lines[i + j]!, tier) !== key[j]!) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** The first line at or after `from` that matches `anchor` as a single line, at the first tier with one (section 8). */
function anchorAt(anchor: string, lines: string[], from: number, strict: boolean): { tier: number; at: number } | null {
  const last = strict ? 0 : 2;
  for (let tier = 0; tier <= last; tier += 1) {
    const k = tierText(anchor, tier);
    for (let i = from; i < lines.length; i += 1) {
      if (tierText(lines[i]!, tier) === k) return { tier, at: i };
    }
  }
  return null;
}

/** A line of N at tier 2 takes the file's indentation F in place of O's P when it starts with P (section 5). */
function reindented(line: string, F: string, P: string, tier: number): string {
  if (tier !== 2) return line;
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(P)) return line;
  return F + line.slice(P.length);
}

/** One line of a hunk or chunk body: a context line, an old line, a new line, or a `\` line. */
type BodyKind = ' ' | '-' | '+' | '\\';
interface Body {
  kind: BodyKind;
  text: string;
}

/** The old lines O and new lines N a body names, in body order. */
const oldOf = (body: Body[]): string[] => body.filter((b) => b.kind === ' ' || b.kind === '-').map((b) => b.text);
const newLen = (body: Body[]): number => body.filter((b) => b.kind === ' ' || b.kind === '+').length;

/** Whether a `\` line follows the body's last context or `+` line (sections 6 and 8). */
function endsWithoutEol(body: Body[]): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const b = body[k]!;
    if (b.kind === ' ' || b.kind === '+') return k + 1 < body.length && body[k + 1]!.kind === '\\';
  }
  return false;
}

/** The lines N writes when it replaces O at `pos`: context lines are the file's own, the rest re-indent at tier 2. */
function buildN(body: Body[], fileLines: string[], pos: number, tier: number): string[] {
  const firstO = body.find((b) => b.kind === ' ' || b.kind === '-');
  const P = firstO === undefined ? '' : leadingWs(firstO.text);
  const F = pos < fileLines.length ? leadingWs(fileLines[pos]!) : '';
  const out: string[] = [];
  let k = pos;
  for (const b of body) {
    if (b.kind === '\\') continue;
    if (b.kind === '-') {
      k += 1;
      continue;
    }
    if (b.kind === '+') {
      out.push(reindented(b.text, F, P, tier));
      continue;
    }
    out.push(fileLines[k]!);
    k += 1;
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Every move edit that succeeded, in the patch's order (sections 6 and 8), for the `R` lines (section 2). */
  readonly moves: Array<[string, string]> = [];
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
  snapshot(): { now: Map<string, string | null>; moves: Array<[string, string]> } {
    return { now: new Map(this.now), moves: this.moves.slice() };
  }
  restore(s: { now: Map<string, string | null>; moves: Array<[string, string]> }): void {
    this.now.clear();
    for (const [k, v] of s.now) this.now.set(k, v);
    this.moves.length = 0;
    for (const m of s.moves) this.moves.push(m);
  }
}

type Edit = (tree: Tree) => void;

// ---------- detecting the format (section 4) ----------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => stripTail(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- unified diffs (section 6) ----------

const isDiffGit = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');

/** The old and new path a `diff --git a/<X> b/<Y>` line names; any other form is a parse fault. */
function diffGitPaths(l: string, lineNo: number): [string, string] {
  if (!l.startsWith('diff --git ')) throw new Exit2(`error: parse ${lineNo}`);
  const rest = l.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNo}`);
  const sep = rest.indexOf(' b/');
  if (sep < 0) throw new Exit2(`error: parse ${lineNo}`);
  return [rest.slice(2, sep), rest.slice(sep + 3)];
}

/** A `--- <path>` or `+++ <path>` header's path: after 4 characters, up to the first tab, trimmed,
 *  `/dev/null` as no file, one leading `a/` or `b/` removed. */
function headerPath(l: string): string | null {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** One unified section before its paths are final: every header names a candidate. */
interface USection {
  gitOld?: string;
  gitNew?: string;
  dashOld?: string | null;
  dashNew?: string | null;
  dashSeen: boolean;
  renOld?: string;
  renNew?: string;
  create: boolean;
  del: boolean;
  hunks: Array<{ A: number; body: Body[] }>;
}

/** The old and new path of a section, by the order section 6 gives them. */
function sectionPaths(s: USection): { oldPath: string | null; newPath: string | null } {
  let o: string | null | undefined;
  if (s.dashSeen) o = s.dashOld;
  else if (s.renOld !== undefined) o = s.renOld;
  else o = s.gitOld;
  let n: string | null | undefined;
  if (s.dashSeen) n = s.dashNew;
  else if (s.renNew !== undefined) n = s.renNew;
  else n = s.gitNew;
  if (s.create) o = null;
  if (s.del) n = null;
  return { oldPath: o ?? null, newPath: n ?? null };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A hunk body: the lines after the header that are body lines, its trailing empty lines left out. */
function hunkBody(lines: string[], start: number): { body: Body[]; next: number } {
  const n = lines.length;
  let end = start;
  while (end < n) {
    const l = lines[end]!;
    if (l === '') {
      end += 1;
      continue;
    }
    const c = l[0];
    if (c === ' ' || c === '+' || c === '\\') {
      end += 1;
      continue;
    }
    if (c === '-') {
      // A `--- ` line followed by `+++ ` opens a new section; any other `-` line is an old line.
      if (l.startsWith('--- ') && (lines[end + 1] ?? '').startsWith('+++ ')) break;
      end += 1;
      continue;
    }
    break;
  }
  let stop = end;
  while (stop > start) {
    const l = lines[stop - 1]!;
    if (l === '' || l === ' ') stop -= 1;
    else break;
  }
  const body: Body[] = [];
  for (let i = start; i < stop; i += 1) {
    const l = lines[i]!;
    if (l === '') body.push({ kind: ' ', text: '' });
    else if (l[0] === ' ') body.push({ kind: ' ', text: l.slice(1) });
    else if (l[0] === '-' || l[0] === '+' || l[0] === '\\') body.push({ kind: l[0] as BodyKind, text: l.slice(1) });
  }
  return { body, next: stop };
}

/** Every section of a unified patch, read as section 6 says. */
function parseUnified(lines: string[]): USection[] {
  const n = lines.length;
  const sections: USection[] = [];
  let cur: USection | null = null;
  const open = (): USection => {
    const s: USection = { dashSeen: false, create: false, del: false, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (isDiffGit(l)) {
      const [x, y] = diffGitPaths(l, i + 1);
      const s = open();
      s.gitOld = x;
      s.gitNew = y;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const got = hunkBody(lines, i + 1);
      cur.hunks.push({ A: Number(m[1]), body: got.body });
      i = got.next;
      continue;
    }
    const inHeader = cur !== null && cur.hunks.length === 0;
    if (inHeader) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur!.dashSeen) {
            // A second `---`/`+++` pair is a new section, not this one's header.
            const s = open();
            s.dashSeen = true;
            s.dashOld = headerPath(l);
            s.dashNew = headerPath(lines[i + 1]!);
            i += 2;
            continue;
          }
          cur!.dashSeen = true;
          cur!.dashOld = headerPath(l);
          cur!.dashNew = headerPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) {
        cur!.renOld = l.slice('rename from '.length);
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur!.renNew = l.slice('rename to '.length);
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur!.create = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur!.del = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = open();
      s.dashSeen = true;
      s.dashOld = headerPath(l);
      s.dashNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** The text a creation writes: every hunk's `+` lines, with a final LF unless a `\` line follows the last. */
function createdText(hunks: Array<{ A: number; body: Body[] }>): string {
  const xs: string[] = [];
  for (const h of hunks) for (const b of h.body) if (b.kind === '+') xs.push(b.text);
  if (xs.length === 0) return '';
  let noEol = false;
  outer: for (let h = hunks.length - 1; h >= 0; h -= 1) {
    const body = hunks[h]!.body;
    for (let k = body.length - 1; k >= 0; k -= 1) {
      if (body[k]!.kind === '+') {
        noEol = k + 1 < body.length && body[k + 1]!.kind === '\\';
        break outer;
      }
    }
  }
  return xs.join('\n') + (noEol ? '' : '\n');
}

/** The lines and final break after a section's hunks apply in order (sections 5 and 6). */
function applyHunks(m: Model, hunks: Array<{ A: number; body: Body[] }>, strict: boolean, path: string): { lines: string[]; final: boolean } {
  let lines = m.lines.slice();
  let final = m.final;
  let d = 0;
  for (const h of hunks) {
    const beforeLen = lines.length;
    const O = oldOf(h.body);
    const N = newLen(h.body);
    let pos: number;
    let tier: number;
    if (O.length > 0) {
      const found = occurrences(O, lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = found.at[0]!;
      for (const p of found.at) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      pos = best;
      tier = found.tier;
    } else {
      pos = Math.max(0, Math.min(h.A + d, beforeLen));
      tier = 0;
    }
    const repl = buildN(h.body, lines, pos, tier);
    lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + O.length)];
    d += N - O.length;
    if (pos + O.length === beforeLen) final = !endsWithoutEol(h.body);
  }
  return { lines, final };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => {
    const { oldPath, newPath } = sectionPaths(s);
    if (s.create || oldPath === null) {
      return (tree: Tree): void => {
        const p = newPath!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, createdText(s.hunks));
      };
    }
    if (s.del || newPath === null) {
      return (tree: Tree): void => {
        const p = oldPath!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    if (oldPath !== newPath) {
      return (tree: Tree): void => {
        const a = oldPath!;
        const b = newPath!;
        if (!safe(a)) throw new Fail('unsafe', a);
        if (!safe(b)) throw new Fail('unsafe', b);
        const t = tree.get(a);
        if (t === null) throw new Fail('missing', a);
        if (tree.get(b) !== null) throw new Fail('exists', b);
        const m = readModel(t);
        const r = applyHunks(m, s.hunks, strict, a);
        tree.now.set(b, writeModel({ lines: r.lines, final: r.final, br: m.br }));
        tree.now.set(a, null);
        tree.moves.push([a, b]);
      };
    }
    return (tree: Tree): void => {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      const t = tree.get(p);
      if (t === null) throw new Fail('missing', p);
      const m = readModel(t);
      const r = applyHunks(m, s.hunks, strict, p);
      tree.now.set(p, writeModel({ lines: r.lines, final: r.final, br: m.br }));
    };
  });
}

// ---------- SEARCH/REPLACE blocks (section 7) ----------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
  line: number;
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const n = lines.length;
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < n) {
    if (stripTail(lines[i]!) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let sep = -1;
    for (let j = i + 1; j < n; j += 1) {
      if (stripTail(lines[j]!) === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = sep + 1; j < n; j += 1) {
      if (stripTail(lines[j]!) === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end), line: searchLine });
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((b) => {
    const path = b.path;
    if (b.oldLines.length === 0) {
      return (tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      };
    }
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      const t = tree.get(path);
      if (t === null) throw new Fail('missing', path);
      const m = readModel(t);
      const found = occurrences(b.oldLines, m.lines, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.at.length > 1) throw new Fail('ambiguous', path);
      const pos = found.at[0]!;
      const F = leadingWs(m.lines[pos]!);
      const P = leadingWs(b.oldLines[0]!);
      const repl = b.newLines.map((l) => reindented(l, F, P, found.tier));
      m.lines = [...m.lines.slice(0, pos), ...repl, ...m.lines.slice(pos + b.oldLines.length)];
      tree.now.set(path, writeModel(m));
    };
  });
}

// ---------- V4A patches (section 8) ----------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: Body[];
}

type VSection =
  | { kind: 'add'; path: string; lines: string[]; line: number }
  | { kind: 'delete'; path: string; line: number }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: Chunk[]; line: number };

const isBodyStart = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+';

function parseV4a(lines: string[]): VSection[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  if (last <= first) return [];
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const startLine = i + 1;
      i += 1;
      const raw: Array<{ line: number; text: string }> = [];
      while (i < last && !isSectionHead(lines[i]!)) {
        raw.push({ line: i + 1, text: lines[i]! });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const ls: string[] = [];
      for (const r of raw) {
        if (r.text === '') ls.push('');
        else if (r.text[0] === '+') ls.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.line}`);
      }
      sections.push({ kind: 'add', path, lines: ls, line: startLine });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      const startLine = i + 1;
      i += 1;
      while (i < last && !isSectionHead(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      sections.push({ kind: 'delete', path, line: startLine });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const startLine = i + 1;
      i += 1;
      const raw: string[] = [];
      let stopAt = i;
      while (stopAt < last && !isSectionHead(lines[stopAt]!)) {
        raw.push(lines[stopAt]!);
        stopAt += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const sec = parseUpdateBody(raw, startLine, path);
      sections.push(sec);
      i = stopAt;
      continue;
    }
    if (blank(l)) {
      // A blank line between sections.
      i += 1;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

const isSectionHead = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

/** The Update File section a raw body names; any other line inside it is a parse fault. */
function parseUpdateBody(raw: string[], startLine: number, path: string): VSection {
  let moveTo: string | null = null;
  let j = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    j = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  const push = (): void => {
    if (cur !== null) chunks.push(cur);
    cur = null;
  };
  while (j < raw.length) {
    const l = raw[j]!;
    if (l.startsWith('@@')) {
      push();
      cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
      if (cur.anchor === '') cur.anchor = null;
      j += 1;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${startLine + j + 1}`);
      cur.eof = true;
      push();
      j += 1;
      continue;
    }
    if (isBodyStart(l)) {
      if (cur === null) cur = { anchor: null, eof: false, body: [] };
      if (l === '') cur.body.push({ kind: ' ', text: '' });
      else cur.body.push({ kind: l[0] as BodyKind, text: l.slice(1) });
      j += 1;
      continue;
    }
    throw new Exit2(`error: parse ${startLine + j + 1}`);
  }
  push();
  if (moveTo === null && chunks.length === 0) throw new Exit2(`error: parse ${startLine}`);
  return { kind: 'update', path, moveTo, chunks, line: startLine };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4a(lines).map((s) => {
    if (s.kind === 'add') {
      const path = s.path;
      return (tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      };
    }
    if (s.kind === 'delete') {
      const path = s.path;
      return (tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      };
    }
    const path = s.path;
    const moveTo = s.moveTo;
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const t = tree.get(path);
      if (t === null) throw new Fail('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const m = readModel(t);
      let cursor = 0;
      const last = strict ? 0 : 2;
      for (const ch of s.chunks) {
        if (ch.anchor !== null) {
          const a = anchorAt(ch.anchor, m.lines, cursor, strict);
          if (a === null) throw new Fail('no-match', path);
          cursor = a.at + 1;
        }
        const O = oldOf(ch.body);
        const N = newLen(ch.body);
        if (O.length > 0) {
          let pos = -1;
          let tier = 0;
          if (ch.eof) {
            const p = m.lines.length - O.length;
            if (p >= cursor) {
              for (let t2 = 0; t2 <= last && pos < 0; t2 += 1) {
                let ok = true;
                for (let k = 0; k < O.length; k += 1) {
                  if (tierText(m.lines[p + k]!, t2) !== tierText(O[k]!, t2)) {
                    ok = false;
                    break;
                  }
                }
                if (ok) {
                  pos = p;
                  tier = t2;
                }
              }
            }
          } else {
            for (let t2 = 0; t2 <= last && pos < 0; t2 += 1) {
              for (let i = cursor; i + O.length <= m.lines.length; i += 1) {
                let ok = true;
                for (let k = 0; k < O.length; k += 1) {
                  if (tierText(m.lines[i + k]!, t2) !== tierText(O[k]!, t2)) {
                    ok = false;
                    break;
                  }
                }
                if (ok) {
                  pos = i;
                  tier = t2;
                  break;
                }
              }
            }
          }
          if (pos < 0) throw new Fail('no-match', path);
          const F = leadingWs(m.lines[pos]!);
          const P = leadingWs(O[0]!);
          const repl: string[] = [];
          let oi = pos;
          for (const b of ch.body) {
            if (b.kind === '\\') continue;
            if (b.kind === '-') {
              oi += 1;
              continue;
            }
            if (b.kind === '+') {
              repl.push(reindented(b.text, F, P, tier));
              continue;
            }
            repl.push(m.lines[oi]!);
            oi += 1;
          }
          m.lines = [...m.lines.slice(0, pos), ...repl, ...m.lines.slice(pos + O.length)];
          cursor = pos + N;
        } else {
          const pos = ch.eof ? m.lines.length : cursor;
          const repl: string[] = [];
          for (const b of ch.body) if (b.kind === '+') repl.push(b.text);
          m.lines = [...m.lines.slice(0, pos), ...repl, ...m.lines.slice(pos)];
          cursor = pos + repl.length;
        }
      }
      const text = writeModel(m);
      if (moveTo !== null) {
        tree.now.set(moveTo, text);
        tree.now.set(path, null);
        tree.moves.push([path, moveTo]);
      } else {
        tree.now.set(path, text);
      }
    };
  });
}

// ---------- JSON edits (section 9) ----------

/** One JSON edit object, or null when it is not one. */
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

/** Every edit a JSON patch names: one array, or JSON Lines (section 9). */
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

// ---------- the command line, the output and the write (sections 1, 2 and 10) ----------

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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.restore(snap);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, 'A' | 'D' | 'M'>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rows: Array<{ key: string; line: string }> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [a, b] of tree.moves) {
    if (usedOld.has(a) || usedNew.has(b)) continue;
    if (tree.original(a) === null) continue;
    if (tree.get(a) !== null) continue;
    if (tree.original(b) !== null) continue;
    if (tree.get(b) === null) continue;
    usedOld.add(a);
    usedNew.add(b);
    rows.push({ key: b, line: `R ${a} -> ${b}` });
  }
  for (const [p, op] of changed) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    rows.push({ key: p, line: `${op} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const [p, op] of changed) {
      if (op === 'D') rmSync(p, { force: true });
    }
    for (const [p, op] of changed) {
      if (op === 'D') continue;
      const now = tree.now.get(p)!;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
