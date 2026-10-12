#!/usr/bin/env bash
# 모든 mod 를 검사(validate)하고 테스트가 있으면 돌린다.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
claude plugin validate "$ROOT" >/dev/null || { echo "✗ marketplace.json"; FAIL=1; }
for dir in "$ROOT"/plugins/*/; do
  name="$(basename "$dir")"
  if ! claude plugin validate "$dir" >/dev/null 2>&1; then
    echo "✗ $name validate"; claude plugin validate "$dir"; FAIL=1; continue
  fi
  if ls "$dir"tests/*.test.ts* >/dev/null 2>&1; then
    claude plugin test "$dir" >/dev/null 2>&1 || { echo "✗ $name test"; claude plugin test "$dir"; FAIL=1; continue; }
  fi
  echo "✓ $name"
done
exit $FAIL
