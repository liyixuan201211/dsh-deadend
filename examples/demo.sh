#!/usr/bin/env bash
#
# A runnable tour of deadend: blocked -> suspect -> re-confirmed -> retired.
#
# It builds a throwaway repository in a temp directory, so it touches nothing in
# your working tree. Run it from anywhere:
#
#   ./examples/demo.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI=(node "$HERE/../src/cli.js")
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
git init -q .
git config user.email demo@example.com
git config user.name demo

printf '{"name":"demo","dependencies":{}}\n' > package.json
printf '{"lockfileVersion":3}\n' > package-lock.json
cat > install.log <<'LOG'
npm ERR! code 1
npm ERR! path /Users/demo/app/node_modules/sharp
Error: Cannot find module '/Users/demo/app/node_modules/sharp/build/Release/sharp-darwin-arm64.node'
    at Object..node (node:internal/modules/cjs/loader:1234:18)
npm ERR! 3.7s elapsed
LOG

banner() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

# The set +e / set -e dance is load-bearing: several of these commands exit
# non-zero by design (that is the interface), and the tour has to keep going in
# order to show them.
run() {
  printf '\033[2m$ deadend %s\033[0m\n' "$*"
  set +e
  "${CLI[@]}" "$@"
  local code=$?
  set -e
  printf '\033[2m[exit %s]\033[0m\n' "$code"
}

run_quiet() {
  set +e
  "${CLI[@]}" "$@" >/dev/null 2>&1
  local code=$?
  set -e
  printf '\033[2m$ deadend %s -> exit %s\033[0m\n' "$*" "$code"
}

banner "1. Set up a ledger in this repository"
run init

banner "2. Record a failure that cost real time"
printf '\033[2m$ deadend record --title ... --cmd "npm install sharp" ...\033[0m\n'
"${CLI[@]}" record \
  --title "npm install sharp fails: no prebuilt binary for darwin-arm64" \
  --cmd "npm install sharp" --exit 1 --log install.log \
  --why "sharp ships prebuilt binaries and publishes none for this platform/arch" \
  --retry "npm rebuild sharp --build-from-source" \
  --anchor package.json --anchor package-lock.json \
  --evidence install.log

banner "3. Before retrying it: blocked (exit 3)"
run check --cmd "npm install sharp"

banner "4. A different command, the same failure — still caught by signature"
run check --cmd "pnpm add sharp" --log install.log

banner "5. Something else entirely is not blocked, only mentioned"
run check --cmd "npm install left-pad"

banner "6. Change one anchor: the dead end decays to a suspect (exit 4)"
printf '{"lockfileVersion":3,"packages":{}}\n' > package-lock.json
run check --cmd "npm install sharp"

banner "7. Re-test it. Still broken -> re-pin the anchors and block again (exit 3)"
run verify dd_ --still-fails --note "retested after the lockfile bump"
run_quiet check --cmd "npm install sharp"

banner "8. Later, it is genuinely fixed -> retire it (exit 0)"
run verify dd_ --now-works --note "prebuilt binary published upstream"
run_quiet check --cmd "npm install sharp"

banner "9. The ledger keeps the history"
run list --all
run show dd_

banner "10. The guard that makes this work: no anchors, no entry (exit 5)"
run record --title "go build fails on cgo" --cmd "go build ./..."

banner "Done. The ledger is .deadend/ledger.jsonl — commit it."
