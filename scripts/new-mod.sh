#!/usr/bin/env bash
# 새 mod 를 템플릿에서 만들고 마켓플레이스에 등록한다.
# 사용법: scripts/new-mod.sh <이름> "<한 줄 설명>"
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${1:?mod 이름을 주세요 (예: turn-timer)}"
DESC="${2:-$NAME}"
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "이름은 소문자·숫자·- 만 씁니다: $NAME" >&2; exit 1; }
DEST="$ROOT/plugins/$NAME"
[ -e "$DEST" ] && { echo "이미 있어요: $DEST" >&2; exit 1; }
cp -R "$ROOT/templates/mod" "$DEST"
node -e '
const fs = require("fs"), path = require("path")
const [dest, name, desc, market] = process.argv.slice(1)
const p = path.join(dest, ".claude-plugin/plugin.json")
fs.writeFileSync(p, fs.readFileSync(p, "utf8").replaceAll("__NAME__", name).replaceAll("__DESCRIPTION__", desc))
const r = path.join(dest, "hooks/register.tsx")
fs.writeFileSync(r, fs.readFileSync(r, "utf8").replaceAll("__NAME__", name))
const m = JSON.parse(fs.readFileSync(market, "utf8"))
m.plugins.push({ name, source: `./plugins/${name}`, description: desc })
fs.writeFileSync(market, JSON.stringify(m, null, 2) + "\n")
' "$DEST" "$NAME" "$DESC" "$ROOT/.claude-plugin/marketplace.json"
echo "만들었어요: plugins/$NAME (마켓플레이스 등록 완료)"
echo "개발 중 바로 띄우기: claude --plugin-dir $DEST"
