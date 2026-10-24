# AI Usage panel widget (Plasma 5)

A native Plasma 5 panel widget for the self-hosted AI usage dashboard. It reads
`GET /api/usage` and pools quotas by provider and type across all active
accounts. The panel is text-free: one thin horizontal bar per type, using its
longest rolling window.

- Fill length is the **pooled remaining fraction**. Two equal-capacity accounts
  with 20% and 80% remaining produce a 50% bar.
- The faint solid black line marks **average time remaining**, weighted by
  window length. Two weekly limits resetting in two and five days therefore put
  the line at `(2 + 5) / (7 + 7) = 50%`.
- Fill right of the line means ahead of pace; left means behind.
- Google Claude and Gemini are separate types. Their 5-hour and weekly limits
  are never combined into one percentage.
- Bar and percentage colour follows a continuous scale from red at 0% through
  orange and yellow to bright green at 100%. Grey means unavailable. A red dot
  indicates account, authentication, or network problems.

Click the widget to open a native Plasma popup. Each type occupies one compact
row, with its two or three windows side by side. Reset countdowns, balances,
pace, and errors remain available without listing every account. Hover the
panel for pooled values. Right-click for **Open dashboard**, **Refresh
providers**, and **Reload credentials**.

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

The script prompts for the dashboard username and password and stores
`base64(username:password)` in the Secret Service as `service=ai-usage`,
`entry=basic`. It does not put the secret in the widget configuration.

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
| Panel bar width | 72 px | Width of each bar in the panel |

All active accounts are pooled automatically; no account or quota selection is
needed. Missing values are excluded from the pooled average and flagged as
incomplete in the tooltip. They are never silently treated as zero.

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

The widget uses the server's `serverTime` for the marker. Each pooled window
uses the earliest upcoming reset for its countdown. It polls cached data;
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
