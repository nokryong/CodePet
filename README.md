# CodePet

**English** | [한국어](README.ko.md)

[Download the latest release](https://github.com/nokryong/CodePet/releases/latest) · [AppImage catalog](https://appimage.github.io/CodePet/)

CodePet is a desktop pet that shows the activity of Codex, Google Antigravity (AGY), Claude Code, and Grok in one place. It watches conversations from all four tools at the same time, displays their activity in speech bubbles, and provides settings for accounts, usage-limit support, bubble colors, and fonts.

It supports Windows, Linux, and macOS. CodePet detects both CLI sessions (Claude Code, Codex CLI, and Grok) and desktop-app sessions. Claude Code sessions created by the Claude desktop app are stored under `~/.claude/projects`, and Codex desktop-app sessions are stored under `~/.codex/sessions`, so the same watchers detect them automatically.

CodePet also uses Codex CLI pet assets directly from `~/.codex/pets`. If you already installed pets in Codex, you can select them in CodePet without additional setup.

## Run from source

```bash
npm install
npm run start
```

To build a distributable package:

```bash
npm run dist            # Current OS (Windows → exe, Linux → AppImage, macOS → dmg)
npm run dist -- --win   # Windows explicitly
npm run dist -- --linux # Linux explicitly
npm run dist -- --mac   # macOS explicitly
```

Windows builds produce `artifacts/CodePet-<version>.exe`, Linux builds produce `CodePet-<version>-<architecture>.AppImage`, and macOS builds produce `CodePet-<version>-mac-universal.dmg` with both Intel and Apple Silicon support. The GitHub Actions `Release` workflow packages each platform on its native Windows, Ubuntu, or macOS runner instead of cross-compiling all three on one system. Builds triggered by a `main` push, a manual run, or a `v*` tag provide a `CodePet-<commit>-all-platforms` artifact containing the `.exe`, `.AppImage`, `.AppImage.zsync`, `.dmg`, and `SHA256SUMS` files. Tagged builds attach the same files to a GitHub Release. Close the app before building locally; an active process can keep package files locked.

GitHub Release AppImages are repacked with the current statically linked type-2 runtime, so the system does not need `libfuse2`. Each AppImage embeds update information for the latest stable release in `nokryong/CodePet`, and the release includes the `.zsync` file used by AppImageUpdate. The Electron payload requires `glibc 2.25` or newer. In a container or restricted environment where FUSE mounting is unavailable, run `./CodePet-<version>-x86_64.AppImage --appimage-extract-and-run`.

### Repository and package scope

- The repository contains runtime source (`src`), regression tests (`test`), three-platform automation (`.github/workflows`), build scripts, and the icons used by the app.
- `node_modules`, `artifacts`, logs, caches, temporary QA images, local settings, and credentials are excluded through `.gitignore`.
- Desktop packages contain the runtime files from `src`, app icons, and a minimal `package.json`. Development-only files such as `test`, `scripts`, `.github`, and README files, along with nested Electron dependencies, are not included.
- The npm package includes the runtime source, the `code-pet` launcher, and runtime icons. The root `README.md`, `LICENSE`, and `package.json` files that npm adds for package identification and license disclosure remain included.

On Linux, AGY credential storage requires Secret Service and `secret-tool`. Debian and Ubuntu provide it through the `libsecret-tools` package. Auto-start uses an XDG autostart entry, and installed fonts are read through fontconfig (`fc-list`).

Using Grok workspace read or write access on Linux requires the current user to run `docker info` without `sudo`. If only the Docker CLI is installed or the user cannot access the daemon socket, CodePet marks this mode unavailable.

Electron cannot control absolute window positions natively under Linux Wayland. When an XWayland `DISPLAY` is available, CodePet automatically launches only the pet window through the X11 backend to preserve always-on-top behavior and automatic movement. Explicit user settings through `--ozone-platform` or `ELECTRON_OZONE_PLATFORM_HINT` take precedence.

To enable DevTools:

```powershell
$env:PET_DEVTOOLS="1"
npm run dev
```

## What CodePet does

### Usage limits

Double-click the pet to open the `한도` (Limits) page in Settings. Cards show current account limits for Codex, AGY, and Claude, plus whether Grok usage lookup is supported. Account switching is kept outside the cards. Grok CLI 1.0.0 does not expose an account-limit command, so CodePet reports it as unsupported. Codex does not assume a fixed five-hour cycle; it reads the actual server-provided periods and dynamically shows five-hour, weekly, monthly, and model-specific limits. Gauges turn yellow above 70% usage and red above 90%.

When Codex usage exceeds 90%, CodePet shows one warning bubble per reset period.

### Add, switch, and delete accounts

The context menu and system tray provide the same saved-account list and `로그인 / 계정 추가` (Sign in / Add account) action for Codex, AGY, Claude, and Grok. Delete accounts from `설정…` → `계정` (Settings → Accounts).

- **Codex:** Add accounts through isolated login profiles and switch saved authentication data atomically. `Codex 재시작 없는 전환 (프록시)` (switch without restarting Codex) is enabled by default. A local proxy on `127.0.0.1` swaps authentication headers per request, enabling account changes and automatic rotation after a limit is exhausted without restarting Codex. The legacy Codex Desktop restart flow is used only when proxy mode is explicitly disabled from the context menu. Enabling or disabling proxy mode adds or removes one marked `openai_base_url` block at the root of `~/.codex/config.toml`. Codex instances that were already running may need one restart immediately after the first activation. A normal CodePet exit restores the original configuration automatically. If a forced exit leaves Codex unable to connect, start CodePet again to clean the stale marker or remove the `# codepet-codex-proxy` block.
- **AGY:** Save the current credentials from Windows Credential Manager, Linux Secret Service, or macOS Keychain as a profile, record the account email when it can be verified, switch to the selected profile, and restart AGY.
- **Claude:** Save and switch the current Claude credential file together with the email reported by `claude auth status`. Refreshed OAuth tokens with the same email are merged into one account. Existing sessions stay open, and new sessions use the selected account.
- **Grok:** Preserve the current OAuth account from `~/.grok/auth.json` as a profile and switch it atomically. Grok hot-reloads the credential file, so CodePet does not terminate a running CLI; the selected account is used from the next API call. Environment-variable API keys and external authentication are shown as status only and are not copied into profile files.

Profiles are stored under `~/.codepet/codex-switch`, `~/.codepet/antigravity-switch`, `~/.codepet/claude-switch`, and `~/.codepet/grok-switch`. Secret values are not displayed in Settings.

The active account cannot be deleted. Switch to another account first, then delete the saved profile.

### Live activity display

CodePet tails Codex `~/.codex/sessions`, AGY local transcripts, Claude project JSONL files, and Grok `~/.grok/sessions/**/updates.jsonl` to track work across all four tools.

- Starting work or writing a response changes the pet to the review animation. When a Codex rollout contains verified Sol, Terra, or Luna model information, the model appears in the title. Concurrent conversations from all providers are combined in start order, up to five at once, with each conversation shown below its title.
- File changes, commands, tests, and builds use the working animation and show the current state in the bubble.
- Waiting for Codex user input or execution approval uses the waiting animation. Clicking the bubble opens that Codex conversation when the session log contains a structured navigation event.
- Completed work makes the pet hop and displays the last message. Clicking the completion bubble opens the Codex chat.
- Interrupted work makes the pet fall over.

Multiple sessions are tracked independently. Work without a completion event returns to the normal state after provider-specific quiet-time or stale handling.

Choose the bubble privacy level on the `일반` (General) page in Settings.

- **Full content:** Show requests, intermediate messages, filenames, and commands.
- **Status only:** Show states such as working, testing, or waiting for approval.
- **Off:** Disable automatic activity bubbles while keeping pet animations active.

### Agent chat room

Open `에이전트 채팅방…` (Agent chat room) from the context menu or system tray to talk with coding-agent CLIs installed on this computer as if they were in a group chat.

- **Sessions:** Create unlimited sessions from the left sidebar, rename them by double-clicking or using the edit action, move them to trash for 30 days, and switch with one click. Conversations are stored under `~/.code-pet` and restored after an app restart. The first user message becomes the session title automatically.
- **Participation and mentions:** Without a mention, every participating agent responds concurrently. Mentions such as `@codex, @claude` call only those agents. `@모두`, `@all`, and Korean particles attached to mentions are recognized. An `@name` in an agent response can call that agent for real, with a default two-step continuation limit per user message to prevent infinite loops. Mentions inside code blocks, inline code, and email addresses do not trigger calls.
- **Discussion:** Participants speak one turn at a time and distinguish new contributions, agreement, passing, and a final conclusion. Discussion stops early when everyone agrees or passes, or when a conclusion is reached. Otherwise it stops at the total execution budget, which defaults to nine turns.
- **Agent settings:** Participant chips control session participation, the model list exposed by each CLI, speed or reasoning effort, and tool auto-approval. Each response header stores and displays the actual selected model, CLI version, and reasoning effort.
- **Rich rendering:** Code blocks with language labels and copy buttons, lists, inline code, bold text, and links are rendered safely. The token-based renderer never inserts raw HTML, so markup from an agent response is not interpreted as a script.
- **Character emotes:** Each agent can choose one context-appropriate character emote per response. The prompt receives an emote dictionary, and the app replaces `[[CODEPET_EMOTE:key]]` markers with images. The manifest under `src/chat-icon/emoticons` controls the mapping, with a maximum of one emote per message. Each of the four character directories accepts only 256×256 RGBA PNG files whose names match the manifest. Markers inside code blocks or inline code are ignored.
- Every response runs in a fresh headless process with conversation history passed in the prompt. Each CLI must already be signed in. Status and partial output appear while the process is running.
- During development, open the chat window directly with `npx electron . --chat`.

Supported CLIs and verified invocation modes:

| Agent | Invocation | Model selection | Speed / effort |
|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json` | Alias and full-name list documented by the installed CLI's `--help` | `--effort` (low–max) |
| Codex CLI | `codex exec --json --ephemeral` | Routing list from app-server `model/list` | Reasoning effort advertised by the selected model |
| Antigravity | `agy --sandbox --output-format stream-json … --print <prompt>` | Actual list from `agy models` | `--effort` (low/medium/high) |
| Grok | `grok --prompt-file … --output-format streaming-messages-json` | Actual list from `grok models` | `--effort` (low/medium/high) |

An unavailable CLI appears as a dimmed participant chip. Clicking it shows installation guidance. The first time the chat opens, `에이전트 환경 진단` (Agent environment diagnostics) checks CLI installation, version, and sign-in status. Later, use `환경 진단` (Environment diagnostics) or `CLI 다시 탐지` (Detect CLIs again) from the sidebar without restarting the app. Codex and Claude use dedicated status commands, Grok checks authentication text from `grok models`, and CLIs without a status command are marked as not automatically verifiable.

#### Workspaces and permissions

Each session has its own workspace folder and permission mode. Workspaces can be chosen only through the operating system's folder picker; arbitrary path strings are not accepted.

- **Chat only (default):** Pure conversation without tools or file access. Claude uses `--tools ""`, Codex uses a read-only sandbox with an empty working directory, AGY uses `--mode plan --sandbox`, and Grok uses a tool allowlist with web access and subagents blocked.
- **Workspace read:** Read and search only within the selected folder. Claude uses `--tools "Read,Grep,Glob"`, Codex uses `--sandbox read-only --cd`, AGY uses `--mode plan --sandbox --add-dir`, and Grok uses a Docker Linux container on Windows and Linux.
- **Workspace write:** Must be enabled explicitly. The defaults are Claude `acceptEdits`, Codex `workspace-write`, and AGY `accept-edits`. Grok modifies only an isolated Docker copy. The user must review changed files and the diff, then choose `전체 적용` (Apply all) before changes reach the original workspace. If an additional permission request is denied, CodePet opens an approval dialog and can rerun that entire turn once with auto-approval after confirmation.

Grok accesses workspaces only through an isolated Docker runner, not through native operating-system file permissions. When a Docker Linux backend is available, CodePet prepares the official `@xai-official/grok@1.0.0` image once. Read mode exposes only the selected project at `/workspace:ro`. Write mode keeps the original at `/workspace-src:ro` and copies up to 64 MiB into a 128 MiB tmpfs for each run, excluding `.git`, `node_modules`, build artifacts, and similar files. Grok receives dedicated read and edit tools; Bash is blocked so it cannot bypass the authentication-file boundary.

After a write container exits, only structured content snapshots for up to 32 files and 1 MiB total, plus display diffs, are returned to the host app. CodePet revalidates original paths, junctions and symlinks, special files, and original hashes. An approval can be used once and expires after 15 minutes. If applying changes fails, CodePet restores from a temporary backup in the same workspace. On Linux, the already authenticated `~/.grok/auth.json` is passed through stdin to a network-disabled preparation container and synchronized to an OS-user-specific `codepet-grok-auth-v1-<hash>` volume, so a separate Docker login is unnecessary. Existing Docker-specific login behavior remains available on Windows. The host home directory, other drives, `/mnt/host`, and `docker.sock` are never mounted into a work container. Remote Docker contexts are rejected before credentials or workspace content are sent. Grok's Linux `bubblewrap` deny rules hide the authentication volume from work tools. The work container disables only Docker's default seccomp profile while preserving non-root execution, `cap-drop=ALL`, `no-new-privileges`, a read-only root, and the read-only original mount.

Each agent's **tool auto-approval** can be enabled separately only in workspace-write mode. After a warning is confirmed, CodePet uses that CLI's full-approval flag. Enable it only for folders you trust.

#### Attachments

Attach images and regular files with the ＋ button, drag and drop, or by pasting a screenshot into the chat input. Limits are 20 MiB per file and 200 MiB per session.

- Attachments are copied into the session directory, so deleting the original does not break conversation history. File types are detected by magic bytes, and executable formats are rejected.
- Images are passed directly to Codex with `--image` and to Claude by path when read permission is available. AGY and Grok do not have a verified image-delivery path, so images are not sent to them. Small text attachments within the limit can be inlined for Grok.
- An attachment that could not be delivered is shown as a badge on the corresponding response instead of disappearing silently.

#### `.code-pet` storage and privacy

Chat data is stored under `~/.code-pet` in the home directory. Set `CODE_PET_HOME` to use another location.

```
~/.code-pet/
  config.json                       # App settings and CLI detection cache; no credentials
  sessions/<id>/meta.json           # Session title, workspace, permissions, and agent settings
  sessions/<id>/transcript.jsonl    # Append-only conversation history
  sessions/<id>/attachments/        # Attachment copies named by content hash
  trash/                             # Deleted sessions retained for 30 days
```

- Prompts, responses, workspace paths, and attachment copies are stored **only on the local machine**. CodePet does not send this data anywhere else.
- The chat store never records CLI login tokens or credentials. If account switching is used, copies of provider authentication files are stored locally in permission-restricted `~/.codepet/*-switch` profiles.
- Claude and Codex prompts are passed through stdin. Grok prompts use a permission-restricted temporary file that is deleted when the process exits. AGY 1.1.10 accepts non-interactive prompts only through argv, so a prompt can appear temporarily in the operating system's process list while AGY is responding. CodePet automatically truncates the beginning of very long AGY conversations to stay within the Windows command-line limit.
- Deleting a session moves it to trash, where it is removed after 30 days. Uninstalling the app does not remove `~/.code-pet`; delete the directory manually to erase it completely.
- Writes use a temporary file followed by an atomic rename, so an interrupted process does not corrupt the previous data. Stores created by a newer version open in read-only mode.

#### Antigravity: the IDE and `agy` CLI are separate

The Antigravity **IDE** desktop app does not include the **`agy` CLI** required by Agent chat. CodePet searches both `PATH` and the official installation path (`%LOCALAPPDATA%\agy\bin\agy.exe`), so an installed CLI can be found immediately with `CLI 다시 탐지` even when it is not on `PATH`. When only the IDE is present, the participant chip reports that only the GUI is installed. CodePet never attempts to run the GUI executable as a CLI.

The pet and chat features are published together as one `code-pet` npm package and one desktop distribution. Most of the chat core remains in pure Node modules independent of Electron. The append-only JSONL session layout and permission vocabulary were inspired by the Apache-2.0-licensed design of [openai/codex](https://github.com/openai/codex); no code or assets were copied.

### Appearance

On the `일반` (General) page in Settings, choose the bubble background and text colors directly. The text color applies to model names and activity-state titles as well as the message body. CodePet searches installed system fonts through the Windows registry, Linux fontconfig, or macOS font directories. The selected font and a size from 10 to 20 px are applied to both the preview and live bubbles.

### Change the pet

Choose `펫 바꾸기` (Change pet) from the context menu to switch immediately. The selection persists across launches. Pets appear in this order:

1. `pet/spritesheet.webp` next to the executable, for a custom sprite sheet.
2. Pets installed under `~/.codex/pets`; new Codex pets appear automatically.
3. The built-in default pet.

## Controls

| Action | Result |
|---|---|
| Click | Wave |
| Double-click | Jump and open the Limits page in Settings |
| Drag | Move the window |
| Finish dragging or resizing | Save the current position and size, then restore them within the current display on the next launch |
| Right-click | Open the menu for Settings, accounts, pet selection, animations, movement pause, mouse following, auto-start, hiding, and more |
| System tray | Open Settings, show or hide the pet, manage accounts and pets, or quit completely |
| Click a completion, input-waiting, or approval-waiting bubble | Open the corresponding Codex chat |
| Click any other bubble | Close it |

`숨기기` (Hide) in the context menu hides only the window; the app stays in the system tray. To stop it completely, right-click the tray icon and choose `완전 종료` (Quit completely).

The `이동 일시 정지` (Pause movement) and `마우스 따라가기` (Follow mouse) states are saved in the settings file and persist after restarting the app or computer.

Enable `로그인 시 자동 실행` (Launch at login) from the context menu to start CodePet when you sign in.

## Custom sprite sheets

CodePet follows the Codex pet sprite format and detects both v1 and v2 automatically.

- **v1:** 1536×1872 total, an 8-column × 9-row grid of 192×208 cells.
- **v2:** 1536×2288 total, an 8-column × 11-row grid of 192×208 cells.
- Rows represent states and columns represent frames.

| Row | State | v1 frames | v2 frames |
|---:|---|---:|---:|
| 0 | idle | 6 | 6 |
| 1 | runningRight | 8 | 8 |
| 2 | runningLeft | 8 | 8 |
| 3 | waving | 4 | 4 |
| 4 | jumping | 5 | 5 |
| 5 | failed | 8 | 8 |
| 6 | waiting | 8 | 6 |
| 7 | running | 8 | 6 |
| 8 | review | 8 | 6 |
| 9 | look directions A | — | 8 |
| 10 | look directions B | — | 8 |

Rows 9 and 10 in v2 contain 16 clockwise look directions. CodePet currently plays the standard animations from rows 0 through 8 and recognizes rows 9 and 10 as part of the v2 layout so the sheet is sliced correctly.

When the image has a standard size, CodePet detects the 9-row or 11-row layout from its height. If the image ratio cannot be identified, it falls back to `spriteVersionNumber` in the `pet.json` file beside the image.

Place a compatible `spritesheet.webp` under a `pet/` directory next to the executable. It appears as `커스텀` (Custom) in the menu.

## Code structure

- `src/main.js` — Window management, movement, menus, and speech-bubble control. Values such as movement speed and bubble size are grouped under `MOVEMENT_CONFIG` and `BUBBLE_CONFIG` near the top.
- `src/codex-watcher.js`, `antigravity-watcher.js`, `claude-watcher.js`, `grok-watcher.js` — Watch the four providers' local activity logs.
- `src/codex-account-switcher.js`, `antigravity-account-switcher.js`, `claude-account-switcher.js`, `grok-account-switcher.js` — Save, switch, and delete provider accounts.
- `src/account-submenu.js` — Builds the shared account menu for Codex, AGY, Claude, and Grok.
- `src/codex-usage-label.js` — Generates display labels for Codex server limit periods and model scopes.
- `src/provider-usage.js` — Retrieves and normalizes AGY and Claude limits. Grok does not expose limit lookup in its CLI, so Settings shows support status only.
- `src/settings.html` / `settings.js` — Settings, Accounts, and Limits pages.
- `src/providers/provider-capabilities.js` — Detects and validates provider CLIs and exposes models, effort levels, and permission capabilities shared by the pet and chat.
- `src/providers/provider-diagnostics.js` — Defines the installation and sign-in diagnostic contract shared by the GUI and `code-pet doctor`.
- `src/chat/` — Agent chat core: mention parsing, group-chat prompts, invocation arguments, CLI execution, event normalization, session storage, attachments, emotes, and room orchestration. Everything except `chat-window.js` and `chat-ipc.js` is independent of Electron.
- `src/chat.html` / `chat.js` / `chat-markdown.js` — Agent chat window and safe rich-text renderer.
- `bin/code-pet.js` — Launcher. Run `code-pet doctor` to check CLI status without printing credentials.
- `src/renderer.js` — Sprite animation playback. State definitions live in `PET_STATES`.
- `src/bubble.html` / `bubble.js` — Unified activity speech bubble.
