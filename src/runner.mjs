import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, statSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { StringDecoder } from 'node:string_decoder';

export function clean(value, cap = 8192) {
  // Best effort only: never use redaction to make a secret-bearing command replayable.
  const text = value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED KEY]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [REDACTED]')
    .replace(/((?:pass(?:word|wd)|token|secret|api[_-]?key|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,"';}]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  return text.length > cap ? text.slice(0, cap) + '\n[truncated; remainder not stored]' : text;
}
export const powershellPrefix = "$ProgressPreference='SilentlyContinue'; $utf8=New-Object System.Text.UTF8Encoding $false; [Console]::InputEncoding=$utf8; [Console]::OutputEncoding=$utf8; $OutputEncoding=$utf8; ";
export function diagnostic(value) {
  // PowerShell error records include source/argv excerpts; retain the error message, not those records.
  const text = String(value).replace(/<Objs[\s\S]*?<\/Objs>/g, '[PowerShell error records omitted]').replace(/^.*(?:At line:|\+ |CategoryInfo\s*:|FullyQualifiedErrorId\s*:).*$/gm, '');
  return clean(text, 4096).replace(/(?:[A-Za-z]:[\\/]|\/)[^\s<>"']+|(?:[\w.-]+@)?[\w.-]+\.[A-Za-z]{2,}(?::\d+)?/g, '[private]').slice(0, 2048);
}
const scriptError = () => new Error('Script program requires explicit command+shell (sh|powershell|pwsh), or interpreter program+args; native execution never enables shell implicitly');
export function checkCwd(cwd) {
  try { if (!statSync(cwd ?? process.cwd()).isDirectory()) throw Error(); }
  catch { throw new Error('cwd invalid: working directory missing, inaccessible, or not a directory'); }
}
export function checkProgram(program, cwd) {
  if (process.platform !== 'win32') return;
  if (/\.(cmd|bat|ps1)$/i.test(program)) throw scriptError();
  if (extname(program)) return;
  const dirs = /[\\/]/.test(program) ? [''] : [cwd ?? process.cwd(), ...(process.env.PATH ?? '').split(';')];
  for (const dir of dirs) for (const ext of ['.exe', '.com', ...(process.env.PATHEXT ?? '.CMD;.BAT').split(';')]) {
    if (existsSync(resolve(cwd ?? process.cwd(), dir.replace(/^"|"$/g, ''), program + ext))) {
      if (/\.(cmd|bat|ps1)$/i.test(ext)) throw scriptError();
      return;
    }
  }
}
export const spawnError = e => new Error(`spawn: ${/^[A-Z0-9_]+$/.test(e?.code) ? e.code : 'UNKNOWN'}; ${e?.code === 'ENOENT' ? 'program or selected shell unavailable; check installation/PATH' : 'cannot start native program; check permissions and executable format'}`);
// Independent decoders keep split characters from separate pipes from being joined.
export function outputTail(cap = 32768) {
  const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
  let bytes = Buffer.alloc(0), truncated = false, ended = false;
  const append = text => {
    const next = Buffer.concat([bytes, Buffer.from(text)]);
    let start = Math.max(0, next.length - cap);
    if (start) { truncated = true; while (start < next.length && (next[start] & 0xc0) === 0x80) start++; }
    bytes = Buffer.from(next.subarray(start));
  };
  return {
    write(index, chunk) { if (!ended) append(decoders[index].write(chunk)); },
    end() { if (!ended) { ended = true; for (const decoder of decoders) append(decoder.end()); } },
    get output() { return bytes.toString('utf8'); }, get truncated() { return truncated; },
  };
}

// Increment only for incompatible request/response semantics.
export const RUNNER_PROTOCOL_VERSION = 1;
export const runnerFile = fileURLToPath(import.meta.url);
export const stateRoot = () => join(process.platform === 'win32' ? (process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')) : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : (process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')), 'pi-remote-automation');
const validText = v => typeof v === 'string' && v.length <= 8192 && !v.includes('\0');
export function execution(input, platform = process.platform, legacy = false) {
  if (!input || typeof input !== 'object') throw new Error('Invalid execution');
  const { program, command, shell, args = [], env = [] } = input;
  if (Number(program !== undefined) + Number(command !== undefined) !== 1) throw new Error('Specify program+args OR command+shell');
  if (!Array.isArray(args) || args.length > 128 || !args.every(validText) || !Array.isArray(env) || env.length > 128 || !env.every(v => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v))) throw new Error('Invalid args or environment names');
  if (program !== undefined) {
    if (!validText(program) || !program.trim() || shell !== undefined) throw new Error('Invalid program (shell not allowed)');
    if (platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(program)) throw scriptError();
    return { program, args, env };
  }
  if (!validText(command) || !command.trim() || args.length) throw new Error('Invalid command');
  const selected = shell ?? (legacy ? 'sh' : undefined);
  if (!['sh', 'powershell', 'pwsh'].includes(selected)) throw new Error('command requires explicit shell: sh|powershell|pwsh');
  if (selected === 'sh') return { program: 'sh', args: ['-c', command], env };
  if (selected === 'powershell' && platform !== 'win32') throw new Error('powershell requires Windows; select pwsh explicitly on POSIX');
  const body = powershellPrefix + `$ErrorActionPreference='Stop'; & { ${command}\n }; if (-not $?) { exit 1 }; if ($LASTEXITCODE) { exit $LASTEXITCODE }`;
  return { program: selected === 'powershell' ? 'powershell.exe' : platform === 'win32' ? 'pwsh.exe' : 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], env };
}
export function environment(names = []) {
  const result = {};
  // Windows OpenSSH needs ProgramData to initialize successfully.
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'ProgramData', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', ...names]) if (process.env[name] !== undefined) result[name] = process.env[name];
  return result;
}
// shortcut: cancellation owns only the direct child handle; use OS job objects for guaranteed Windows tree containment.
export function execute(spec, { cwd, signal, timeout = 15000, spawnProcess = spawn, input } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted; execution not started'));
    let child, done = false, size = 0, failure, stopTimer;
    const output = [], stderr = [];
    try { checkCwd(cwd); checkProgram(spec.program, cwd); } catch (error) { reject(error); return; }
    const finish = error => { if (done) return; done = true; clearTimeout(timer); clearTimeout(stopTimer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(Buffer.concat(output).toString('utf8')); };
    const stop = why => {
      if (done || failure) return;
      failure = new Error(`${why}; termination requested, outcome unknown; descendants may survive`);
      const unknown = () => { child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); child.unref?.(); finish(failure); };
      stopTimer = setTimeout(unknown, 1000);
      try { if (!child.kill('SIGKILL')) unknown(); } catch { unknown(); }
    };
    const abort = () => stop('aborted; outcome unknown');
    const timer = setTimeout(() => stop('timeout; outcome unknown'), timeout);
    try { child = spawnProcess(spec.program, spec.args, { cwd, env: environment(spec.env), shell: false, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); }
    catch (error) { finish(spawnError(error)); return; }
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    signal?.addEventListener('abort', abort, { once: true });
    for (const [stream, stdout] of [[child.stdout, true], [child.stderr, false]]) stream.on('data', chunk => {
      size += chunk.length;
      if (done) return;
      if (size > 65536) { if (!failure) stop('output limit exceeded; outcome unknown'); return; }
      (stdout ? output : stderr).push(Buffer.from(chunk));
    });
    child.on('error', error => finish(spawnError(error)));
    // Exit, not pipe close: an escaped descendant may retain the pipes indefinitely.
    child.on('exit', (code, sig) => {
      const complete = () => { child.stdout.destroy(); child.stderr.destroy(); finish(failure || (code === 0 ? undefined : new Error(`command: exit=${code ?? 'unknown'} signal=${sig ?? 'none'}; ${diagnostic(Buffer.concat(stderr).toString('utf8'))}`))); };
      child.once('close', complete); setTimeout(complete, 100).unref();
    });
    if (signal?.aborted) abort();
  });
}
function paths(root, id) {
  if (!/^pra_[a-f0-9]{32}$/.test(id)) throw new Error('Invalid job identity');
  return { file: join(root, `${id}.json`), socket: process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : join(root, `${id}.sock`) };
}
function readState(file) { if (lstatSync(file).isSymbolicLink()) throw new Error('Unsafe job metadata'); return JSON.parse(readFileSync(file, 'utf8')); }
function publicState(s) { const { token, session, ...visible } = s; return visible; }
export function request(socket, message) {
  return new Promise((resolve, reject) => {
    const client = createConnection(socket); client.setEncoding('utf8'); let data = '', done = false;
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); client.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(new Error('worker unavailable; outcome unknown')), 3000);
    client.on('error', () => finish(new Error('worker unavailable; outcome unknown')));
    client.on('connect', () => client.write(JSON.stringify(message) + '\n'));
    client.on('data', chunk => { data += chunk; if (Buffer.byteLength(data) > 150000) return finish(new Error('Invalid worker response')); if (data.includes('\n')) { try { const r = JSON.parse(data); finish(r.error ? new Error(r.error) : undefined, r); } catch { finish(new Error('Invalid worker response')); } } });
  });
}
export async function doctor(cwd, signal, spawnProcess = spawn) {
  let directory = 'available';
  try { checkCwd(cwd); } catch { directory = 'invalid'; }
  const shells = {};
  for (const shell of ['sh', 'powershell', 'pwsh']) {
    signal?.throwIfAborted();
    try {
      const output = await execute(execution({ shell, command: shell === 'sh' ? "printf 'sh compatible'" : '$PSVersionTable.PSVersion.ToString()' }), { signal, timeout: 3000, spawnProcess });
      shells[shell] = { available: true, version: diagnostic(output.trim()) };
    } catch (error) { if (signal?.aborted) throw error; shells[shell] = { available: false, note: diagnostic(error.message) }; }
  }
  let native = false;
  try { native = (await execute({ program: process.execPath, args: ['--version'], env: [] }, { signal, timeout: 3000, spawnProcess })).trim().startsWith('v'); } catch (error) { if (signal?.aborted) throw error; }
  return { platform: process.platform, node: process.versions.node, managed: native && Number(process.versions.node.split('.')[0]) >= 22, native, cwd: directory, shells, cancellation: 'direct child only; descendants may survive' };
}
export async function dispatch(message, root = stateRoot(), signal) {
  signal?.throwIfAborted();
  if (message.action === 'doctor') return doctor(message.cwd, signal);
  const { file, socket } = paths(root, message.id);
  if (message.action === 'start') {
    if (!/^[a-f0-9]{32}$/.test(message.token) || typeof message.session !== 'string' || !message.session || message.session.length > 256 || !validText(message.cwd)) throw new Error('Invalid ownership/cwd');
    const spec = execution(message.execution);
    checkCwd(message.cwd); checkProgram(spec.program, message.cwd);
    if (message.execution.shell) await execute(execution({ shell: message.execution.shell, command: message.execution.shell === 'sh' ? ':' : '$null' }), { cwd: message.cwd, timeout: 3000, signal });
    signal?.throwIfAborted();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (lstatSync(root).isSymbolicLink()) throw new Error('Unsafe state directory');
    const state = { id: message.id, token: message.token, session: message.session, state: 'unknown', output: '', truncated: false };
    writeFileSync(file, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    // Exclusive identity reservation precedes spawn. Existing identities can NEVER be launched again.
    const worker = spawn(process.execPath, [runnerFile, '--worker'], { detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    worker.on('error', () => {});
    worker.stdin.on('error', () => {});
    worker.stdin.end(JSON.stringify({ root, id: message.id, spec, cwd: message.cwd }));
    worker.unref();
    return { id: message.id, state: 'submitted', note: 'Reconcile this identity; never retry start. Worker detaches; reboot persistence not promised.' };
  }
  const state = readState(file);
  if (message.action === 'cancel' && (message.token !== state.token || message.session !== state.session)) throw new Error('Cancellation requires original ownership');
  if (!['status', 'output', 'cancel'].includes(message.action)) throw new Error('Unknown runner action');
  if (['succeeded', 'failed', 'cancelled'].includes(state.state)) return publicState(state);
  try { return await request(socket, { action: message.action, token: state.token, session: state.session }); }
  catch { return { id: message.id, state: 'unknown', note: 'Worker unreachable; no PID fallback, no automatic relaunch', ...(message.action === 'output' ? { output: state.output, truncated: state.truncated } : {}) }; }
}
async function work({ root, id, spec, cwd }) {
  const { file, socket } = paths(root, id);
  const state = readState(file);
  const tail = outputTail();
  let child, cancelling = false, completed = false, pending;
  const persist = () => { clearTimeout(pending); pending = undefined; writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 }); renameSync(file + '.tmp', file); };
  const server = createServer(client => {
    let data = '';
    client.setEncoding('utf8');
    client.setTimeout(3000, () => client.destroy());
    client.on('error', () => {});
    client.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > 4096) return client.destroy();
      if (!data.includes('\n')) return;
      try {
        const m = JSON.parse(data);
        if (m.token !== state.token || m.session !== state.session) return client.end(JSON.stringify({ error: 'Unauthorized worker request' }) + '\n');
        if (!['status', 'output', 'cancel'].includes(m.action)) throw new Error('Invalid action');
        if (m.action === 'cancel' && !completed) {
          try {
            if (!child.kill('SIGKILL')) throw new Error('Signal not sent');
            cancelling = true;
          } catch { return client.end(JSON.stringify({ id, state: 'unknown', note: 'Cancellation not confirmed; reconcile status; descendants may survive' }) + '\n'); }
          const reply = () => {
            if (client.destroyed) return;
            if (completed) client.end(JSON.stringify(publicState(state)) + '\n');
            else setTimeout(reply, 20);
          };
          reply();
        } else client.end(JSON.stringify(publicState(state)) + '\n');
      } catch { client.end(JSON.stringify({ error: 'Invalid request' }) + '\n'); }
    });
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(socket, res); });
  const finish = (code, signal) => {
    if (completed) return;
    completed = true;
    tail.end(); state.output = tail.output; state.truncated = tail.truncated;
    state.state = cancelling ? 'cancelled' : code === 0 ? 'succeeded' : 'failed';
    state.exitCode = code; state.exitSignal = signal;
    state.note = 'Direct child exited; descendants may survive. Output is bounded, untrusted, not a full log.';
    child?.stdout?.destroy(); child?.stderr?.destroy();
    persist(); server.close();
  };
  try {
    child = spawn(spec.program, spec.args, { cwd, env: environment(spec.env), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', error => { state.error = spawnError(error).message; finish(null, 'spawn-error'); });
    child.on('exit', (code, signal) => {
      child.once('close', () => finish(code, signal));
      setTimeout(() => finish(code, signal), 100).unref();
    });
    state.state = 'running'; persist();
    for (const [index, stream] of [child.stdout, child.stderr].entries()) stream.on('data', chunk => {
      tail.write(index, chunk); state.output = tail.output; state.truncated = tail.truncated;
      if (!pending) pending = setTimeout(persist, 100);
    });
  } catch (error) { state.error = spawnError(error).message; finish(null, 'spawn-error'); }
}
if (process.argv[1] && resolve(process.argv[1]) === runnerFile) {
  let input = '';
  process.stdin.setEncoding('utf8');
  try {
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 150000) throw new Error('Request too large'); }
    const message = JSON.parse(input);
    if (process.argv[2] === '--worker') await work(message);
    else process.stdout.write(JSON.stringify(await dispatch(message)) + '\n');
  } catch (error) { process.stderr.write('Runner: ' + diagnostic(error.message) + '\n'); process.exitCode = 1; }
}
