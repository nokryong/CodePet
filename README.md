# CodePet

Codex, Google Antigravity(AGY), Claude Code, Grok의 작업 상태를 한곳에서 보여 주는 데스크톱 펫입니다. 네 프로그램의 대화를 동시에 감지해 말풍선으로 표시하고, 설정 창에서 계정·한도 지원 상태·말풍선 색상·글꼴을 관리합니다.

Windows, Linux, macOS를 지원합니다. CLI 세션(Claude Code, Codex CLI, Grok)뿐 아니라 데스크톱 앱 세션도 감지합니다 — Claude 데스크톱 앱의 Claude Code 세션은 `~/.claude/projects`에, Codex 데스크톱 앱 세션은 `~/.codex/sessions`에 기록되므로 같은 감시 경로로 함께 잡힙니다.

Codex CLI의 펫 에셋(`~/.codex/pets`)을 그대로 가져다 쓰기 때문에, Codex에서 펫을 설치해뒀다면 별도 설정 없이 바로 골라 쓸 수 있습니다.

## 실행

```bash
npm install
npm run start
```

실행 파일로 뽑으려면:

```bash
npm run dist          # 현재 OS용 (Windows → exe, Linux → AppImage, macOS → dmg)
npm run dist -- --win # Windows용 명시
npm run dist -- --linux # Linux용 명시
npm run dist -- --mac # macOS용 명시
```

Windows에서는 `artifacts/CodePet-<버전>.exe`, Linux에서는 `CodePet-<버전>-linux-<아키텍처>.AppImage`, macOS에서는 Intel과 Apple Silicon을 모두 지원하는 `CodePet-<버전>-mac-universal.dmg`가 나옵니다. 한 운영체제에서 세 플랫폼을 교차 빌드하지 않고, GitHub Actions의 `Release` 워크플로가 Windows·Ubuntu·macOS 네이티브 러너에서 각각 패키징합니다. `main` 푸시, 수동 실행, 태그(`v*`) 빌드가 끝나면 `.exe`, `.AppImage`, `.dmg`, `SHA256SUMS`를 합친 `CodePet-<커밋>-all-platforms` 아티팩트를 내려받을 수 있고, 태그 빌드는 같은 세 패키지를 GitHub Release에도 첨부합니다. 로컬 빌드는 앱을 끈 상태에서 돌려야 합니다(실행 중이면 파일 잠금 때문에 실패).

### 저장소와 배포 파일 범위

- 저장소에는 실행 소스(`src`), 회귀 테스트(`test`), 3플랫폼 자동 빌드(`.github/workflows`), 빌드 스크립트와 실제 사용 아이콘만 둡니다.
- `node_modules`, `artifacts`, 로그, 캐시, 임시 QA 이미지, 로컬 설정과 자격 증명은 `.gitignore`로 제외합니다.
- 데스크톱 배포본에는 `src`의 런타임 파일과 앱 아이콘, 최소 `package.json`만 넣습니다. `test`, `scripts`, `.github`, README 같은 개발 파일과 중첩 Electron 의존성은 포함하지 않습니다.
- npm 패키지에는 실행 소스, `code-pet` 실행 도우미, 런타임 아이콘만 추가합니다. npm이 패키지 식별과 라이선스 고지를 위해 자동으로 넣는 루트 `README.md`, `LICENSE`, `package.json`은 유지합니다.

Linux에서 AGY 계정 자격 증명 저장을 사용하려면 Secret Service와 `secret-tool`이 필요합니다. Debian/Ubuntu 계열에서는 `libsecret-tools` 패키지가 이를 제공합니다. 자동 시작은 XDG autostart 항목으로 등록되고, 설치 글꼴은 fontconfig(`fc-list`)에서 읽습니다.

Linux에서 Grok 워크스페이스 읽기·쓰기를 사용하려면 현재 사용자가 `docker info`를 `sudo` 없이 실행할 수 있어야 합니다. Docker CLI만 설치되어 있거나 daemon 소켓 권한이 없으면 CodePet은 이 모드를 사용 불가로 표시합니다.

