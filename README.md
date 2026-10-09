# Antigravity AI Quota & Auto-Accept Autopilot

[![Open VSX](https://img.shields.io/badge/Open%20VSX-v1.1.3-blue.svg)](https://open-vsx.org/extension/san-chanadach/antigravity-quota-autopilot)
[![Author: San Chanadach](https://img.shields.io/badge/Author-San%20Chanadach-blue.svg)](https://github.com/San-chanadach)
[![Ko-fi: Buy Me a Coffee](https://img.shields.io/badge/Ko--fi-Buy%20Me%20a%20Coffee-ff5e5b?style=flat&logo=ko-fi)](https://ko-fi.com/sanchanadach)
[![Antigravity IDE: v2.5.5](https://img.shields.io/badge/Antigravity%20IDE-v2.5.5-purple.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An all-in-one companion extension designed exclusively for **Google Antigravity IDE (Version: 2.5.5)** — featuring hands-free **Dual-Mode Auto-Accept** for agent actions, real-time **AI Quota Tracking** (Gemini & Claude), an interactive **Visual Dashboard**, and an automated **1,000-Turn Activity History Logger**.

---

<p align="center">
  <img src="assets/video-preview.gif" alt="Status Bar Hover & Option Switcher Preview" width="650" />
  <br />
  <em>Interactive Status Bar: Hover to view real-time model quotas, countdown reset timers, and switch Auto-Accept modes in 1 click!</em>
</p>

---

## What's New in v1.1.3

- **1-Click Port 9333 Auto-Patch & Clean Relaunch (Windows)**: Added a one-click button in the Dashboard to automatically patch all Antigravity IDE shortcuts (Desktop, Start Menu, Taskbar) with `--remote-debugging-port=9333` and cleanly restart the IDE within 2 seconds.
- **Focus Safety Guard & Typing Protection**: The Auto-Accept engine now detects when you are actively typing in the chat composer (`role="combobox"` / `contenteditable`) or Monaco code editor, completely pausing element interactions so your cursor never gets stolen or interrupted.
- **Strict Exact-Match Button Detection**: Upgraded DOM observer to use strict phrase matching, eliminating false clicks on mentioned file chips (`autoAcceptService.ts`, etc.) or collapsible command accordions.
- **Dual-Mode Visual Indicators**: Enhanced Dashboard and Status Bar with dedicated visual badges for **Standard Auto** (`Auto: ON(Std)`) and **CDP Autopilot** (`Auto: ON`).

---

## Key Features

### 1. Hands-Free Auto-Accept (Dual-Mode Autopilot)
Tired of constantly clicking "Accept" and "Allow" dozens of times during multi-step agent coding sessions? The built-in Autopilot handles permissions automatically while keeping you in full control.

| Auto Active (`Auto: ON`) | Auto Paused (`Auto: OFF`) |
|:---:|:---:|
| ![Auto ON](assets/auto-on.png) | ![Auto OFF](assets/auto-off.png) |

- **1-Click Direct Toggle**: Click the status bar item anytime to instantly toggle Autopilot `ON` <-> `OFF`.
- **Smart Dual-Mode Engine**: Automatically detects whether Antigravity IDE was launched with a debug port:
  - **Standard Auto Mode (Zero Configuration - Recommended)**: Works out of the box without any startup flags or open ports. Automatically executes terminal commands and accepts code changes smoothly via the IDE native engine.
  - **CDP Autopilot Mode (Advanced)**: Connects to Chrome DevTools Protocol (`--remote-debugging-port=9333`) to auto-select and submit chat modal dialog options.
- **Hover Option Selector**: Hover your mouse over the status bar item to view the active setting and switch options directly inside the tooltip without opening dialog menus.

#### Auto-Accept Safety Modes:
- **Option 1: Standard Auto (Allow once / Native Engine)**: Approves steps and terminal commands automatically using the IDE native engine. Requires zero extra configuration or open ports.
- **Option 2: In conversation (Recommended for CDP)**: Auto-approves code edits and terminal commands within the current chat session via CDP. Requires port 9333.
- **Option 3: Always allow (Permanent CDP Mode)**: Full hands-free automation for long, autonomous, or overnight development tasks via CDP. Requires port 9333.

---

### 2. Real-Time AI Quota Tracking (Status Bar)
Never get caught off guard by sudden model quota limits mid-task.

- **Clean Status Bar Display**: `Gemi:80% | Cl:80% Auto: ON(Std)`
- **Multi-Window Support**: Tracks rolling 5-Hour and Weekly limit windows for Google Gemini (3.7 / 3.1 Pro & Flash) and Anthropic Claude (3.7 Sonnet / 3.5 Sonnet).
- **Smart Color Health Cues**:
  - 🟢 **Healthy**: `> 35%` remaining quota
  - 🟡 **Warning**: `15% - 35%` remaining quota
  - 🔴 **Critical**: `< 15%` remaining quota (status bar alerts with error styling)
- **Countdown Timers**: Tooltips show the exact countdown until your rolling quota window resets.

---

### 3. Interactive Visual Analytics Dashboard
A modern, dark-themed dashboard built for real-time monitoring of all your AI models.

![Visual Dashboard](assets/dashboard1.png)

- **Circular Animated SVG Gauges**: High-resolution vector gauges displaying remaining percentages for each model family.
- **Live Reset Timers**: Real-time countdowns for both weekly and 5-hour rolling windows.
- **Quick Controls**: Toggle Autopilot ON/OFF, change permission levels, and force refresh quotas directly from the dashboard header.

---

### 4. 100% Automated Activity Logger (1,000 Turns)
Keep an accurate record of your AI usage and understand where your quota is being spent.

![Auto-Tracked Activity Log](assets/dashboard-log.png)

- **Prompt Snippet Tagging**: Automatically detects and pairs each quota drop with your actual prompt text.
- **Zero-Manual Effort**: Automatically records every AI prompt/turn without needing to click Start or Stop.
- **1,000-Turn FIFO History**: Stores your last 1,000 interactions locally in extension storage.
- **Today's Stats Summary**: Quick glance at total percentage consumed today across all requests.
- **Pagination**: Smooth 10-items-per-page pagination (`Page 1 of 100`) with instant Clear History support.

---

### 5. Multi-Account Switcher & Session Manager
Connect multiple Google / Antigravity accounts and switch between active sessions in one click.

- **1-Click Seamless Session Switching**: Switch active account sessions in 1 click without manually logging out or re-authenticating.
- **Direct SQLite `state.vscdb` Token Injection**: Uses detached worker process and rolling SQLite backups to safely inject Protobuf tokens and randomized device profiles.
- **Unified Sidebar UI**: Directly accessible from the same **Model Limits** Activity Bar panel alongside your Usage Limits and Dashboard.
- **Intelligent Renewal-Aware Sorting**:
  - Pinned active account at the top.
  - Accounts with available quota (> 0%) ordered by highest remaining quota first.
  - Depleted accounts (0%) ordered by **closest renewal countdown** (accounts recharging soonest appear first).
- **Auto-Capture Native Logins**: Automatically detects and registers accounts already signed into Antigravity IDE.
- **Multiple Theme Options**: Choose between **Dark Purple**, **VS Code Adaptive**, **Midnight Black (OLED Pure)**, or **Deep Ocean Blue**.
- **Keyboard Shortcuts**:
  - `Ctrl+Shift+A` / `Cmd+Shift+A`: Open Account Manager
  - `Ctrl+Shift+S` / `Cmd+Shift+S`: Quick Switch Account
  - `Ctrl+Shift+N` / `Cmd+Shift+N`: Add New Google Account
  - `Ctrl+Shift+R` / `Cmd+Shift+R`: Refresh All Balances

---

## Choosing Your Auto-Accept Mode

| Feature | Standard Auto (Recommended) | CDP Autopilot (Advanced) |
|---|---|---|
| **Setup Required** | None (Zero configuration) | Add `--remote-debugging-port=9333` |
| **Open Debug Port** | None (Secure) | Port 9333 open locally |
| **Terminal Execution** | Fully automated (IDE Native) | Fully automated |
| **Code Edits & Steps** | Fully automated (IDE Native) | Fully automated |
| **Chat Dialog Radio Buttons** | Bypassed by IDE setting | Automatically selected (Opt 2/3) |
| **Best For** | 99% of development workflows | Workflows keeping IDE on Request Review |

---

## Requirements & Setup

### 1. Supported Platform
- **Google Antigravity IDE**: **Version 2.5.5+** (tested and verified).

### 2. Setup: Mode A - Standard Auto (Zero Configuration - Recommended)
No special startup flags or shortcuts required!

1. Open **Antigravity IDE Settings** (or Agent Settings).
2. Under **Terminal**, set **Terminal Command Auto Execution** to **Always Proceed**.
3. Under **General**, ensure **Review Policy** is set to **Always Proceed** (optional, for hands-free artifact plans).
4. Click the status bar item to turn on Auto-Accept (`Auto: ON(Std)`).
5. You're all set! The agent will now code and run terminal commands seamlessly.

### 3. Setup: Mode B - CDP Autopilot (Optional / Advanced Users)
If you prefer keeping Antigravity IDE on **Request Review** mode and want the extension to automatically select radio buttons (Option 2 or Option 3) inside the chat prompt dialog, launch Antigravity IDE with the remote debugging port flag:

#### Method A: 1-Click Auto-Restart in Dashboard (Easiest - Windows)
1. Open the Dashboard (`Ctrl+Shift+P` -> **Antigravity: Show Dashboard**).
2. Click **Enable Port 9333 & Restart** in the header (or **Restart with Port 9333** on the alert banner).
3. Confirm **Restart Now** — Antigravity will patch shortcuts, save state, close, and automatically relaunch within 2 seconds with Port 9333 active!
4. Status in Dashboard will turn green: **CDP: Connected**.

#### Method B: Windows Shortcut (Manual)
1. Right-click your **Antigravity IDE** shortcut -> select **Properties**.
2. In the **Shortcut** tab, locate the **Target** field.
3. Append ` --remote-debugging-port=9333` at the end of the line (with a leading space):
   ```text
   "C:\Users\<YourUsername>\AppData\Local\Programs\Antigravity IDE\Antigravity IDE.exe" --remote-debugging-port=9333
   ```
4. Click **Apply** and **OK**. Launch Antigravity IDE from this shortcut.

#### Method C: Terminal / PowerShell
```powershell
& "C:\Users\$env:USERNAME\AppData\Local\Programs\Antigravity IDE\Antigravity IDE.exe" --remote-debugging-port=9333
```

> **Note:** The **Real-Time Quota Monitor**, **Activity Tracker**, and **Visual Dashboard** work out of the box via the local Language Server regardless of which mode you choose.

---

## Installation

### Method 1: Install from Open VSX Registry (Recommended)
1. In Antigravity IDE, open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **`Antigravity AI Quota & Auto-Accept Autopilot`** (or `san-chanadach`).
3. Click **Install**.

### Method 2: Install from `.vsix` Release
1. Download the latest `antigravity-quota-autopilot-1.1.3.vsix` from [GitHub Releases](https://github.com/San-chanadach/antigravity-quota-autopilot/releases).
2. Open Antigravity IDE.
3. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and choose **Extensions: Install from VSIX...**.
4. Select the downloaded `.vsix` file and reload the window.

---

## Contributed Commands

| Command | Identifier | Description |
|---|---|---|
| **Toggle Auto-Accept (ON/OFF)** | `antigravityLimitMonitor.toggleAutoAccept` | Quickly toggles hands-free step & terminal approvals. |
| **Set Auto-Accept Option** | `antigravityLimitMonitor.setAutoAcceptChoice` | Opens quick-pick to select Option 1, 2, or 3. |
| **Show Limit Monitor Dashboard** | `antigravityLimitMonitor.showDashboard` | Opens the full visual webview dashboard and activity logs. |
| **Clear Activity History Logs** | `antigravityLimitMonitor.clearHistory` | Clears the 1,000 saved activity history records. |
| **Refresh Model Limits** | `antigravityLimitMonitor.refresh` | Forces an immediate quota refresh from the Language Server. |
| **Switch Status Bar Display Mode** | `antigravityLimitMonitor.toggleDisplayMode` | Switches status bar text formatting style. |
| **Open Limit Monitor Quick Menu** | `antigravityLimitMonitor.openQuickMenu` | Opens the consolidated action menu. |

---

## Support & Buy Me a Coffee

If you find **Antigravity AI Quota & Auto-Accept Autopilot** useful and it saves you time, please consider buying me a coffee to support continued development and maintenance!

[![Buy Me a Coffee on Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20on%20Ko--fi-ff5e5b?style=for-the-badge&logo=ko-fi)](https://ko-fi.com/sanchanadach)

Your support is deeply appreciated!

---

## Author

Developed and maintained by **San Chanadach** ([@San-chanadach](https://github.com/San-chanadach)).

---

## License

MIT License - see [LICENSE](LICENSE) for details.
