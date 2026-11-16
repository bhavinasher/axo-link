'use strict';
// Spawns agent CLIs, parses their NDJSON event stream, tracks session state.
// Per-vendor protocol lives in VENDORS; verified against OpenMausBot's
// server/drivers/claude.ts (Apache-2.0, github.com/milind-soni/OpenMausBot)
// and against the shipping `claude` binary's own schema.
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const blockText = (msg) => (Array.isArray(msg?.content) ? msg.content : [])
  .filter((b) => b.type === 'text')
  .map((b) => b.text)
  .join('')
  .trim();

/** First two sentences, hard-capped. This is what gets spoken, so it has to
 *  stand alone -- no "as mentioned above". */
const brief = (s, max = 200) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^.*?[.!?](?:\s+.*?[.!?])?(?=\s|$)/);
  const out = m ? m[0] : t;
  return out.length > max ? out.slice(0, max - 1).trimEnd() + '\u2026' : out;
};

/** "Edit x3, Bash x2" -- what it did, without asking a model to summarise. */
const tally = (names) => {
  const c = new Map();
  for (const n of names) c.set(n, (c.get(n) || 0) + 1);
  return [...c].map(([n, k]) => (k > 1 ? `${n} \u00d7${k}` : n)).join(', ');
};

/** The interesting half of a tool call, for "wants to run: Bash(rm -rf /)". */
const argPreview = (input) => {
  const v = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern
    ?? input?.url ?? (input && JSON.stringify(input));
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 59) + '\u2026' : s;
};

/** The narrowest permission rule that lets exactly the denied call through, in
 *  Claude Code's own rule syntax. File tools take `//` + an absolute path
 *  (one Edit rule covers Write/MultiEdit/NotebookEdit too). Anything without a
 *  narrower form falls back to the bare tool name -- still scoped to the one
 *  session it was approved in. */
const ruleFor = ({ tool_name: tool, tool_input: input = {} }) => {
  if (!tool) return null;
  if (tool === 'Bash' && input.command) return `Bash(${input.command})`;
  if (tool === 'WebFetch' && input.url) {
    try { return `WebFetch(domain:${new URL(input.url).hostname})`; } catch { /* bare name */ }
  }
  const file = input.file_path ?? input.notebook_path;
  if (typeof file === 'string' && file.startsWith('/')) {
    return `${tool === 'Read' ? 'Read' : 'Edit'}(/${file})`;
  }
  return tool;
};

// Approved rules go to a settings file rather than argv: they carry
// agent-written text (a whole shell command), and on Windows argv goes through
// a shell. mkdtemp makes the directory ours alone (0700), even on a shared /tmp.
let grantsDir = null;
const writeGrants = (id, allow) => {
  grantsDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'axo-link-'));
  const file = path.join(grantsDir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow } }), { mode: 0o600 });
  return file;
};

// ponytail: a plain object per vendor, not a driver class. codex/grok slot in
// as two more entries with different args, no class hierarchy.
const VENDORS = {
  claude: {
    cmd: 'claude',
    args: (sid, { resume = false, settings = null } = {}) => [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',                        // required by stream-json output
      '--permission-mode', 'acceptEdits',
      // A new session is pinned to our id. An approval reopens that same
      // session -- --resume without --fork-session keeps the id and history.
      ...(resume ? ['--resume', sid] : ['--session-id', sid]),
      ...(settings ? ['--settings', settings] : []),
    ],
    rule: ruleFor,
    write: (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } }) + '\n',
    // (line, per-turn scratch) -> state patch, or null for lines we ignore
    parse: (o, turn) => {
      if (o.type === 'system' && o.subtype === 'init') return { model: o.model };

      if (o.type === 'assistant') {
        for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
          if (b.type === 'tool_use') turn.tools.push(b.name);
        }
        const t = blockText(o.message);
        if (!t) return null;
        turn.text = t;
        return { last: t };
      }

      if (o.type === 'result') {
        // The CLI's own docs call result.permission_denials "the authoritative
        // record" of what it was blocked from doing. Shape: {tool_name,
        // tool_input, tool_use_id}.
        const denied = Array.isArray(o.permission_denials) ? o.permission_denials : [];
        turn.denied = denied;   // kept raw: approve() turns these into rules
        const summary = brief(o.result || turn.text);
        return {
          state: o.is_error === true ? 'error' : 'waiting',
          waiting_kind: denied.length ? 'approval_request'
            : /\?["')\]]*\s*$/.test(summary) ? 'question'
            : 'finished',
          pending: denied.map((d) => `${d.tool_name}(${argPreview(d.tool_input)})`),
          summary,
          did: tally(turn.tools),
        };
      }
      return null;
    },
  },
};

const freshTurn = () => ({ tools: [], text: '' });

class Sessions extends EventEmitter {
  #procs = new Map();   // id -> { child, vendor, cwd, allow, stderr, turn }
  #state = new Map();   // id -> record rendered by the pill
  #spawn;

