import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { AutoAcceptChoice } from './types';

/**
 * Pure Node.js WebSocket Client using http & crypto (Zero external npm dependencies)
 */
class PureCdpSocket {
  private socket: any = null;
  public isConnected: boolean = false;
  private wsUrl: string;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(this.wsUrl);
        const key = crypto.randomBytes(16).toString('base64');
        const req = http.request({
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': key,
          },
        });
        req.on('upgrade', (res, socket) => {
          this.socket = socket;
          this.isConnected = true;
          socket.on('close', () => { this.isConnected = false; });
          socket.on('error', () => { this.isConnected = false; });
          resolve();
        });
        req.on('error', (err) => {
          this.isConnected = false;
          reject(err);
        });
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  public send(obj: any): void {
    if (!this.socket || !this.isConnected) return;
    try {
      const json = JSON.stringify(obj);
      const length = Buffer.byteLength(json);
      let frameHeader: Buffer;
      if (length <= 125) {
        frameHeader = Buffer.from([0x81, 0x80 | length]);
      } else if (length <= 65535) {
        frameHeader = Buffer.alloc(4);
        frameHeader[0] = 0x81;
        frameHeader[1] = 0x80 | 126;
        frameHeader.writeUInt16BE(length, 2);
      } else {
        frameHeader = Buffer.alloc(10);
        frameHeader[0] = 0x81;
        frameHeader[1] = 0x80 | 127;
        frameHeader.writeBigUInt64BE(BigInt(length), 2);
      }
      const mask = Buffer.alloc(4);
      const payload = Buffer.from(json);
      const buffer = Buffer.concat([frameHeader, mask, payload]);
      this.socket.write(buffer);
    } catch (e) {}
  }

  public close(): void {
    if (this.socket) {
      try { this.socket.destroy(); } catch (e) {}
      this.socket = null;
      this.isConnected = false;
    }
  }
}

/**
 * Intelligent DOM Observer Script for CDP injection
 * - Prioritizes user's chosen option (Option 1 / Option 2 / Option 3)
 * - Selects radio/option in permission prompts before clicking Submit
 * - Directly clicks choice action button if buttons are rendered directly
 * - Avoids clicking sidebar conversation history
 */
