# Release notes / 릴리즈 노트

## 1.2.2 — 2026-10-29

### English

- Improve cancellation and owned-process cleanup; retain partial output and diagnostics without reporting failed work as successful.
- Repair interrupted JSONL appends, recover incomplete indexes, preserve deletion records, and enforce one writer per chat store.
- Refuse to reclaim foreign or unknown writer hosts. Chat storage requires a local filesystem with hard-link support; network/shared folders are unsupported.
- Forward repeated launches to the existing instance and move transcript searches to a worker.
- Skip already-published versions while retaining strict release identity checks, and add Windows/macOS package readiness and IPC smoke validation.

### 한국어

- 취소와 소유 프로세스 정리를 개선하고, 실패한 작업을 성공으로 표시하지 않으면서 부분 출력과 진단 정보를 보존합니다.
- 중단된 JSONL 추가 기록과 불완전한 인덱스를 복구하고, 삭제 기록을 보존하며 채팅 저장소의 writer를 하나로 제한합니다.
- 다른 호스트나 소유 호스트를 알 수 없는 잠금은 회수하지 않습니다. 채팅 저장소는 하드 링크를 지원하는 로컬 파일시스템을 사용해야 하며 네트워크·공유 폴더는 지원하지 않습니다.
- 반복 실행을 기존 인스턴스로 전달하고 대화 검색을 worker로 옮겼습니다.
- 이미 공개된 버전은 건너뛰되 실제 발행 대상 검증은 유지하며, Windows·macOS 패키지의 준비 상태와 IPC 확인을 추가했습니다.

## 1.2.1 — 2026-10-28

### English

- Harden the local Codex account-switching proxy against browser-originated and DNS-rebinding requests by validating Host, Origin and Sec-Fetch-Site before forwarding HTTP or WebSocket traffic.
- Preserve native Codex requests, safely close rejected WebSocket connections, and limit repeated rejection logs.

### 한국어

- Codex 계정 전환용 로컬 프록시가 HTTP·WebSocket 요청을 중계하기 전에 Host·Origin·Sec-Fetch-Site를 검사해 웹페이지와 DNS 리바인딩 요청을 제한하도록 했습니다.
- 네이티브 Codex 요청을 유지하고, 거부된 WebSocket 연결을 안전하게 닫으며 반복 거부 로그를 제한합니다.

## 1.1.9 — 2026-10-27

### English

- Add an always-visible update check in Settings, with retry and failure feedback. Explicit checks refresh cached results while coalescing concurrent requests and limiting repeated requests.
- Add confirmed deletion of Codex Live conversations and clean up microphone connections even when active-conversation deletion fails.
- Default new Live conversations to the home folder. The workspace-write permission scope therefore covers the home folder; choose a narrower project folder in Live settings when needed.

### 한국어

- 설정에 항상 표시되는 업데이트 확인 버튼과 재시도·실패 안내를 추가했습니다. 직접 확인하면 캐시를 갱신하며, 동시 요청과 짧은 시간의 반복 요청을 제한합니다.
- 확인 후 Codex Live 대화를 삭제하는 기능을 추가하고, 활성 대화 삭제에 실패해도 마이크 연결을 정리하도록 했습니다.
- 새 Live 대화의 기본 프로젝트 폴더를 홈폴더로 변경했습니다. workspace-write 권한의 쓰기 범위도 홈폴더가 되므로, 더 좁은 범위가 필요하면 Live 설정에서 프로젝트 폴더를 선택하세요.

## 1.1.8 — 2026-10-27

### English

- Add a responsive conversation sidebar to Codex Live and remember each conversation's project folder when switching or continuing conversations.
- Keep late text responses and errors from appearing in a different conversation after switching, without clearing that conversation's input.

### 한국어

- Codex Live에 반응형 대화 사이드바를 추가하고, 대화를 전환하거나 이어갈 때 각 대화의 프로젝트 폴더를 기억하도록 했습니다.
- 대화 전환 후 늦게 도착한 텍스트 응답이나 오류가 다른 대화에 표시되거나 해당 대화의 입력 내용을 지우지 않도록 수정했습니다.

