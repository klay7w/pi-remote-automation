# pi-remote-automation

在 Pi 中监视本机或 SSH 目标上的任务，在条件满足时接收更新。在同一会话中设置提醒、等待结果文件、查看后台作业。

监视和定时任务需要 Pi 会话保持运行。新建和恢复的会话初始都处于暂停状态。

[English](README.md) | 简体中文

[快速开始](#快速开始) · [使用示例](#使用示例) · [SSH 配置](#ssh-配置) · [查看和控制监视](#查看和控制监视) · [工具](#工具) · [会话和通知](#会话和通知)

本机 10 秒提醒，包含 Monitor 处理标记和 Activity 常驻栏：

![Pi 中的本机会话和 10 秒提醒](docs/assets/remote-automation-local.png)

## 快速开始

在 Windows、Linux 或 macOS 上安装 Node.js 22 或更高版本、支持包管理的 Pi 和 Git。在终端中运行：

```bash
pi install git:github.com/klay7w/pi-remote-automation
```

重启 Pi，或在已有会话中运行 `/reload`。安装默认使用个人设置，添加 `-l` 可使用项目设置。Pi 仅在项目获得信任后加载项目包。运行 `pi list` 查看包，运行 `pi remove <source>` 移除包。

<details class="orca-details">
<summary>从本地检出目录安装，用于源码开发</summary>

克隆仓库后，使用检出目录的绝对路径运行 `pi install "/absolute/path/to/pi-remote-automation"`。Pi 直接从该目录加载包。

</details>

在终端中进入项目目录并启动 Pi：

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

pi-remote-automation 默认使用本机和 Pi 的当前目录。如需使用其他本地目录，启动 Pi 时运行 `pi --automation-target local --automation-cwd <absolute-project-path>`。

在 Pi 中运行 `/remote resume`，然后输入：

> 用 remote_schedule 在 10 秒后提醒我检查这个项目。

约 10 秒后，Pi 应收到一条提醒更新。在 Pi 中运行 `/remote activity` 查看活动。等待时请保持会话运行。

## 使用示例

在 Pi 中输入以下提示：

- 每 30 秒检查一次 `result.json` 是否出现，出现后通知我一次。
- 10 秒后提醒我检查这个项目。
- 启动我指定的后台作业，然后查看其状态和输出。

文件检查使用在所选目标上运行的自定义 JSON 探针。探针和作业命令使用目标用户的权限执行。执行前请检查 Pi 提出的命令。

## SSH 配置

在本机安装 OpenSSH 客户端，在目标上安装 Node.js 22 或更高版本。配置 SSH 别名，使用非交互式认证，并在 `known_hosts` 中保存已验证的主机密钥。在终端中启动 Pi，指定目标的绝对目录和平台：

```bash
# POSIX 目标，使用 sh 登录
pi --automation-target ssh:lab --automation-cwd /srv/project --automation-platform posix
```

```powershell
# Windows 目标，使用 PowerShell 登录
pi --automation-target ssh:lab --automation-cwd C:/work/project --automation-platform win32
```

在 Pi 中运行 `/remote doctor`，然后显式运行 `/remote deploy-runner` 和 `/remote resume`。部署会将随包提供的 runner 复制到 SSH 用户的状态目录。这些参数为自动化工具选择执行目标。设置 `--automation-target ssh:lab` 后，自动化命令在 `lab` 上执行。

## 查看和控制监视

Activity 常驻栏最多显示三个活跃或未读的监视源，出错的监视源排在最前，其次是未读更新。打开 `/remote activity` 可查看完整列表、检查时间、观测结果和通知提交状态。

在 `/remote` 后输入空格可查看子命令建议。在 `/remote activity` 后输入空格可查看 `hide`、`show` 和 `clear`。


| 命令                                                   | 操作                                                  |
| ---------------------------------------------------- | --------------------------------------------------- |
| `/remote` 或 `/remote menu`                           | 打开 Remote 菜单。选择 Activity 可查看活动、设置常驻栏显示或标记更新为已读。在 Activity 子菜单按 Esc 返回 Remote 主菜单。 |
| `/remote activity`                                   | 打开 Activity，按 `r` 查看 Monitor 响应记录。                  |
| `/remote model`                                      | 为当前会话选择事件响应模型，或恢复默认设置 **Follow main model**（跟随主模型）。 |
| `/remote status`                                     | 打开 Activity 概览。                                     |
| `/remote jobs`、`/remote watches`、`/remote schedules` | 按监视源类型查看 Activity。                                  |
| `/remote activity hide` 或 `/remote activity show`    | `hide` 隐藏常驻栏，`show` 恢复自动显示。                                           |
| `/remote activity clear`                             | 将所有 Activity 更新标记为已查看，保留注册和历史。                      |
| `/remote doctor`                                     | 检查目标能力。                                             |
| `/remote pause` 或 `/remote resume`                   | 暂停或恢复检查与通知提交。                                       |
| `/remote clear`                                      | 移除监视注册并清空 Activity 历史。                              |


暂停监视期间，作业继续运行。连续三次探针出错后，监视会被禁用。重新创建该监视即可重试。

### 选择事件响应模型

默认情况下，监视通知会等到主助手空闲后再发给它。要让其他模型单独回复通知，打开 `/remote model`，选择一个 `provider/model` 条目。如果你在 Pi 中限定了模型范围，列表会先显示范围内的模型。选择 `Show all available models` 可查看全部可用模型。Pi 会为当前会话保存这项选择。要恢复默认设置，选择 `Follow main model`。

所选模型只能看到事件详情，不能调用工具，也看不到聊天记录。即使主助手正忙，它也可以回复。对话和 Monitor 响应记录详情都会显示模型名称，并按 Markdown 格式显示回复正文。主助手不会因此开始新一轮对话。只记入 Activity 的更新不会调用任何模型。

如果所选模型未能回复，监视会暂停，待处理事件会保留。检查该模型是否可用、凭据是否有效，或改选其他模型，然后运行 `/remote resume` 重试。监视不会自动切换模型。

### Monitor 响应记录

记录详情展示通知及其关联的助手文本：

![Pi Monitor 响应详情中的关联通知和助手文本](docs/assets/remote-automation-response.png)

在 `/remote activity` 中按 `r`，可查看当前对话分支的响应记录，最新记录排在最前。用上下方向键选择记录，按 Enter 查看详情。按 Esc 依次返回记录列表、Activity 和对话。查看器显示打开 Activity 时的快照，需要重新打开才能查看新记录。

在跟随主模型模式下，每条记录包含通知、事件时间，以及通过明确消息 ID 关联的已保存助手文本。记录描述助手对通知的响应过程。作业状态可通过 `remote_job` 查看。


| 响应状态                               | 含义                   |
| ---------------------------------- | -------------------- |
| `response ended`                   | 助手已完成对通知的处理。         |
| `interrupted`                      | 处理提前中断。              |
| `user handover / source uncertain` | 用户输入或其他消息使响应来源变得不确定。 |
| `incomplete / unknown`             | 记录缺少结束标记。            |


对话中会为关联响应显示 Monitor 处理标记。已保存且关联明确的助手消息在渲染时带有 `Monitor-triggered response` 标签。

### 清空监视

用 `/remote clear` 移除当前会话的监视、定时任务、作业监视注册、尚未提交的事件和 Activity 历史。该命令保存空状态、暂停监视，并在查看器中隐藏较早的 Monitor 响应记录。再次监视时需要创建新的注册。对应的工具调用是 `remote_control`，参数为 `action: "clear"`。

运行中的作业、目标文件和对话文本保持原状。清空还会移除作业的本地所有权记录，重新附加这些作业后只能观察。

用 `/remote activity clear` 将更新标记为已查看，同时保留注册和历史。

## 工具


| 工具                | 用途                          |
| ----------------- | --------------------------- |
| `remote_watch`    | 运行 JSON 探针，监视匹配的状态。         |
| `remote_schedule` | 一次或定期发送提醒、执行检查。             |
| `remote_job`      | 启动或附加作业，查看状态或输出，或取消有所有权的作业。 |
| `remote_control`  | 查看可用能力并控制监视。                |


## 会话和通知

创建监视或定时任务时设置 `persist: true`，可以在同一会话和目标中恢复其配置。恢复后监视处于暂停状态，使用 `/remote resume` 从当前时间继续检查。托管作业在 Pi 退出后仍可继续运行，作业输出提供最近的有限末尾内容。

`Follow-up requested` 表示已向 Pi 提交请求，`Model responded` 表示所选的事件响应模型已回复。打开 Monitor 响应记录可查看关联的助手回复。提交失败时，查看 `/remote activity` 并使用 `/remote resume` 重试。

会话保存 Activity 历史、待处理事件和工具参数。`persist` 控制监视和定时任务配置的保存。凭据使用目标上已有的配置，分享会话前请检查其内容。

<details>
<summary>让编码助手安装</summary>

替换占位内容，然后将其中一段提示发给编码助手。

本机：

```text
请安装这个 Pi 插件：<仓库 URL 或本地目录>。
在 <项目目录> 中配置本地使用，检查插件是否加载成功，
并告诉我如何创建一条 10 秒后的提醒。
```

SSH：

```text
请安装这个 Pi 插件：<仓库 URL 或本地目录>。
通过 <SSH 别名> 为 <项目绝对路径> 配置自动化，
目标系统是 <Windows/Linux/macOS>。请检查连接、部署 runner，
并给我一条可以直接使用的 Pi 启动命令。
```

</details>

<details class="orca-details">
<summary>旧版 SSH 集成</summary>

Pi 官方另有一个 SSH 示例扩展，也会重定向普通 Pi 工具，要求目标上有 `bash`。请将路径替换为 Pi 的 `examples/extensions/ssh.ts` 实际路径。在终端中运行：

```bash
pi install "/absolute/path/to/pi-coding-agent/examples/extensions/ssh.ts"
pi --ssh lab:/srv/project
```

启动 Pi 时，在旧版 `--ssh` 和自动化参数之间选择一种配置方式。旧版 SSH 在 POSIX 目标上默认使用 tmux 作业，这类作业需要 tmux。托管作业还需要 Node.js 22 或更高版本，并需在 Pi 中显式运行 `/remote deploy-runner`。

</details>

## 许可证

[MIT](LICENSE)