const DOM_OBSERVER_SCRIPT = `
(function() {
  window.__AGY_AUTO_ACCEPT_ACTIVE = true;

  if (window.__AGY_AUTO_ACCEPT_OBSERVER) {
    try { window.__AGY_AUTO_ACCEPT_OBSERVER.disconnect(); } catch(e) {}
  }
  if (window.__AGY_AUTO_ACCEPT_INTERVAL) {
    try { clearInterval(window.__AGY_AUTO_ACCEPT_INTERVAL); } catch(e) {}
  }

  // 1. Strict blacklist: Never touch code editors, file trees, settings, file mention chips, or chat history
  var IGNORED_SELECTORS = [
    '.monaco-editor',
    '.editor-instance',
    '.editor-group-container',
    '.part.editor',
    '.settings-editor',
    '.preferences-editor',
    '[class*="settings-"]',
    '[class*="preferences-"]',
    '[role="tree"]',
    '[role="treeitem"]',
    '.conversation-list',
    '.chat-history',
    '.past-chat',
    '[class*="history-list"]',
    '[class*="convo-list"]',
    '.context-scope-mention',
    '[class*="context-scope"]',
    '[class*="context-mention"]',
    '[class*="mention"]',
    '[class*="composer"]',
    '[role="combobox"]',
    '.monaco-list-row'
  ].join(', ');

  function isIgnoredElement(el) {
    if (!el || !el.closest) return false;
    if (el.closest(IGNORED_SELECTORS)) return true;
    // Prevent clicking anything inside input or contenteditable containers
    if (el.closest('[contenteditable="true"], textarea, input, .monaco-inputbox')) return true;
    // Prevent clicking file reference buttons (e.g. chips with file paths in title)
    var title = (el.getAttribute('title') || '').toLowerCase();
    if (title && (title.includes('\\') || title.includes('/') || /\.(ts|js|json|md|py|go|rs|cpp|c|h|html|css)$/.test(title))) {
      return true;
    }
    return false;
  }

  // 2. Focus Safety Guard: If user is actively focused on chat input, code editor, or any input, NEVER steal focus!
  function isUserTyping() {
    var active = document.activeElement;
    if (!active) return false;
    var tag = (active.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input' || active.isContentEditable) {
      return true;
    }
    if (active.closest && active.closest('[contenteditable="true"], [role="combobox"], .monaco-inputbox, .interactive-input, .chat-input, .composer')) {
      return true;
    }
    return false;
  }

  function getChoiceKeywords() {
    var choice = window.__AGY_AUTO_ACCEPT_CHOICE || 1;
    if (choice === 2) {
      return ['in this conversation', 'allow in this conversation'];
    } else if (choice === 3) {
      return ['always allow', 'yes, and always allow'];
    }
    return ['allow this time', 'yes, allow this time', 'allow once'];
  }

  function selectTargetOption() {
    var targetKeywords = getChoiceKeywords();
    var options = document.querySelectorAll('[role="radio"], [role="option"], input[type="radio"], label');
    for (var i = 0; i < options.length; i++) {
      var opt = options[i];
      if (isIgnoredElement(opt)) continue;
      if (opt.closest('.monaco-list, [role="tree"], .editor-container, .tabs-container')) continue;

      var optText = (opt.innerText || opt.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!optText) continue;

      for (var k = 0; k < targetKeywords.length; k++) {
        if (optText.indexOf(targetKeywords[k]) !== -1) {
          if (opt.getAttribute('aria-checked') !== 'true' && !opt.checked && !opt.classList.contains('selected')) {
            try { opt.click(); } catch(e) {}
          }
          return true;
        }
      }
    }
    return false;
  }

  function isTargetButton(text, choice) {
    var exactTargets = [
      'submit',
      'submit ↵',
      'allow',
      'allow this time',
      'yes, allow this time',
      'allow once',
      'proceed',
      'continue',
      'retry',
      'run',
      'run command',
      'accept'
    ];

    if (choice === 2) {
      exactTargets.push('in this conversation', 'yes, in this conversation', 'allow in this conversation');
    } else if (choice === 3) {
      exactTargets.push('always allow', 'yes, and always allow');
    }

    for (var i = 0; i < exactTargets.length; i++) {
      var target = exactTargets[i];
      if (text === target) return true;
      // Allow trailing symbol like 'submit ↵' or 'submit ->' (max 4 extra chars after space)
      if (text.startsWith(target + ' ') && (text.length <= target.length + 4)) return true;
    }
    return false;
  }

  function scanAndClick() {
    if (!window.__AGY_AUTO_ACCEPT_ENABLED) return;

    // Safety: If the user is currently typing in chat or input box, do not interrupt!
    if (isUserTyping()) return;

    // 1. Auto-select user's preferred option in radio/checkbox/list prompts
    selectTargetOption();

    // 2. Scan and click confirmation buttons in chat prompts
    var choice = window.__AGY_AUTO_ACCEPT_CHOICE || 1;
    var buttons = document.querySelectorAll('button, div[role="button"], a[role="button"], input[type="button"], input[type="submit"]');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (isIgnoredElement(btn)) continue;

      var text = (btn.innerText || btn.textContent || btn.value || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!text) continue;

      if (isTargetButton(text, choice)) {
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;

        var now = Date.now();
        if (btn.__lastAgyClick && now - btn.__lastAgyClick < 2500) continue;
        btn.__lastAgyClick = now;

        try {
          btn.click();
          return;
        } catch (e) {}
      }
    }
  }

  window.__AGY_SCAN_AND_CLICK = scanAndClick;
  window.__AGY_AUTO_ACCEPT_OBSERVER = new MutationObserver(scanAndClick);
  window.__AGY_AUTO_ACCEPT_OBSERVER.observe(document.body, { childList: true, subtree: true });
  window.__AGY_AUTO_ACCEPT_INTERVAL = setInterval(scanAndClick, 500);
  scanAndClick();
})();
`;

