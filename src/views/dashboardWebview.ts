import * as vscode from 'vscode';
import { QuotaService } from '../quotaService';
import { TaskSessionService } from '../taskSessionService';
import { AutoAcceptService } from '../autoAcceptService';
import { ActivityLogEntry, AutoAcceptChoice, ParsedQuotaInfo } from '../types';

export class DashboardWebviewPanel {
  public static currentPanel: DashboardWebviewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _quotaService: QuotaService;
  private _taskSessionService: TaskSessionService;
  private _autoAcceptService: AutoAcceptService;
  private _onQuotaUpdatedHandler: (quota: ParsedQuotaInfo) => void;
  private _onQuotaErrorHandler: (err: Error) => void;

  public static createOrShow(
    extensionUri: vscode.Uri,
    quotaService: QuotaService,
    taskSessionService?: TaskSessionService,
    autoAcceptService?: AutoAcceptService
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DashboardWebviewPanel.currentPanel) {
      DashboardWebviewPanel.currentPanel._panel.reveal(column);
      DashboardWebviewPanel.currentPanel.updateContent();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'antigravityModelLimitDashboard',
      'AI Model Limits Dashboard',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    DashboardWebviewPanel.currentPanel = new DashboardWebviewPanel(
      panel,
      extensionUri,
      quotaService,
      taskSessionService || TaskSessionService.getInstance(),
      autoAcceptService || AutoAcceptService.getInstance()
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    quotaService: QuotaService,
    taskSessionService: TaskSessionService,
    autoAcceptService: AutoAcceptService
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._quotaService = quotaService;
    this._taskSessionService = taskSessionService;
    this._autoAcceptService = autoAcceptService;

    this.updateContent();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Refresh immediately whenever the dashboard panel becomes visible
    this._panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.visible) {
          this._quotaService.refresh(false).catch(() => {});
          this._panel.webview.postMessage({
            type: 'updateActivityHistory',
            history: this._taskSessionService.getHistory(),
            todaySummary: this._taskSessionService.getTodaySummary(),
          });
          this._panel.webview.postMessage({
            type: 'updateAutoAccept',
            enabled: this._autoAcceptService.getStatus(),
            choice: this._autoAcceptService.getChoice(),
          });
        }
      },
      null,
      this._disposables
    );

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'refresh':
            try {
              const res = await this._quotaService.refresh(true);
              if (res) {
                this._panel.webview.postMessage({
                  type: 'updateQuota',
                  data: res,
                });
                this._panel.webview.postMessage({
                  type: 'updateActivityHistory',
                  history: this._taskSessionService.getHistory(),
                  todaySummary: this._taskSessionService.getTodaySummary(),
                });
              }
            } catch (err: any) {
              this._panel.webview.postMessage({
                type: 'quotaError',
                message: err.message || 'Unable to connect to Language Server.',
              });
            }
            break;
          case 'openSettings':
            vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'antigravityLimitMonitor'
            );
            break;
          case 'clearHistory':
            await this._taskSessionService.clearHistory();
            break;
          case 'toggleAutoAccept':
            await this._autoAcceptService.toggle();
            break;
          case 'setAutoAcceptChoice':
            if (message.choice === 1 || message.choice === 2 || message.choice === 3) {
              await this._autoAcceptService.setChoice(message.choice as AutoAcceptChoice);
            }
            break;
          case 'relaunchWithPort': {
            const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
            const port = config.get<number>('autoAccept.cdpPort', 9333);
            const action = await vscode.window.showInformationMessage(
              `Antigravity IDE will close and restart with Port ${port} in 2 seconds to activate 100% Hands-free CDP Autopilot. Please ensure all your files are saved.`,
              'Restart Now',
              'Cancel'
            );
            if (action === 'Restart Now') {
              await this._autoAcceptService.relaunchWithDebugPort(port);
            }
            break;
          }
          case 'patchShortcuts': {
            const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
            const port = config.get<number>('autoAccept.cdpPort', 9333);
            const res = await this._autoAcceptService.patchWindowsShortcuts(port);
            if (res.newlyPatched > 0) {
              vscode.window.showInformationMessage(
                `Successfully patched ${res.newlyPatched} Antigravity shortcut(s) with --remote-debugging-port=${port}. Please close and reopen Antigravity from your Desktop or Start Menu shortcut to activate 100% Hands-free CDP Autopilot.`,
                'Dismiss'
              );
            } else if (res.alreadyPatched > 0) {
              vscode.window.showInformationMessage(
                `All ${res.alreadyPatched} Antigravity shortcut(s) on Desktop and Start Menu already have --remote-debugging-port=${port}. Please close Antigravity completely and reopen it from your Desktop or Start Menu shortcut to activate Port ${port}.`,
                'Dismiss'
              );
            } else {
              vscode.window.showWarningMessage(
                `Could not find Antigravity shortcuts on Desktop or Start Menu. Please launch Antigravity with: "Antigravity IDE.exe" --remote-debugging-port=${port}`,
                'Dismiss'
              );
            }
            await this._autoAcceptService.checkCdpPort();
            this.updateContent();
            break;
          }
        }
      },
      null,
      this._disposables
    );

    this._onQuotaUpdatedHandler = (quota: ParsedQuotaInfo) => {
      this._panel.webview.postMessage({
        type: 'updateQuota',
        data: quota,
      });
      this._panel.webview.postMessage({
        type: 'updateActivityHistory',
        history: this._taskSessionService.getHistory(),
        todaySummary: this._taskSessionService.getTodaySummary(),
      });
    };

    this._onQuotaErrorHandler = (err: Error) => {
      this._panel.webview.postMessage({
        type: 'quotaError',
        message: err.message || 'Unable to connect to Language Server.',
      });
    };

    this._quotaService.on('quotaUpdated', this._onQuotaUpdatedHandler);
    this._quotaService.on('error', this._onQuotaErrorHandler);

    // Task session / activity listeners
    const sendActivityUpdate = () => {
      this._panel.webview.postMessage({
        type: 'updateActivityHistory',
        history: this._taskSessionService.getHistory(),
        todaySummary: this._taskSessionService.getTodaySummary(),
      });
    };

    this._taskSessionService.on('activityLogged', sendActivityUpdate);
    this._taskSessionService.on('historyCleared', sendActivityUpdate);

    // Auto-Accept state change listeners
    const onAutoAcceptStateChanged = (enabled: boolean) => {
      this._panel.webview.postMessage({
        type: 'updateAutoAccept',
        enabled,
        choice: this._autoAcceptService.getChoice(),
      });
    };
    this._autoAcceptService.on('stateChanged', onAutoAcceptStateChanged);

    const onAutoAcceptChoiceChanged = (choice: AutoAcceptChoice) => {
      this._panel.webview.postMessage({
        type: 'updateAutoAcceptChoice',
        choice,
      });
    };
    this._autoAcceptService.on('choiceChanged', onAutoAcceptChoiceChanged);
  }

  public updateContent() {
    const quota = this._quotaService.getLastQuotaInfo();
    const history = this._taskSessionService.getHistory();
    const todaySummary = this._taskSessionService.getTodaySummary();
    const autoAccept = this._autoAcceptService.getStatus();
    const autoChoice = this._autoAcceptService.getChoice();
    const isCdp = this._autoAcceptService.getIsCdpAvailable();
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, quota, history, todaySummary, autoAccept, autoChoice, isCdp);
  }

  private _getHtmlForWebview(
    webview: vscode.Webview,
    quota: ParsedQuotaInfo | null,
    history: ActivityLogEntry[],
    todaySummary: any,
    autoAcceptEnabled: boolean = false,
    autoAcceptChoice: AutoAcceptChoice = 1,
    isCdpAvailable: boolean = false
  ): string {
    const initialDataJson = JSON.stringify(quota || null);
    const initialHistoryJson = JSON.stringify(history || []);
    const initialSummaryJson = JSON.stringify(todaySummary || null);
    const initialAutoAcceptJson = JSON.stringify(autoAcceptEnabled);
    const initialAutoChoiceJson = JSON.stringify(autoAcceptChoice);
    const initialIsCdpJson = JSON.stringify(isCdpAvailable);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Model Limits</title>
  <style>
    :root {
      --bg-primary: #121417;
      --bg-card: #1c1f24;
      --bg-card-hover: #22262d;
      --border-color: #2e343d;
      --text-main: #e6edf3;
      --text-muted: #8b949e;
      --accent-green: #3fb950;
      --accent-yellow: #d29922;
      --accent-red: #f85149;
      --accent-blue: #58a6ff;
      --accent-purple: #bc8cff;
      --radius: 12px;
      --transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--vscode-editor-background, var(--bg-primary));
      color: var(--vscode-editor-foreground, var(--text-main));
      padding: 24px 32px;
      line-height: 1.5;
    }

    .container {
      max-width: 840px;
      margin: 0 auto;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border-color);
    }

    .header-title {
      font-size: 22px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--text-main);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #238636;
      color: #ffffff;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: var(--transition);
    }

    .btn:hover:not(:disabled) {
      background: #2ea043;
      transform: translateY(-1px);
    }

    .btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none !important;
    }

    .btn-secondary {
      background: #21262d;
      color: var(--text-main);
      border: 1px solid var(--border-color);
    }

    .btn-secondary:hover:not(:disabled) {
      background: #30363d;
    }

    .auto-accept-group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .auto-accept-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 12px;
      font-size: 13px;
      border-radius: 6px;
      cursor: pointer;
      transition: var(--transition);
      user-select: none;
    }

    .auto-accept-btn.active {
      border-color: rgba(63, 185, 80, 0.6);
      background: rgba(63, 185, 80, 0.12);
      color: #3fb950;
    }

    .mini-toggle {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #484f58;
      transition: var(--transition);
      margin-left: 2px;
    }

    .auto-accept-btn.active .mini-toggle {
      background: #3fb950;
      box-shadow: 0 0 6px #3fb950;
    }

    .choice-select {
      background: var(--bg-card);
      color: var(--text-main);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      outline: none;
      transition: var(--transition);
    }

    .choice-select:hover {
      border-color: #444c56;
      background: var(--bg-card-hover);
    }

    .btn-patch-shortcuts {
      background: rgba(210, 153, 34, 0.15);
      color: #d29922;
      border: 1px solid rgba(210, 153, 34, 0.4);
      padding: 7px 11px;
      font-size: 12px;
      font-weight: 500;
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      transition: var(--transition);
      white-space: nowrap;
    }

    .btn-patch-shortcuts:hover:not(:disabled) {
      background: rgba(210, 153, 34, 0.25);
      border-color: #d29922;
      transform: translateY(-1px);
    }

    .cdp-status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 6px;
      background: rgba(63, 185, 80, 0.1);
      border: 1px solid rgba(63, 185, 80, 0.3);
      color: #3fb950;
      white-space: nowrap;
    }

    .badge-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #3fb950;
      box-shadow: 0 0 6px #3fb950;
    }

    .cdp-tip-banner {
      background: rgba(210, 153, 34, 0.08);
      border: 1px solid rgba(210, 153, 34, 0.25);
      border-radius: 8px;
      padding: 10px 16px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 12px;
      color: var(--text-main);
    }

    .cdp-tip-content strong {
      color: #d29922;
    }

    .cdp-tip-content code {
      background: rgba(255, 255, 255, 0.08);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 11px;
      color: #e6edf3;
    }

    .btn-warning-sm {
      background: rgba(210, 153, 34, 0.2);
      color: #d29922;
      border: 1px solid rgba(210, 153, 34, 0.4);
      padding: 5px 12px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      transition: var(--transition);
      white-space: nowrap;
    }

    .btn-warning-sm.active-btn {
      background: #238636;
      border-color: #2ea043;
      color: #ffffff;
    }

    .btn-warning-sm.active-btn:hover:not(:disabled) {
      background: #2ea043;
      border-color: #3fb950;
      transform: translateY(-1px);
    }

    .btn-warning-sm:hover:not(:disabled) {
      background: rgba(210, 153, 34, 0.35);
      border-color: #d29922;
      transform: translateY(-1px);
    }

    .choice-select:focus {
      border-color: var(--accent-blue);
      box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.2);
    }

    .btn-sm {
      padding: 4px 10px;
      font-size: 12px;
    }

    .error-banner {
      display: none;
      background: rgba(248, 81, 73, 0.12);
      border: 1px solid rgba(248, 81, 73, 0.35);
      color: #ff7b72;
      padding: 12px 16px;
      border-radius: var(--radius);
      margin-bottom: 20px;
      font-size: 13px;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .error-banner.visible {
      display: flex;
    }

    /* Model Limits Section */
    .group-section {
      margin-bottom: 32px;
    }

    .group-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 12px;
    }

    .group-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-main);
    }

    .group-desc {
      font-size: 12px;
      color: var(--text-muted);
    }

    .bucket-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: var(--radius);
      padding: 16px 20px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: var(--transition);
    }

    .bucket-card:hover {
      background: var(--bg-card-hover);
      border-color: #444c56;
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }

    .bucket-info {
      flex: 1;
      padding-right: 20px;
    }

    .bucket-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-main);
      margin-bottom: 4px;
    }

    .bucket-desc {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    .reset-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 500;
      color: var(--accent-blue);
      background: rgba(88, 166, 255, 0.12);
      padding: 2px 8px;
      border-radius: 12px;
    }

    .gauge-wrapper {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .gauge-percentage {
      font-size: 18px;
      font-weight: 700;
      min-width: 45px;
      text-align: right;
    }

    .gauge-ring {
      position: relative;
      width: 44px;
      height: 44px;
    }

    .gauge-ring svg {
      transform: rotate(-90deg);
      width: 100%;
      height: 100%;
    }

    .gauge-bg {
      fill: none;
      stroke: #2a313c;
      stroke-width: 3.5;
    }

    .gauge-progress {
      fill: none;
      stroke-width: 3.5;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.8s ease-in-out, stroke 0.3s ease;
      filter: drop-shadow(0 0 3px currentColor);
    }

    /* Activity History Section */
    .history-section {
      margin-top: 36px;
      border-top: 1px solid var(--border-color);
      padding-top: 24px;
    }

    .history-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
    }

    .history-title-wrap {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .history-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-main);
    }

    .history-stat-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      background: rgba(88, 166, 255, 0.12);
      color: var(--accent-blue);
      font-weight: 500;
    }

    .history-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      transition: var(--transition);
      gap: 16px;
    }

    .history-card:hover {
      background: var(--bg-card-hover);
      border-color: #444c56;
    }

    .history-item-left {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1;
      min-width: 0;
    }

    .history-prompt-title {
      font-weight: 600;
      color: var(--text-main);
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
    }

    .history-item-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: var(--text-muted);
    }

    .history-pill {
      font-size: 12px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 6px;
      background: rgba(248, 81, 73, 0.12);
      color: #ff7b72;
      border: 1px solid rgba(248, 81, 73, 0.3);
      font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace;
    }

    .history-remaining {
      font-size: 12px;
      color: var(--text-muted);
    }

    .pagination-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 16px;
      padding: 10px 4px 0 4px;
    }

    .pagination-info {
      font-size: 12px;
      color: var(--text-muted);
    }

    .pagination-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .info-footer {
      background: rgba(88, 166, 255, 0.05);
      border: 1px solid rgba(88, 166, 255, 0.2);
      border-radius: var(--radius);
      padding: 14px 18px;
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.6;
      margin-top: 24px;
    }

    .status-pill {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent-green);
      margin-right: 4px;
    }

    .status-pill.offline {
      background: var(--accent-red);
    }

    .last-sync {
      font-size: 12px;
      color: var(--text-muted);
    }

    .spin {
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1 class="header-title">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            <circle cx="12" cy="12" r="3" fill="currentColor"/>
          </svg>
          AI Model Limit Monitor
        </h1>
        <div class="last-sync" id="lastSyncText">Connecting to Language Server...</div>
      </div>
      <div class="header-actions">
        <div class="auto-accept-group">
          <button class="btn btn-secondary auto-accept-btn" id="autoAcceptToggleBtn" onclick="toggleAutoAccept()" title="Toggle Auto-Accept (Automatically approve file changes & run terminal commands)">
            <span id="autoAcceptIcon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px; margin-right: 3px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></span>
            <span id="autoAcceptText">Auto: OFF</span>
            <span class="mini-toggle" id="autoAcceptMiniToggle"></span>
          </button>
          <select class="choice-select" id="autoAcceptChoiceSelect" onchange="changeAutoAcceptChoice(this.value)" title="Auto-Accept Permission Preference">
            <option value="1">${isCdpAvailable ? 'Option 1: Allow once' : 'Option 1: Standard Auto (Native)'}</option>
            <option value="2" ${isCdpAvailable ? '' : 'disabled'}>Option 2: In conversation ${isCdpAvailable ? '' : '(Requires Port 9333)'}</option>
            <option value="3" ${isCdpAvailable ? '' : 'disabled'}>Option 3: Always allow ${isCdpAvailable ? '' : '(Requires Port 9333)'}</option>
          </select>
          ${!isCdpAvailable ? `
          <button class="btn-patch-shortcuts" id="relaunchBtn" onclick="relaunchWithPort()" title="1-Click: Patch shortcuts and automatically restart Antigravity with Port 9333">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px; margin-right: 4px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            Enable Port 9333 & Restart
          </button>
          ` : `
          <span class="cdp-status-badge" title="CDP 100% Hands-Free Autopilot is Connected on Port 9333">
            <span class="badge-dot"></span> CDP: Connected
          </span>
          `}
        </div>
        <button class="btn btn-secondary" onclick="openSettings()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          Settings
        </button>
        <button class="btn" onclick="refreshQuota()" id="refreshBtn">
          <span id="refreshIcon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
            </svg>
          </span>
          Refresh
        </button>
      </div>
    </div>

    ${!isCdpAvailable ? `
    <div class="cdp-tip-banner" id="cdpTipBanner">
      <div class="cdp-tip-content">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d29922" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -2px; margin-right: 6px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <strong>Standard Auto Active:</strong> For true 100% hands-free Auto-Run (auto-clicking prompts in Chat), launch Antigravity with <code>--remote-debugging-port=9333</code>.
      </div>
      <div style="display: flex; gap: 8px; align-items: center;">
        <button class="btn-warning-sm" onclick="patchShortcuts()" title="Patch Windows shortcuts to always start with port 9333">
          Patch Shortcuts Only
        </button>
        <button class="btn-warning-sm active-btn" onclick="relaunchWithPort()" title="Patch shortcuts and restart Antigravity with Port 9333 right now">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px; margin-right: 3px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          Restart with Port 9333
        </button>
      </div>
    </div>
    ` : ''}

    <div id="errorBanner" class="error-banner">
      <span id="errorMessage">Unable to connect to Antigravity Language Server.</span>
      <button class="btn btn-secondary btn-sm" onclick="refreshQuota()">Try Again</button>
    </div>

    <!-- Usage Limits Container -->
    <div id="contentArea"></div>

    <!-- Auto-Tracked Activity History Container -->
    <div id="historyArea"></div>

    <div class="info-footer" id="footerText">
      Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. Limits will last longer with shorter tasks or using more cost-effective models.
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentData = ${initialDataJson};
    let currentHistory = ${initialHistoryJson};
    let currentSummary = ${initialSummaryJson};
    let currentPage = 1;
    const PAGE_SIZE = 10;

    const SVG_REFRESH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>';
    const SVG_SPINNER = '<svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9" stroke-dasharray="36" stroke-dashoffset="14"/></svg>';
    const SVG_CLOCK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px; margin-right: 4px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
    const SVG_TRASH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    const SVG_SPARKLE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>';
    const SVG_CHAT = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -2px; margin-right: 5px; flex-shrink: 0; color: var(--accent-blue);"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    const SVG_FLAME = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px; margin-right: 4px;"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>';
    const SVG_USER = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -2px; margin-right: 4px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

    function setRefreshing(isRefreshing) {
      const btn = document.getElementById('refreshBtn');
      if (btn) {
        btn.disabled = isRefreshing;
        btn.innerHTML = isRefreshing
          ? SVG_SPINNER + ' Refreshing...'
          : SVG_REFRESH + ' Refresh';
      }
    }

    function refreshQuota() {
      setRefreshing(true);
      const syncEl = document.getElementById('lastSyncText');
      if (syncEl) {
        syncEl.innerHTML = '<span class="status-pill"></span> Discovering Language Server & refreshing quota...';
      }
      vscode.postMessage({ command: 'refresh' });
      setTimeout(() => {
        setRefreshing(false);
      }, 6000);
    }

    function openSettings() {
      vscode.postMessage({ command: 'openSettings' });
    }

    function clearHistory() {
      vscode.postMessage({ command: 'clearHistory' });
    }

    function changePage(delta) {
      const totalPages = Math.ceil((currentHistory || []).length / PAGE_SIZE) || 1;
      const newPage = currentPage + delta;
      if (newPage >= 1 && newPage <= totalPages) {
        currentPage = newPage;
        renderHistory(currentHistory, currentSummary);
      }
    }

    function formatTimeUntilReset(resetIso) {
      if (!resetIso) return '';
      const target = new Date(resetIso);
      const diffMs = target - new Date();
      if (diffMs <= 0) return 'Resetting now';

      const totalMins = Math.floor(diffMs / 60000);
      const days = Math.floor(totalMins / 1440);
      const hours = Math.floor((totalMins % 1440) / 60);
      const mins = totalMins % 60;

      const parts = [];
      if (days > 0) parts.push(days + 'd');
      if (hours > 0 || days > 0) parts.push(hours + 'h');
      parts.push(mins + 'm');
      return parts.join(' ');
    }

    function getColorForFraction(f) {
      if (f <= 0) return '#484f58';
      if (f >= 0.7) return 'var(--accent-green)';
      if (f >= 0.3) return 'var(--accent-yellow)';
      return 'var(--accent-red)';
    }

    function renderHistory(history, summary) {
      const container = document.getElementById('historyArea');
      if (!container) return;

      if (!history || history.length === 0) {
        container.innerHTML = \`
          <div class="history-section">
            <div class="history-header">
              <div class="history-title-wrap">
                <span class="history-title">\${SVG_CLOCK} Auto-Tracked Activity Log</span>
                <span class="history-stat-badge">Auto-Logging Active</span>
              </div>
            </div>
            <div style="padding: 24px; text-align: center; color: var(--text-muted); background: var(--bg-card); border: 1px dashed var(--border-color); border-radius: var(--radius); font-size: 13px;">
              No AI quota consumption recorded yet. When you prompt AI models, consumption per turn will appear here automatically (up to 1,000 logs).
            </div>
          </div>
        \`;
        return;
      }

      const totalItems = history.length;
      const totalPages = Math.ceil(totalItems / PAGE_SIZE) || 1;
      if (currentPage > totalPages) currentPage = totalPages;

      const startIdx = (currentPage - 1) * PAGE_SIZE;
      const pageItems = history.slice(startIdx, startIdx + PAGE_SIZE);

      let itemsHtml = '';
      for (const item of pageItems) {
        const d = new Date(item.timestamp);
        const dateStr = d.toLocaleDateString();
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const pctUsed = item.usedPct.toFixed(1);
        const remPct = item.remainingPct.toFixed(1);
        const promptDisplay = item.promptTitle ? '"' + item.promptTitle + '"' : (item.groupName + ' · ' + item.bucketDisplayName);

        itemsHtml += \`
          <div class="history-card">
            <div class="history-item-left">
              <div class="history-prompt-title" title="\${item.promptTitle ? item.promptTitle.replace(/"/g, '&quot;') : ''}">
                \${SVG_CHAT}
                <span>\${promptDisplay}</span>
              </div>
              <div class="history-item-meta">
                <span>\${SVG_SPARKLE} \${item.groupName} · \${item.bucketDisplayName}</span>
                <span>•</span>
                <span>\${dateStr} \${timeStr}</span>
              </div>
            </div>
            <div class="history-item-stats">
              <span class="history-remaining">Remaining: <b>\${remPct}%</b></span>
              <span class="history-pill">-\${pctUsed}%</span>
            </div>
          </div>
        \`;
      }

      const todayStats = summary && summary.logCountToday > 0
        ? \`\${SVG_FLAME} Used Today: -\${summary.totalUsedTodayPct}% across \${summary.logCountToday} turns\`
        : \`Total: \${totalItems} logs\`;

      const prevDisabled = currentPage <= 1 ? 'disabled' : '';
      const nextDisabled = currentPage >= totalPages ? 'disabled' : '';

      container.innerHTML = \`
        <div class="history-section">
          <div class="history-header">
            <div class="history-title-wrap">
              <span class="history-title">\${SVG_CLOCK} Auto-Tracked Activity Log</span>
              <span class="history-stat-badge">\${todayStats}</span>
            </div>
            <button class="btn btn-secondary btn-sm" onclick="clearHistory()" title="Clear 1,000 History Logs">
              \${SVG_TRASH} Clear History
            </button>
          </div>
          \${itemsHtml}
          <div class="pagination-bar">
            <div class="pagination-info">
              Showing \${startIdx + 1}–\${Math.min(startIdx + PAGE_SIZE, totalItems)} of \${totalItems} activities (Max 1,000)
            </div>
            <div class="pagination-controls">
              <button class="btn btn-secondary btn-sm" onclick="changePage(-1)" \${prevDisabled}>
                &larr; Prev
              </button>
              <span style="font-size: 12px; color: var(--text-main); font-weight: 500;">
                Page \${currentPage} of \${totalPages}
              </span>
              <button class="btn btn-secondary btn-sm" onclick="changePage(1)" \${nextDisabled}>
                Next &rarr;
              </button>
            </div>
          </div>
        </div>
      \`;
    }

    function render(data) {
      const container = document.getElementById('contentArea');
      const syncEl = document.getElementById('lastSyncText');
      if (!data || !data.groups || data.groups.length === 0) {
        container.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--text-muted);">Waiting for quota data from Language Server...</div>';
        return;
      }

      if (syncEl && data.lastUpdated) {
        const d = new Date(data.lastUpdated);
        const emailStr = data.userEmail ? ' · ' + SVG_USER + data.userEmail + (data.planName ? ' (' + data.planName + ')' : '') : '';
        syncEl.innerHTML = '<span class="status-pill"></span> Last updated: ' + d.toLocaleTimeString() + emailStr;
      }

      const circumference = 2 * Math.PI * 18; // radius 18 => ~113.1
      let html = '';

      for (const group of data.groups) {
        html += '<div class="group-section">';
        html += '<div class="group-header">';
        html += '<span class="group-title">' + group.displayName + '</span>';
        if (group.description) {
          html += '<span class="group-desc">(' + group.description + ')</span>';
        }
        html += '</div>';

        for (const bucket of group.buckets) {
          if (bucket.disabled) {
            html += '<div class="bucket-card" style="opacity: 0.85;">';
            html += '  <div class="bucket-info">';
            html += '    <div class="bucket-name">' + bucket.displayName + '</div>';
            html += '    <div class="bucket-desc">' + (bucket.description || '') + '</div>';
            html += '  </div>';
            html += '</div>';
            continue;
          }

          const frac = typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : 1.0;
          const pct = Math.round(frac * 100);
          const color = getColorForFraction(frac);
          const offset = circumference * (1 - frac);
          const resetStr = bucket.resetTime ? formatTimeUntilReset(bucket.resetTime) : '';

          html += '<div class="bucket-card">';
          html += '  <div class="bucket-info">';
          html += '    <div class="bucket-name">' + bucket.displayName + '</div>';
          html += '    <div class="bucket-desc">' + (bucket.description || '') + '</div>';
          if (resetStr) {
            html += '    <div class="reset-badge">' + SVG_CLOCK + 'Resets in ' + resetStr + '</div>';
          }
          html += '  </div>';
          html += '  <div class="gauge-wrapper">';
          html += '    <div class="gauge-percentage" style="color: ' + (pct === 0 ? 'var(--text-muted)' : color) + ';">' + pct + '%</div>';
          html += '    <div class="gauge-ring">';
          html += '      <svg viewBox="0 0 44 44">';
          html += '        <circle class="gauge-bg" cx="22" cy="22" r="18"/>';
          html += '        <circle class="gauge-progress" cx="22" cy="22" r="18" ';
          html += '          stroke="' + color + '" ';
          html += '          stroke-dasharray="' + circumference + '" ';
          html += '          stroke-dashoffset="' + offset + '"/>';
          html += '      </svg>';
          html += '    </div>';
          html += '  </div>';
          html += '</div>';
        }

        html += '</div>';
      }

      container.innerHTML = html;
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'updateQuota') {
        currentData = msg.data;
        const errBanner = document.getElementById('errorBanner');
        if (errBanner) errBanner.classList.remove('visible');
        setRefreshing(false);
        render(currentData);
      } else if (msg.type === 'quotaError') {
        setRefreshing(false);
        const errBanner = document.getElementById('errorBanner');
        const errMsg = document.getElementById('errorMessage');
        const syncEl = document.getElementById('lastSyncText');
        if (errBanner && errMsg) {
          errMsg.textContent = msg.message || 'Unable to connect to Language Server.';
          errBanner.classList.add('visible');
        }
        if (syncEl) {
          syncEl.innerHTML = '<span class="status-pill offline"></span> Connection Offline';
        }
      } else if (msg.type === 'updateActivityHistory') {
        currentHistory = msg.history;
        currentSummary = msg.todaySummary;
        renderHistory(currentHistory, currentSummary);
      } else if (msg.type === 'updateAutoAccept') {
        updateAutoAcceptUI(msg.enabled, msg.choice);
      } else if (msg.type === 'updateAutoAcceptChoice') {
        updateAutoAcceptUI(undefined, msg.choice);
      }
    });

    let currentAutoAccept = ${initialAutoAcceptJson};
    let currentAutoChoice = ${initialAutoChoiceJson};
    let currentIsCdp = ${initialIsCdpJson};

    function relaunchWithPort() {
      vscode.postMessage({ command: 'relaunchWithPort' });
    }

    function patchShortcuts() {
      const btns = document.querySelectorAll('.btn-patch-shortcuts, #patchShortcutsBtn, .btn-warning-sm');
      btns.forEach(b => {
        b.disabled = true;
        b.innerText = 'Patching...';
      });
      vscode.postMessage({ command: 'patchShortcuts' });
    }

    function toggleAutoAccept() {
      vscode.postMessage({ command: 'toggleAutoAccept' });
    }

    function changeAutoAcceptChoice(val) {
      const choice = parseInt(val, 10);
      if (!currentIsCdp && (choice === 2 || choice === 3)) {
        const sel = document.getElementById('autoAcceptChoiceSelect');
        if (sel) sel.value = '1';
        vscode.postMessage({ command: 'setAutoAcceptChoice', choice: 1 });
        return;
      }
      if (choice === 1 || choice === 2 || choice === 3) {
        currentAutoChoice = choice;
        vscode.postMessage({ command: 'setAutoAcceptChoice', choice });
      }
    }

    function updateAutoAcceptUI(enabled, choice) {
      if (enabled !== undefined) {
        currentAutoAccept = !!enabled;
        const btn = document.getElementById('autoAcceptToggleBtn');
        const txt = document.getElementById('autoAcceptText');
        if (btn && txt) {
          if (currentAutoAccept) {
            btn.classList.add('active');
            txt.textContent = 'Auto: ON';
          } else {
            btn.classList.remove('active');
            txt.textContent = 'Auto: OFF';
          }
        }
      }
      if (choice !== undefined) {
        currentAutoChoice = choice;
        const sel = document.getElementById('autoAcceptChoiceSelect');
        if (sel) {
          sel.value = String(choice);
        }
      }
    }

    // Initial render
    render(currentData);
    renderHistory(currentHistory, currentSummary);
    updateAutoAcceptUI(currentAutoAccept, currentAutoChoice);

    // Live local countdown timer update every 30s
    setInterval(() => {
      if (currentData) render(currentData);
    }, 30000);
  </script>
</body>
</html>`;
  }

  public dispose() {
    this._quotaService.off('quotaUpdated', this._onQuotaUpdatedHandler);
    this._quotaService.off('error', this._onQuotaErrorHandler);
    DashboardWebviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}
