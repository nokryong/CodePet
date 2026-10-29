# CodePet

**English** | [한국어](README.ko.md)

[Download](https://github.com/nokryong/CodePet/releases/latest) · [Release notes](CHANGELOG.md) · [AppImage catalog](https://appimage.github.io/CodePet/)

A desktop pet for Codex, Antigravity (AGY), Claude Code, and Grok. Follow agent activity, check remaining usage limits, switch accounts, and talk to installed agents in a shared chat room.

Supports Windows, Linux, and macOS.

## Getting started

Download the package for your platform: `.exe` for Windows, `.AppImage` for Linux, or the universal `.dmg` for Intel and Apple Silicon Macs.

Right-click the pet or tray icon to open Settings, manage accounts, or launch **Agent chat room** (`에이전트 채팅방…`).

On Windows portable builds, the update button in Settings downloads and applies the new version, then restarts CodePet. On Linux and macOS, the same button opens the new version's download.

## Features

- **Live activity:** Speech bubbles and animations show work, tool use, waiting, completion, and interruptions across supported CLI and desktop sessions. Choose full message content, status only, or no bubbles.
- **Usage limits:** View available remaining limits and reset times for the current account. On Windows, a compact display sits beside the notification area in the primary horizontal taskbar. Click it or the tray icon for details. Readings refresh every minute; unavailable or stale data is labeled.
- **Accounts:** Add and switch Codex, AGY, Claude, and Grok accounts from the pet menu or tray. Delete saved accounts in Settings.
- **Appearance:** Choose a pet, bubble colors, system font, and text size. Movement, position, and size are saved between launches.
- **Launch at login:** Enable it from the context menu.

Grok account-limit lookup is currently unavailable in the supported CLI.

## Agent chat room

Install and sign in to the CLIs you want to use: `codex`, `claude`, `agy`, or `grok`. Use **Environment diagnostics** or **Detect CLIs again** in the sidebar if an agent is unavailable.

**Antigravity: the IDE and `agy` CLI are separate.** Agent chat requires the CLI even if the IDE is installed.

- **Sessions:** Create, rename, and switch conversations; search message contents; export a complete session as Markdown. Deleted sessions remain in trash for 30 days.
- **Codex continuity:** Chat keeps its own persistent Codex sessions, separate from Codex Desktop, and resumes them across turns and restarts. Existing linked histories are copied on first use; originals remain untouched. Chat notifications open the corresponding CodePet conversation.
- **History:** Open the latest messages first, up to 50 at a time. New messages appear at the bottom; scroll upward to load older messages while keeping your reading position.
- **Shared traces:** Agents can look up another participant's commands, tool inputs, results, and errors in the same chat, including work in progress. Records are compressed and read in pages, without size-based truncation or automatic expiry. Available detail depends on the CLI.
- **Mentions:** Send without a mention, or use `@all` / `@모두`, to deliver the same message to all participants at once. Replies appear as each finishes. Use `@codex`, `@claude`, `@agy`, or `@grok` to choose recipients. Agents can hand off work to multiple participants concurrently; only work for the same participant waits its turn. There is no handoff count limit.
- **Turn control:** View active participants and queued turns, cancel individual turns, interject, or stop responses.
- **Multiple accounts:** Save Codex, Claude, or Grok accounts in Settings, then choose **Add account** (`계정 추가`) in the chat. Available accounts appear as `email(agent)(plan)`. Each participant has its own mention, model, reasoning setting, and task traces. One CLI installation per service is enough. Default participants use the currently active account; disable them if that duplicates a saved participant.
- **Appearance:** The existing font-size setting also applies to chat messages and the input. Enable **Work mode** (`회사 모드`) in Settings to hide the pet, character avatars, and emotes; open chat from the tray.
- **Discussion:** Agents take turns until they agree or conclude, without a turn limit. Use Stop or Interject to end the discussion.
- **Per-agent settings:** Choose participation, model, reasoning effort, and tool auto-approval from each participant chip. You can also change the display name and `@mention` for each chat. Original mentions still work. Model and reasoning choices come from the installed CLI; agents cannot run if their model list cannot be retrieved. Unspecified settings follow the CLI configuration.
- **Messages:** Live partial responses, quote replies, code blocks with copy buttons, formatted text, links, and character emotes.

### Workspaces and permissions

Choose a folder and permission mode for each session.

| Mode | Use |
|---|---|
| Chat only | Default conversation mode without a selected project folder. |
| Workspace read | Read and search project files. |
| Workspace write | Allow project edits. Additional tool permissions may require approval. |

Grok workspace access requires a local Docker Linux backend on Windows or Linux. Write mode edits an isolated copy; review the changes and choose **Apply all** to update the original files. On Linux, the current user must be able to run `docker info` without `sudo`.

Tool auto-approval is optional, configured per agent, and available only in workspace-write mode. Enable it only for trusted folders.

### Attachments

Use **＋**, drag and drop, or paste a screenshot. Limits are **20 MiB per file** and **200 MiB per session**.

Attachments are copied into the session. Images can be delivered to Codex and, with read permission, Claude. AGY and Grok image delivery is not supported; undelivered attachments are marked on the response. Executable files are rejected.

## Live voice conversation

Right-click the pet or tray icon and choose **Live 음성 대화…**. Sign in to the installed Codex CLI with a ChatGPT account, then press Start in Live. Use the microphone button to mute, type into the message box during a call, or end the call with the stop button. Closing the window also releases the microphone.

- **Conversations:** Select a conversation in the left sidebar to view its saved messages and continue it, or choose **새 대화** to start a new one. In narrow windows, use the menu button to open the sidebar.
- **Projects:** Each conversation keeps its own project folder. New conversations default to your user home directory, such as `C:\Users\<username>` on Windows. Click the project path above the conversation to open settings and choose another folder.
- **Permissions:** Choose **승인 요청** to request approval for untrusted commands and additional access, **나 대신 승인** to allow ordinary workspace operations and request approval for extra access, or **전체 권한** for unrestricted file and network access. Approval requests appear inside Live. Changing permissions reconnects the call.
- **Delete:** Click **×** beside a conversation and confirm to delete its saved messages and dedicated Codex thread. Deleting an active conversation also ends its call.

Conversation models and voices are loaded from the signed-in Codex runtime. Refresh the list in voice settings after ending a call. The voice model uses the server default; its name is shown only when the connection supplies it. Codex currently exposes no selectable language catalog, so Live follows the language you speak.

Live shares the Settings and agent-chat theme. Its window can be resized, with the character capped at 200 pixels. Work mode replaces the character with an animated orb. Live keeps its Codex conversation separate from other chats and offers permission levels and approval prompts in its settings.

## Account switching

| Service | Behavior |
|---|---|
| Codex | Switch accounts without restarting through the local proxy, enabled by default. The first activation may require restarting an already-open Codex instance. |
| AGY | Switch the saved account and restart Antigravity. |
| Claude | New sessions use the selected account; existing sessions stay open. |
| Grok | The selected OAuth account is used from the next API call. API keys are not saved as account profiles. |

Switch away from the active account before deleting its saved profile. If Codex cannot connect after CodePet was forcibly closed, restart CodePet to restore the proxy configuration.

Linux AGY account storage requires Secret Service and `secret-tool` (`libsecret-tools` on Debian/Ubuntu).

## Controls

| Action | Result |
|---|---|
| Click the pet | Wave |
| Double-click | Open usage limits in Settings |
| Drag | Move the pet |
| Right-click the pet or tray icon | Open the menu |
| Click the taskbar display or tray icon | View remaining limits |
| Click a supported Codex completion or waiting bubble | Open that conversation |

**Hide** leaves CodePet running in the tray. Use **Quit completely** to exit.

## Pets

Choose **Change pet** from the context menu. CodePet includes a default pet and detects pets in `~/.codex/pets`.

For a custom pet, place `spritesheet.webp` in a `pet/` folder beside the executable. Supported layouts use 192×208 cells in eight columns:

- **v1:** 1536×1872, nine rows.
- **v2:** 1536×2288, eleven rows; standard animations use rows 0–8.

## Data and privacy

Agent-chat conversations, attachment copies, and local task traces are stored in `~/.code-pet`. Set `CODE_PET_HOME` to change the location. Uninstalling the app leaves this folder in place. Deleting a chat also removes its traces.

Use a local folder on a filesystem that supports hard links for the chat store. Network/shared folders are not supported: writer recovery uses local process IDs and hostnames, which cannot reliably distinguish machines with duplicate names or separate PID namespaces. A lock belonging to another or unknown host is left intact; verify that no writer is active before attempting recovery. Do not remove a lock while another instance is using the store.

In agent chats, each participant resumes its native CLI session within the same chat, including after an app restart. Changing the account, working directory, permissions, model, or reasoning setting starts a new session. Saved-account participants use their own profile; deleting an agent chat does not delete native CLI history.

Live stores completed voice transcripts, typed messages, and its dedicated Codex sessions separately under `~/.codepet/live`, with history separated by account. Select a saved conversation in Live to continue after reopening the app. Earlier voice conversations may have no transcript if it was not recorded. Deleting a Live conversation removes its local message contents and its dedicated Codex thread.

CodePet does not copy CLI credentials into chat storage and redacts recognized credential patterns from task traces. Saved account profiles are stored separately under `~/.codepet/*-switch`.

Conversation context, supported attachments, and requested trace excerpts are passed to the selected agent CLI for processing by its provider. AGY prompts can temporarily appear in the operating system's process list while a response is running.

## Run from source

```bash
npm install
npm start
npm test
```

Open chat directly with `npx electron . --chat`, or check CLI setup with `node bin/code-pet.js doctor`.

Build for the current OS with `npm run dist`; only distributable packages are added to `artifacts/`, and temporary build files are removed. Close CodePet before building. The release workflow builds Windows, Linux, and macOS packages and includes checksums.

On Linux without FUSE mounting, run the AppImage with `--appimage-extract-and-run`. Release AppImages include `.zsync` files for AppImageUpdate. Wayland users need XWayland for automatic pet movement; explicit Electron platform settings take precedence.
