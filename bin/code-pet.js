#!/usr/bin/env node
// CodePet 실행 도우미.
//   code-pet          → Electron 앱 실행 (로컬에 electron이 설치된 경우)
//   code-pet --chat   → 채팅 창을 바로 열며 실행
//   code-pet doctor   → 프로바이더 CLI 상태 점검 (자격 증명은 출력하지 않습니다)
const path = require("node:path");
const { spawn } = require("node:child_process");

const APP_ROOT = path.join(__dirname, "..");

async function doctor() {
  const { diagnoseProviders } = require(path.join(
    APP_ROOT,
    "src",
    "providers",
    "provider-diagnostics"
  ));
  const records = await diagnoseProviders();

  console.log("CodePet doctor — 프로바이더 CLI 상태\n");
  for (const record of records) {
    const statusLabel = record.installed === true ? "설치됨" : record.installed === false ? "설치되지 않음" : "확인 실패";
    console.log(`  ${record.name} (@${record.provider})`);
    console.log(`    상태: ${statusLabel}${record.version ? ` · ${record.version}` : ""}`);
    if (record.installed === true) {
      const loginLabel = record.loggedIn === true ? "로그인됨" : record.loggedIn === false ? "로그인 필요" : "자동 확인 불가";
      console.log(`    로그인: ${loginLabel}`);
    }
    if (record.message) console.log(`    안내: ${record.message}`);
  }
  console.log("\n세션/설정 저장 위치: ~/.code-pet (CODE_PET_HOME으로 변경 가능)");
  const failed = records.some(
    (record) => record.installed !== true || record.loggedIn === false
  );
  process.exitCode = failed ? 1 : 0;
}

function launchApp(extraArgs) {
  let electronPath = null;
  try {
    // electron 패키지가 함께 설치된 경우에만 실행할 수 있습니다.
    electronPath = require("electron");
  } catch {
    console.error(
      [
        "Electron 런타임을 찾을 수 없습니다.",
        "데스크톱 배포판(포터블/설치본)으로 실행하거나, 저장소에서",
        "  npm install && npm start",
        "로 실행해 주세요. `code-pet doctor`는 Electron 없이도 동작합니다.",
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }
  const child = spawn(electronPath, [APP_ROOT, ...extraArgs], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

const args = process.argv.slice(2);
if (args[0] === "doctor") {
  doctor().catch((error) => {
    console.error("doctor 실행 실패:", error?.message || error);
    process.exitCode = 1;
  });
} else {
  launchApp(args);
}
