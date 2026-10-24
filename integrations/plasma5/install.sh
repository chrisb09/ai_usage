#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package="$here/ai-usage"

if ! command -v kpackagetool5 >/dev/null 2>&1; then
    echo "kpackagetool5 not found. Install the Plasma development/package tools." >&2
    exit 1
fi

if kpackagetool5 -t Plasma/Applet -l 2>/dev/null | grep -qx "org.chrisb09.aiusage"; then
    kpackagetool5 -t Plasma/Applet -u "$package"
    echo "Updated AI Usage."
else
    kpackagetool5 -t Plasma/Applet -i "$package"
    echo "Installed AI Usage."
fi

echo
echo "Add it to a panel: right-click the panel -> Add Widgets -> AI Usage."
echo "If it does not appear immediately, restart plasmashell or log out and back in."
