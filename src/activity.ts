import type { ExtensionContext, SessionEntry, Theme } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { clean } from './ssh.ts';

export type Activity = {
  id: string; source: 'watch' | 'schedule' | 'job'; label?: string; state: string; active: boolean;
  observedSince: number; startKnown?: number; lastChecked?: number; lastSuccessfulCheck?: number;
  lastObserved: string; lastChange?: number; nextCheck?: number; errors: number; unread: boolean;
  followUp: 'None' | 'Pending' | 'Follow-up requested' | 'Submission failed' | 'Model responded';
};
export type Observation = { id: string; at: number; state: string; summary: string; evidence: string };
export const singleLine = (value: string, cap = 240) => clean(value, cap).replace(/\s+/g, ' ').trim();
// Default surface omits address/path-shaped text; arbitrary prose can still contain sensitive data.
export const displayText = (value: string) => singleLine(value).replace(/(?:\b[\w.-]+@)?\b[\w.-]+\.[a-zA-Z]{2,}(?::\d+)?(?:[^\s]*)|(?<![\w])(?:[A-Za-z]:[\\/]|\/)[^\s]+/g, '[private]');
export const activityName = (a: Activity) => displayText(a.label ?? `${a.source[0].toUpperCase()}${a.source.slice(1)} ${a.id.replace(/^pra_/, '').slice(0, 8)}`);
const needsAttention = (a: Activity) => a.errors > 0 || ['unknown', 'failed'].includes(a.state.toLowerCase()) || a.followUp === 'Submission failed';
export function activityRows(sources: Activity[]) {
  const rank = (a: Activity) => needsAttention(a) ? 0 : a.unread ? 1 : 2;
  return sources.filter(a => a.active || a.unread).sort((a, b) => rank(a) - rank(b));
}
export function activityWidget(sources: Activity[], paused: boolean, theme: Theme, attention = false, location = 'ssh') {
  const rows = activityRows(sources);
  return {
    invalidate() {},
    render(width: number) {
      width = Math.max(0, width);
      const sep = theme.fg('dim', ' · ');
      const lines = [truncateToWidth('📡 Remote Automation' + sep + theme.fg('dim', paused ? `${location} · background · monitoring paused` : `${location} · background`) + (attention ? sep + theme.fg('warning', 'Attention') : ''), width)];
      for (const a of rows.slice(0, 3)) {
        const state = a.errors || a.followUp === 'Submission failed' ? 'Attention' : a.state[0].toUpperCase() + a.state.slice(1);
        const color = needsAttention(a) ? 'warning' : paused && a.active ? 'dim' : 'accent';
        const suffix = sep + theme.fg(color, state);
        const labelWidth = Math.max(1, width - 6 - visibleWidth(suffix));
        const base = '    ' + theme.fg(color, '●') + ' ' + truncateToWidth(activityName(a), labelWidth) + suffix;
        const summary = a.lastObserved ? sep + displayText(a.lastObserved) : '';
        const checked = a.lastChecked === undefined ? '' : sep + theme.fg('dim', `checked ${Math.max(0, Math.floor((Date.now() - a.lastChecked) / 1000))}s ago`);
        lines.push(truncateToWidth(base + summary + (visibleWidth(base + summary + checked) <= width ? checked : ''), width));
      }
      if (rows.length > 3) lines.push(truncateToWidth(theme.fg('dim', `+${rows.length - 3} more sources`), width));
      return lines;
    },
  };
}

export const MODEL_RESPONSE = 'remote-automation-model-response';
export const RESPONSE_CLEAR = 'remote-automation-response-clear';
export type ResponseRecord = { title: string; status: string; at: string; detail: () => string };
const recordTime = (value: unknown) => {
  const date = typeof value === 'string' || typeof value === 'number' ? new Date(value) : new Date(NaN);
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'time unavailable';
};
const prose = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n\n') : '';