Linux Wayland에서는 Electron의 창 절대 위치 제어가 지원되지 않으므로, XWayland `DISPLAY`가 있으면 CodePet이 펫 창만 X11 백엔드로 자동 실행해 항상 위와 자동 이동을 유지합니다. `--ozone-platform` 또는 `ELECTRON_OZONE_PLATFORM_HINT`를 사용자가 명시하면 그 설정을 우선합니다.

DevTools가 필요하면 이렇게 켜세요.

```powershell
$env:PET_DEVTOOLS="1"
npm run dev
```

## 뭘 하는 앱인가

### 사용량 확인

펫을 더블클릭하면 설정의 `한도` 화면이 열립니다. Codex, AGY, Claude의 현재 계정 한도와 Grok의 조회 지원 상태를 카드로 함께 표시하며 계정 전환 기능은 카드에 넣지 않습니다. Grok CLI 1.0.0은 계정 한도 조회 명령을 제공하지 않아 지원 불가로 명시합니다. Codex는 고정된 5시간 주기로 추정하지 않고 서버가 보내는 실제 기간을 읽어 5시간·주간·월간 한도와 모델별 추가 한도를 동적으로 표시합니다. 사용률이 70%를 넘으면 게이지가 노란색, 90%를 넘으면 빨간색이 됩니다.

Codex 사용률이 90%를 넘으면 초기화 주기당 한 번 경고 말풍선을 표시합니다.

### 계정 추가/전환/삭제

우클릭 메뉴와 시스템 트레이에서 Codex, AGY, Claude, Grok 모두 같은 형태의 저장 계정 목록과 `로그인 / 계정 추가` 항목을 제공합니다. 계정 삭제는 `설정…` → `계정`에서 할 수 있습니다.

- Codex: 별도 로그인 프로필에서 새 계정을 추가하고 저장된 인증 정보를 원자적으로 전환합니다. "Codex 재시작 없는 전환 (프록시)"는 기본으로 켜지며, 로컬 프록시(127.0.0.1)가 요청 단위로 계정 인증 헤더를 갈아끼워 계정 전환과 한도 소진 시 자동 로테이션을 재시작 없이 적용합니다. 우클릭 메뉴에서 프록시 모드를 명시적으로 끈 경우에만 기존의 Codex Desktop 재시작 방식으로 전환합니다. 프록시 모드를 켜고 끌 때 `~/.codex/config.toml` 루트에 `openai_base_url` 한 줄을 넣고 빼며(마커 주석으로 관리), 최초 활성화 직후 이미 실행 중이던 Codex에는 한 번의 재시작이 필요할 수 있습니다. 정상 종료 시 자동으로 원복되고, 강제 종료 뒤 Codex 연결이 막히면 CodePet을 다시 실행해 stale 마커를 정리하거나 `# codepet-codex-proxy` 블록을 제거하면 됩니다.
- AGY: 현재 자격 증명(Windows 자격 증명 관리자 / Linux Secret Service / macOS Keychain)을 프로필로 저장하고, 확인 가능한 계정 이메일을 함께 기록한 뒤 선택한 계정으로 바꾸고 AGY를 다시 시작합니다.
- Claude: 현재 Claude 자격 파일과 `claude auth status`의 이메일을 프로필로 저장하고 전환합니다. OAuth 토큰이 갱신돼도 같은 이메일은 한 계정으로 병합하며, 이미 열린 세션은 유지되고 새 세션부터 선택한 계정을 사용합니다.
- Grok: `~/.grok/auth.json`의 현재 OAuth 계정을 프로필로 보존하고 원자적으로 전환합니다. Grok이 자격 파일을 hot reload하므로 실행 중인 CLI를 강제 종료하지 않으며 다음 API 호출부터 선택한 계정이 적용됩니다. 환경 변수 API 키나 외부 인증은 상태만 표시하고 프로필 파일로 복제하지 않습니다.

프로필 저장소는 `~/.codepet/codex-switch`, `~/.codepet/antigravity-switch`, `~/.codepet/claude-switch`, `~/.codepet/grok-switch`입니다. 설정 화면에는 비밀 값이 노출되지 않습니다.