## 1.1.7 — 2026-10-27

### English

- Add workspace selection and configurable agent permission levels to Codex Live, plus saved conversation history and continuation.
- Show complete commands, access paths and requested permissions in approval dialogs, including long requests, while retaining redaction and length limits for error messages.
- Prevent delayed text acknowledgements from writing into a later call, and decline pending approval requests when voice-session startup fails.

### 한국어

- Codex Live에 작업 폴더 선택과 에이전트 권한 단계 설정, 대화 기록 저장 및 이어가기를 추가했습니다.
- 긴 승인 요청에서도 명령·접근 경로·요청 권한 전체를 확인할 수 있게 했습니다. 오류 메시지의 민감정보 가림과 길이 제한은 유지합니다.
- 늦게 도착한 텍스트 전송 응답이 다른 통화 기록에 저장되지 않도록 하고, 음성 연결 시작에 실패하면 대기 중인 승인 요청을 거절하도록 수정했습니다.

## 1.1.6 — 2026-10-27

### English

- Add a tooltip to the settings version label identifying the currently running version.

### 한국어

- 설정의 버전 표시에 현재 실행 중인 버전임을 알려주는 도움말을 추가했습니다.

## 1.1.5 — 2026-10-27

### English

- Fix Windows updates failing before the app restarts, and allow executable replacement and relaunch to finish after shutdown.
- If automatic updates fail in 1.1.3 or 1.1.4, download and run 1.1.5 manually once.

### 한국어

- Windows에서 앱이 재시작되기 전에 업데이트가 실패하던 문제를 수정하고, 종료 후 실행 파일 교체와 재실행이 완료되도록 했습니다.
- 1.1.3 또는 1.1.4에서 자동 업데이트에 실패하면 이번 1.1.5 버전은 한 번 직접 다운로드해 실행해 주세요.

## 1.1.4 — 2026-10-27

### English

- Add Codex Live voice conversations over WebRTC, with microphone mute, captions, text input, and voice selection using the signed-in Codex account.
- Isolate the Live window and restrict its permissions to audio. Keep Codex conversations read-only and release microphone resources when calls end, are cancelled, or the system suspends.
- Apply the shared app theme to chat and settings windows.

### 한국어

- 로그인한 Codex 계정으로 WebRTC 음성 대화를 할 수 있는 Codex Live를 추가했습니다. 마이크 음소거, 자막, 텍스트 입력, 목소리 선택을 지원합니다.
- Live 창을 격리하고 오디오 권한만 허용합니다. Codex 대화는 읽기 전용으로 유지하며, 통화 종료·취소·절전 시 마이크 자원을 해제합니다.
- 채팅과 설정 창에 공통 앱 테마를 적용했습니다.

## 1.1.3 — 2026-10-27

### English

- Add one-click updates for Windows portable builds: verify release checksums, replace the executable at its existing path, restart, and restore the previous version if startup fails. Install this updater-enabled release manually first when upgrading from an older build without the updater.
- Show missing Gemini quota for Antigravity accounts while preserving existing quota summaries when the optional lookup fails.
- Reduce idle filesystem scanning and movement timers, and release hidden UI resources after a grace period.
- Skip native packaging and intermediate artifact uploads for versions that already have a published release. Make native watcher tests cover recovery from missed filesystem notifications.

### 한국어

- Windows 포터블 버전에 원클릭 업데이트를 추가했습니다. 릴리스 체크섬을 검증하고 기존 경로의 실행 파일을 교체해 재시작하며, 시작에 실패하면 이전 버전으로 복구합니다. 자동 업데이트가 없는 이전 빌드에서는 먼저 이번 버전을 직접 다운로드해 설치해 주세요.
- Antigravity 계정에서 빠져 있던 Gemini 잔여량을 보완하고, 추가 조회에 실패해도 기존 할당량 요약을 유지합니다.
- 유휴 상태의 파일 탐색과 이동 타이머를 줄이고, 숨겨진 UI 자원을 일정 시간 후 해제합니다.
- 이미 공개 릴리스가 있는 버전은 네이티브 패키징과 중간 아티팩트 업로드를 생략합니다. 파일 감시 테스트에 알림 누락 후 복구 검증을 추가했습니다.