// Only explicit provenance IDs on this branch count; proximity is never evidence.
export function responseRecords(branch: SessionEntry[], eventType: string, provenance: string): ResponseRecord[] {
  let cutoff = -1;
  branch.forEach((e, i) => { if (e.type === 'custom' && e.customType === RESPONSE_CLEAR) cutoff = i; });
  const entries = branch.slice(cutoff + 1);
  const notifications = entries.filter(e => e.type === 'custom_message' && e.customType === eventType);
  const byId = new Map(entries.map(e => [e.id, e]));
  const segments = new Map<string, { at: string; status: string; batches: Set<string>; ids: Set<string> }>();
  const owners = new Map<string, Set<string>>();
  for (const e of entries) {
    if (e.type !== 'custom' || e.customType !== provenance) continue;
    const d = e.data as { segment?: unknown; status?: unknown; batches?: unknown; messageId?: unknown } | undefined;
    if (typeof d?.segment !== 'string') continue;
    let s = segments.get(d.segment);
    if (!s) { s = { at: recordTime(e.timestamp), status: 'incomplete / unknown', batches: new Set([d.segment]), ids: new Set() }; segments.set(d.segment, s); }
    if (typeof d.status === 'string') {
      if (d.status.startsWith('ended —')) s.status = 'response ended';
      else if (d.status.startsWith('interrupted —')) s.status = 'interrupted';
      else if (d.status.startsWith('handover —')) s.status = 'user handover / source uncertain';
    }
    if (Array.isArray(d.batches)) for (const batch of d.batches) if (typeof batch === 'string') s.batches.add(batch);
    if (typeof d.messageId === 'string') {
      s.ids.add(d.messageId);
      const set = owners.get(d.messageId) ?? new Set<string>(); set.add(d.segment); owners.set(d.messageId, set);
    }
  }
  const batchOf = (e: typeof notifications[number]) => (e.details as { batch?: unknown } | undefined)?.batch;
  const used = new Set<string>();
  const make = (at: string, status: string, notes: typeof notifications, ids: Set<string>, batches: Set<string>): ResponseRecord => {
    const labels = notes.flatMap(e => {
      const events = (e.details as { events?: unknown } | undefined)?.events;
      return Array.isArray(events) ? events.map(f => typeof f?.label === 'string' ? displayText(f.label) : typeof f?.source === 'string' ? displayText(`${f.source} ${String(f.id ?? '').slice(0, 8)}`) : 'Monitor update') : [];
    });
    const title = [...new Set(labels)].join(', ') || `Monitor batch (${batches.size || notes.length})`;
    return { at, status, title, detail: () => {
      const lines = [title, `${at} · ${status}`, 'Agent processing status is NOT remote task completion.',
        'Missing end marker means incomplete/unknown, not necessarily active.', 'Original stored text below; terminal controls/secrets scrubbed. No generated summary.', '', 'Associated notifications:'];
      for (const e of notes) {
        const d = e.details as { requestedAt?: unknown; events?: unknown } | undefined;
        lines.push(`Notification: ${recordTime(d?.requestedAt)} · recorded: ${recordTime(e.timestamp)}`);
        if (Array.isArray(d?.events)) for (const f of d.events) lines.push(`Observed event: ${recordTime(f?.first)} · last: ${recordTime(f?.last)}`);
        lines.push(prose(e.content) || '[Notification text unavailable]');
      }
      if (!notes.length || [...batches].some(b => !notes.some(e => batchOf(e) === b))) lines.push('[Associated notification unavailable on this branch]');
      lines.push('', 'Proven associated assistant text:');
      if (!ids.size) lines.push('[No proven assistant text; queued/mixed/unknown responses are not attributed]');
      for (const id of ids) {
        const e = byId.get(id);
        lines.push(`Message: ${id}`);
        lines.push(owners.get(id)?.size === 1 && e?.type === 'message' && e.message.role === 'assistant'
          ? prose(e.message.content) || '[No assistant text blocks]' : '[Assistant text unavailable or ambiguous on this branch]');
      }
      return clean(lines.join('\n\n'), Infinity);
    } };
  };
  const records: ResponseRecord[] = [];
  for (const e of entries) {
    if (e.type !== 'custom' || e.customType !== MODEL_RESPONSE) continue;
    const d = e.data as { model?: string; reply?: string; error?: string; events?: unknown[] } | undefined;
    if (typeof d?.model !== 'string' || !Array.isArray(d.events)) continue;
    const title = singleLine(d.model), at = recordTime(e.timestamp);
    const status = d.error ? 'Model failed · retry with /remote resume' : 'Model response';
    records.push({ title, at, status, detail: () => clean(`${title} · ${at} · ${status}

${d.error ?? d.reply}

Associated event facts:
${JSON.stringify(d.events, null, 2)}`, Infinity) });
  }
  for (const s of segments.values()) {
    const notes = notifications.filter(e => typeof batchOf(e) === 'string' && s.batches.has(batchOf(e) as string));
    notes.forEach(e => used.add(e.id));
    records.push(make(s.at, s.status, notes, s.ids, s.batches));
  }
  for (const e of notifications) if (!used.has(e.id)) records.push(make(recordTime(e.timestamp), 'incomplete / unknown', [e], new Set(), new Set()));
  return records.sort((a, b) => b.at.localeCompare(a.at));
}

