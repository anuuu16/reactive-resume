#!/usr/bin/env bash
# Builds the Taiga upload from a branch (default sandbox-base) and refuses to finish if anything that must not be uploaded is inside.
# Leaves out this .sandbox/ folder and files the code and tests don't need (docs, .github, editor/deploy configs, design notes).
# Usage (from anywhere): bash /Users/anu/Desktop/PersonalProjects/Alignerr/reactive-resume/.sandbox/make-sandbox-zip.sh [branch]
# Or, with any branch checked out: git -C <repo> show sandbox-base:.sandbox/make-sandbox-zip.sh | REPO=<repo> bash -s -- [branch]
set -euo pipefail

if [ -n "${REPO:-}" ]; then REPO="$(cd "$REPO" && pwd)"; else REPO="$(cd "$(dirname "$0")/.." && pwd)"; fi
BRANCH="${1:-sandbox-base}"
ZIP="$(dirname "$REPO")/reactive-resume-sandbox.zip"

git -C "$REPO" rev-parse --verify --quiet "$BRANCH" >/dev/null || { echo "No branch '$BRANCH' in $REPO"; exit 1; }
echo "Branch $BRANCH @ $(git -C "$REPO" log --oneline -1 "$BRANCH")"

# Left out of the upload. A trailing "/" means the whole folder.
DROP=(
	.sandbox/
	.github/
	docs/
	.vscode/
	packages/dsh-plugin/docs/
	README.md GLOSSARY.md SECURITY.md
	apps/web/PRODUCT.md apps/web/DESIGN.md
	tooling/mcp/README.md tests/e2e/README.md packages/dsh-plugin/README.md packages/pdf/fixtures/ats/README.md
	crowdin.yml server.json doctor.config.json vercel.json .vercelignore
	Dockerfile Dockerfile.dev .dockerignore compose.yml compose.dev.yml
)
# Kept although inside a dropped folder: tests read them.
KEEP=(
	.github/workflows/docker-build.yml           # tooling/docker-publishing.test.ts
	docs/guides/json-resume-schema.mdx           # tooling/semantic-css/generate-reference(.test).ts
	docs/applying-custom-styles.mdx              # tooling/semantic-css/generate-reference.test.ts
)

dropped() { # path -> 0 if it is left out
	local path="$1" entry
	for entry in "${KEEP[@]}"; do [ "$path" = "$entry" ] && return 1; done
	for entry in "${DROP[@]}"; do
		case "$entry" in
			*/) [ "${path#"$entry"}" != "$path" ] && return 0 ;;
			*) [ "$path" = "$entry" ] && return 0 ;;
		esac
	done
	return 1
}

files=()
skipped=0
while IFS= read -r -d '' path; do
	if dropped "$path"; then skipped=$((skipped + 1)); else files+=("$path"); fi
done < <(git -C "$REPO" ls-tree -r -z --name-only "$BRANCH")
echo "Files: ${#files[@]} packed, $skipped left out"

# git archive packs committed files only: no .git, no node_modules, no .env*, no build output.
rm -f "$ZIP"
git -C "$REPO" --literal-pathspecs archive --format=zip --prefix=reactive-resume/ -o "$ZIP" "$BRANCH" -- "${files[@]}"

fail=0
check() { # name, count, expected
	if [ "$2" != "$3" ]; then echo "  ✗ $1: $2 (expected $3)"; fail=1; else echo "  ✓ $1"; fi
}
list="$(unzip -Z1 "$ZIP")"
check ".git entries"            "$(grep -c '/\.git/' <<<"$list" || true)" 0
check "node_modules entries"    "$(grep -c 'node_modules/' <<<"$list" || true)" 0
check ".env files (except .env.example)" "$(grep -E '/\.env' <<<"$list" | grep -vc '\.env\.example$' || true)" 0
check "agent / AI-tool files"   "$(grep -ciE '(^|/)(AGENTS|CLAUDE|GEMINI|PRODUCT|DESIGN)\.md$|copilot-instructions\.md$|/\.claude-plugin/|(^|/)skills-lock\.json$|(^|/)SKILL\.md$|(^|/)\.mcp\.json$|(^|/)server\.json$|(^|/)llms(-full)?\.txt$|/\.(cursor|codex|gemini|windsurf|claude)/|\.cursorrules$|/docs/agents/' <<<"$list" || true)" 0
check "this .sandbox folder"    "$(grep -c '^reactive-resume/\.sandbox/' <<<"$list" || true)" 0
files_in() { grep "^reactive-resume/$1" <<<"$list" | grep -vc '/$' || true; }
check "docs (only the 2 files tests read)" "$(files_in 'docs/')" 2
check ".github (only docker-build.yml)" "$(files_in '\.github/')" 1
check ".gitignore present"      "$(grep -c '^reactive-resume/\.gitignore$' <<<"$list" || true)" 1
check "private registry URLs"   "$(unzip -p "$ZIP" | grep -ac 'artifactory' || true)" 0
check "turbo agentGuidance off" "$(unzip -p "$ZIP" reactive-resume/turbo.json | grep -c '"agentGuidance": false' || true)" 1
check "packageManager/engines pins" "$(unzip -p "$ZIP" reactive-resume/package.json | grep -cE '"packageManager"|"engines"' || true)" 0

ls -lh "$ZIP" | awk '{print "Size:", $5, " ->", $9}'
if [ "$fail" = 1 ]; then echo "NOT OK: fix the items above before uploading."; rm -f "$ZIP"; exit 1; fi
echo "OK: upload $ZIP with 'Mount files' (extraction path /workspace)."