## 1.1.2 — 2026-10-26

### English

- Keep cookie and JWT redaction linear on repeated long input while covering long cookie names, values beginning with `=`, and JWTs after hyphens.
- Restore curl cookie-option masking and correctly handle brackets inside quoted cookie-array values, including escaped JSON.
- Reduce false positives in code and add regression, persisted-trace, and performance tests for credential masking.

### 한국어

- 반복되는 긴 입력에서도 쿠키·JWT 가림을 선형으로 처리하며, 긴 쿠키 이름·`=`로 시작하는 값·하이픈 뒤 JWT의 가림 범위를 유지합니다.
- curl 쿠키 옵션의 가림을 복원하고, 이스케이프된 JSON을 포함해 쿠키 배열의 문자열 안에 있는 대괄호를 올바르게 처리합니다.
- 코드의 오탐을 줄이고 자격 증명 가림의 회귀·저장된 작업 기록·성능 테스트를 추가했습니다.

## 1.1.1 — 2026-10-26

### English

- Preserve read-only chat sessions and their messages, attachments, and execution history when deletion is requested.
- Match agent mention routing to the Markdown renderer's code-fence boundaries, including inline backticks and LF/CRLF input.
- Harden credential redaction in execution traces, including escaped JSON, cookie values, and additional token formats.
- Avoid counting reused attachment files more than once against the storage quota.

### 한국어

- 읽기 전용 채팅 세션의 삭제를 차단해 메시지·첨부·실행 기록을 보존합니다.
- 코드 펜스와 인라인 백틱, LF/CRLF 입력에서 멘션 호출을 Markdown 렌더러의 표시와 일치시킵니다.
- 실행 기록의 이스케이프된 JSON·쿠키 값·추가 토큰 형식에 대한 자격 증명 가림을 강화합니다.
- 재사용한 첨부 파일을 저장 용량 한도에서 중복 계산하지 않습니다.

## 1.0.14 — 2026-10-24

### English

- Isolate CodePet's Codex runtime from Codex Desktop to prevent active-writer conflicts while preserving each chat participant's conversation across restarts. Existing sessions are copied into the isolated runtime without modifying the originals.
- Open the matching CodePet chat from its notifications, with independent activity indicators for participants working concurrently.
- Show a download icon beside the version in Settings when a newer stable release is available. The icon opens the download for the current platform.
- Preserve the Electron 44.9.3 security baseline and macOS Antigravity account fixes included in the public release.

### 한국어

- CodePet의 Codex 실행 세션을 Codex Desktop과 분리해 동시 접근 충돌을 방지하고, 앱을 다시 시작해도 대화방·참가자별 대화를 이어갑니다. 기존 세션은 원본을 변경하지 않고 분리된 저장소로 복사합니다.
- CodePet 채팅 알림을 누르면 해당 채팅방이 열립니다. 여러 참가자가 동시에 작업할 때도 각자의 작업 알림을 유지합니다.
- 새 정식 버전이 있으면 설정의 버전 정보 옆에 다운로드 아이콘을 표시하고, 현재 운영체제에 맞는 다운로드를 엽니다.
- 공개 배포판의 Electron 44.9.3 보안 업데이트와 macOS Antigravity 계정 수정을 유지했습니다.

## 1.0.13 — 2026-10-22

### English

- Updated Electron to 44.9.3 for Chromium and certificate security fixes.
- Build tooling now uses Node.js 22.23.4. Electron still embeds Node.js 24.22.0; this release does not claim to include every October 21 Node.js fix.