export async function inspectActivity(ctx: ExtensionContext, sources: Activity[], history: Observation[], truncated: boolean, acknowledge: (ids: string[]) => void, lifecycle: (close: (() => void) | undefined) => void, responses?: ResponseRecord[]) {
  if (!ctx.hasUI || ctx.mode !== 'tui') return;
  const stamp = (n?: number) => n === undefined ? 'not available' : new Date(n).toISOString();
  const lines = ['📡 Remote Automation · Activity',
    'View only. Monitoring pause never pauses remote jobs.',
    'Hide lasts this session: /remote activity hide; show restores automatic visibility.',
    'Viewing does not request or acknowledge agent action. Follow-up requested = API submission only.',
    'History/pending facts can persist with persist=false; commands/config do not. Redaction is best effort.',
    ...(truncated ? ['Older history truncated (latest 100 changes retained).'] : [])];
  for (const a of sources) {
    lines.push('', `${activityName(a)} · ${singleLine(a.state)} · ${a.active ? 'monitor registered' : 'inactive'} · ${a.unread ? 'unviewed' : 'viewed'}`,
      `ID: ${a.id} · ${a.source} · errors ${a.errors} · ${a.followUp}`,
      `Last checked: ${stamp(a.lastChecked)} · successful: ${stamp(a.lastSuccessfulCheck)}`,
      `Last change: ${stamp(a.lastChange)} · next eligible check: ${a.active ? stamp(a.nextCheck) : 'none'}`,
      a.startKnown ? `Owned submission confirmed: ${stamp(a.startKnown)}` : `Observed since: ${stamp(a.observedSince)} · remote start unknown`,
      `Latest observation: ${a.lastObserved || 'none'}`);
  }
  lines.push('', 'Change history (newest first):');
  for (const e of [...history].reverse()) lines.push(`${stamp(e.at)} · ${e.id} · ${e.state}`, e.summary, `Evidence: ${e.evidence}`);
  if (!sources.length) lines.push('No sources registered.');
  try { await ctx.ui.custom<void>((tui, theme, keys, done) => {
    lifecycle(() => done());
    let offset = 0, total = 0, page = 1, selected = 0;
    let view: 'overview' | 'responses' | 'detail' = 'overview';
    const text = new Text(lines.join('\n'), 0, 0);
    const switchView = (next: typeof view) => {
      view = next; offset = 0;
      text.setText(next === 'overview' ? lines.join('\n') : next === 'detail' ? responses![selected].detail() : '');
    };
    return {
      invalidate() { text.invalidate(); },
      render(width) {
        width = Math.max(0, width);
        if (view === 'responses') {
          const count = Math.max(1, Math.min(20, tui.terminal.rows - 7));
          const start = Math.max(0, selected - count + 1);
          return ['📡 Activity · Monitor response records (newest first)',
            'Current branch snapshot. Ended processing ≠ remote task completion.',
            '/remote clear hides older records here; session text is not deleted.',
            ...(responses!.length ? responses!.slice(start, start + count).map((r, i) =>
              `${start + i === selected ? '›' : ' '} ${r.at} · ${r.status} · ${r.title}`) : ['No visible Monitor records.']),
            '↑/↓ select · Enter inspect · Esc back to Activity',
          ].map(line => truncateToWidth(line, width));
        }
        const rendered = text.render(Math.max(1, width)).map(line => truncateToWidth(line, width));
        total = rendered.length;
        page = Math.max(1, Math.min(24, tui.terminal.rows - 4));
        offset = Math.min(offset, Math.max(0, total - page));
        // Acknowledge only sources actually shown, not pages the user has not reached.
        const shown = rendered.slice(offset, offset + page).join('').replace(/\s+/g, '');
        if (view === 'overview') acknowledge(sources.filter(a => shown.includes(`ID:${a.id}`)).map(a => a.id));
        return [...rendered.slice(offset, offset + page), truncateToWidth(theme.fg('dim', `↑/↓ scroll · ${offset + 1}-${Math.min(total, offset + page)}/${total} · ${view === 'detail' ? 'Esc back to records' : `${responses ? 'r: response records · ' : ''}Esc returns to chat`}`), width)];
      },
      handleInput(data) {
        if (keys.matches(data, 'tui.select.cancel')) {
          if (view === 'overview') { done(); return; }
          switchView(view === 'detail' ? 'responses' : 'overview');
        }
        else if (view === 'overview' && responses && data === 'r') switchView('responses');
        else if (view === 'responses') {
          if (keys.matches(data, 'tui.select.up')) selected = Math.max(0, selected - 1);
          else if (keys.matches(data, 'tui.select.down')) selected = Math.min(Math.max(0, responses!.length - 1), selected + 1);
          else if (keys.matches(data, 'tui.select.confirm') && responses!.length) switchView('detail');
          else return;
        }
        else if (keys.matches(data, 'tui.select.up')) offset = Math.max(0, offset - 1);
        else if (keys.matches(data, 'tui.select.down')) offset = Math.min(Math.max(0, total - page), offset + 1);
        else return;
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { width: '95%', maxHeight: '90%' } });
  } finally { lifecycle(undefined); }
}
