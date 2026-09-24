#!/usr/bin/env bash
# Creates a PRIVATE GitHub repo from this folder, pushes it, and turns on GitHub Pages.
# Usage (on your Mac, from this folder):   bash publish-private.sh [repo-name]
set -euo pipefail
REPO="${1:-office-signage}"
cd "$(dirname "$0")"

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI not found. Install it with:  brew install gh   then re-run this script."
  exit 1
fi
gh auth status >/dev/null 2>&1 || gh auth login --web --git-protocol https

OWNER="$(gh api user -q .login)"
echo "Creating private repo $OWNER/$REPO ..."
gh repo create "$REPO" --private --source=. --remote=origin --push \
  --description "Office screen signage: schedule, events, quote of the day"

echo "Turning on GitHub Pages (branch main, folder /) ..."
if gh api -X POST "repos/$OWNER/$REPO/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 \
   || gh api "repos/$OWNER/$REPO/pages" >/dev/null 2>&1; then
  echo
  echo "Done. The site will be live in about a minute at:"
  echo "  https://$OWNER.github.io/$REPO/"
else
  echo
  echo "The repo is pushed, but Pages could not be enabled."
  echo "Pages on a PRIVATE repo needs GitHub Pro/Team/Enterprise (Pro is free with the GitHub Student Developer Pack)."
  echo "After upgrading: Settings -> Pages -> Deploy from a branch -> main / (root)."
fi