### 한국어

- Chromium 및 인증서 보안 수정을 포함한 Electron 44.9.3으로 업데이트했습니다.
- 빌드 환경에 Node.js 22.23.4를 적용했습니다. Electron 내장 Node.js는 24.22.0이며, 10월 21일 Node.js 보안 수정 전체가 반영된 릴리즈는 아닙니다.

## 1.0.12 — 2026-10-18

### English

- Fixed Space ending chat-name editing.
- Open and switch chats without waiting for CLI discovery, and reduce typing lag during concurrent responses.
- Reflect active chat work in the pet's animation.
- Removed mouse-following behavior and its settings and menu controls.
- Load the font list independently of settings and preview only visible fonts to reduce freezes.
- Resume native CLI sessions per chat and participant across app restarts. Send only newly received messages, and keep trace lookups in the same session.

### 한국어

- 대화방 이름 편집이 스페이스 입력으로 끝나는 문제를 수정했습니다.
- CLI 탐지를 기다리지 않고 대화방을 열고 전환하며, 여러 답변이 출력될 때 입력 지연을 줄였습니다.
- 채팅에서 작업 중인 상태를 펫 모션에 반영합니다.
- 마우스 따라보기 동작과 설정·메뉴 항목을 제거했습니다.
- 글꼴 목록을 설정과 별도로 불러오고 보이는 글꼴만 미리보기해 멈칫하는 현상을 줄였습니다.
- 대화방·참가자별 CLI 세션을 앱 재시작 후에도 이어 씁니다. 새로 받은 대화만 전달하고 작업 기록 조회도 같은 세션에서 이어갑니다.

## 1.0.11 — 2026-10-15

### English

- Added per-chat display names and `@mentions` for all participants, including saved accounts. Original mentions continue to work.
- Fixed agent handoffs running one at a time and cancelled work blocking new messages. Different participants can work concurrently; each participant keeps its own task order.

### 한국어

- 기본·추가 계정 참가자의 표시 이름과 `@호출명`을 대화방별로 변경할 수 있습니다. 기존 호출명도 계속 사용할 수 있습니다.
- 에이전트 간 작업 전달이 한 명씩 실행되거나 중지한 작업이 새 메시지를 막는 문제를 수정했습니다. 다른 참가자는 동시에 작업하며, 같은 참가자의 작업만 순서를 지킵니다.

## 1.0.10 — 2026-10-15

### English

- Removed the two-step agent handoff limit and nine-turn discussion limit. Existing stop and interject controls remain available.
- Enabled follow-up agent calls after group messages, including `@all`.

### 한국어

- 에이전트 간 호출 2단계·토론 9턴 제한을 제거했습니다. 기존 중지·끼어들기는 그대로 사용할 수 있습니다.
- `@모두` 등 단체 메시지 이후에도 에이전트끼리 후속 작업을 전달할 수 있습니다.

## 1.0.9 — 2026-10-15

### English

- Added Claude and Grok accounts as separate chat participants alongside Codex.
- Unified account selection with independent logins, model choices, mentions, and task traces.
- Fixed AGY command approval requests being shown as errors, and prevented sandbox setup failures from offering an unsandboxed retry.
- Fixed Windows sandbox login conflicts between Codex account participants.
- Fixed Claude's PowerShell execution when using the Microsoft Store version of PowerShell.
- Aligned the pet and notification settings.
- Added access to in-progress commands and full tool records, with paged compression instead of trace size limits or automatic expiry.
- Removed the remaining cumulative output limit from Grok's Docker write runs.

### 한국어