현재 사용 중인 계정은 삭제할 수 없으며, 다른 계정으로 전환한 뒤 저장된 프로필만 삭제할 수 있습니다.

### 작업 실시간 표시

Codex의 `~/.codex/sessions`, AGY의 로컬 transcript, Claude의 프로젝트 JSONL, Grok의 `~/.grok/sessions/**/updates.jsonl`을 tail해 네 프로그램의 작업을 함께 감지합니다.

- 작업 시작/응답 작성 → 펫이 살펴보기 모션으로 바뀜. Codex rollout에 확인된 Sol/Terra/Luna 모델 정보가 있으면 제목에 표시됩니다. 동시 대화는 공급자를 합쳐 시작 순서대로 최대 5개를 보여 주며, 각 제목 바로 아래에 해당 대화 내용이 표시됩니다.
- 파일 수정, 명령, 테스트, 빌드 → 작업 중 모션과 현재 상태가 말풍선에 표시됨
- Codex 사용자 입력 또는 실행 승인 대기 → 기다리기 모션으로 바뀜. 말풍선을 클릭하면 해당 Codex 대화를 바로 열 수 있음(세션 로그에 구조화 이벤트가 있을 때)
- 작업 완료 → 폴짝 뛰고 마지막 메시지를 표시함. 완료 말풍선을 클릭하면 해당 Codex 채팅으로 이동함
- 작업 중단 → 쓰러짐

세션 여러 개를 동시에 돌려도 각각 추적하고, 완료 이벤트가 없는 작업은 공급자별 quiet-time 또는 stale 처리 뒤 원래 상태로 돌아옵니다.

말풍선 개인정보 수준은 설정의 `일반` 화면에서 선택합니다.

- "전체 내용" — 요청, 중간 메시지, 파일명과 명령을 표시
- "상태만" — 작업 중, 테스트 중, 승인 대기 같은 상태만 표시
- "끄기" — 자동 작업 말풍선만 끔. 펫 모션은 그대로 동작

### 에이전트 채팅방

우클릭 메뉴 또는 시스템 트레이의 "에이전트 채팅방…"에서 이 PC에 설치된 코딩 에이전트 CLI들을 단체 채팅방처럼 불러 대화할 수 있습니다.

- **세션**: 왼쪽 사이드바에서 세션을 무제한 만들고, 이름을 바꾸고(더블클릭 또는 ✎), 휴지통으로 보내고(🗑, 30일 보관 후 정리), 클릭 한 번으로 전환합니다. 모든 대화는 `~/.code-pet`에 저장되어 앱을 재시작해도 그대로 복원됩니다. 첫 사용자 메시지가 자동으로 세션 제목이 됩니다.
- **참여와 멘션**: 멘션 없이 보내면 세션에 참여 중인 모든 에이전트가 동시에 응답합니다. `@codex, @claude`처럼 멘션하면 그 대상만 호출하고, `@모두`/`@all`과 한국어 조사도 인식합니다. 에이전트 답변 속 `@이름`도 해당 에이전트를 실제로 호출하며, 무한 호출을 막기 위해 사용자 발화 기준 기본 2단계까지만 이어집니다. 코드 블록·인라인 코드·이메일 안의 `@`는 호출하지 않습니다.
- **토론**: 참가자들이 한 턴씩 차례로 말하며, 새 기여·동의·패스·최종 결론을 스스로 구분합니다. 전원이 동의/패스하거나 결론이 나오면 일찍 끝나고, 끝나지 않더라도 총 실행 예산(기본 9턴)에서 멈춥니다.
- **에이전트 설정**: 참가자 칩에서 세션별 참여 여부, CLI가 제공하는 모델 목록, 속도/노력, 도구 자동 승인을 고릅니다. 각 답변 헤더에는 실제 선택 모델·CLI 버전·추론 강도가 함께 저장되어 표시됩니다.
- **리치 렌더링**: 답변의 코드 블록(언어 라벨 + 복사 버튼), 목록, 인라인 코드, 굵게, 링크가 안전하게 렌더링됩니다. HTML을 직접 삽입하지 않는 토큰 기반 렌더러라 에이전트 출력에 어떤 마크업이 있어도 스크립트로 해석되지 않습니다.
- **캐릭터 이모티콘**: 에이전트가 답변마다 상황에 맞는 캐릭터 이모티콘을 1개 골라 붙입니다. 프롬프트에 이모티콘 의미 사전이 함께 전달되고, 답변 속 `[[CODEPET_EMOTE:키]]` 표기를 앱이 이미지로 바꿔 보여 줍니다(`src/chat-icon/emoticons`의 매니페스트 기반, 메시지당 최대 1개). 네 캐릭터 폴더는 매니페스트와 같은 이름의 256×256 RGBA PNG만 사용합니다. 코드 블록·인라인 코드 안의 표기는 무시합니다.
- 각 응답은 headless 모드의 새 프로세스로 실행되며(대화 기록을 프롬프트로 전달), 로그인은 각 CLI에 이미 되어 있어야 합니다. 실행 중에는 상태/부분 출력이 실시간으로 표시됩니다.
- 개발 중에는 `npx electron . --chat`으로 채팅 창을 바로 열 수 있습니다.

