import { randomUUID, createHash } from 'node:crypto';
import { clean, quote } from './ssh.ts';
import { execution, diagnostic } from './runner.mjs';
import type { Executor, Execution } from './target.ts';
import { singleLine, type Activity, type Observation } from './activity.ts';

export const STATE = 'pi-remote-automation/state-v1';
export const EVENT = 'pi-remote-automation/event';
const id = () => randomUUID().replaceAll('-', '');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
// Display-only name: single line, short, best-effort secret scrub. Ids stay authoritative.
const label = (value: unknown): string | undefined =>
  typeof value === 'string' ? clean(value.replace(/\s+/g, ' ').trim().slice(0, 40), 40) || undefined : undefined;
function text(value: unknown, name: string, max = 8192): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${name}`);
  return value;
}
function seconds(value: unknown, fallback: number, min = 5): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > 86400) throw new Error(`Seconds must be an integer from ${min} to 86400`);
  return n;
}
export type Input = Execution & {
  backend?: 'managed' | 'tmux';
  action: string; id?: string; command?: string; match?: string; mode?: 'once' | 'change' | 'cooldown';
  every?: number; cooldown?: number; delay?: number; message?: string; persist?: boolean; socket?: string; pane?: string; label?: string; delivery?: 'activity' | 'followUp';
};
export type Fact = { source: 'watch' | 'schedule' | 'job'; id: string; condition: string; evidence: string; first: number; last: number; count: number; label?: string };
type Delivery = { delivery?: 'activity' | 'followUp'; pending?: string; pendingAt?: number; pendingCondition?: string; deliveryError?: boolean };
type Task = Delivery & Execution & {
  id: string; kind: 'watch' | 'schedule'; label?: string; command?: string; match?: string; message?: string;
  mode: 'once' | 'change' | 'cooldown'; every: number; cooldown: number; next: number;
  enabled: boolean; persist: boolean; failures: number; previous?: string; last?: number;
};
type Job = Delivery & { backend?: 'managed' | 'tmux'; id: string; owned: boolean; token?: string; label?: string; state: string; socket?: string; pane?: string; reported?: boolean; next?: number; failures?: number; monitoring?: boolean; exitCode?: number; exitSignal?: string };
type Snapshot = { version: 1; session: string; target: string; tasks: Task[]; jobs: Job[]; events?: Fact[]; activity?: Activity[]; history?: Observation[]; historyTruncated?: boolean };
export type Hooks = { save: (state: Snapshot) => void; notify: (events: Fact[]) => void; idle?: () => boolean; changed?: () => void };

export class Runtime {
  tasks = new Map<string, Task>();
  jobs = new Map<string, Job>();
  activity = new Map<string, Activity>();
  history: Observation[] = [];
  historyTruncated = false;
  paused = true;
  stopped = false;
  private events: Fact[] = [];
  private batchTimer?: ReturnType<typeof setTimeout>;
  private deadline?: number;
  private flushing = false;
  private capacityBlocked = false;
  private generation = 0;
  private active = new Set<AbortController>();
  private timer?: ReturnType<typeof setTimeout>;
  private ticking = false;
  private savedKey?: string;
  constructor(readonly session: string, readonly target: string, private run: Executor, private hooks: Hooks) {}

  restore(raw: unknown) {
    const s = raw as Snapshot | undefined;
    if (!s || s.version !== 1 || s.session !== this.session || s.target !== this.target) return false;
    if (s.events !== undefined && (!Array.isArray(s.events) || s.events.length > 200)) return false;
    if (!Array.isArray(s.tasks) || !Array.isArray(s.jobs) || s.tasks.length > 100 || s.jobs.length > 100) return false;
    // Persisted entries are data, not authority to start anything: restored tasks always pause.
    for (const t of s.tasks) {
      if (!t || !/^[a-f0-9]{32}$/.test(t.id) || !['watch', 'schedule'].includes(t.kind) || !t.persist) continue;
      try {
        if (t.command !== undefined || t.program !== undefined) execution(t, this.run.destination?.platform, this.run.destination?.legacy ?? true);
        if (t.message !== undefined) text(t.message, 'message');
        if (t.match !== undefined) text(t.match, 'match', 128);
        seconds(t.every, 30); seconds(t.cooldown, 60, 0);
        if (!['once', 'change', 'cooldown'].includes(t.mode) || !Number.isFinite(t.next)) continue;
        if (t.kind === 'watch' && (!(t.command || t.program) || !t.match)) continue;
        if (t.kind === 'schedule' && Number(Boolean(t.command || t.program)) + Number(Boolean(t.message)) !== 1) continue;
        this.tasks.set(t.id, { ...t, label: label(t.label), pending: typeof t.pending === 'string' ? clean(t.pending) : undefined, failures: 0 });
      } catch { /* Invalid stored record stays inert. */ }
    }
    for (const j of s.jobs) {
      if (j && /^pra_[a-f0-9]{32}$/.test(j.id) && typeof j.owned === 'boolean' &&
          (!j.owned || (typeof j.token === 'string' && /^[a-f0-9]{32}$/.test(j.token)))) {
        if (j.backend !== undefined && !['managed', 'tmux'].includes(j.backend)) continue;
        if (j.backend === 'managed' && j.socket !== undefined) continue;
        if (j.socket !== undefined && (j.owned || !/^[a-zA-Z0-9_-]{1,64}$/.test(j.socket) || !/^%[0-9]+$/.test(j.pane ?? ''))) continue;
        this.jobs.set(j.id, { ...j, label: label(j.label), pending: typeof j.pending === 'string' ? clean(j.pending) : undefined, reported: j.reported === true, state: ['succeeded', 'failed', 'cancelled'].includes(j.state) ? j.state : 'unknown', next: 0, failures: 0, monitoring: j.monitoring !== false });
      }
    }
    if (Array.isArray(s.events)) {
      for (const e of s.events.slice(0, 200)) {
        if (!e || !['watch', 'schedule', 'job'].includes(e.source) ||
            !/^(?:pra_)?[a-f0-9]{32}$/.test(e.id) || typeof e.evidence !== 'string' ||
            typeof e.condition !== 'string' || !Number.isFinite(e.first) || !Number.isFinite(e.last) ||
            !Number.isSafeInteger(e.count) || e.count < 1) continue;
        this.events.push({ source: e.source, id: e.id, condition: clean(e.condition, 128), evidence: clean(e.evidence, 1024), first: e.first, last: e.last, count: e.count, label: label(e.label) });
      }
    }
    for (const e of this.events) {
      const job = e.source === 'job' ? this.jobs.get(e.id) : undefined;
      if (job && e.condition === 'observed' && ['succeeded', 'failed'].includes(job.state)) e.condition = job.state;
    }
    if (Array.isArray(s.activity)) for (const a of s.activity.slice(-300)) {
      if (!a || !/^(?:pra_)?[a-f0-9]{32}$/.test(a.id) || !['watch', 'schedule', 'job'].includes(a.source) || typeof a.state !== 'string' || typeof a.lastObserved !== 'string' || !Number.isFinite(a.observedSince)) continue;
      const restored: Activity = { id: a.id, source: a.source, label: label(a.label), state: singleLine(a.state, 128),
        lastObserved: singleLine(a.lastObserved), observedSince: a.observedSince, active: false, unread: a.unread === true,
        errors: Number.isSafeInteger(a.errors) && a.errors >= 0 ? a.errors : 0,
        followUp: ['Pending', 'Follow-up requested', 'Submission failed'].includes(a.followUp) ? a.followUp : 'None' };
      for (const key of ['startKnown', 'lastChecked', 'lastSuccessfulCheck', 'lastChange', 'nextCheck'] as const) if (Number.isFinite(a[key])) restored[key] = a[key];
      this.activity.set(a.id, restored);
    }
    if (Array.isArray(s.history)) for (const e of s.history.slice(-100)) {
      if (e && /^(?:pra_)?[a-f0-9]{32}$/.test(e.id) && Number.isFinite(e.at) && typeof e.state === 'string' && typeof e.summary === 'string' && typeof e.evidence === 'string')
        this.history.push({ id: e.id, at: e.at, state: singleLine(e.state, 128), summary: singleLine(e.summary), evidence: clean(e.evidence, 1024) });
    }
    this.historyTruncated = s.historyTruncated === true;
    this.syncActivity();
    for (const e of this.events) {
      if (!this.activity.has(e.id)) this.activity.set(e.id, { id: e.id, source: e.source, label: e.label, state: 'Recorded', active: false, observedSince: e.first, lastObserved: 'Retained follow-up observation', errors: 0, unread: true, followUp: 'Pending' });
      this.activity.get(e.id)!.followUp = 'Pending';
    }
    this.capacityBlocked = this.events.length >= 200;
    // Older snapshots kept pending text beside an already queued fact.
    for (const r of [...this.tasks.values(), ...this.jobs.values()]) {
      if (r.pending && this.events.some(e => e.id === r.id && e.first <= (r.pendingAt ?? e.first) && e.last >= (r.pendingAt ?? e.last))) r.pending = undefined;
    }
    return true;
  }
  snapshot(): Snapshot {
    return { version: 1, session: this.session, target: this.target,
      tasks: [...this.tasks.values()].filter(t => t.persist).map(t => ({ ...t })),
      jobs: [...this.jobs.values()].map(j => ({ ...j })), events: this.events.map(e => ({ ...e })), activity: [...this.activity.values()].map(a => ({ ...a })), history: this.history.map(e => ({ ...e })), historyTruncated: this.historyTruncated };
  }
  private syncActivity() {
    for (const a of this.activity.values()) a.active = false;
    for (const r of [...this.tasks.values(), ...this.jobs.values()]) {
      const source = 'kind' in r ? r.kind : 'job';
      let a = this.activity.get(r.id);
      if (!a) {
        a = { id: r.id, source, label: r.label, state: 'kind' in r ? (r.kind === 'schedule' ? 'Scheduled' : 'Waiting') : r.state, active: true,
          observedSince: Date.now(), lastObserved: '', errors: 0, unread: true, followUp: 'None' };
        this.activity.set(r.id, a);
      }
      a.active = 'kind' in r ? r.enabled : r.monitoring !== false && !['succeeded', 'failed', 'cancelled'].includes(r.state);
      a.nextCheck = r.next;
      if (r.deliveryError) a.followUp = 'Submission failed';
      else if (r.pending || this.events.some(e => e.id === r.id)) a.followUp = 'Pending';
    }
    // Bound retired source metadata too; active/unviewed sources are never evicted first.
    for (const [key, a] of this.activity) {
      if (this.activity.size < 300) break;
      if (!a.active && !a.unread && !this.tasks.has(key) && !this.jobs.has(key)) { this.activity.delete(key); this.historyTruncated = true; }
    }
  }
  private observe(r: Task | Job, state: string, summary: string, evidence = '', successful = true, checked = true) {
    this.syncActivity();
    const a = this.activity.get(r.id)!;
    const now = Date.now();
    state = singleLine(state, 128); summary = singleLine(summary);
    if (checked) {
      a.lastChecked = now;
      if (successful) a.lastSuccessfulCheck = now;
      a.errors = successful ? 0 : (r.failures ?? 0) || 1;
    }
    if (a.state !== state || a.lastObserved !== summary) {
      a.state = state; a.lastObserved = summary; a.lastChange = now; a.unread = true;
      this.history.push({ id: r.id, at: now, state, summary, evidence: clean(evidence, 1024) });
      if (this.history.length > 100) { this.history.shift(); this.historyTruncated = true; }
    }
  }
  acknowledge(ids: string[]) {
    let changed = false;
    for (const id of ids) { const a = this.activity.get(id); if (a?.unread) { a.unread = false; changed = true; } }
    if (changed) this.save();
  }
  private save() {
    if (this.stopped) return;
    this.syncActivity();
    const snapshot = this.snapshot();
    // Check timestamps stay live in UI; unchanged polls must not append full history forever.
    const key = JSON.stringify({ ...snapshot,
      tasks: snapshot.tasks.map(({ next, ...task }) => task),
      jobs: snapshot.jobs.map(({ next, ...job }) => job),
      activity: snapshot.activity?.map(({ lastChecked, lastSuccessfulCheck, nextCheck, ...a }) => a),
    });
    if (key !== this.savedKey) { this.hooks.save(snapshot); this.savedKey = key; }
    this.hooks.changed?.();
  }
  private invalidate() {
    this.generation++;
    this.ticking = false;
    clearTimeout(this.timer);
    clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }
  shutdown() { this.stopped = true; this.paused = true; this.invalidate(); }
  private async exec(script: string | Execution, signal?: AbortSignal) {
    if (this.stopped) throw new Error('Session closed');
    const generation = this.generation;
    const controller = new AbortController();
    this.active.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const output = await this.run(script, controller.signal);
      if (this.stopped || generation !== this.generation || controller.signal.aborted) throw new Error('Operation superseded');
      return output;
    } finally {
      this.active.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  }
  private arm() {
    clearTimeout(this.timer);
    if (this.stopped || this.paused || this.ticking) return;
    for (const r of [...this.tasks.values(), ...this.jobs.values()]) if (r.pending) this.deliver(r);
    if (this.paused) return;
    const due = [...this.tasks.values()].filter(t => t.enabled && !t.pending).map(t => t.next);
    due.push(...[...this.jobs.values()].filter(j => !j.pending && j.monitoring !== false && !j.reported && j.state !== 'cancelled' && !this.events.some(e => e.id === j.id && ['succeeded', 'failed'].includes(e.condition))).map(j => j.next ?? 0));
    const generation = this.generation;
    if (due.length) this.timer = setTimeout(() => {
      if (generation !== this.generation) return;
      void this.tick().catch(() => { if (generation === this.generation) { this.paused = true; this.invalidate(); this.hooks.changed?.(); } });
    }, Math.max(0, Math.min(...due) - Date.now()));
  }
  get state() {
    // Pause wins over pending; attention wins over ordinary queued updates.
    if (this.capacityBlocked || [...this.tasks.values(), ...this.jobs.values()].some(r => r.deliveryError)) return 'Attention';
    if (this.paused) return 'Paused';
    if ([...this.tasks.values(), ...this.jobs.values()].some(r => r.deliveryError || (r.failures ?? 0) > 0)) return 'Attention';
    if (this.events.length) return 'Updates Pending';
    return [...this.tasks.values()].some(t => t.enabled) || [...this.jobs.values()].some(j => j.monitoring !== false && !j.reported && j.state !== 'cancelled') ? 'Watching' : 'Ready';
  }
  get pendingCount() { return this.events.reduce((n, e) => n + e.count, 0); }
  private deliver(record: Task | Job) {
    if (!record.pending || this.paused || this.stopped) return;
    const source = 'kind' in record ? record.kind : 'job';
    const condition = record.pendingCondition ?? (record.pending.includes('condition UNKNOWN') || record.pending.includes('connection/pane UNKNOWN') ? 'attention' : 'observed');
    record.pendingAt ??= Date.now();
    const existing = !this.flushing && condition === 'attention' ? this.events.find(e => e.id === record.id && e.source === source && e.condition === condition) : undefined;
    if (existing) {
      existing.count++; existing.last = record.pendingAt; existing.evidence = clean(record.pending, 1024);
    } else {
      if (this.events.length >= 200) { this.capacityBlocked = true; this.paused = true; this.invalidate(); this.save(); return; }
      this.events.push({ source, id: record.id, condition, evidence: clean(record.pending, 1024), first: record.pendingAt, last: record.pendingAt, count: 1, label: record.label });
    }
    // The queue now owns this observation; polling may continue independently.
    record.pending = undefined; record.pendingAt = undefined;
    if (this.events.length >= 200) { this.capacityBlocked = true; this.paused = true; this.invalidate(); }
    this.deadline ??= Date.now() + 3000;
    this.save();
    this.armBatch();
  }
  private armBatch() {
    if (this.stopped || this.paused || this.ticking || !this.events.length || this.batchTimer) return;
    this.deadline ??= Date.now() + 3000;
    const generation = this.generation;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      if (generation === this.generation) this.flush();
    }, Math.max(0, this.deadline - Date.now()));
  }
  settled() { this.flush(); }
  private flush() {
    if (this.stopped || this.paused || this.flushing || !this.events.length) return;
    if (Date.now() < (this.deadline ?? Infinity)) { this.armBatch(); return; }
    if (this.ticking || this.hooks.idle?.() === false) return;
    this.flushing = true;
    const batch = this.events.slice(0, 20);
    try {
      this.hooks.notify(batch.map(e => ({ ...e })));
    } catch {
      for (const e of batch) { const r = this.tasks.get(e.id) ?? this.jobs.get(e.id); if (r) r.deliveryError = true; }
      this.paused = true; this.invalidate(); this.save();
      this.flushing = false;
      return;
    }
    this.events.splice(0, batch.length);
    for (const e of batch) {
      const r = this.tasks.get(e.id) ?? this.jobs.get(e.id);
      const a = this.activity.get(e.id); if (a) a.followUp = 'Follow-up requested';
      if (r) { r.deliveryError = false; if (e.source === 'job' && ['succeeded', 'failed'].includes(e.condition)) (r as Job).reported = true; }
    }
    this.deadline = undefined;
    this.flushing = false;
    this.save(); // API submission, not model acknowledgement; persistence is not transactional.
    this.armBatch(); this.arm();
  }
  async tick(now = Date.now()) {
    if (this.stopped || this.paused || this.ticking) return;
    if (this.events.length >= 200) { this.capacityBlocked = true; this.paused = true; this.invalidate(); this.save(); return; }
    this.ticking = true;
    const generation = this.generation;
    try {
      for (const task of this.tasks.values()) {
        if (this.stopped || this.paused || generation !== this.generation) break;
        if (task.pending) { this.deliver(task); continue; }
        if (this.events.length >= 200) { this.capacityBlocked = true; this.paused = true; this.invalidate(); this.save(); break; }
        if (!task.enabled || task.next > now) continue;
        try {
          let payload = task.message ?? '';
          let state: string | undefined;
          let summary = 'Scheduled message';
          if (task.command || task.program) {
            // Managed target runner enforces probe timeout; legacy SSH can only bound the client.
            const output = await this.exec(task);
            let probe: unknown;
            try { probe = JSON.parse(output); } catch { throw new Error('Probe must emit one JSON object'); }
            const p = probe as { state?: unknown; summary?: unknown; evidence?: unknown } | null;
            if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.state !== 'string' ||
                !/^[a-zA-Z0-9_.-]{1,128}$/.test(p.state) || typeof p.summary !== 'string' ||
                !(typeof p.evidence === 'string' || (Array.isArray(p.evidence) && p.evidence.every(e => typeof e === 'string')))) {
              throw new Error('Probe needs {state: identifier, summary: string, evidence: string|string[]}');
            }
            state = p.state; summary = p.summary;
            payload = JSON.stringify({ state, summary: p.summary, evidence: p.evidence });
          }
          if (this.stopped || this.paused || generation !== this.generation || !task.enabled) continue;
          const matches = task.kind === 'schedule' || state === task.match;
          const stateHash = state === undefined ? undefined : hash(state);
          const eligible = task.mode === 'once' || (task.mode === 'change' ? task.previous !== stateHash : now - (task.last ?? -Infinity) >= task.cooldown * 1000);
          task.failures = 0;
          task.previous = stateHash;
          task.next = Date.now() + task.every * 1000;
          this.observe(task, state ?? 'Triggered', summary, payload, true, Boolean(task.command || task.program));
          if (matches && eligible) {
            task.last = now;
            if (task.mode === 'once') task.enabled = false;
            if (task.delivery !== 'activity') {
              task.pendingCondition = state ?? 'scheduled';
              task.pendingAt = Date.now();
              task.pending = clean(`${task.kind} ${task.id}: ${payload}`);
            }
            this.save();
          } else this.save();
        } catch (error) {
          if (this.stopped || this.paused || generation !== this.generation || !task.enabled) continue;
          task.failures++;
          task.next = Date.now() + task.every * 1000;
          if (task.failures >= 3) task.enabled = false;
          this.observe(task, 'unknown', task.enabled ? 'Probe unavailable; retry scheduled' : 'Monitoring disabled after 3 errors', diagnostic(error instanceof Error ? error.message : 'Probe failed'), false);
          if (task.failures >= 3 && task.delivery !== 'activity') { task.pendingCondition = 'attention'; task.pendingAt = Date.now(); task.pending = clean(`${task.kind} ${task.id}: probe/transport error; condition UNKNOWN (not false). ${task.enabled ? 'Will check again within the authorized polling policy.' : 'Disabled after 3 consecutive errors; explicitly recreate to retry.'}`); }
          this.save();
        }
        this.deliver(task);
      }
      for (const job of this.jobs.values()) {
        if (this.stopped || this.paused || generation !== this.generation) break;
        if (job.pending) { this.deliver(job); continue; }
        if (this.events.some(e => e.source === 'job' && e.id === job.id && ['succeeded', 'failed'].includes(e.condition))) continue;
        if (this.events.length >= 200) { this.capacityBlocked = true; this.paused = true; this.invalidate(); this.save(); break; }
        if (job.monitoring === false || job.reported || job.state === 'cancelled' || (job.next ?? 0) > now) continue;
        const result = await this.status(job, undefined, true);
        if (this.stopped || this.paused || generation !== this.generation) break;
        job.next = Date.now() + 30000;
        if (job.state === 'unknown') {
          job.failures = (job.failures ?? 0) + 1;
          if (job.failures >= 3) { job.monitoring = false; job.pendingCondition = 'attention'; job.pending = `job ${job.id}: connection/pane UNKNOWN, monitoring stopped after 3 errors. Explicit resume retries; never resubmit automatically.`; }
        } else {
          job.failures = 0;
          if (['succeeded', 'failed'].includes(job.state)) {
            job.pendingCondition = job.state;
            job.pending = `job ${job.id}: ${job.state}; exitCode=${job.exitCode ?? 'unknown'}; signal=${job.exitSignal ?? 'none'}`;
          }
        }
        this.observe(job, job.state, job.state === 'unknown' ? (job.monitoring === false ? 'Monitoring stopped after 3 errors' : 'State unavailable; retry scheduled') : '', result.error ?? result.note ?? '', job.state !== 'unknown');
        this.save();
        this.deliver(job);
      }
    } finally { if (generation === this.generation) { this.ticking = false; this.arm(); this.armBatch(); this.hooks.changed?.(); } }
  }
  list(kind?: 'watch' | 'schedule') {
    return { paused: this.paused, pendingEvents: this.pendingCount, tasks: [...this.tasks.values()].filter(t => !kind || t.kind === kind)
      .map(t => ({ id: t.id, label: t.label, kind: t.kind, enabled: t.enabled, failures: t.failures, next: t.next, persistent: t.persist, pendingDelivery: Boolean(t.pending) || this.events.some(e => e.id === t.id), deliveryError: t.deliveryError === true })),
      ...(kind ? {} : { jobs: [...this.jobs.values()].map(({ id, label, owned, backend, state, monitoring, pending, deliveryError }) => ({ id, label, owned, backend: backend ?? 'tmux', state, monitoring: monitoring !== false, pendingDelivery: Boolean(pending) || this.events.some(e => e.id === id), deliveryError: deliveryError === true })) }) };
  }
  async control(action: string, signal?: AbortSignal) {
    if (this.stopped) throw new Error('Session closed');
    if (action === 'clear') {
      this.paused = true;
      this.invalidate();
      this.tasks.clear(); this.jobs.clear(); this.events = [];
      this.activity.clear(); this.history = []; this.historyTruncated = false;
      this.deadline = undefined; this.capacityBlocked = false;
      this.save();
      return { ...this.list(), note: 'Cleared current-session watches, schedules, job monitoring, unsubmitted events and Activity history; paused. Actual jobs, target files and conversation are unchanged. Notifications already submitted to Pi cannot be retracted.' };
    }
    else if (action === 'pause') { this.paused = true; this.invalidate(); this.hooks.changed?.(); }
    else if (action === 'resume') { this.paused = false; if (this.capacityBlocked) { this.deadline = Date.now(); this.flush(); if (this.events.length >= 200) { this.paused = true; this.hooks.changed?.(); return this.list(); } this.capacityBlocked = false; } for (const j of this.jobs.values()) { j.monitoring = true; j.failures = 0; } this.arm(); this.armBatch(); this.hooks.changed?.(); }
    else if (action === 'doctor') {
      return this.run.doctor ? this.run.doctor(signal ?? new AbortController().signal) : { note: 'Injected transport; capabilities unknown' };
    } else if (action === 'deploy-runner') {
      if (!this.run.deploy) throw new Error('Deployment unavailable');
      return this.run.deploy(signal ?? new AbortController().signal);
    } else if (!['status', 'jobs', 'watches', 'schedules'].includes(action)) throw new Error('Use status/jobs/watches/schedules/pause/resume/clear/doctor/deploy-runner');
    return action === 'jobs' ? this.list().jobs : this.list(action === 'watches' ? 'watch' : action === 'schedules' ? 'schedule' : undefined);
  }
  task(kind: 'watch' | 'schedule', input: Input) {
    if (this.stopped) throw new Error('Session closed');
    if (input.action === 'list') return this.list(kind);
    if (input.action === 'cancel') {
      const t = this.tasks.get(input.id ?? '');
      if (!t || t.kind !== kind) throw new Error('Unknown task');
      t.enabled = false;
      this.observe(t, 'Cancelled', `Local ${t.kind} cancelled`, '', true, false);
      this.tasks.delete(t.id);
      this.save(); this.arm();
      return { id: t.id, cancelled: true };
    }
    if (this.activity.size >= 300) throw new Error('Activity capacity reached; view or clear retired updates first');
    if (input.action !== 'create') throw new Error('Use create/list/cancel');
    if (this.tasks.size >= 100 || this.events.length + this.tasks.size + this.jobs.size >= 200) throw new Error('Task or pending-event capacity reached; submit pending updates and cancel old tasks');
    const command = input.command === undefined ? undefined : text(input.command, 'command');
    const program = input.program;
    if (command !== undefined || program !== undefined) execution(input, this.run.destination?.platform, this.run.destination?.legacy ?? true);
    const message = input.message === undefined ? undefined : text(input.message, 'message');
    if (kind === 'watch' && (!(command || program) || message)) throw new Error('Watch requires command and no message');
    if (kind === 'schedule' && Number(Boolean(command || program)) + Number(Boolean(message)) !== 1) throw new Error('Schedule requires exactly one command or message');
    const match = kind === 'watch' ? text(input.match, 'match', 128) : undefined;
    if (match && !/^[a-zA-Z0-9_.-]+$/.test(match)) throw new Error('Match must be a state identifier');
    const mode = kind === 'watch' ? (input.mode ?? 'once') : (input.every === undefined ? 'once' : 'cooldown');
    if (!['once', 'change', 'cooldown'].includes(mode)) throw new Error('Invalid watch mode');
    if (input.delivery !== undefined && !['activity', 'followUp'].includes(input.delivery)) throw new Error('Invalid delivery');
    const task: Task = { delivery: input.delivery ?? 'followUp', id: id(), kind, label: label(input.label), command, program, args: input.args, shell: input.shell, env: input.env, message, match, mode, every: seconds(input.every, 30),
      cooldown: seconds(input.cooldown, 60, 0), next: Date.now() + seconds(input.delay, 0, 0) * 1000,
      enabled: true, persist: input.persist === true, failures: 0 };
    if (kind === 'schedule') task.cooldown = 0;
    this.tasks.set(task.id, task);
    this.save(); this.arm();
    return { id: task.id, paused: this.paused, persistent: task.persist,
      note: 'Use /remote resume to enable polling. Pause stops local checks, not remote jobs. Missed intervals coalesce; no catch-up replay. Restores always pause.' };
  }

  async job(input: Input, signal?: AbortSignal) {
    if (this.stopped) throw new Error('Session closed');
    if (input.action === 'list') return this.list().jobs;
    if (input.action === 'start' || input.action === 'attach') {
      const backend = input.socket !== undefined ? 'tmux' : input.backend ?? (this.run.destination && !this.run.destination.legacy ? 'managed' : 'tmux');
      if (input.backend !== undefined && !['managed', 'tmux'].includes(input.backend)) throw new Error('Invalid backend');
      if (input.socket !== undefined && input.backend === 'managed') throw new Error('socket/pane attachment requires tmux backend');
      if (backend === 'tmux' && this.run.destination && (this.run.destination.kind !== 'ssh' || this.run.destination.platform !== 'posix')) throw new Error('tmux backend requires SSH POSIX');
      const existing = this.jobs.get(input.id ?? '');
      if (existing && input.backend !== undefined && input.backend !== (existing.backend ?? 'tmux')) throw new Error('Backend conflicts with registered job');
    }
    if (input.action === 'start') {
      if (this.activity.size >= 300 || this.jobs.size >= 100 || this.events.length + this.tasks.size + this.jobs.size >= 200) throw new Error('Job or pending-event capacity reached');
      const backend = input.backend ?? (this.run.destination && !this.run.destination.legacy ? 'managed' : 'tmux');
      if (!['managed', 'tmux'].includes(backend)) throw new Error('Invalid backend');
      if (backend === 'tmux' && this.run.destination && (this.run.destination.kind !== 'ssh' || this.run.destination.platform !== 'posix')) throw new Error('tmux backend requires SSH POSIX');
      execution(input, this.run.destination?.platform, this.run.destination?.legacy ?? true);
      if (backend === 'tmux' && (input.program || (input.shell && input.shell !== 'sh') || input.env?.length)) throw new Error('tmux start supports sh command only; use managed backend for structured execution');
      const command = input.command ?? '';
      const job: Job = { id: `pra_${id()}`, owned: true, backend, token: id(), label: label(input.label), state: 'unknown' };
      this.jobs.set(job.id, job);
      this.save(); // Identity exists before submission; never automatically repeat an ambiguous launch.
      if (backend === 'managed') {
        try { const result = await this.managed(job, 'start', signal, { execution: { command: input.command, program: input.program, args: input.args, shell: input.shell ?? (this.run.destination?.legacy ? 'sh' : undefined), env: input.env }, cwd: this.run.destination?.cwd }); this.requireJob(job); job.state = result.state; if (job.state === 'submitted') this.activity.get(job.id)!.startKnown = Date.now(); this.observe(job, job.state, '', '', true, false); this.save(); this.arm(); return result; }
        catch (error) { this.arm(); return { id: job.id, state: 'unknown', error: diagnostic(error instanceof Error ? error.message : 'Submission failed'), note: 'Reconcile same identity; NEVER automatically relaunch' }; }
      }
      const socket = quote(job.id), token = quote(job.token!);
      // Dedicated socket and gated pane: remain-on-exit and ownership are set before any user command runs.
      // Poll only this dedicated session's token gate; partial submission expires without launching user code.
      const runner = `n=0; while [ "$n" -lt 30 ]; do if [ "$(tmux -L ${socket} show-options -t job -v @pra_go 2>/dev/null)" = ${token} ]; then exec sh -c ${quote(command)}; fi; n=$((n+1)); sleep 1; done; exit 124`;
      const script = `set -eu\numask 077\n` +
        `tmux -L ${socket} -f /dev/null new-session -d -s job ${quote(`sh -c ${quote(runner)}`)}\n` +
        `tmux -L ${socket} set-option -t job @pra_owner ${token}\n` +
        `tmux -L ${socket} set-option -w -t job:0 remain-on-exit on\n` +
        `tmux -L ${socket} set-option -t job @pra_go ${token}\nprintf 'submitted'`;
      try {
        await this.exec(script, signal);
        this.requireJob(job);
        job.state = 'submitted'; this.activity.get(job.id)!.startKnown = Date.now(); this.observe(job, job.state, '', '', true, false); this.save(); this.arm();
      } catch {
        this.arm();
        // Reconcile with status using this exact id; absence never authorizes resubmission.
        return { id: job.id, state: 'unknown', note: 'Submission outcome unknown. Use status with this id; do NOT retry start automatically.' };
      }
      return { id: job.id, state: job.state };
    }
    if (input.action === 'attach' && input.socket !== undefined) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.socket) || !/^%[0-9]+$/.test(input.pane ?? '')) throw new Error('Attach requires socket label and pane %number');
      if (this.activity.size >= 300 || this.jobs.size >= 100 || this.events.length + this.tasks.size + this.jobs.size >= 200) throw new Error('Job or pending-event capacity reached');
      const job: Job = { id: `pra_${id()}`, owned: false, socket: input.socket, pane: input.pane, label: label(input.label), state: 'unknown' };
      this.jobs.set(job.id, job); this.save(); this.arm();
      return { id: job.id, observeOnly: true, note: 'Read-only monitoring; existing pane must retain exit status (remain-on-exit). Disappearing panes remain unknown, not failed.' };
    }
    const jobId = text(input.id, 'job id', 64);
    if (!/^pra_[a-f0-9]{32}$/.test(jobId)) throw new Error('Expected pi-remote job id');
    if (input.action === 'attach') {
      if (!this.jobs.has(jobId)) {
        if (this.activity.size >= 300 || this.jobs.size >= 100 || this.events.length + this.tasks.size + this.jobs.size >= 200) throw new Error('Job or pending-event capacity reached');
        this.jobs.set(jobId, { id: jobId, owned: false, backend: input.backend ?? (this.run.destination && !this.run.destination.legacy ? 'managed' : 'tmux'), label: label(input.label), state: 'unknown' });
        this.save(); this.arm();
      }
      return { id: jobId, observeOnly: !this.jobs.get(jobId)!.owned, note: 'Attached existing identity; no launch or cancellation authority granted.' };
    }
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Unknown job; attach its existing id first');
    if (job.backend === 'managed') {
      if (!['status', 'output', 'cancel'].includes(input.action)) throw new Error('Use status/output/cancel');
      if (input.action === 'cancel' && !job.owned) throw new Error('Attached jobs are observe-only');
      if (input.action === 'status') return this.status(job, signal);
      const result = await this.managed(job, input.action, signal);
      this.requireJob(job);
      if (input.action === 'cancel') { job.state = result.state; this.observe(job, job.state, result.note ?? '', '', job.state !== 'unknown'); this.save(); }
      return { id: job.id, backend: 'managed', state: result.state, exitCode: result.exitCode, exitSignal: result.exitSignal, error: typeof result.error === 'string' ? diagnostic(result.error) : undefined, truncated: result.truncated, note: typeof result.note === 'string' ? clean(result.note) : undefined, output: typeof result.output === 'string' ? clean(result.output) : undefined };
    }
    const tmux = `tmux -L ${quote(job.socket ?? job.id)}`;
    if (input.action === 'cancel') {
      if (!job.owned || !job.token) throw new Error('Attached jobs are observe-only');
      await this.exec(`test "$(${tmux} show-options -t job -v @pra_owner)" = ${quote(job.token)} || exit 73\n${tmux} kill-session -t job`, signal);
      this.requireJob(job);
      job.state = 'cancelled'; this.observe(job, job.state, '', '', true, false); this.save();
      return { id: job.id, state: job.state, note: 'tmux session terminated; detached descendants may survive.' };
    }
    if (input.action === 'output') {
      const output = await this.exec(`${tmux} capture-pane -p -t ${quote(job.pane ?? 'job:0.0')} -S -100`, signal);
      return { id: job.id, untrustedOutput: clean(output), note: 'Last 100 tmux lines plus visible pane; bounded capture, not a durable log.' };
    }
    if (input.action !== 'status') throw new Error('Use start/attach/list/status/output/cancel');
    return this.status(job, signal);
  }
  private requireJob(job: Job) {
    // Transport completion and its caller continuation are separate microtasks.
    if (this.stopped || this.jobs.get(job.id) !== job) throw new Error('Job monitoring cleared; operation outcome unknown');
  }
  private async managed(job: Job, action: string, signal?: AbortSignal, extra = {}) {
    if (!this.run.managed) throw new Error('Managed runner unavailable');
    if (this.stopped) throw new Error('Session closed');
    const controller = new AbortController(), generation = this.generation;
    const abort = () => controller.abort();
    this.active.add(controller); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const result = await this.run.managed({ action, id: job.id, token: job.token, session: this.session, ...extra }, controller.signal);
      if (this.stopped || generation !== this.generation || controller.signal.aborted) throw new Error('Operation superseded; outcome unknown');
      return result;
    } finally { this.active.delete(controller); signal?.removeEventListener('abort', abort); }
  }
  private async status(job: Job, signal?: AbortSignal, polling = false) {
    const generation = this.generation;
    const tmux = `tmux -L ${quote(job.socket ?? job.id)}`;
    try {
      if (job.backend === 'managed') {
        const result = await this.managed(job, 'status', signal);
        this.requireJob(job);
        job.state = result.state; job.exitCode = result.exitCode; job.exitSignal = result.exitSignal;
        if (!polling) { this.observe(job, job.state, '', '', job.state !== 'unknown'); this.save(); }
        return { id: job.id, state: job.state, exitCode: job.exitCode, exitSignal: job.exitSignal, error: typeof result.error === 'string' ? diagnostic(result.error) : undefined };
      }
      const output = await this.exec(`${tmux} display-message -p -t ${quote(job.pane ?? 'job:0.0')} '#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}'`, signal);
      this.requireJob(job);
      const m = /^([01])\|(\d*)\|([a-zA-Z0-9]*)\s*$/.exec(output);
      if (!m || (m[1] === '1' && !m[2] && !m[3])) throw new Error('Invalid tmux status');
      job.state = m[1] === '0' ? 'running' : m[3] || Number(m[2]) !== 0 ? 'failed' : 'succeeded';
      job.exitCode = m[1] === '1' && m[2] ? Number(m[2]) : undefined;
      job.exitSignal = m[1] === '1' && m[3] ? m[3] : undefined;
      if (!polling) { this.observe(job, job.state, ''); this.save(); }
      return { id: job.id, state: job.state, exitCode: job.exitCode, exitSignal: job.exitSignal };
    } catch (error) {
      const detail = diagnostic(error instanceof Error ? error.message : 'Status failed');
      if (!this.stopped && generation === this.generation && this.jobs.get(job.id) === job) { job.state = 'unknown'; if (!polling) { this.observe(job, 'unknown', 'State unavailable', detail, false); this.save(); } }
      return { id: job.id, state: 'unknown', error: detail, note: 'Connection or tmux state unavailable; not evidence of task failure. Never automatically resubmit.' };
    }
  }
}
