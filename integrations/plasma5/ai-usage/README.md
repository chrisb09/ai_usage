# AI Usage panel widget (Plasma 5)

A native Plasma 5 panel widget for the self-hosted AI usage dashboard. It reads
`GET /api/usage` and renders the selected quotas as a compact stack of horizontal
bars. The panel shows no text: the bars themselves are the indicator.

```text
[=====|==========]   quota remaining
[========|=======]   time remaining
```

- Bar length is the **remaining fraction**: 38% remaining fills 38% of the bar.
- The panel is intentionally text-free: each selected quota is one thin bar,
  stacked vertically. Hover the widget for a text summary; click for details.
- The faint dashed red line marks **how much of the quota window is left**. If
  the fill is to the right of the line, you have more quota left than time left
  and are ahead of pace. If it is to the left, you are burning quota faster than
  the window.
- Bar colour changes at 20% remaining or when you are more than 5 percentage
  points behind pace, and turns red at 5% or less.
- A small red dot appears when the widget cannot authenticate, cannot reach the
  dashboard, or any account reports an error.

Click the widget to open a native Plasma popup. It lists every active account and
quota, including 5-hour windows, reset countdowns, balance amounts, pace, and
account errors. Google Claude and Gemini pools stay separate. Right-click the
widget for **Open dashboard**, **Refresh providers**, and **Reload credentials**.

## Requirements

- Plasma 5.24 or newer (developed against Plasma 5.27).
- `kpackagetool5`, normally provided by the Plasma workspace.
- `secret-tool` from `libsecret-tools` for the default credential setup. KWallet
  provides the Secret Service backend on Plasma.

## Install

```bash
cd integrations/plasma5
./install.sh
```

Then store the dashboard Basic credential in the Secret Service (KWallet):

```bash
./ai-usage/scripts/setup-kwallet.sh
```

The script prompts for the dashboard username and password and writes
`base64(username:password)` to the `ai-usage-basic` entry in the `ai-usage`
folder of the `kdewallet` wallet. It does not put the secret in the widget
configuration.

Finally, right-click the panel, choose **Add Widgets**, and add **AI Usage**. If
it does not appear, restart Plasma or log out and back in.

To preview it in a standalone window:

```bash
plasmawindowed org.chrisb09.aiusage
```

## Configuration

Right-click the widget and choose **Configure AI Usage…**.

| Setting | Default | Purpose |
|---|---|---|
| Dashboard URL | `https://usage.christian-f-brinkmann.de` | Base URL; `/api/usage` is appended |
| Credential command | `secret-tool lookup service ai-usage entry basic` | Prints base64 `username:password` or a complete `Basic …` header |
| Refresh interval | 60 s | Poll interval for cached API data |
| Panel quotas | see below | Comma-separated `provider:quotaKey` selectors |
| Panel bar width | 72 px | Width of each bar in the panel |

The default panel selection is:

```text
google:claude-weekly,codex:codex-weekly,opencode-go:opencode-go-monthly,oneprovider:oneprovider,vnai-pro:vnai-pro
```

Selectors use the provider name and quota key from `/api/usage`. For a provider
with multiple accounts, such as Google, the widget shows the account with the
least remaining quota in that pool. Add other keys, for example:

```text
google:claude-weekly,google:gemini-weekly,codex:codex-weekly,codex:codex-5h,opencode-go:opencode-go-weekly
```

The full popup always shows all active accounts, independent of this list.

### Credential alternatives

The command is deliberately generic. To use a mode-600 file instead of the Secret Service:

```bash
install -m 600 /dev/null ~/.config/ai-usage/basic
printf '%s' "$(printf '%s' 'username:password' | base64 -w0)" > ~/.config/ai-usage/basic
```

Then set the credential command to:

```text
cat ~/.config/ai-usage/basic
```

The command output must be one line:

- base64 of `username:password`, or
- a complete header such as `Basic dXNlcjpwYXNz`.

No trailing slash is needed on the dashboard URL.

## API and time marker

The time marker needs the quota window length. The API exposes `windowSec` on
every quota when known (`604800` for weekly, `2592000` for monthly, `18000` for
5-hour). Older data without `windowSec` is inferred from the quota key or label.
Balance-style quotas such as OneProvider and VNAI Pro have no rolling window, so
they show a bar but no time marker.

The widget uses the server's `serverTime` for the marker. It polls cached data;
provider checks remain the scheduler's job. Use **Refresh** in the popup only
when you explicitly want to contact providers, and note the API's manual refresh
cooldown.

## Troubleshooting

**401 / Authentication failed**

- Run the setup script in a graphical session where KWallet is unlocked.
- Test the entry: `secret-tool lookup service ai-usage entry basic | head -c 8; echo`
- Right-click the widget and choose **Reload credentials**.
- Confirm the credential command in the widget settings.

**No bars / "No credential returned"**

- The default command reads the Secret Service. If you use another password
  store, change the command to one that prints the base64 credential.
- KWallet may have prompted behind the popup; unlock it and reload credentials.

**Widget shows `—` for every quota**

- Check the dashboard URL and open it in a browser.
- The compact bars stay visible with old data on network failures; the tooltip
  and popup show the error.

**Widget does not appear in Add Widgets**

- Re-run `install.sh`.
- Check `kpackagetool5 -t Plasma/Applet -l | grep aiusage`.
- Restart `plasmashell` from a terminal or log out and back in.
