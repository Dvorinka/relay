#!/usr/bin/env bash
# Sign a PE file (exe/installer/uninstaller) in place with Authenticode.
#
# Usage:
#   SIGNING_CERT_PFX=/path/cert.pfx SIGNING_CERT_PASSWORD=... ./scripts/sign-windows.sh file.exe
# or:
#   ./scripts/sign-windows.sh file.exe cert.pem key.pem
#
# Used by makensis !finalize/!uninstfinalize during installer builds and by
# release CI when the SIGNING_CERT_B64 secret is configured. Requires
# osslsigncode. A dev cert is enough for local verification; releases should
# use a publicly trusted Authenticode certificate or Smart App Control may
# still block the installer.
set -euo pipefail

FILE="$1"
PFX="${SIGNING_CERT_PFX:-${2:-}}"
KEY="${3:-}"
PASS="${SIGNING_CERT_PASSWORD:-}"

if [[ ! -f $FILE ]]; then
	echo "sign-windows: no such file: $FILE" >&2
	exit 1
fi

args=(sign -n "Relay" -t "http://timestamp.digicert.com")
if [[ -n $PFX ]]; then
	args+=(-pkcs12 "$PFX")
	[[ -n $PASS ]] && args+=(-pass "$PASS")
elif [[ -n ${2:-} && -n $KEY ]]; then
	args+=(-certs "$2" -key "$KEY")
else
	echo "sign-windows: set SIGNING_CERT_PFX or pass cert.pem key.pem" >&2
	exit 1
fi

tmp="$FILE.signed"
osslsigncode "${args[@]}" -in "$FILE" -out "$tmp"
mv "$tmp" "$FILE"
echo "signed: $FILE"
