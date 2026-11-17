# pi-remote-automation

Monitor local or SSH tasks from Pi and receive updates when a condition matches. You can set reminders, watch for a result, or check a background job without leaving the session.

Watches and schedules need a running Pi session. New and restored sessions start with monitoring paused.

English | [简体中文](README.zh-CN.md)

[Quickstart](#quickstart) · [Examples](#examples) · [SSH setup](#ssh-setup) · [Monitoring](#monitoring) · [Tools](#tools) · [Limits](#lifecycle-and-notification-limits)

A local reminder in Pi:

![A local Pi session with a 10-second reminder](docs/assets/remote-automation-local.png)

## Quickstart

Install Node.js 22 or later and Pi with package support on Windows, Linux or macOS. In a terminal, replace `OWNER/REPO` with the repository address:

```bash
git clone https://github.com/OWNER/REPO.git
```

Install from the checkout using its absolute path:

```bash
# POSIX
pi install "/absolute/path/to/pi-remote-automation"
```

```powershell
# Windows PowerShell
pi install "C:/absolute/path/to/pi-remote-automation"
```

Pi loads the package from the checkout without copying it. Restart Pi or run `/reload` in an existing session. Installation uses personal settings by default. Add `-l` for project settings. Use `pi list` to list packages and `pi remove <source>` to remove one.

Start Pi in your project directory in a terminal:

```bash
# POSIX
cd /path/to/project
pi
```

```powershell
# Windows PowerShell
cd C:/work/project
pi
```

Automation defaults to the local machine and Pi's current directory. Local use needs no SSH setup or runner deployment. To use another local directory, start Pi with `pi --automation-target local --automation-cwd <absolute-project-path>`.

In Pi, run `/remote resume`, then enter this prompt:

> Use remote_schedule to remind me to check this project in 10 seconds.

After about 10 seconds, Pi should receive a reminder update. Run `/remote activity` in Pi to check activity. Keep the session running while you wait.

## Examples

Enter these as prompts in Pi. Review commands Pi proposes before allowing them to run.

- Watch for `result.json` to appear every 30 seconds and notify me once. Do not launch or modify any jobs.
- Remind me to check this project in 10 seconds.
- Start the background job I specify, then check its status and output.

File checks use a custom JSON probe on the selected target. There is no built-in file watcher. Probes and job commands can execute arbitrary code, so authorize only commands you intend to run.

## SSH setup

Install an OpenSSH client locally and Node.js 22 or later on the target. Configure an SSH alias with non-interactive authentication and a verified host key in `known_hosts`. Start Pi in a terminal with an absolute target directory and platform:

```bash
# POSIX target with an sh login
pi --automation-target ssh:lab --automation-cwd /srv/project --automation-platform posix
```

```powershell
# Windows target with a PowerShell login
pi --automation-target ssh:lab --automation-cwd C:/work/project --automation-platform win32
```

In Pi, run `/remote doctor`, then explicitly run `/remote deploy-runner` and `/remote resume`. Deployment copies the bundled runner to the SSH user's state directory. The flags affect automation tools, not normal Pi tools. Explicit SSH does not fall back to local execution.

## Monitoring

In Pi, use `/remote activity` to view activity and `/remote doctor` to inspect capabilities. Use `/remote pause` to stop checks and suppress notifications, or `/remote resume` to resume monitoring. Pausing does not stop jobs. Resuming does not re-enable a watch disabled after three probe errors. Recreate it to retry.

Use `/remote clear` to remove the current session's watches, schedules, job monitoring registrations, unsubmitted events and Activity history. It saves the empty state and leaves monitoring paused. Resuming does not restore cleared registrations. You can also ask Pi to call `remote_control` with `action: "clear"`.

Clear does not terminate jobs, delete target files, erase the conversation or retract notifications already submitted to Pi. It also forgets local job ownership. Jobs attached again are observe-only. `/remote activity clear` only marks Activity updates as viewed. It does not remove registrations or clear history.

## Tools

| Tool | Purpose |
| --- | --- |
| `remote_watch` | Run a JSON probe and watch for a matching state. |
| `remote_schedule` | Send a reminder or run a check once or at an interval. |
| `remote_job` | Start or attach to a job, inspect status or output, or cancel an owned job. |
| `remote_control` | Inspect capabilities and control monitoring. |

## Lifecycle and notification limits

Set `persist: true` when creating a watch or schedule to restore its configuration in the same session and target. Restored monitoring starts paused; use `/remote resume` to restart it. Missed intervals are not replayed. Managed jobs can continue after Pi exits. Job output is a bounded tail, not a full log.

If notification submission fails, check `/remote activity` and use `/remote resume` to retry. Setting `persist: false` does not prevent Activity history or pending events from being saved. Pi also records tool arguments in its session, so do not put credentials in commands or messages.

<details>
<summary>Ask a coding agent to install</summary>

Replace the placeholders and give one of these prompts to your coding agent.

Local:

```text
Install this Pi plugin: <repository URL or local directory>.
Set it up for local use in <project directory>, check that it loads,
and show me how to create a reminder for 10 seconds from now.
```

SSH:

```text
Install this Pi plugin: <repository URL or local directory>.
Configure automation over <SSH alias> in <absolute project path>;
the target OS is <Windows/Linux/macOS>. Check the connection, deploy the
runner, and give me a ready-to-use Pi launch command.
```

</details>

<details>
<summary>Legacy SSH integration</summary>

The separate official Pi SSH example extension also redirects normal Pi tools and requires `bash` on the target. Replace the path with the actual path to Pi's `examples/extensions/ssh.ts`. In a terminal:

```bash
pi install "/absolute/path/to/pi-coding-agent/examples/extensions/ssh.ts"
pi --ssh lab:/srv/project
```

Do not combine legacy `--ssh` with the automation flags. Legacy SSH defaults to tmux jobs on POSIX targets and requires tmux for those jobs. Managed jobs also require Node.js 22 or later and an explicit `/remote deploy-runner` in Pi.

</details>
