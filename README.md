# pi-remote-automation

Monitor local or SSH tasks from Pi and receive updates when a condition matches. Set reminders, watch for results, and check background jobs in the same session.

Watches and schedules need a running Pi session. New and restored sessions start with monitoring paused.

English | [简体中文](README.zh-CN.md)

[Quickstart](#quickstart) · [Examples](#examples) · [SSH setup](#ssh-setup) · [Monitoring](#monitoring) · [Tools](#tools) · [Session and notifications](#session-and-notifications)

A 10-second reminder with Monitor processing markers and the Activity widget:

![A local Pi session with a 10-second reminder](docs/assets/remote-automation-local.png)

## Quickstart

Install Node.js 22 or later and Pi with package support on Windows, Linux or macOS. Clone the repository in a terminal:

```bash
git clone https://github.com/klay7w/pi-remote-automation.git
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

Pi loads the package directly from the checkout. Restart Pi or run `/reload` in an existing session. Installation uses personal settings by default. Add `-l` for project settings. Use `pi list` to list packages and `pi remove <source>` to remove one.

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

Automation defaults to the local machine and Pi's current directory. To use another local directory, start Pi with `pi --automation-target local --automation-cwd <absolute-project-path>`.

In Pi, run `/remote resume`, then enter this prompt:

> Use remote_schedule to remind me to check this project in 10 seconds.

After about 10 seconds, Pi should receive a reminder update. Run `/remote activity` in Pi to check activity. Keep the session running while you wait.

## Examples

Enter these as prompts in Pi:

- Check whether `result.json` exists every 30 seconds and notify me once when it appears.
- Remind me to check this project in 10 seconds.
- Start the background job I specify, then check its status and output.

File checks use a custom JSON probe on the selected target. Probes and job commands run with the target user's permissions. Review the commands Pi proposes before execution.

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

In Pi, run `/remote doctor`, then explicitly run `/remote deploy-runner` and `/remote resume`. Deployment copies the bundled runner to the SSH user's state directory. These flags select the target for automation tools. With `--automation-target ssh:lab`, automation commands execute on `lab`.

## Monitoring

The Activity widget shows up to three active or unread sources. Sources with errors appear first, followed by unread updates. Open `/remote activity` for the full list, check times, observations and notification submission status.

| Command | Action |
| --- | --- |
| `/remote` or `/remote activity` | Open Activity. Press `r` for Monitor response records. |
| `/remote status` | Open the Activity overview. |
| `/remote jobs`, `/remote watches`, `/remote schedules` | Show Activity for one source type. |
| `/remote activity hide` or `/remote activity show` | Hide or show the widget. |
| `/remote activity clear` | Mark all Activity updates as viewed. Keep registrations and history. |
| `/remote doctor` | Check target capabilities. |
| `/remote pause` or `/remote resume` | Pause or resume checks and notification submission. |
| `/remote clear` | Forget monitoring registrations and clear Activity history. |

Jobs continue running while monitoring is paused. Three consecutive probe errors disable a watch. Recreate that watch to retry.

### Monitor response records

Record details show the notification and its associated assistant text:

![Pi Monitor response detail with the associated notification and assistant text](docs/assets/remote-automation-response.png)

In `/remote activity`, press `r` to view records for the current conversation branch, newest first. Use the up and down arrows to select a record, then Enter to inspect it. Esc returns to the record list, then Activity, then chat. The inspector shows a snapshot taken when you open Activity. Reopen it to see newer records.

Each record contains notifications, event times and stored assistant text linked by explicit message IDs. Records describe the assistant's response to a notification. Check job status through `remote_job`.

| Response status | Meaning |
| --- | --- |
| `response ended` | The assistant finished processing the notification. |
| `interrupted` | Processing stopped early. |
| `user handover / source uncertain` | User input or another message made the response's source uncertain. |
| `incomplete / unknown` | The record lacks an end marker. |

Chat shows Monitor processing markers for associated responses. Stored assistant messages with a known association receive a `Monitor-triggered response` label when rendered.

### Clear monitoring

Use `/remote clear` to remove the current session's watches, schedules, job monitoring registrations, unsubmitted events and Activity history. It saves the empty state, pauses monitoring and hides older Monitor response records in the inspector. Create new registrations to start monitoring again. The tool equivalent is `remote_control` with `action: "clear"`.

Running jobs, target files and conversation text remain. Clear also removes local job ownership records, so jobs attached again are observe-only.

Use `/remote activity clear` to mark updates as viewed while keeping registrations and history.

## Tools

| Tool | Purpose |
| --- | --- |
| `remote_watch` | Run a JSON probe and watch for a matching state. |
| `remote_schedule` | Send a reminder or run a check once or at an interval. |
| `remote_job` | Start or attach to a job, inspect status or output, or cancel an owned job. |
| `remote_control` | Inspect capabilities and control monitoring. |

## Session and notifications

Set `persist: true` when creating a watch or schedule to restore its configuration in the same session and target. Restored monitoring starts paused. Use `/remote resume` to continue checks from the current time. Managed jobs can continue after Pi exits, and job output provides a bounded tail of recent output.

`Follow-up requested` records notification submission to Pi. Open Monitor response records to inspect associated assistant replies. If submission fails, check `/remote activity` and use `/remote resume` to retry.

The session stores Activity history, pending events and tool arguments. `persist` controls storage of watch and schedule configuration. Use credentials already configured on the target and review session content before sharing it.

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

Choose either legacy `--ssh` or the automation flags when starting Pi. Legacy SSH defaults to tmux jobs on POSIX targets and requires tmux for those jobs. Managed jobs also require Node.js 22 or later and an explicit `/remote deploy-runner` in Pi.

</details>

## License

[MIT](LICENSE)