export interface ShortcutPatchResult {
  newlyPatched: number;
  alreadyPatched: number;
  totalFound: number;
}

export class AutoAcceptService extends EventEmitter implements vscode.Disposable {
  private static instance: AutoAcceptService;
  private globalState?: vscode.Memento;
  private isEnabled: boolean = false;
  private choice: AutoAcceptChoice = 1;
  private isCdpAvailable: boolean = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private cdpCheckTimer: NodeJS.Timeout | null = null;
  private cdpSockets: Map<string, PureCdpSocket> = new Map();
  private isExecuting: boolean = false;

  private constructor(globalState?: vscode.Memento) {
    super();
    this.globalState = globalState;
    this.isEnabled = this.globalState?.get<boolean>('antigravity_auto_accept_enabled', false) ?? false;
    const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
    const defaultChoice = config.get<AutoAcceptChoice>('autoAccept.choice', 1);
    this.choice = this.globalState?.get<AutoAcceptChoice>('antigravity_auto_accept_choice', defaultChoice) ?? defaultChoice;

    // Asynchronously check CDP port status on init
    this.checkCdpPort().then((available) => {
      if (!available && this.choice !== 1) {
        this.choice = 1;
        this.globalState?.update('antigravity_auto_accept_choice', 1);
        this.emit('choiceChanged', 1);
      }
      if (this.isEnabled) {
        this.startEngines();
      }
    });
  }

  public static getInstance(globalState?: vscode.Memento): AutoAcceptService {
    if (!AutoAcceptService.instance) {
      AutoAcceptService.instance = new AutoAcceptService(globalState);
    } else if (globalState && !AutoAcceptService.instance.globalState) {
      AutoAcceptService.instance.globalState = globalState;
    }
    return AutoAcceptService.instance;
  }

  public getStatus(): boolean {
    return this.isEnabled;
  }

  public getChoice(): AutoAcceptChoice {
    return this.choice;
  }

  public getIsCdpAvailable(): boolean {
    return this.isCdpAvailable;
  }

  public async checkCdpPort(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
    const port = config.get<number>('autoAccept.cdpPort', 9333);
    this.isCdpAvailable = await this.pingPort(port);
    return this.isCdpAvailable;
  }

  public getChoiceLabel(choice?: AutoAcceptChoice): string {
    const c = choice ?? this.choice;
    switch (c) {
      case 1:
        return this.isCdpAvailable ? 'Allow this time (Once)' : 'Standard Auto (Native Engine)';
      case 2:
        return 'In this conversation (Recommended)';
      case 3:
        return 'Always allow (Permanent)';
      default:
        return 'Standard Auto';
    }
  }

  public async setChoice(choice: AutoAcceptChoice, autoEnable: boolean = true): Promise<boolean> {
    await this.checkCdpPort();

    if (!this.isCdpAvailable && (choice === 2 || choice === 3)) {
      const targetLabel = choice === 2 ? 'Option 2 (In conversation)' : 'Option 3 (Always allow)';
      vscode.window.showWarningMessage(
        `${targetLabel} requires Antigravity IDE to be launched with --remote-debugging-port=9333. Switched to Option 1 (Standard Auto) instead.`,
        'Auto-Patch Shortcuts',
        'Dismiss'
      ).then(async (action) => {
        if (action === 'Auto-Patch Shortcuts') {
          const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
          const port = config.get<number>('autoAccept.cdpPort', 9333);
          const res = await this.patchShortcuts(port);
          if (res.newlyPatched > 0) {
            vscode.window.showInformationMessage(
              `Successfully patched ${res.newlyPatched} Antigravity shortcut(s) with port ${port}. Please close and reopen Antigravity to activate CDP Autopilot.`
            );
          } else if (res.alreadyPatched > 0) {
            vscode.window.showInformationMessage(
              `All ${res.alreadyPatched} Antigravity shortcut(s) already have port ${port}. Please close Antigravity completely and reopen it to activate Port ${port}.`
            );
          }
        }
      });

      this.choice = 1;
      await this.globalState?.update('antigravity_auto_accept_choice', 1);
      this.emit('choiceChanged', 1);
      if (autoEnable && !this.isEnabled) {
        await this.setEnabled(true, false);
      }
      return false;
    }

    this.choice = choice;
    await this.globalState?.update('antigravity_auto_accept_choice', choice);
    this.broadcastCdpChoice(choice);
    this.emit('choiceChanged', choice);
    if (autoEnable && !this.isEnabled) {
      await this.setEnabled(true, false);
    }
    return true;
  }