- Codex에 이어 Claude·Grok의 저장 계정도 별도 채팅 참가자로 추가할 수 있습니다.
- 계정 선택을 하나로 통합하고 로그인·모델 선택·멘션·작업 기록을 참가자별로 구분합니다.
- AGY 명령 승인 요청이 오류로 표시되는 문제를 수정하고, 샌드박스 초기화 실패 시 격리 해제 재시도를 제안하지 않도록 했습니다.
- 여러 Codex 계정이 참여할 때 Windows 샌드박스 로그인이 충돌하는 문제를 수정했습니다.
- Microsoft Store판 PowerShell을 사용할 때 Claude의 명령 실행이 실패하는 문제를 수정했습니다.
- 펫과 알림 설정의 항목 정렬을 수정했습니다.
- 실행 중 명령과 전체 도구 기록을 조회할 수 있도록 하고, 기록의 용량·보존 기간 제한을 분할 압축 저장으로 대체했습니다.
- Grok의 Docker 쓰기 실행에 남아 있던 누적 출력량 제한을 제거했습니다.

## 1.0.8 — 2026-10-15

### English

- Added Work mode to hide the pet, character avatars, and emotes.
- Deliver group messages to all selected agents at once and show replies as they finish. Discussions retain turn order.
- Added separate Codex account participants with independent mentions, model settings, and task traces, using one CLI installation.
- Applied the existing font-size setting to chat messages and the input.

### 한국어

- 펫과 채팅 캐릭터·이모티콘을 숨기는 회사 모드를 추가했습니다.
- 여러 수신자에게 같은 메시지를 동시에 전달하고 완료 순서대로 답변을 표시합니다. 토론은 기존 순서를 유지합니다.
- CLI 추가 설치 없이 Codex 계정별 참가자·멘션·모델 설정·작업 기록을 구분합니다.
- 기존 글자 크기 설정을 채팅 본문과 입력창에도 적용했습니다.

## 1.0.7 — 2026-10-14

### English

- Restored each agent's original character emoticons.
- Removed bundled model and reasoning lists and automatic overrides. Choices are retrieved from the installed CLI; failed lookups and unsupported saved selections block execution.
- Distinguished missing CLI, required login, and model lookup failures; recheck unavailable agents when returning to the chat.

### 한국어

- 에이전트마다 원래 캐릭터 이모티콘을 사용하도록 복구했습니다.
- 고정 모델·추론 목록과 임의 기본 선택을 제거했습니다. 설치된 CLI에서 선택지를 조회하며, 조회 실패나 지원되지 않는 저장 설정으로는 실행하지 않습니다.
- CLI 미설치·로그인 필요·모델 조회 실패를 구분하고 채팅으로 돌아오면 사용할 수 없던 에이전트를 다시 확인합니다.

## 1.0.6 — 2026-10-14

### English

- Agents can retrieve one another's saved tool activity and results within the same chat, without expanding workspace permissions.
- Trace storage is capped at 64KiB per run, 1MiB per chat, and 16MiB overall, with seven-day retention and credential redaction.
- Fixed agent runs stopping at the default 2 MiB cumulative output limit.
- Chat opens with up to 50 recent messages and loads older history when scrolling upward.
- Preserved the reading position during history loading and incoming replies; added retry for failed history loads.
- Reduced chat memory use and batched streaming display updates.
- Updated the English and Korean guides with current chat features and usage.

### 한국어

- 같은 대화방의 에이전트들이 필요할 때 서로의 도구 실행·결과 기록을 조회합니다. 워크스페이스 권한은 유지합니다.
- 작업 기록을 실행당 64KiB·대화방당 1MiB·전체 16MiB·최대 7일로 제한하고 자격 증명 패턴을 가립니다.
- 누적 출력이 기본 2MiB 제한을 넘으면 에이전트 실행이 중단되던 문제를 수정했습니다.
- 최근 대화를 최대 50개씩 표시하고 위로 스크롤하면 이전 기록을 불러옵니다.
- 이전 기록을 불러오거나 새 답변이 도착해도 읽던 위치를 유지하며, 기록 로딩 실패 시 재시도를 지원합니다.
- 채팅 메모리 사용량과 스트리밍 화면 갱신을 개선했습니다.
- 영어·한국어 사용 안내를 현재 채팅 기능과 사용법에 맞춰 갱신했습니다.
