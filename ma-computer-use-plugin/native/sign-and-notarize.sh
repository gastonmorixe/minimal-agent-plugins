#!/usr/bin/env bash
# Sign ComputerUseHelper.app with the Developer ID identity, notarize via
# notarytool, and staple. Idempotent; safe to re-run.
#
# Secrets are read from a credentials env file (default: the private dir outside
# this repo). Nothing secret is committed. Required vars in that file:
#   NOTARY_KEY_ID, NOTARY_ISSUER_ID, NOTARY_KEY_FILE (path may be relative to the
#   creds file's dir), TEAM_ID
#
# Usage:
#   ./sign-and-notarize.sh [path/to/ComputerUseHelper.app] [path/to/notary-credentials.env]
set -euo pipefail

APP="${1:-$(cd "$(dirname "$0")" && pwd)/build/ComputerUseHelper.app}"
CREDS="${2:-/Users/gaston/Projects/minimal-agent/private/20260606-161000-notarization-secrets/notary-credentials.env}"
IDENTITY="${CUD_SIGN_IDENTITY:-Developer ID Application: Gaston Morixe (RRF7B9FTY3)}"
ENTITLEMENTS="$(cd "$(dirname "$0")" && pwd)/Sources/ComputerUseHelper.release.entitlements"

echo "==> App:          $APP"
echo "==> Identity:     $IDENTITY"
echo "==> Entitlements: $ENTITLEMENTS"

[ -d "$APP" ] || { echo "ERROR: app not found: $APP"; exit 1; }
[ -f "$CREDS" ] || { echo "ERROR: creds not found: $CREDS"; exit 1; }
[ -f "$ENTITLEMENTS" ] || { echo "ERROR: entitlements not found: $ENTITLEMENTS"; exit 1; }

# shellcheck disable=SC1090
source "$CREDS"
CREDS_DIR="$(cd "$(dirname "$CREDS")" && pwd)"
KEY_PATH="$NOTARY_KEY_FILE"
[ -f "$KEY_PATH" ] || KEY_PATH="$CREDS_DIR/$NOTARY_KEY_FILE"
[ -f "$KEY_PATH" ] || { echo "ERROR: notary key not found: $NOTARY_KEY_FILE"; exit 1; }

echo
echo "==> [1/5] Codesign (Developer ID, hardened runtime, secure timestamp)"
# Sign inside-out: any nested code first, then the bundle. This app is a single
# Mach-O so the bundle sign covers it; --options runtime + --timestamp are the
# notarization requirements.
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  --sign "$IDENTITY" \
  "$APP"

echo
echo "==> [2/5] Verify signature"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E "Identifier|TeamIdentifier|Authority|flags|Timestamp" || true
codesign --verify --strict --verbose=2 "$APP"

echo
echo "==> [3/5] Zip for notary submission"
ZIP="${APP%.app}.zip"
rm -f "$ZIP"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
echo "    $ZIP"

echo
echo "==> [4/5] Submit to notarytool (waits for result)"
xcrun notarytool submit "$ZIP" \
  --key "$KEY_PATH" \
  --key-id "$NOTARY_KEY_ID" \
  --issuer "$NOTARY_ISSUER_ID" \
  --wait

echo
echo "==> [5/5] Staple the ticket"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

echo
echo "==> Gatekeeper assessment"
spctl -a -vvv --type exec "$APP" 2>&1 || true

echo
echo "DONE: $APP is signed, notarized, and stapled."
rm -f "$ZIP"