  private broadcastCdpChoice(choice: AutoAcceptChoice): void {
    const expr = `window.__AGY_AUTO_ACCEPT_CHOICE = ${choice};\nif (window.__AGY_SCAN_AND_CLICK) { window.__AGY_SCAN_AND_CLICK(); }`;
    const payload = {
      id: 98,
      method: 'Runtime.evaluate',
      params: { expression: expr }
    };

    for (const [wsUrl, client] of this.cdpSockets) {
      try {
        if (client.isConnected) {
          client.send(payload);
        } else {
          this.cdpSockets.delete(wsUrl);
        }
      } catch (e) {}
    }
  }

  public async toggle(): Promise<boolean> {
    const nextState = !this.isEnabled;
    await this.setEnabled(nextState, false);
    const modeLabel = this.isCdpAvailable ? `Option ${this.choice}` : 'Standard';
    vscode.window.setStatusBarMessage(
      nextState ? `$(zap) Auto-Accept: ON (${modeLabel})` : `$(circle-slash) Auto-Accept: OFF`,
      2500
    );
    return this.isEnabled;
  }

  public async setEnabled(enabled: boolean, notify: boolean = false): Promise<boolean> {
    if (this.isEnabled === enabled) return this.isEnabled;

    this.isEnabled = enabled;
    await this.globalState?.update('antigravity_auto_accept_enabled', this.isEnabled);

    if (this.isEnabled) {
      this.startEngines();
      this.broadcastCdpState(true);
      if (notify) {
        this.verifyPortAndNotify();
      }
    } else {
      this.stopEngines();
    }

    this.emit('stateChanged', this.isEnabled);
    return this.isEnabled;
  }

