import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export type Target = { host: string; cwd: string; fingerprint: string };
export function target(value: unknown): Target {
  if (typeof value !== 'string') throw new Error('Requires stock --ssh remote.example:/srv/project');
  const match = /^([a-zA-Z0-9_][a-zA-Z0-9_.@-]*):(\/[^\x00-\x1f\x7f]*)$/.exec(value);
  if (!match || value.length > 4096) throw new Error('Requires SSH alias or host:/absolute/path (IPv6: use an SSH config alias)');
  return { host: match[1], cwd: match[2], fingerprint: createHash('sha256').update(value).digest('hex') };
}
export function quote(value: string): string {
  if (value.includes('\0')) throw new Error('NUL is not allowed');
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export { clean } from './runner.mjs';
import { execute } from './runner.mjs';
export type Transport = (script: string, signal: AbortSignal) => Promise<string>;
export function transport(dest: Target, spawnProcess = spawn, platform = process.platform): Transport {
  return (script, signal) => execute({ program: platform === 'win32' ? 'ssh.exe' : 'ssh', args: [
    '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '--', dest.host, 'sh -s',
  ], env: ['SSH_AUTH_SOCK'] }, { signal, timeout: 20000, spawnProcess,
    input: `cd ${quote(dest.cwd)} || exit 72
${script}
`,
  }).catch((error: Error) => { throw new Error(`SSH/remote command: ${error.message}; remote outcome may be unknown; no fallback`); });
}