지원 CLI와 실행 방식(검증된 플래그만 사용):

| 에이전트 | 실행 | 모델 선택 | 속도/노력 |
|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json` | 설치된 CLI `--help`가 안내하는 alias/full-name 목록 | `--effort` (low~max) |
| Codex CLI | `codex exec --json --ephemeral` | `app-server`의 `model/list` 라우팅 목록 | 선택 모델이 광고하는 reasoning effort |
| Antigravity | `agy --sandbox --output-format stream-json … --print <prompt>` | `agy models`의 실제 목록 | `--effort` (low/medium/high) |
| Grok | `grok --prompt-file … --output-format streaming-messages-json` | `grok models`의 실제 목록 | `--effort` (low/medium/high) |

설치되지 않은 CLI는 참가자 칩이 흐리게 표시되고, 칩을 클릭하면 설치 안내가 나옵니다. 채팅을 처음 열면 "에이전트 환경 진단"이 한 번 표시되어 CLI 설치·버전·로그인 상태를 확인합니다. 이후에는 사이드바의 "환경 진단" 또는 "CLI 다시 탐지"로 앱 재시작 없이 다시 확인할 수 있습니다. Codex와 Claude는 전용 상태 명령으로, Grok은 `grok models`의 인증 문구로 로그인을 확인하며, 상태 명령이 없는 CLI는 "자동 확인 불가"로 구분합니다.

#### 워크스페이스와 권한

세션마다 워크스페이스 폴더와 권한 모드를 정합니다. 폴더는 OS 폴더 선택 대화상자로만 지정할 수 있습니다(경로 문자열을 직접 입력받지 않습니다).

- **대화만 (기본)** — 도구/파일 접근 없이 순수 대화. Claude는 `--tools ""`, Codex는 읽기 전용 샌드박스 + 빈 작업 폴더, agy는 `--mode plan --sandbox`, Grok은 도구 allowlist와 웹·서브에이전트 차단 정책으로 실행됩니다.
- **워크스페이스 읽기** — 선택한 폴더를 읽기/검색만. Claude는 `--tools "Read,Grep,Glob"`, Codex는 `--sandbox read-only --cd`, agy는 `--mode plan --sandbox --add-dir`, Grok은 Windows·Linux의 Docker Linux 컨테이너를 사용합니다.
- **워크스페이스 쓰기** — 명시적으로 켜야 하며, 기본은 Claude `acceptEdits`, Codex `workspace-write` 샌드박스, agy `accept-edits`입니다. Grok은 Docker 내부 복제본만 수정하고, 사용자가 변경 파일과 diff를 확인해 `전체 적용`을 눌러야 원본에 반영됩니다. 추가 권한이 거부되면 CodePet이 승인창을 띄우고, 승인 시 해당 턴 전체를 자동 승인으로 한 번 다시 실행합니다.

Grok은 운영체제의 네이티브 파일 권한 경계 대신 Docker 격리 실행기로만 워크스페이스를 접근합니다. Docker의 Linux 컨테이너 백엔드가 사용 가능하면 CodePet이 공식 `@xai-official/grok@1.0.0` 이미지를 최초 1회 준비합니다. 읽기는 선택한 프로젝트 하나만 `/workspace:ro`로 노출합니다. 쓰기는 원본을 `/workspace-src:ro`로 유지한 채 최대 64MiB를 실행마다 128MiB tmpfs 복제본으로 옮기며, `.git`, `node_modules`, 빌드 산출물 등은 복사하지 않습니다. Grok에는 전용 읽기·편집 도구만 제공하고 인증 파일을 우회해 읽을 수 있는 Bash는 차단합니다.

쓰기 컨테이너가 끝나면 최대 32개·합계 1MiB의 구조화된 내용 스냅숏과 표시용 diff만 호스트 앱에 전달됩니다. 원본 경로·정션/심링크·특수 파일·원본 해시를 앱이 다시 검증하고, 승인은 한 번만 사용할 수 있으며 15분 뒤 만료됩니다. 적용 도중 실패하면 같은 워크스페이스 안의 임시 백업으로 되돌립니다. Linux에서는 이미 로그인된 `~/.grok/auth.json`을 네트워크가 차단된 준비 컨테이너의 stdin으로 전달해 OS 사용자별 전용 `codepet-grok-auth-v1-<hash>` 볼륨에 자동 동기화하므로 별도의 Docker 로그인이 필요 없습니다. Windows에서는 기존 Docker 전용 로그인도 유지합니다. 호스트 홈·다른 드라이브·`/mnt/host`·`docker.sock`은 작업 컨테이너에 마운트하지 않습니다. 원격 Docker context는 인증이나 워크스페이스를 보내기 전에 거부합니다. 인증 볼륨 경로는 Grok의 Linux `bubblewrap` deny 규칙으로 작업 도구에서 숨깁니다. 이를 위해 작업 컨테이너에서는 Docker 기본 seccomp 프로필만 해제하지만 비루트 실행, `cap-drop=ALL`, `no-new-privileges`, 읽기 전용 루트와 원본 마운트는 유지합니다.

각 에이전트의 **도구 자동 승인**은 워크스페이스 쓰기 모드에서만 별도로 켤 수 있으며, 경고 확인 뒤 해당 CLI의 전체 승인 플래그를 사용합니다. 신뢰하는 폴더에서만 사용해야 합니다.

#### 첨부 파일

＋ 버튼 또는 드래그&드롭으로 이미지와 일반 파일을 첨부할 수 있습니다. 채팅 입력창에 스크린샷 이미지를 붙여넣어도 바로 첨부됩니다(파일당 20MiB, 세션당 200MiB).

- 첨부는 세션 폴더로 복사되어 원본을 지워도 대화 기록이 깨지지 않습니다. 형식은 매직 바이트로 판별하고, 실행 파일류는 거부합니다.
- 이미지: Codex는 `--image`로 직접 전달, Claude는 읽기 권한이 있을 때 경로로 전달합니다. agy와 Grok은 검증된 이미지 전달 경로가 없어 전달되지 않습니다. Grok에는 한도 안의 작은 텍스트 첨부만 인라인됩니다.
- 전달되지 못한 첨부는 조용히 사라지지 않고 해당 답변에 배지로 표시됩니다.

#### `.code-pet` 저장소와 개인정보

채팅 데이터는 홈 폴더의 `~/.code-pet`(환경 변수 `CODE_PET_HOME`으로 변경 가능)에 저장됩니다.

```
~/.code-pet/
  config.json              # 앱 설정·CLI 탐지 캐시 (자격 증명 없음)
  sessions/<id>/meta.json  # 세션 제목·워크스페이스·권한·에이전트 설정
  sessions/<id>/transcript.jsonl   # 대화 기록 (추가 전용)
  sessions/<id>/attachments/       # 첨부 사본 (내용 해시 이름)
  trash/                   # 삭제된 세션 (30일 보관)