  constructor(spawnFn = spawn) {
    super();
    this.#spawn = spawnFn;
  }

  list() { return [...this.#state.values()]; }

  start({ vendor = 'claude', label, cwd = process.cwd() } = {}) {
    if (!VENDORS[vendor]) throw new Error(`unknown vendor: ${vendor}`);
    const id = randomUUID();
    this.#launch(id, { vendor, cwd, allow: [] });
    this.#set(id, {
      id, vendor, cwd,
      label: label || `${vendor} ${id.slice(0, 4)}`,
      state: 'idle', waiting_kind: null,
      last: '', summary: '', did: '', pending: [],
      since: Date.now(),
    });
    return id;
  }

  /** Spawn the CLI process behind session `id`: a fresh session, or (resume)
   *  the same one reopened with the rules in `allow` granted. */
  #launch(id, { vendor, cwd, allow }, { resume = false } = {}) {
    const v = VENDORS[vendor];
    let settings = allow.length ? writeGrants(id, allow) : null;
    // ponytail: shell:true on Windows resolves the claude.cmd shim. Safe here --
    // every arg is our own constant, a UUID, or the path of our own grants file
    // (quoted for cmd.exe). User and agent text never reach argv: turns go over
    // stdin, approved rules into that file.
    const shell = process.platform === 'win32';
    if (settings && shell) settings = `"${settings}"`;
    const child = this.#spawn(v.cmd, v.args(id, { resume, settings }), {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell,
    });
    const proc = { child, vendor, cwd, allow, stderr: '', turn: freshTurn() };
    this.#procs.set(id, proc);
    // Once approve() has replaced this process, nothing it says or does
    // (a late line, its own exit) speaks for the session any more.
    const current = () => this.#procs.get(id) === proc;

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (!current()) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }   // partial/non-JSON noise
      const patch = v.parse(o, proc.turn);
      if (patch) this.#set(id, patch);
    });
    child.stderr?.on('data', (d) => { proc.stderr = (proc.stderr + d).slice(-500); });
    child.on('error', (e) => {
      if (current()) this.#set(id, { state: 'error', last: e.message, summary: e.message });
    });
    child.on('exit', (code) => {
      if (!current()) return;
      this.#procs.delete(id);
      // a clean exit is just an idle session; a crash should say why
      if (code) {
        const why = proc.stderr.trim() || `exited ${code}`;
        this.#set(id, { state: 'error', last: why, summary: brief(why) });
      } else this.#set(id, { state: 'idle' });
    });
    return proc;
  }

  send(id, text) {
    const p = this.#procs.get(id);
    if (!p || !p.child.stdin?.writable) return false;
    p.child.stdin.write(VENDORS[p.vendor].write(text));
    p.turn = freshTurn();
    this.#set(id, {
      state: 'running', last: text,
      waiting_kind: null, summary: '', did: '', pending: [],
    });
    return true;
  }

  // Saying "approved" down stdin grants nothing: the CLI checks permissions
  // against its own rules, so the agent retries and hits the same wall. A
  // running `-p` process can't be granted anything, so approval replaces it --
  // the same session reopened with a rule for exactly the call that was
  // denied -- and then says go ahead.
  // ponytail: post-hoc. The turn has settled, so the agent retries rather than
  // resuming mid-tool. The mid-turn version is --permission-prompt-tool
  // pointed at an MCP `approve` tool returning {"behavior":"allow"}.
  approve(id) {
    const p = this.#procs.get(id);
    if (!p || this.#state.get(id)?.waiting_kind !== 'approval_request') return false;
    const rules = (p.turn.denied || []).map(VENDORS[p.vendor].rule || (() => null)).filter(Boolean);
    if (!rules.length) return this.send(id, 'Approved. Go ahead and do that.');

    const fresh = rules.filter((r) => !p.allow.includes(r));
    if (fresh.length) {
      // New process first, so the old one's exit lands on a session it no
      // longer owns and can't flash it idle.
      this.#launch(id, { vendor: p.vendor, cwd: p.cwd, allow: [...p.allow, ...fresh] }, { resume: true });
      p.child.kill();
    }
    return this.send(id, `Approved -- you now have permission for ${rules.join(', ')}. Go ahead and do that.`);
  }
  deny(id) { return this.send(id, "Denied. Don't do that \u2014 tell me what you'd do instead."); }

  stop(id) { this.#procs.get(id)?.child.kill(); }

  #set(id, patch) {
    const prev = this.#state.get(id) || {};
    const next = { ...prev, ...patch };
    if (patch.state && patch.state !== prev.state) next.since = Date.now();
    this.#state.set(id, next);
    this.emit('update', this.list());
    // the one transition this whole app exists to catch
    if (next.state === 'waiting' && prev.state !== 'waiting') this.emit('waiting', next);
  }
}

module.exports = { Sessions, VENDORS, brief, tally, ruleFor };
