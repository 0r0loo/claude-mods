# claude-mods

내가 쓰는 Claude Code mod 모음. 저장소 하나가 마켓플레이스 하나이고, mod 는 `plugins/` 아래에 하나씩 둔다.

| mod | 하는 일 |
|-----|--------|
| [statusline-plus](plugins/statusline-plus) | 프롬프트 위 상태 띠: 폴더·브랜치(●=미커밋)·세션 시간·프롬프트 수·비용 / 컨텍스트·5시간·주간 한도 막대와 리셋 시각 / 직전 턴 모델·시간·캐시율·대기 시간·컴팩트 횟수·실행 중 에이전트. **컴팩트·클리어 버튼**, 한도 80·95% 토스트 |

## 설치 (터미널에서)

데스크탑 앱 Code 탭에서는 `/plugin` 이 안 된다. 터미널 `claude` 에서 한 번 설치하면(사용자 범위) 데스크탑 앱 세션에도 뜬다.

```
/plugin install statusline-plus --marketplace 0r0loo/claude-mods
```

`Add marketplace?` → `y`, 범위는 맨 위(User) 그대로 Enter.

다른 mod 도 같은 줄에서 이름만 바꾼다. 마켓플레이스를 한 번 추가했으면 `/plugin install <mod>@0r0loo-mods` 로도 된다.

업데이트: `claude plugin marketplace update 0r0loo-mods` → `claude plugin update <mod>@0r0loo-mods` → 세션에서 `/reload-plugins`.

## 새 mod 만들기

```bash
scripts/new-mod.sh turn-timer "턴 걸린 시간 토스트"
claude --plugin-dir plugins/turn-timer     # 개발 중 바로 띄워 보기
scripts/check.sh                           # 전부 validate + test
```

Claude 에게 시킬 때는 "claude-mods 에 ○○ mod 추가해줘" 라고 하면 된다 — 템플릿·등록·검사까지 이 스크립트를 쓴다.

### 로컬 폴더를 마켓플레이스로 쓰기 (수정 즉시 반영)

```bash
claude plugin marketplace add ~/code/claude-mods
claude plugin install statusline-plus@0r0loo-mods
```

폴더에서 읽으므로 파일을 고친 뒤 세션에서 `/reload-plugins` 만 하면 된다.

## 구조

```
.claude-plugin/marketplace.json   # mod 목록
plugins/<mod>/
  .claude-plugin/plugin.json      # 이름·버전·설명
  hooks/hooks.json                # { "modules": ["./register.tsx"] }
  hooks/register.tsx              # 본체
  types/index.d.ts                # $.state 를 쓰면 타입 계약
  tests/*.test.ts                 # claude plugin test
templates/mod/                    # new-mod.sh 가 복사하는 틀
```