```

- 프롬프트, 응답, 워크스페이스 경로, 첨부 사본이 **로컬에만** 저장됩니다. CodePet이 이 데이터를 외부로 전송하지 않습니다.
- 채팅 저장소에는 CLI 로그인 토큰/자격 증명을 기록하지 않습니다. 사용자가 계정 전환 기능을 쓰면 각 공급자의 인증 파일 사본은 권한을 제한한 `~/.codepet/*-switch` 프로필에 로컬 저장됩니다.
- Claude와 Codex 프롬프트는 stdin으로, Grok 프롬프트는 실행 종료 시 삭제되는 권한 제한 임시 파일로 전달합니다. `agy` 1.1.10은 비대화형 프롬프트를 argv로만 받기 때문에 AGY 응답이 실행되는 동안에는 운영체제의 프로세스 목록에 프롬프트가 일시적으로 보일 수 있습니다. CodePet은 Windows 명령줄 한도를 피하도록 긴 AGY 대화의 앞부분을 자동으로 축약합니다.
- 세션 삭제는 휴지통 이동이며 30일 뒤 정리됩니다. 앱을 삭제해도 `~/.code-pet`은 남으므로, 완전히 지우려면 폴더를 직접 삭제하세요.
- 쓰기는 임시 파일 + 교체(rename) 방식이라 도중에 꺼져도 기존 데이터가 깨지지 않고, 더 새로운 버전이 만든 저장소는 읽기 전용으로만 엽니다.

#### Antigravity: IDE와 `agy` CLI는 별개입니다

Antigravity **IDE**(GUI 앱)가 설치되어 있어도 채팅에는 **`agy` CLI**가 따로 필요합니다. CodePet은 PATH와 함께 공식 설치 경로(`%LOCALAPPDATA%\agy\bin\agy.exe`)도 탐색하므로, CLI를 설치했다면 PATH에 없어도 "CLI 다시 탐지"로 바로 인식됩니다. IDE만 있는 경우 칩에 "GUI만 설치됨" 안내가 나오며, GUI 실행 파일을 CLI처럼 실행하지는 않습니다.

펫과 채팅은 하나의 `code-pet` npm 패키지와 데스크톱 배포판으로 공개합니다. 채팅 코어의 대부분은 Electron과 분리된 순수 Node 모듈로 유지합니다. 세션 저장 구조(추가 전용 JSONL)와 권한 어휘는 Apache-2.0으로 공개된 [openai/codex](https://github.com/openai/codex)의 설계에서 영감을 받았으며, 코드/자산은 복사하지 않았습니다.

### 화면 설정

설정의 `일반` 화면에서 말풍선 배경색과 글자색을 직접 고를 수 있습니다. 글자색은 본문뿐 아니라 모델명과 작업 상태 제목에도 함께 적용됩니다. 설치된 시스템 글꼴(Windows 레지스트리 / Linux fontconfig / macOS 폰트 폴더)을 검색하고 10~20px 글자 크기와 함께 선택하면 설정 미리보기와 말풍선에 적용됩니다.

### 펫 바꾸기

우클릭 → "펫 바꾸기"에서 고르면 즉시 바뀌고, 선택은 다음 실행 때도 유지됩니다. 목록에 나오는 순서는:

1. exe 옆 `pet/spritesheet.webp` — 직접 만든 스프라이트를 쓰고 싶을 때
2. `~/.codex/pets`에 설치된 펫들 — Codex에서 펫을 추가하면 여기에도 자동으로 나타남
3. 내장 기본 펫

## 조작법

| 동작 | 반응 |
|---|---|
| 클릭 | 인사 |
| 더블클릭 | 점프 + 설정의 한도 화면 열기 |
| 드래그 | 창 이동 |
| 드래그 종료 / 크기 조절 종료 | 현재 위치와 크기를 저장하고, 다음 실행 때 현재 화면 안에서 복원 |
| 우클릭 | 메뉴 (설정, 계정, 펫 바꾸기, 모션, 일시정지, 마우스 따라가기, 자동 실행, 숨기기 등) |
| 시스템 트레이 | 설정, 보이기, 숨기기, 계정, 펫 바꾸기, 완전 종료 |
| 완료·입력 대기·승인 대기 말풍선 클릭 | 해당 Codex 채팅 열기 |
| 그 외 말풍선 클릭 | 닫기 |

우클릭 메뉴의 "숨기기"는 창만 감추고 앱은 시스템 트레이에 남깁니다. 완전히 끄려면 시스템 트레이 아이콘을 우클릭해서 "완전 종료"를 누르면 됩니다.

`이동 일시 정지`와 `마우스 따라가기` 상태는 설정 파일에 저장되므로 앱을 다시 실행하거나 재부팅해도 유지됩니다.

우클릭 메뉴의 "로그인 시 자동 실행"을 켜면 로그인할 때 같이 뜹니다.

## 커스텀 스프라이트 만들기

Codex 펫 스프라이트 규격을 그대로 따르며 v1과 v2를 모두 자동 인식합니다.

- v1: 전체 크기 1536x1872, 셀 192x208의 8열 x 9행 그리드
- v2: 전체 크기 1536x2288, 셀 192x208의 8열 x 11행 그리드
- row가 상태, column이 프레임

| row | 상태 | v1 프레임 수 | v2 프레임 수 |
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
| 9 | look directions A | - | 8 |
| 10 | look directions B | - | 8 |

v2의 row 9~10에는 시계 방향의 시선 방향 16개가 들어갑니다. 현재 CodePet은 row 0~8의 기본 애니메이션을 재생하고 row 9~10은 시트를 올바르게 자르기 위한 v2 레이아웃으로 인식합니다.

이미지 크기가 정상 규격이면 높이로 9행/11행을 자동 판별합니다. 이미지 비율을 판별할 수 없을 때는 같은 폴더의 `pet.json`에 있는 `spriteVersionNumber`를 fallback으로 사용합니다.

이 규격으로 만든 `spritesheet.webp`를 exe 옆 `pet/` 폴더에 넣으면 메뉴에 "커스텀"으로 나타납니다.

## 코드 구조

- `src/main.js` — 창 관리, 이동 로직, 메뉴, 말풍선 제어. 이동 속도나 말풍선 크기 같은 값은 상단의 `MOVEMENT_CONFIG`, `BUBBLE_CONFIG`에 모여 있음
- `src/codex-watcher.js`, `antigravity-watcher.js`, `claude-watcher.js`, `grok-watcher.js` — 네 프로그램의 로컬 작업 로그 감시
- `src/codex-account-switcher.js`, `antigravity-account-switcher.js`, `claude-account-switcher.js`, `grok-account-switcher.js` — 공급자별 계정 저장/전환/삭제
- `src/account-submenu.js` — Codex·AGY·Claude·Grok 공통 계정 메뉴 구성
- `src/codex-usage-label.js` — Codex 서버 한도 기간과 모델 범위에 맞는 표시 이름 생성
- `src/provider-usage.js` — AGY·Claude 한도 조회 및 정규화. Grok은 CLI가 한도 조회를 제공하지 않아 설정에서 지원 상태만 표시
- `src/settings.html` / `settings.js` — 설정, 계정, 한도 화면
- `src/providers/provider-capabilities.js` — 프로바이더 CLI 탐지·검증·능력(모델/노력/권한) 공개. 펫과 채팅이 공유
- `src/providers/provider-diagnostics.js` — GUI와 `code-pet doctor`가 공유하는 설치·로그인 진단 결과 계약
- `src/chat/` — 에이전트 채팅방 코어(멘션 파싱, 그룹챗 프롬프트, 실행 인자 생성, CLI 실행, 이벤트 정규화, 세션 저장소, 첨부, 이모티콘, 룸 오케스트레이션). `chat-window.js`/`chat-ipc.js` 외에는 Electron 비의존
- `src/chat.html` / `chat.js` / `chat-markdown.js` — 에이전트 채팅방 창과 안전한 리치 렌더러
- `bin/code-pet.js` — 실행 도우미. `code-pet doctor`로 CLI 상태를 점검(자격 증명 출력 없음)
- `src/renderer.js` — 스프라이트 애니메이션 재생. 상태 정의는 `PET_STATES`
- `src/bubble.html` / `bubble.js` — 통합 작업 말풍선
