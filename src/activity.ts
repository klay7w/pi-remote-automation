import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { clean } from './ssh.ts';

export type Activity = {
  id: string; source: 'watch' | 'schedule' | 'job'; label?: string; state: string; active: boolean;
  observedSince: number; startKnown?: number; lastChecked?: number; lastSuccessfulCheck?: number;
  lastObserved: string; lastChange?: number; nextCheck?: number; errors: number; unread: boolean;
  followUp: 'None' | 'Pending' | 'Follow-up requested' | 'Submission failed';
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

export async function inspectActivity(ctx: ExtensionContext, sources: Activity[], history: Observation[], truncated: boolean, acknowledge: (ids: string[]) => void, lifecycle: (close: (() => void) | undefined) => void) {
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
    let offset = 0, total = 0, page = 1;
    const text = new Text(lines.join('\n'), 0, 0);
    return {
      invalidate() { text.invalidate(); },
      render(width) {
        const rendered = text.render(Math.max(1, width));
        total = rendered.length;
        page = Math.max(1, Math.min(24, tui.terminal.rows - 4));
        offset = Math.min(offset, Math.max(0, total - page));
        // Acknowledge only sources actually shown, not pages the user has not reached.
        const shown = rendered.slice(offset, offset + page).join('').replace(/\s+/g, '');
        acknowledge(sources.filter(a => shown.includes(`ID:${a.id}`)).map(a => a.id));
        return [...rendered.slice(offset, offset + page), truncateToWidth(theme.fg('dim', `↑/↓ scroll · ${offset + 1}-${Math.min(total, offset + page)}/${total} · Esc returns to chat`), width)];
      },
      handleInput(data) {
        if (keys.matches(data, 'tui.select.cancel')) { done(); return; }
        if (keys.matches(data, 'tui.select.up')) offset = Math.max(0, offset - 1);
        else if (keys.matches(data, 'tui.select.down')) offset = Math.min(Math.max(0, total - page), offset + 1);
        else return;
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { width: '95%', maxHeight: '90%' } });
  } finally { lifecycle(undefined); }
}