  public pingPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 1200 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data.includes('{')));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  public async patchShortcuts(targetPort: number = 9333): Promise<ShortcutPatchResult> {
    if (process.platform === 'win32') {
      return this.patchWindowsShortcuts(targetPort);
    } else if (process.platform === 'linux') {
      return this.patchLinuxShortcuts(targetPort);
    }
    return { newlyPatched: 0, alreadyPatched: 0, totalFound: 0 };
  }

  public async patchLinuxShortcuts(targetPort: number = 9333): Promise<ShortcutPatchResult> {
    const res: ShortcutPatchResult = { newlyPatched: 0, alreadyPatched: 0, totalFound: 0 };
    if (process.platform !== 'linux') return res;
    const searchDirs = [
      path.join(os.homedir(), '.local', 'share', 'applications'),
      path.join(os.homedir(), 'Desktop')
    ];
    const flag = `--remote-debugging-port=${targetPort}`;

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (!file.endsWith('.desktop')) continue;
          if (!file.toLowerCase().includes('antigravity')) continue;
          const fullPath = path.join(dir, file);
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            if (content.includes(flag)) {
              res.alreadyPatched++;
              res.totalFound++;
            } else {
              const updated = content.replace(/^(Exec=[^\r\n]+)$/m, (line) => {
                if (/\s+%[A-Za-z]\s*$/.test(line)) {
                  return line.replace(/(\s+%[A-Za-z]\s*)$/, ` ${flag}$1`);
                }
                return `${line} ${flag}`;
              });
              fs.writeFileSync(fullPath, updated, 'utf8');
              res.newlyPatched++;
              res.totalFound++;
            }
          } catch (e) {}
        }
      } catch (e) {}
    }
    return res;
  }

  public async patchWindowsShortcuts(targetPort: number = 9333): Promise<ShortcutPatchResult> {
    const emptyResult: ShortcutPatchResult = { newlyPatched: 0, alreadyPatched: 0, totalFound: 0 };
    if (process.platform !== 'win32') return emptyResult;
    return new Promise((resolve) => {
      const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
$dirs = @(
  "$env:USERPROFILE\\Desktop",
  "$env:PUBLIC\\Desktop",
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:ALLUSERSPROFILE\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar"
)
$flag = "--remote-debugging-port=${targetPort}"
$newly = 0
$already = 0
foreach ($dir in $dirs) {
  if (Test-Path $dir) {
    $files = Get-ChildItem -Path $dir -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue
    foreach ($file in $files) {
      try {
        $s = $WshShell.CreateShortcut($file.FullName)
        if ($file.Name -like "*Antigravity*" -or $s.TargetPath -like "*Antigravity*") {
          if ($s.Arguments -like "*$flag*") {
            $already++
          } else {
            $s.Arguments = ("$($s.Arguments) " + $flag).Trim()
            $s.Save()
            $newly++
          }
        }
      } catch {}
    }
  }
}
Write-Output "$newly,$already"
`;
      const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
      cp.exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`, (err, stdout) => {
        const parts = (stdout?.trim() || '0,0').split(',');
        const newly = parseInt(parts[0] || '0', 10) || 0;
        const already = parseInt(parts[1] || '0', 10) || 0;
        resolve({
          newlyPatched: newly,
          alreadyPatched: already,
          totalFound: newly + already
        });
      });
    });
  }

  public async findAntigravityExe(): Promise<string> {
    if (
      process.execPath &&
      !process.execPath.toLowerCase().endsWith('node') &&
      !process.execPath.toLowerCase().endsWith('node.exe') &&
      fs.existsSync(process.execPath)
    ) {
      return process.execPath;
    }
    if (process.platform === 'linux') {
      const linuxCandidates = [
        path.join(os.homedir(), '.local', 'bin', 'antigravity'),
        '/usr/bin/antigravity',
        '/usr/local/bin/antigravity',
        '/opt/Antigravity/antigravity'
      ];
      for (const c of linuxCandidates) {
        if (fs.existsSync(c)) return c;
      }
      return 'antigravity';
    }
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Antigravity IDE', 'Antigravity IDE.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Antigravity IDE', 'Antigravity IDE.exe')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }
    return 'Antigravity IDE.exe';
  }

  public async relaunchWithDebugPort(targetPort: number = 9333): Promise<void> {
    if (process.platform === 'win32') {
      // 1. Patch shortcuts so all future launches keep port 9333
      await this.patchWindowsShortcuts(targetPort);

      // 2. Locate the executable
      const exePath = await this.findAntigravityExe();

      // 3. Resolve active workspace
      let workspaceArg = '';
      if (vscode.workspace.workspaceFile) {
        workspaceArg = vscode.workspace.workspaceFile.fsPath;
      } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        workspaceArg = vscode.workspace.workspaceFolders[0].uri.fsPath;
      }

      // 4. Create an independent launcher .bat in temp directory
      const batPath = path.join(os.tmpdir(), `antigravity_relaunch_${Date.now()}.bat`);
      const targetArgs = workspaceArg ? `--remote-debugging-port=${targetPort} "${workspaceArg}"` : `--remote-debugging-port=${targetPort}`;
      const batContent = `@echo off\r\ntimeout /t 2 /nobreak >nul\r\nstart "" "${exePath}" ${targetArgs}\r\ndel "%~f0"\r\n`;
      fs.writeFileSync(batPath, batContent, 'utf8');

      // 5. Spawn via WMI to break out of VS Code's Windows Job Object
      const psCmd = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "${batPath}"' }`;
      const b64 = Buffer.from(psCmd, 'utf16le').toString('base64');
      try {
        cp.execSync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${b64}`, { windowsHide: true });
      } catch (e) {}

      // 6. Gracefully exit current IDE window
      await vscode.commands.executeCommand('workbench.action.quit');
    } else if (process.platform === 'linux') {
      await this.patchLinuxShortcuts(targetPort);
      const exePath = await this.findAntigravityExe();
      const args = [`--remote-debugging-port=${targetPort}`];
      if (vscode.workspace.workspaceFile) {
        args.push(vscode.workspace.workspaceFile.fsPath);
      } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        args.push(vscode.workspace.workspaceFolders[0].uri.fsPath);
      }
      try {
        const child = cp.spawn(exePath, args, {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
      } catch (e) {}
      await vscode.commands.executeCommand('workbench.action.quit');
    } else if (process.platform === 'darwin') {
      const args = ['-n', '-a', 'Antigravity', '--args', `--remote-debugging-port=${targetPort}`];
      if (vscode.workspace.workspaceFile) {
        args.push(vscode.workspace.workspaceFile.fsPath);
      } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        args.push(vscode.workspace.workspaceFolders[0].uri.fsPath);
      }
      try {
        const child = cp.spawn('open', args, {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
      } catch (e) {}
      await vscode.commands.executeCommand('workbench.action.quit');
    }
  }

  public async verifyPortAndNotify(): Promise<void> {
    const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
    const port = config.get<number>('autoAccept.cdpPort', 9333);
    const isOpen = await this.pingPort(port);
    if (isOpen) {
      vscode.window.showInformationMessage(`$(zap) Auto-Accept is ACTIVE (Debug Port ${port} connected).`);
    } else {
      const choice = await vscode.window.showWarningMessage(
        `$(zap) Auto-Accept is active for code edits, but Antigravity needs to be restarted with Debug Port ${port} to auto-click Run & Permission prompts.`,
        'Auto-Patch Shortcuts',
        'Dismiss'
      );
      if (choice === 'Auto-Patch Shortcuts') {
        await this.patchShortcuts(port);
        vscode.window.showInformationMessage(
          `$(check) Antigravity shortcuts patched with port ${port}! Please restart Antigravity to activate full auto-run.`,
          'Reload Window'
        ).then(action => {
          if (action === 'Reload Window') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
      }
    }
  }

  private async startEngines(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.cdpCheckTimer) {
      clearInterval(this.cdpCheckTimer);
      this.cdpCheckTimer = null;
    }

    const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
    const enableCdp = config.get<boolean>('autoAccept.enableCdpMode', true);

    if (enableCdp) {
      await this.checkCdpPort();
    }

    // If CDP port 9333 is open, CDP observer handles auto-accept directly without polling native commands
    if (this.isCdpAvailable) {
      this.broadcastCdpState(true);
      this.checkAndInjectCdp();
      this.cdpCheckTimer = setInterval(() => {
        this.checkAndInjectCdp();
      }, 5000);
      return;
    }

    // Layer 1 Fallback (Port 9333 closed): Poll native VS Code Commands
    const intervalMs = config.get<number>('autoAccept.pollIntervalMs', 800);
    this.pollTimer = setInterval(() => {
      this.runNativeCommands();
    }, Math.max(400, intervalMs));

    this.runNativeCommands();
  }

  private stopEngines(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.cdpCheckTimer) {
      clearInterval(this.cdpCheckTimer);
      this.cdpCheckTimer = null;
    }

    // Tell injected CDP scripts to pause
    this.broadcastCdpState(false);
  }

  /**
   * Layer 1: Execute native Antigravity accept commands safely and quietly
   */
  private async runNativeCommands(): Promise<void> {
    if (!this.isEnabled || this.isExecuting) return;
    this.isExecuting = true;

    // If CDP is available and active, CDP handles chat clicks without needing native command spam
    if (this.isCdpAvailable) {
      this.isExecuting = false;
      return;
    }

    // Only run safe, non-focus-stealing commands (never run hunk navigation commands that yank editor focus)
    const commandsToRun = [
      'antigravity.agent.acceptAgentStep',
      'antigravity.terminalCommand.run',
      'antigravity.terminalCommand.accept',
      'antigravity.command.accept'
    ];

    for (const cmd of commandsToRun) {
      try {
        await vscode.commands.executeCommand(cmd);
      } catch (err) {
        // Silently ignore when nothing is pending
      }
    }

    this.isExecuting = false;
  }

  /**
   * Layer 2: Seamlessly check port 9333 for CDP without crashing or throwing errors
   */
  private checkAndInjectCdp(): void {
    if (!this.isEnabled) return;

    const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
    const port = config.get<number>('autoAccept.cdpPort', 9333);

    const req = http.get(`http://127.0.0.1:${port}/json/list`, { timeout: 1500 }, (res) => {
      if (res.statusCode !== 200) return;

      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        try {
          const targets = JSON.parse(rawData);
          if (Array.isArray(targets)) {
            this.handleCdpTargets(targets);
          }
        } catch (e) {}
      });
    });

    req.on('error', () => {
      // Port is closed / not running with debugging port - totally fine, Layer 1 handles commands!
    });
  }

  private async handleCdpTargets(targets: any[]): Promise<void> {
    for (const target of targets) {
      const wsUrl = target.webSocketDebuggerUrl;
      if (!wsUrl) continue;

      // Target Workbench pages and Webviews
      const isCandidate = (target.type === 'page' || target.type === 'webview') &&
        !target.url?.includes('extension-output') &&
        !target.title?.includes('Developer Tools');

      if (!isCandidate) continue;

      if (this.cdpSockets.has(wsUrl)) {
        const client = this.cdpSockets.get(wsUrl);
        if (client && client.isConnected) {
          client.send({
            id: 2,
            method: 'Runtime.evaluate',
            params: {
              expression: `window.__AGY_AUTO_ACCEPT_ENABLED = ${this.isEnabled};\nwindow.__AGY_AUTO_ACCEPT_CHOICE = ${this.choice};\n${DOM_OBSERVER_SCRIPT}`
            }
          });
          continue;
        } else {
          this.cdpSockets.delete(wsUrl);
        }
      }

      try {
        const client = new PureCdpSocket(wsUrl);
        await client.connect();
        this.cdpSockets.set(wsUrl, client);

        const evalPayload = {
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: `window.__AGY_AUTO_ACCEPT_ENABLED = ${this.isEnabled};\nwindow.__AGY_AUTO_ACCEPT_CHOICE = ${this.choice};\n${DOM_OBSERVER_SCRIPT}`,
            returnByValue: false
          }
        };
        client.send(evalPayload);
      } catch (e) {}
    }
  }

  private broadcastCdpState(enabled: boolean): void {
    const expr = `window.__AGY_AUTO_ACCEPT_ENABLED = ${enabled};\nif (window.__AGY_SCAN_AND_CLICK) { window.__AGY_SCAN_AND_CLICK(); }`;
    const payload = {
      id: 99,
      method: 'Runtime.evaluate',
      params: { expression: expr }
    };

    for (const [wsUrl, client] of this.cdpSockets) {
      try {
        if (client.isConnected) {
          client.send(payload);
        } else {
          this.cdpSockets.delete(wsUrl);
        }
      } catch (e) {}
    }
  }

  public dispose(): void {
    this.stopEngines();
    for (const [, client] of this.cdpSockets) {
      try { client.close(); } catch (e) {}
    }
    this.cdpSockets.clear();
  }
}
