import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { execution, execute, dispatch, runnerFile, powershellPrefix, doctor, diagnostic, RUNNER_PROTOCOL_VERSION } from './runner.mjs';
import { target as legacyTarget, transport as legacyTransport, quote, type Transport } from './ssh.ts';
export type Execution = { command?: string; program?: string; args?: string[]; shell?: 'sh' | 'powershell' | 'pwsh'; env?: string[] };
export type Target = { kind: 'local' | 'ssh'; host?: string; cwd: string; platform: 'win32' | 'posix'; legacy: boolean; fingerprint: string };
export type Executor = ((input: string | Execution, signal: AbortSignal) => Promise<string>) & {
  destination?: Target;
  managed?: (message: Record<string, unknown>, signal: AbortSignal) => Promise<any>;
  doctor?: (signal: AbortSignal) => Promise<unknown>;
  deploy?: (signal: AbortSignal) => Promise<unknown>;
};
export function target(value: unknown, cwd: unknown, platform: unknown, stock: unknown, localCwd: string): Target {
  if (stock !== undefined) {
    if (value !== undefined || cwd !== undefined || platform !== undefined) throw new Error('Do not combine --ssh with automation target/cwd/platform flags; agent tools and automation must not silently diverge');
    return { ...legacyTarget(stock), kind: 'ssh', platform: 'posix', legacy: true };
  }
  if (value !== undefined && value !== 'local' && !(typeof value === 'string' && /^ssh:[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(value))) throw new Error('Use --automation-target local|ssh:alias');
  const kind = value === undefined || value === 'local' ? 'local' : 'ssh';
  const host = kind === 'ssh' ? (value as string).slice(4) : undefined;
  const os = kind === 'local' ? (process.platform === 'win32' ? 'win32' : 'posix') : platform;
  if (!['win32', 'posix'].includes(String(os))) throw new Error('SSH requires --automation-platform win32|posix; login must support powershell.exe or sh respectively');
  if (kind === 'local' && platform !== undefined && platform !== os) throw new Error('Local platform conflicts with this OS');
  const dir = cwd ?? (kind === 'local' ? localCwd : undefined);
  if (typeof dir !== 'string' || dir.length > 4096 || /[\x00-\x1f\x7f]/.test(dir) || !(os === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(dir) : dir.startsWith('/'))) throw new Error('Specify absolute --automation-cwd on target');
  return { kind, host, cwd: dir, platform: os as Target['platform'], legacy: false, fingerprint: createHash('sha256').update(JSON.stringify([kind, host, dir, os])).digest('hex') };
}
const psQuote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
export function remoteCommand(dest: Target, script: string) {
  const command = dest.platform === 'win32' ? 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(powershellPrefix + "$ErrorActionPreference='Stop'; " + script, 'utf16le').toString('base64') : 'sh -c ' + quote(script);
  // shortcut: Windows SSH login shells may impose cmd.exe's 8191-character ceiling; use a shorter bootstrap when extending it.
  if (dest.platform === 'win32' && command.length > 8000) throw new Error('Windows SSH bootstrap too long; command not started');
  return command;
}
export function transport(dest: Target, spawnProcess = spawn): Executor {
  const old: Transport | undefined = dest.legacy ? legacyTransport({ host: dest.host!, cwd: dest.cwd, fingerprint: dest.fingerprint }, spawnProcess) : undefined;
  const ssh = (script: string, signal: AbortSignal, input?: string) => execute({ program: process.platform === 'win32' ? 'ssh.exe' : 'ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '--', dest.host!, remoteCommand(dest, script)], env: ['USERPROFILE', 'HOME', 'SSH_AUTH_SOCK'] }, { signal, timeout: 20000, spawnProcess, input }).catch((error: Error) => { throw new Error(`SSH/remote command: ${diagnostic(error.message)}; outcome may be unknown; no retry or local fallback`); });
  // Base64 keeps embedded JS quotes out of Windows PowerShell 5.1 native argv parsing; stdin remains the request channel.
  const node = (code: string, signal: AbortSignal, input?: string) => {
    const encoded = `eval(Buffer.from('${Buffer.from(code).toString('base64')}','base64').toString())`;
    return ssh(dest.platform === 'win32' ? `& node -e ${psQuote(encoded)}; if ($LASTEXITCODE) { exit $LASTEXITCODE }` : `node -e ${quote(encoded)}`, signal, input);
  };
  const bootstrap = `const p=require('node:path'),o=require('node:os'),u=require('node:url');const root=p.join(process.platform==='win32'?(process.env.LOCALAPPDATA||p.join(o.homedir(),'AppData','Local')):process.platform==='darwin'?p.join(o.homedir(),'Library','Application Support'):(process.env.XDG_STATE_HOME||p.join(o.homedir(),'.local','state')),'pi-remote-automation');const file=p.join(root,'runner-v1.mjs');if(+process.versions.node.split('.')[0]<22)throw Error('Node 22+ required');if((process.platform==='win32')!==${dest.platform === 'win32'})throw Error('Target platform mismatch');`;
  const compatible = `if(m.RUNNER_PROTOCOL_VERSION!==${RUNNER_PROTOCOL_VERSION})throw Error('Incompatible runner protocol; preserve running jobs and explicitly reconcile deployment; existing runner is never overwritten');`;
  const managed = async (message: Record<string, unknown>, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (dest.kind === 'local') return dispatch(message, undefined, signal);
    return JSON.parse(await node(bootstrap + `import(u.pathToFileURL(file).href).then(m=>{${compatible}return m.dispatch(JSON.parse(require('node:fs').readFileSync(0,'utf8')))}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.code==='ERR_MODULE_NOT_FOUND'?'Runner not deployed; explicit deploy-runner required':e.message);process.exitCode=1})`, signal, JSON.stringify(message)));
  };
  const run: Executor = async (input, signal) => {
    if (typeof input === 'string') {
      if (dest.platform !== 'posix' || dest.kind !== 'ssh') throw new Error('Legacy tmux operations require SSH POSIX target');
      return old ? old(input, signal) : ssh(`cd ${quote(dest.cwd)} || exit 72\n${input}`, signal);
    }
    const spec = execution(input, dest.platform, dest.legacy);
    if (dest.kind === 'local') return execute(spec, { cwd: dest.cwd, signal, spawnProcess });
    if (old && input.env?.length) throw new Error('Explicit env selection requires managed SSH target');
    if (old) return old(`${quote(spec.program)} ${spec.args.map(quote).join(' ')}`, signal);
    return node(bootstrap + `import(u.pathToFileURL(file).href).then(async m=>{${compatible}const r=JSON.parse(require('node:fs').readFileSync(0,'utf8'));process.stdout.write(await m.execute(r.spec,{cwd:r.cwd,timeout:15000}))}).catch(e=>{console.error(e.code==='ERR_MODULE_NOT_FOUND'?'Runner not deployed; explicit deploy-runner required':e.message);process.exitCode=1})`, signal, JSON.stringify({ spec, cwd: dest.cwd }));
  };
  run.destination = dest;
  run.managed = managed;
  run.doctor = async signal => dest.kind === 'local' ? doctor(dest.cwd, signal, spawnProcess) : dest.legacy ? { capabilities: await old!("uname -s; command -v tmux || true; command -v node || true", signal), note: 'Legacy probes have client-side timeout only; remote descendants may survive disconnect. GNU timeout not required. Managed backend requires explicit deployment.' } : JSON.parse(await node(bootstrap + `const fs=require('node:fs'),cp=require('node:child_process');const cwd=JSON.parse(fs.readFileSync(0,'utf8')).cwd;let directory='available';try{if(!fs.statSync(cwd).isDirectory())directory='invalid'}catch{directory='invalid'};const shells={};for(const [name,program,args] of ${JSON.stringify([['sh', 'sh', ['-c', "printf 'sh compatible'"]], ['powershell', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']], ['pwsh', dest.platform === 'win32' ? 'pwsh.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']]])}){const r=cp.spawnSync(program,args,{timeout:2000,maxBuffer:4096,encoding:'utf8',windowsHide:true,shell:false});shells[name]={available:r.status===0,version:r.status===0?r.stdout.trim().replace(/[^a-zA-Z0-9. -]/g,'').slice(0,80):undefined}}(async()=>{let compatibility='not deployed';if(fs.existsSync(file)){try{const m=await import(u.pathToFileURL(file).href);compatibility=m.RUNNER_PROTOCOL_VERSION===${RUNNER_PROTOCOL_VERSION}?'compatible':'incompatible'}catch{compatibility='unavailable'}}console.log(JSON.stringify({platform:process.platform,node:process.versions.node,native:true,cwd:directory,shells,managed:compatibility==='compatible',compatibility,note:'Incompatible runners require explicit reconciliation; never overwrite running deployments. No job launched.'}))})()`, signal, JSON.stringify({ cwd: dest.cwd })));
  run.deploy = async signal => {
    if (dest.kind !== 'ssh') throw new Error('Local runner is bundled; deployment is SSH-only');
    const source = readFileSync(runnerFile).toString('base64');
    return JSON.parse(await node(bootstrap + `const fs=require('node:fs');fs.mkdirSync(root,{recursive:true,mode:448});if(fs.lstatSync(root).isSymbolicLink())throw Error('Unsafe directory');(async()=>{let deployed=false;try{fs.writeFileSync(file,Buffer.from(fs.readFileSync(0,'utf8'),'base64'),{flag:'wx',mode:384});deployed=true}catch(e){if(e.code!=='EEXIST')throw e}const m=await import(u.pathToFileURL(file).href);${compatible}console.log(JSON.stringify({deployed,compatible:true,note:deployed?'Runner deployed; no jobs launched or dependencies installed.':'Compatible runner already present; no files changed.'}))})().catch(e=>{console.error(e.message);process.exitCode=1})`, signal, source));
  };
  return run;
}
