import * as vscode from 'vscode';
import { QuotaService } from '../quotaService';
import { TaskSessionService } from '../taskSessionService';
import { AutoAcceptService } from '../autoAcceptService';
import { ActivityLogEntry, AutoAcceptChoice, ParsedQuotaInfo } from '../types';
import { getAccountRepo, getAccountService } from '../accountsManager';
import { ExtensionConfig } from '../core/config/extension.config';
import { Account } from '../core/domain/models/account.model';

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
      'AI Model Limits & Accounts Autopilot',
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
      async (e) => {
        if (e.webviewPanel.visible) {
          this._quotaService.refresh(false).catch(() => {});
          await this.postAccountsUpdate();
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
              await this.postAccountsUpdate();
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
          case 'clearHistory': {
            const confirm = await vscode.window.showWarningMessage(
              'Are you sure you want to clear all tracked AI activity history logs?',
              'Clear All',
              'Cancel'
            );
            if (confirm === 'Clear All') {
              await this._taskSessionService.clearHistory();
            }
            break;
          }
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
              `Antigravity IDE will close and restart with Port ${port} to activate 100% Hands-free CDP Autopilot. Please ensure all your files are saved.`,
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
            const res = await this._autoAcceptService.patchShortcuts(port);
            if (res.newlyPatched > 0) {
              vscode.window.showInformationMessage(
                `Successfully patched ${res.newlyPatched} Antigravity shortcut(s) with --remote-debugging-port=${port}. Please close and reopen Antigravity to activate 100% Hands-free CDP Autopilot.`,
                'Dismiss'
              );
            } else if (res.alreadyPatched > 0) {
              vscode.window.showInformationMessage(
                `All ${res.alreadyPatched} Antigravity shortcut(s) already have --remote-debugging-port=${port}. Please close Antigravity completely and reopen it to activate Port ${port}.`,
                'Dismiss'
              );
            } else {
              vscode.window.showWarningMessage(
                `Could not automatically locate desktop shortcuts. Please launch Antigravity with: antigravity --remote-debugging-port=${port}`,
                'Dismiss'
              );
            }
            await this._autoAcceptService.checkCdpPort();
            this.updateContent();
            break;
          }
          case 'switchAccount': {
            const service = getAccountService();
            if (service && message.email) {
              try {
                await service.switchAccountWorkflow(message.email, { skipPrompt: true });
                vscode.window.showInformationMessage(`Successfully switched active account to ${message.email}`);
                await this.postAccountsUpdate();
                this._quotaService.refresh(true).catch(() => {});
              } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to switch account: ${err.message || err}`);
              }
            }
            break;
          }
          case 'refreshAccount': {
            const service = getAccountService();
            if (service) {
              try {
                await service.refreshBalancesWorkflow(true);
                await this.postAccountsUpdate();
              } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to refresh balances: ${err.message || err}`);
              }
            }
            break;
          }
          case 'refreshAllAccounts': {
            const service = getAccountService();
            if (service) {
              try {
                await service.refreshBalancesWorkflow(true);
                await this.postAccountsUpdate();
                vscode.window.showInformationMessage('Account balances refreshed successfully.');
              } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to refresh accounts: ${err.message || err}`);
              }
            }
            break;
          }
          case 'deleteAccount': {
            const service = getAccountService();
            if (service && message.email) {
              try {
                await service.removeAccountWorkflow(message.email);
                await this.postAccountsUpdate();
              } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to remove account: ${err.message || err}`);
              }
            }
            break;
          }
          case 'addAccount': {
            vscode.commands.executeCommand('antigravity-account.addAccount');
            break;
          }
          case 'toggleAutoRotate': {
            try {
              const config = vscode.workspace.getConfiguration('antigravityAccount');
              const current = config.get<boolean>('autoRotateEnabled', false);
              await config.update('autoRotateEnabled', !current, vscode.ConfigurationTarget.Global);
              await this.postAccountsUpdate();
            } catch (err: any) {
              vscode.window.showErrorMessage(`Failed to update auto-rotate setting: ${err.message || err}`);
            }
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

    // Accounts changed listener
    const accountService = getAccountService();
    if (accountService) {
      accountService.onAccountsChanged(() => {
        this.postAccountsUpdate().catch(() => {});
      });
    }
  }

  public async postAccountsUpdate() {
    try {
      const accountRepo = getAccountRepo();
      let accounts: Account[] = [];
      let activeEmail: string | null = null;
      if (accountRepo) {
        accounts = await accountRepo.getAllAccounts();
        activeEmail = await accountRepo.getActiveAccountEmail();
      }
      const isAutoRotate = ExtensionConfig.getInstance().isAutoRotateEnabled();
      this._panel.webview.postMessage({
        type: 'updateAccounts',
        accounts,
        activeEmail,
        isAutoRotate,
      });
    } catch (err) {}
  }

  public async updateContent() {
    const quota = this._quotaService.getLastQuotaInfo();
    const history = this._taskSessionService.getHistory();
    const todaySummary = this._taskSessionService.getTodaySummary();
    const autoAccept = this._autoAcceptService.getStatus();
    const autoChoice = this._autoAcceptService.getChoice();
    const isCdp = this._autoAcceptService.getIsCdpAvailable();

    const accountRepo = getAccountRepo();
    let accounts: Account[] = [];
    let activeEmail: string | null = null;
    if (accountRepo) {
      try {
        accounts = await accountRepo.getAllAccounts();
        activeEmail = await accountRepo.getActiveAccountEmail();
      } catch (err) {}
    }
    const isAutoRotate = ExtensionConfig.getInstance().isAutoRotateEnabled();

    this._panel.webview.html = this._getHtmlForWebview(
      this._panel.webview,
      quota,
      history,
      todaySummary,
      autoAccept,
      autoChoice,
      isCdp,
      accounts,
      activeEmail,
      isAutoRotate
    );
  }

  private _getHtmlForWebview(
    webview: vscode.Webview,
    quota: ParsedQuotaInfo | null,
    history: ActivityLogEntry[],
    todaySummary: any,
    autoAcceptEnabled: boolean = false,
    autoAcceptChoice: AutoAcceptChoice = 1,
    isCdpAvailable: boolean = false,
    accounts: Account[] = [],
    activeEmail: string | null = null,
    isAutoRotate: boolean = false
  ): string {
    const initialDataJson = JSON.stringify(quota || null);
    const initialHistoryJson = JSON.stringify(history || []);
    const initialSummaryJson = JSON.stringify(todaySummary || null);
    const initialAutoAcceptJson = JSON.stringify(autoAcceptEnabled);
    const initialAutoChoiceJson = JSON.stringify(autoAcceptChoice);
    const initialIsCdpJson = JSON.stringify(isCdpAvailable);
    const initialAccountsJson = JSON.stringify(accounts || []);
    const initialActiveEmailJson = JSON.stringify(activeEmail || null);
    const initialAutoRotateJson = JSON.stringify(isAutoRotate);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Model Limits & Accounts Autopilot</title>
  <style>
    :root {
      --bg-canvas: #0d1117;
      --bg-surface: #161b22;
      --bg-surface-raised: #1f242c;
      --bg-card: rgba(22, 27, 34, 0.85);
      --bg-card-hover: rgba(30, 36, 45, 0.95);
      --border-subtle: #21262d;
      --border-glow: #30363d;
      --border-focus: #58a6ff;
      --text-main: #f0f6fc;
      --text-muted: #8b949e;
      --text-dim: #6e7681;
      
      --accent-green: #238636;
      --accent-green-bright: #3fb950;
      --accent-green-glow: rgba(63, 185, 80, 0.25);
      
      --accent-blue: #58a6ff;
      --accent-blue-bright: #79c0ff;
      --accent-blue-glow: rgba(88, 166, 255, 0.2);
      
      --accent-purple: #8957e5;
      --accent-purple-bright: #bc8cff;
      --accent-purple-glow: rgba(188, 140, 255, 0.2);
      
      --accent-yellow: #d29922;
      --accent-yellow-bright: #e3b341;
      --accent-yellow-glow: rgba(210, 153, 34, 0.2);
      
      --accent-red: #da3633;
      --accent-red-bright: #f85149;
      --accent-red-glow: rgba(248, 81, 73, 0.2);

      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
      --radius-xl: 18px;
      --transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
      background-color: var(--vscode-editor-background, var(--bg-canvas));
      color: var(--vscode-editor-foreground, var(--text-main));
      padding: 24px 28px 48px;
      line-height: 1.5;
      font-size: 13px;
      letter-spacing: -0.01em;
    }

    .dashboard-container {
      max-width: 960px;
      margin: 0 auto;
    }

    /* Top Glass Header */
    .top-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border-subtle);
      margin-bottom: 20px;
      flex-wrap: wrap;
      gap: 16px;
    }

    .brand-group {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-icon-wrap {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-md);
      background: linear-gradient(135deg, rgba(88, 166, 255, 0.2), rgba(188, 140, 255, 0.25));
      border: 1px solid rgba(188, 140, 255, 0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--accent-purple-bright);
      box-shadow: 0 0 16px rgba(188, 140, 255, 0.15);
    }

    .brand-titles h1 {
      font-size: 19px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-main);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .brand-version-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 12px;
      background: rgba(88, 166, 255, 0.12);
      color: var(--accent-blue-bright);
      border: 1px solid rgba(88, 166, 255, 0.3);
    }

    .brand-status-line {
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 2px;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent-green-bright);
      box-shadow: 0 0 8px var(--accent-green-bright);
      display: inline-block;
    }

    .status-dot.offline {
      background: var(--accent-red-bright);
      box-shadow: 0 0 8px var(--accent-red-bright);
    }

    .header-quick-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
      font-size: 12px;
      font-weight: 600;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      cursor: pointer;
      transition: var(--transition);
      user-select: none;
      white-space: nowrap;
    }

    .btn:hover:not(:disabled) {
      transform: translateY(-1px);
    }

    .btn:active:not(:disabled) {
      transform: translateY(0);
    }

    .btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      transform: none !important;
    }

    .btn-primary {
      background: linear-gradient(180deg, #2ea043 0%, #238636 100%);
      color: #ffffff;
      border-color: rgba(240, 246, 252, 0.1);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    }

    .btn-primary:hover:not(:disabled) {
      background: linear-gradient(180deg, #3fb950 0%, #2ea043 100%);
      box-shadow: 0 0 12px rgba(63, 185, 80, 0.35);
    }

    .btn-secondary {
      background: var(--bg-surface);
      color: var(--text-main);
      border-color: var(--border-subtle);
    }

    .btn-secondary:hover:not(:disabled) {
      background: var(--bg-surface-raised);
      border-color: var(--border-glow);
    }

    .btn-purple {
      background: linear-gradient(180deg, #8957e5 0%, #6e40c9 100%);
      color: #ffffff;
      border-color: rgba(255, 255, 255, 0.1);
    }

    .btn-purple:hover:not(:disabled) {
      background: linear-gradient(180deg, #a371f7 0%, #8957e5 100%);
      box-shadow: 0 0 12px rgba(188, 140, 255, 0.35);
    }

    .btn-danger {
      background: rgba(248, 81, 73, 0.12);
      color: #ff7b72;
      border-color: rgba(248, 81, 73, 0.3);
    }

    .btn-danger:hover:not(:disabled) {
      background: rgba(248, 81, 73, 0.22);
      border-color: var(--accent-red-bright);
    }

    .btn-sm {
      padding: 5px 10px;
      font-size: 11px;
    }

    /* Active Account Pill in Header */
    .active-account-header-chip {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 12px;
      border-radius: 20px;
      background: rgba(88, 166, 255, 0.08);
      border: 1px solid rgba(88, 166, 255, 0.25);
      color: var(--text-main);
      font-size: 12px;
      cursor: pointer;
      transition: var(--transition);
    }

    .active-account-header-chip:hover {
      background: rgba(88, 166, 255, 0.15);
      border-color: var(--accent-blue-bright);
    }

    .account-avatar-sm {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--accent-blue);
      color: #0d1117;
      font-size: 10px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      text-transform: uppercase;
    }

    /* Navigation Tabs */
    .tab-bar {
      display: flex;
      gap: 6px;
      border-bottom: 1px solid var(--border-subtle);
      margin-bottom: 24px;
      overflow-x: auto;
      scrollbar-width: none;
    }

    .tab-bar::-webkit-scrollbar {
      display: none;
    }

    .tab-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: var(--transition);
      white-space: nowrap;
    }

    .tab-btn:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.03);
    }

    .tab-btn.active {
      color: var(--accent-blue-bright);
      border-bottom-color: var(--accent-blue-bright);
      background: rgba(88, 166, 255, 0.05);
    }

    .tab-badge {
      font-size: 11px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
    }

    .tab-btn.active .tab-badge {
      background: rgba(88, 166, 255, 0.2);
      color: var(--accent-blue-bright);
    }

    /* Tab Panes */
    .tab-pane {
      display: none;
      animation: fadeIn 0.2s ease-in-out;
    }

    .tab-pane.active {
      display: block;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Summary Metric Cards */
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 14px;
      margin-bottom: 26px;
    }

    .metric-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 16px 18px;
      position: relative;
      overflow: hidden;
      backdrop-filter: blur(12px);
      transition: var(--transition);
    }

    .metric-card:hover {
      border-color: var(--border-glow);
      background: var(--bg-card-hover);
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    }

    .metric-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--border-glow), transparent);
    }

    .metric-card.accent-green::before {
      background: linear-gradient(90deg, transparent, var(--accent-green-bright), transparent);
    }

    .metric-card.accent-purple::before {
      background: linear-gradient(90deg, transparent, var(--accent-purple-bright), transparent);
    }

    .metric-card.accent-blue::before {
      background: linear-gradient(90deg, transparent, var(--accent-blue-bright), transparent);
    }

    .metric-card.accent-yellow::before {
      background: linear-gradient(90deg, transparent, var(--accent-yellow-bright), transparent);
    }

    .metric-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }

    .metric-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .metric-icon {
      color: var(--text-dim);
    }

    .metric-value {
      font-size: 26px;
      font-weight: 700;
      color: var(--text-main);
      font-variant-numeric: tabular-nums;
      margin-bottom: 4px;
    }

    .metric-desc {
      font-size: 11px;
      color: var(--text-muted);
    }

    /* Model Quota Cards */
    .group-section {
      margin-bottom: 28px;
    }

    .group-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 12px;
      padding: 0 4px;
    }

    .group-title-wrap {
      display: flex;
      align-items: baseline;
      gap: 10px;
    }

    .group-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-main);
    }

    .group-desc {
      font-size: 12px;
      color: var(--text-muted);
    }

    .bucket-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 16px 20px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      backdrop-filter: blur(8px);
      transition: var(--transition);
      gap: 16px;
    }

    .bucket-card:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-glow);
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
    }

    .bucket-left {
      flex: 1;
      min-width: 0;
    }

    .bucket-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
      flex-wrap: wrap;
    }

    .bucket-name {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-main);
    }

    .bucket-window-badge {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 1px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
      border: 1px solid var(--border-subtle);
    }

    .bucket-desc {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }

    .bucket-reset-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 600;
      color: var(--accent-blue-bright);
      background: rgba(88, 166, 255, 0.1);
      border: 1px solid rgba(88, 166, 255, 0.25);
      padding: 3px 9px;
      border-radius: 12px;
    }

    .gauge-wrapper {
      display: flex;
      align-items: center;
      gap: 14px;
      flex-shrink: 0;
    }

    .gauge-percentage {
      font-size: 20px;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
      min-width: 52px;
      text-align: right;
    }

    .gauge-ring {
      position: relative;
      width: 48px;
      height: 48px;
    }

    .gauge-ring svg {
      transform: rotate(-90deg);
      width: 100%;
      height: 100%;
    }

    .gauge-bg {
      fill: none;
      stroke: #21262d;
      stroke-width: 4;
    }

    .gauge-progress {
      fill: none;
      stroke-width: 4;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.8s ease-in-out, stroke 0.3s ease;
      filter: drop-shadow(0 0 4px currentColor);
    }

    /* Accounts Tab */
    .accounts-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 18px;
      flex-wrap: wrap;
      gap: 12px;
    }

    .search-input-wrap {
      position: relative;
      flex: 1;
      max-width: 320px;
    }

    .search-input {
      width: 100%;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 7px 12px 7px 32px;
      color: var(--text-main);
      font-size: 12px;
      outline: none;
      transition: var(--transition);
    }

    .search-input:focus {
      border-color: var(--accent-blue);
      box-shadow: 0 0 0 2px var(--accent-blue-glow);
    }

    .search-icon {
      position: absolute;
      left: 10px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-dim);
      pointer-events: none;
    }

    .accounts-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .accounts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
      gap: 16px;
    }

    .account-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 18px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: var(--transition);
      position: relative;
      overflow: hidden;
    }

    .account-card:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-glow);
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    }

    .account-card.active-account {
      border-color: rgba(63, 185, 80, 0.6);
      box-shadow: 0 0 20px rgba(63, 185, 80, 0.12);
    }

    .account-card.active-account::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, #2ea043, #3fb950);
    }

    .account-card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }

    .account-info-wrap {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .account-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: linear-gradient(135deg, #1f6feb, #8957e5);
      color: #ffffff;
      font-size: 15px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      text-transform: uppercase;
      flex-shrink: 0;
      border: 2px solid rgba(255, 255, 255, 0.15);
    }

    .account-text-details {
      min-width: 0;
    }

    .account-name-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 2px;
    }

    .account-name {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-main);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .plan-badge {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 1px 6px;
      border-radius: 4px;
      background: rgba(188, 140, 255, 0.15);
      color: var(--accent-purple-bright);
      border: 1px solid rgba(188, 140, 255, 0.3);
    }

    .account-email {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .active-badge-tag {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      border-radius: 12px;
      background: rgba(63, 185, 80, 0.12);
      border: 1px solid rgba(63, 185, 80, 0.35);
      color: var(--accent-green-bright);
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    /* Account Balances Preview */
    .account-balances-box {
      background: rgba(0, 0, 0, 0.2);
      border-radius: var(--radius-sm);
      padding: 10px 12px;
      margin-bottom: 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .balance-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
    }

    .balance-model-name {
      color: var(--text-muted);
      font-weight: 500;
    }

    .balance-bar-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 140px;
    }

    .mini-progress-track {
      flex: 1;
      height: 5px;
      border-radius: 3px;
      background: #21262d;
      overflow: hidden;
    }

    .mini-progress-fill {
      height: 100%;
      border-radius: 3px;
      background: var(--accent-green-bright);
      transition: width 0.4s ease;
    }

    .balance-val {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-main);
      min-width: 34px;
      text-align: right;
    }

    .account-card-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 10px;
      border-top: 1px solid var(--border-subtle);
    }

    .account-last-sync {
      font-size: 11px;
      color: var(--text-dim);
    }

    .account-card-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Autopilot Tab */
    .autopilot-hero-card {
      background: linear-gradient(135deg, rgba(88, 166, 255, 0.08) 0%, rgba(188, 140, 255, 0.08) 100%);
      border: 1px solid rgba(88, 166, 255, 0.25);
      border-radius: var(--radius-xl);
      padding: 24px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      flex-wrap: wrap;
    }

    .autopilot-hero-info h2 {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-main);
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }

    .autopilot-hero-info p {
      font-size: 13px;
      color: var(--text-muted);
      max-width: 580px;
    }

    .autopilot-master-toggle {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .toggle-switch {
      position: relative;
      display: inline-block;
      width: 48px;
      height: 26px;
      cursor: pointer;
    }

    .toggle-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .slider {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: #30363d;
      transition: .24s cubic-bezier(0.16, 1, 0.3, 1);
      border-radius: 26px;
      border: 1px solid var(--border-subtle);
    }

    .slider:before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background-color: #f0f6fc;
      transition: .24s cubic-bezier(0.16, 1, 0.3, 1);
      border-radius: 50%;
    }

    input:checked + .slider {
      background-color: #238636;
      border-color: #2ea043;
      box-shadow: 0 0 12px rgba(63, 185, 80, 0.4);
    }

    input:checked + .slider:before {
      transform: translateX(22px);
    }

    .toggle-label {
      font-size: 13px;
      font-weight: 700;
      color: var(--text-main);
    }

    /* Option Cards Grid */
    .options-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(270px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }

    .option-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 18px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: var(--transition);
      cursor: pointer;
      position: relative;
    }

    .option-card:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-glow);
      transform: translateY(-2px);
    }

    .option-card.selected {
      border-color: var(--accent-blue-bright);
      background: rgba(88, 166, 255, 0.08);
      box-shadow: 0 0 20px rgba(88, 166, 255, 0.15);
    }

    .option-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 12px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      margin-bottom: 8px;
      display: inline-block;
      width: fit-content;
    }

    .option-badge.green {
      background: rgba(63, 185, 80, 0.12);
      color: var(--accent-green-bright);
      border: 1px solid rgba(63, 185, 80, 0.3);
    }

    .option-badge.purple {
      background: rgba(188, 140, 255, 0.15);
      color: var(--accent-purple-bright);
      border: 1px solid rgba(188, 140, 255, 0.3);
    }

    .option-badge.blue {
      background: rgba(88, 166, 255, 0.15);
      color: var(--accent-blue-bright);
      border: 1px solid rgba(88, 166, 255, 0.3);
    }

    .option-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 6px;
    }

    .option-desc {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.5;
      margin-bottom: 16px;
    }

    .option-card-action {
      margin-top: auto;
    }

    /* CDP Status & Relaunch Box */
    .cdp-status-box {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 18px 20px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }

    .cdp-status-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .cdp-pulse-indicator {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--accent-green-bright);
      box-shadow: 0 0 10px var(--accent-green-bright);
      flex-shrink: 0;
    }

    .cdp-pulse-indicator.offline {
      background: var(--accent-yellow-bright);
      box-shadow: 0 0 10px var(--accent-yellow-bright);
    }

    .cdp-status-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 2px;
    }

    .cdp-status-sub {
      font-size: 12px;
      color: var(--text-muted);
    }

    /* Activity History Tab */
    .history-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      gap: 12px;
      flex-wrap: wrap;
    }

    .history-stat-strip {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 12px;
      color: var(--text-muted);
    }

    .history-stat-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      border-radius: 12px;
      background: rgba(88, 166, 255, 0.1);
      color: var(--accent-blue-bright);
      font-weight: 600;
    }

    .history-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
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
      border-color: var(--border-glow);
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
      gap: 6px;
    }

    .history-item-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: var(--text-muted);
    }

    .history-item-stats {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }

    .history-pill {
      font-size: 12px;
      font-weight: 700;
      padding: 3px 9px;
      border-radius: 6px;
      background: rgba(248, 81, 73, 0.12);
      color: #ff7b72;
      border: 1px solid rgba(248, 81, 73, 0.3);
      font-variant-numeric: tabular-nums;
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
      padding-top: 12px;
      border-top: 1px solid var(--border-subtle);
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

    /* Error Banner */
    .error-banner {
      display: none;
      background: rgba(248, 81, 73, 0.12);
      border: 1px solid rgba(248, 81, 73, 0.35);
      color: #ff7b72;
      padding: 12px 16px;
      border-radius: var(--radius-md);
      margin-bottom: 20px;
      font-size: 13px;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .error-banner.visible {
      display: flex;
    }

    /* Info Footer */
    .info-footer {
      background: rgba(88, 166, 255, 0.04);
      border: 1px solid rgba(88, 166, 255, 0.15);
      border-radius: var(--radius-md);
      padding: 12px 16px;
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.6;
      margin-top: 28px;
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
  <div class="dashboard-container">
    <!-- Top Glass Header -->
    <header class="top-header">
      <div class="brand-group">
        <div class="brand-icon-wrap">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            <circle cx="12" cy="12" r="3" fill="currentColor"/>
          </svg>
        </div>
        <div class="brand-titles">
          <h1>
            AI Model Limits & Accounts
            <span class="brand-version-badge">v1.1.0</span>
          </h1>
          <div class="brand-status-line" id="connectionStatusLine">
            <span class="status-dot" id="statusDot"></span>
            <span id="connectionStatusText">Connected to Language Server</span>
          </div>
        </div>
      </div>

      <div class="header-quick-actions">
        <!-- Active Account Chip -->
        <div class="active-account-header-chip" id="activeAccountHeaderChip" onclick="switchTab('accounts')" title="Click to view & switch accounts">
          <div class="account-avatar-sm" id="headerAvatar">?</div>
          <span id="headerAccountEmail">Detecting Account...</span>
        </div>

        <button class="btn btn-secondary" onclick="openSettings()" title="Open Extension Configuration">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          Settings
        </button>

        <button class="btn btn-primary" onclick="refreshAll()" id="refreshBtn">
          <span id="refreshIcon">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
            </svg>
          </span>
          Refresh
        </button>
      </div>
    </header>

    <!-- Error Banner -->
    <div id="errorBanner" class="error-banner">
      <span id="errorMessage">Unable to connect to Antigravity Language Server.</span>
      <button class="btn btn-secondary btn-sm" onclick="refreshAll()">Try Again</button>
    </div>

    <!-- Navigation Tabs -->
    <nav class="tab-bar">
      <button class="tab-btn active" id="tabBtn-quotas" onclick="switchTab('quotas')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
        Quotas & Models
      </button>
      <button class="tab-btn" id="tabBtn-accounts" onclick="switchTab('accounts')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        Accounts Switcher
        <span class="tab-badge" id="accountsCountBadge">0</span>
      </button>
      <button class="tab-btn" id="tabBtn-autopilot" onclick="switchTab('autopilot')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        Autopilot & Permissions
        <span class="tab-badge" id="autoStatusBadge">OFF</span>
      </button>
      <button class="tab-btn" id="tabBtn-history" onclick="switchTab('history')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Activity History
        <span class="tab-badge" id="historyCountBadge">0</span>
      </button>
    </nav>

    <!-- TAB 1: QUOTAS & MODELS -->
    <div class="tab-pane active" id="tabPane-quotas">
      <!-- Summary Metrics Grid -->
      <div class="summary-grid" id="summaryMetricsGrid">
        <div class="metric-card accent-green">
          <div class="metric-header">
            <span class="metric-label">Weekly Quota</span>
            <span class="metric-icon">📅</span>
          </div>
          <div class="metric-value" id="weeklyAverageVal">--%</div>
          <div class="metric-desc" id="weeklyAverageDesc">Overall weekly models health</div>
        </div>

        <div class="metric-card accent-blue">
          <div class="metric-header">
            <span class="metric-label">5-Hour Quota</span>
            <span class="metric-icon">⚡</span>
          </div>
          <div class="metric-value" id="fiveHourAverageVal">--%</div>
          <div class="metric-desc" id="fiveHourAverageDesc">Short-term prompt window</div>
        </div>

        <div class="metric-card accent-purple">
          <div class="metric-header">
            <span class="metric-label">Fastest Reset</span>
            <span class="metric-icon">⏳</span>
          </div>
          <div class="metric-value" id="fastestResetVal">--</div>
          <div class="metric-desc" id="fastestResetDesc">Earliest window renewal</div>
        </div>

        <div class="metric-card accent-yellow">
          <div class="metric-header">
            <span class="metric-label">Active Plan</span>
            <span class="metric-icon">🛡️</span>
          </div>
          <div class="metric-value" id="userPlanVal">Free / Pro</div>
          <div class="metric-desc" id="userPlanDesc">Antigravity Tier</div>
        </div>
      </div>

      <!-- Quota Bucket Groups -->
      <div id="quotaContentArea"></div>

      <div class="info-footer">
        Within each model group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. Limits last significantly longer with concise prompts and cost-effective models.
      </div>
    </div>

    <!-- TAB 2: ACCOUNTS SWITCHER -->
    <div class="tab-pane" id="tabPane-accounts">
      <div class="accounts-toolbar">
        <div class="search-input-wrap">
          <span class="search-icon">🔍</span>
          <input type="text" class="search-input" id="accountSearchInput" placeholder="Filter accounts by email..." oninput="filterAccounts(this.value)">
        </div>
        <div class="accounts-actions">
          <button class="btn btn-secondary" onclick="toggleAutoRotate()" id="autoRotateToggleBtn" title="Toggle automatic account rotation on limit exhaustion">
            <span id="autoRotateIcon">🔄</span>
            <span id="autoRotateText">Auto-Rotate: OFF</span>
          </button>
          <button class="btn btn-secondary" onclick="refreshAllAccounts()" title="Refresh balances for all stored accounts">
            🔄 Refresh Balances
          </button>
          <button class="btn btn-purple" onclick="addAccount()" title="Connect a new Google / Antigravity account">
            + Add Account
          </button>
        </div>
      </div>

      <div class="accounts-grid" id="accountsGrid"></div>
    </div>

    <!-- TAB 3: AUTOPILOT & PERMISSIONS -->
    <div class="tab-pane" id="tabPane-autopilot">
      <!-- Master Autopilot Hero -->
      <div class="autopilot-hero-card">
        <div class="autopilot-hero-info">
          <h2>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-purple-bright);"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            Hands-Free Autopilot & Auto-Accept
          </h2>
          <p>
            Automatically approves file changes, test executions, and terminal commands created by the AI without manual interruption.
          </p>
        </div>
        <div class="autopilot-master-toggle">
          <label class="toggle-switch">
            <input type="checkbox" id="masterAutoAcceptToggle" onchange="toggleAutoAccept()">
            <span class="slider"></span>
          </label>
          <span class="toggle-label" id="masterAutoAcceptLabel">Paused</span>
        </div>
      </div>

      <!-- CDP Port 9333 Status Banner -->
      <div class="cdp-status-box" id="cdpStatusBox">
        <div class="cdp-status-left">
          <div class="cdp-pulse-indicator" id="cdpIndicator"></div>
          <div>
            <div class="cdp-status-title" id="cdpStatusTitle">Checking CDP Port 9333...</div>
            <div class="cdp-status-sub" id="cdpStatusSub">Enables true hands-free DOM auto-approval in Chat conversation.</div>
          </div>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <button class="btn btn-secondary btn-sm" onclick="patchShortcuts()" id="patchShortcutsBtn">
            Patch Shortcuts
          </button>
          <button class="btn btn-primary btn-sm" onclick="relaunchWithPort()" id="relaunchBtn">
            ⚡ Restart with Port 9333
          </button>
        </div>
      </div>

      <!-- Interactive 3-Option Chooser -->
      <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 12px;">Permission Mode Selection</h3>
      <div class="options-grid">
        <!-- Option 1 -->
        <div class="option-card" id="optionCard-1" onclick="selectOption(1)">
          <div>
            <span class="option-badge green">Native Engine</span>
            <div class="option-title">Option 1: Standard Auto</div>
            <div class="option-desc">
              Executes terminal commands and approves file modifications natively inside Antigravity IDE. Works out of the box with zero port or restart requirements.
            </div>
          </div>
          <div class="option-card-action">
            <button class="btn btn-secondary btn-sm" style="width: 100%;">
              <span id="optionBtnText-1">Select Option 1</span>
            </button>
          </div>
        </div>

        <!-- Option 2 -->
        <div class="option-card" id="optionCard-2" onclick="selectOption(2)">
          <div>
            <span class="option-badge blue">Smart Session</span>
            <div class="option-title">Option 2: In Conversation</div>
            <div class="option-desc">
              Automatically selects <i>"Allow in this conversation"</i> on permission dialogs. Maintains autonomy throughout your entire current task.
            </div>
          </div>
          <div class="option-card-action">
            <button class="btn btn-secondary btn-sm" style="width: 100%;">
              <span id="optionBtnText-2">Select Option 2</span>
            </button>
          </div>
        </div>

        <!-- Option 3 -->
        <div class="option-card" id="optionCard-3" onclick="selectOption(3)">
          <div>
            <span class="option-badge purple">Maximum Autonomy</span>
            <div class="option-title">Option 3: Always Allow</div>
            <div class="option-desc">
              Permanently selects <i>"Always allow"</i> radio options without ever prompting again. Ideal for long autonomous programming sessions.
            </div>
          </div>
          <div class="option-card-action">
            <button class="btn btn-secondary btn-sm" style="width: 100%;">
              <span id="optionBtnText-3">Select Option 3</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 4: ACTIVITY HISTORY -->
    <div class="tab-pane" id="tabPane-history">
      <div class="history-controls">
        <div class="search-input-wrap">
          <span class="search-icon">🔍</span>
          <input type="text" class="search-input" id="historySearchInput" placeholder="Search activity logs..." oninput="filterHistory(this.value)">
        </div>
        <div class="history-stat-strip">
          <span class="history-stat-pill" id="historyTodayPill">
            🔥 Today: 0 turns
          </span>
          <button class="btn btn-danger btn-sm" onclick="clearHistory()" title="Clear all recorded history">
            🗑️ Clear History
          </button>
        </div>
      </div>

      <div id="historyListArea"></div>

      <div class="pagination-bar" id="historyPaginationBar">
        <div class="pagination-info" id="historyPaginationInfo">Showing 0 of 0</div>
        <div class="pagination-controls">
          <button class="btn btn-secondary btn-sm" id="prevPageBtn" onclick="changeHistoryPage(-1)">← Prev</button>
          <span style="font-size: 12px; font-weight: 600;" id="pageIndicator">Page 1 of 1</span>
          <button class="btn btn-secondary btn-sm" id="nextPageBtn" onclick="changeHistoryPage(1)">Next →</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    // Initial State Injected from Extension
    let currentQuota = ${initialDataJson};
    let currentHistory = ${initialHistoryJson};
    let currentSummary = ${initialSummaryJson};
    let currentAutoAccept = ${initialAutoAcceptJson};
    let currentAutoChoice = ${initialAutoChoiceJson};
    let currentIsCdp = ${initialIsCdpJson};
    let currentAccounts = ${initialAccountsJson};
    let currentActiveEmail = ${initialActiveEmailJson};
    let currentIsAutoRotate = ${initialAutoRotateJson};

    let activeTab = 'quotas';
    let historySearchQuery = '';
    let accountSearchQuery = '';
    let currentHistoryPage = 1;
    const HISTORY_PAGE_SIZE = 10;

    // Tab Switching
    function switchTab(tabId) {
      activeTab = tabId;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

      const btn = document.getElementById('tabBtn-' + tabId);
      const pane = document.getElementById('tabPane-' + tabId);
      if (btn) btn.classList.add('active');
      if (pane) pane.classList.add('active');
    }

    // Refresh Action
    function refreshAll() {
      const btn = document.getElementById('refreshBtn');
      const icon = document.getElementById('refreshIcon');
      if (btn) btn.disabled = true;
      if (icon) icon.innerHTML = '<svg class="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9" stroke-dasharray="36" stroke-dashoffset="14"/></svg>';
      
      const statusText = document.getElementById('connectionStatusText');
      if (statusText) statusText.textContent = 'Discovering Language Server & refreshing...';

      vscode.postMessage({ command: 'refresh' });
      setTimeout(() => {
        if (btn) btn.disabled = false;
        if (icon) icon.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>';
      }, 5000);
    }

    function openSettings() {
      vscode.postMessage({ command: 'openSettings' });
    }

    function toggleAutoAccept() {
      vscode.postMessage({ command: 'toggleAutoAccept' });
    }

    function selectOption(choice) {
      if (!currentIsCdp && (choice === 2 || choice === 3)) {
        vscode.postMessage({ command: 'setAutoAcceptChoice', choice: 1 });
        return;
      }
      vscode.postMessage({ command: 'setAutoAcceptChoice', choice });
    }

    function relaunchWithPort() {
      vscode.postMessage({ command: 'relaunchWithPort' });
    }

    function patchShortcuts() {
      const btn = document.getElementById('patchShortcutsBtn');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Patching...';
      }
      vscode.postMessage({ command: 'patchShortcuts' });
    }

    function clearHistory() {
      vscode.postMessage({ command: 'clearHistory' });
    }

    function addAccount() {
      vscode.postMessage({ command: 'addAccount' });
    }

    function switchAccount(email) {
      vscode.postMessage({ command: 'switchAccount', email });
    }

    function refreshAccount(email) {
      vscode.postMessage({ command: 'refreshAccount', email });
    }

    function refreshAllAccounts() {
      vscode.postMessage({ command: 'refreshAllAccounts' });
    }

    function deleteAccount(email) {
      vscode.postMessage({ command: 'deleteAccount', email });
    }

    function toggleAutoRotate() {
      vscode.postMessage({ command: 'toggleAutoRotate' });
    }

    // Helper: Format Countdown
    function formatCountdown(resetIso) {
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
      if (f >= 0.65) return 'var(--accent-green-bright)';
      if (f >= 0.25) return 'var(--accent-yellow-bright)';
      return 'var(--accent-red-bright)';
    }

    // Render Quotas Tab
    function renderQuotas(quota) {
      const container = document.getElementById('quotaContentArea');
      const headerEmail = document.getElementById('headerAccountEmail');
      const headerAvatar = document.getElementById('headerAvatar');
      const statusDot = document.getElementById('statusDot');
      const statusText = document.getElementById('connectionStatusText');

      if (!quota || !quota.groups || quota.groups.length === 0) {
        if (container) container.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--text-muted); background: var(--bg-card); border-radius: var(--radius-lg); border: 1px dashed var(--border-subtle);">Connecting to Antigravity Language Server...</div>';
        return;
      }

      // Update Header info
      const email = quota.userEmail || currentActiveEmail || 'Unknown Account';
      if (headerEmail) headerEmail.textContent = email;
      if (headerAvatar) headerAvatar.textContent = email.charAt(0).toUpperCase();
      if (statusDot) statusDot.classList.remove('offline');
      if (statusText) statusText.textContent = 'Synced ' + new Date(quota.lastUpdated).toLocaleTimeString();

      // Calculate Summary Metrics
      let totalWeeklyFrac = 0, countWeekly = 0;
      let totalFiveFrac = 0, countFive = 0;
      let earliestReset: { time: number; str: string } | null = null;

      for (const g of quota.groups) {
        for (const b of g.buckets) {
          if (b.disabled) continue;
          const frac = typeof b.remainingFraction === 'number' ? b.remainingFraction : 1.0;
          if (b.window === 'weekly') {
            totalWeeklyFrac += frac;
            countWeekly++;
          } else {
            totalFiveFrac += frac;
            countFive++;
          }
          if (b.resetTime) {
            const t = new Date(b.resetTime).getTime();
            if (!earliestReset || t < earliestReset.time) {
              earliestReset = { time: t, str: b.resetTime };
            }
          }
        }
      }

      const avgWeeklyPct = countWeekly > 0 ? Math.round((totalWeeklyFrac / countWeekly) * 100) : 100;
      const avgFivePct = countFive > 0 ? Math.round((totalFiveFrac / countFive) * 100) : 100;

      const weeklyEl = document.getElementById('weeklyAverageVal');
      if (weeklyEl) weeklyEl.textContent = avgWeeklyPct + '%';
      const fiveEl = document.getElementById('fiveHourAverageVal');
      if (fiveEl) fiveEl.textContent = avgFivePct + '%';

      const resetEl = document.getElementById('fastestResetVal');
      if (resetEl) {
        resetEl.textContent = earliestReset ? formatCountdown(earliestReset.str) : 'Active';
      }

      const planEl = document.getElementById('userPlanVal');
      if (planEl) planEl.textContent = quota.planName ? quota.planName.toUpperCase() : 'PRO';

      // Render Groups and Buckets
      const circumference = 2 * Math.PI * 18;
      let html = '';

      for (const group of quota.groups) {
        html += '<div class="group-section">';
        html += '<div class="group-header">';
        html += '  <div class="group-title-wrap">';
        html += '    <span class="group-title">' + group.displayName + '</span>';
        if (group.description) {
          html += '    <span class="group-desc">(' + group.description + ')</span>';
        }
        html += '  </div>';
        html += '  <span style="font-size: 11px; color: var(--text-dim);">' + group.buckets.length + ' limit buckets</span>';
        html += '</div>';

        for (const bucket of group.buckets) {
          if (bucket.disabled) {
            html += '<div class="bucket-card" style="opacity: 0.65;">';
            html += '  <div class="bucket-left">';
            html += '    <div class="bucket-title-row">';
            html += '      <span class="bucket-name">' + bucket.displayName + '</span>';
            html += '      <span class="bucket-window-badge">Disabled</span>';
            html += '    </div>';
            html += '    <div class="bucket-desc">' + (bucket.description || 'Weekly quota limit reached') + '</div>';
            html += '  </div>';
            html += '</div>';
            continue;
          }

          const frac = typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : 1.0;
          const pct = Math.round(frac * 100);
          const color = getColorForFraction(frac);
          const offset = circumference * (1 - frac);
          const resetStr = bucket.resetTime ? formatCountdown(bucket.resetTime) : '';
          const windowTag = bucket.window === 'weekly' ? 'Weekly Window' : '5-Hour Window';

          html += '<div class="bucket-card">';
          html += '  <div class="bucket-left">';
          html += '    <div class="bucket-title-row">';
          html += '      <span class="bucket-name">' + bucket.displayName + '</span>';
          html += '      <span class="bucket-window-badge">' + windowTag + '</span>';
          html += '    </div>';
          html += '    <div class="bucket-desc">' + (bucket.description || 'Proportional token consumption') + '</div>';
          if (resetStr) {
            html += '    <div class="bucket-reset-badge">';
            html += '      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
            html += '      Resets in ' + resetStr;
            html += '    </div>';
          }
          html += '  </div>';
          html += '  <div class="gauge-wrapper">';
          html += '    <div class="gauge-percentage" style="color: ' + color + ';">' + pct + '%</div>';
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

    // Render Accounts Tab
    function renderAccounts(accounts, activeEmail, autoRotate) {
      const grid = document.getElementById('accountsGrid');
      const countBadge = document.getElementById('accountsCountBadge');
      const autoRotateText = document.getElementById('autoRotateText');
      const autoRotateBtn = document.getElementById('autoRotateToggleBtn');

      if (countBadge) countBadge.textContent = accounts ? accounts.length : '0';
      if (autoRotateText) autoRotateText.textContent = autoRotate ? 'Auto-Rotate: ON' : 'Auto-Rotate: OFF';
      if (autoRotateBtn) {
        if (autoRotate) {
          autoRotateBtn.classList.add('btn-primary');
          autoRotateBtn.classList.remove('btn-secondary');
        } else {
          autoRotateBtn.classList.remove('btn-primary');
          autoRotateBtn.classList.add('btn-secondary');
        }
      }

      if (!grid) return;

      const filtered = (accounts || []).filter(a => {
        if (!accountSearchQuery) return true;
        const q = accountSearchQuery.toLowerCase();
        return (a.email && a.email.toLowerCase().includes(q)) || (a.name && a.name.toLowerCase().includes(q)) || (a.alias && a.alias.toLowerCase().includes(q));
      });

      if (filtered.length === 0) {
        grid.innerHTML = \`
          <div style="grid-column: 1 / -1; padding: 48px; text-align: center; background: var(--bg-card); border-radius: var(--radius-lg); border: 1px dashed var(--border-subtle); color: var(--text-muted);">
            <div style="font-size: 32px; margin-bottom: 12px;">👤</div>
            <div style="font-size: 15px; font-weight: 700; color: var(--text-main); margin-bottom: 6px;">No Accounts Found</div>
            <div style="font-size: 12px; margin-bottom: 18px;">Connect a Google account to enable instant account switching and quota management.</div>
            <button class="btn btn-purple" onclick="addAccount()">+ Add Google Account</button>
          </div>
        \`;
        return;
      }

      let html = '';
      for (const acc of filtered) {
        const isActive = activeEmail && acc.email.toLowerCase() === activeEmail.toLowerCase();
        const initial = (acc.name || acc.email).charAt(0).toUpperCase();
        const planText = (acc.plan || 'Free').toUpperCase();

        // Model Balances Mini-bars
        let balancesHtml = '';
        if (acc.balances && Object.keys(acc.balances).length > 0) {
          const entries = Object.entries(acc.balances).slice(0, 3);
          for (const [mKey, mVal] of entries) {
            let val = 1.0;
            if (typeof mVal === 'number') val = mVal;
            else if (typeof mVal === 'object' && mVal && 'value' in mVal) val = mVal.value;
            const pct = Math.round(val * 100);
            const color = getColorForFraction(val);
            const cleanName = mKey.replace(/[-_]/g, ' ').replace(/(gemini|claude)/gi, '').trim();

            balancesHtml += \`
              <div class="balance-row">
                <span class="balance-model-name">\${cleanName || mKey}</span>
                <div class="balance-bar-wrap">
                  <div class="mini-progress-track">
                    <div class="mini-progress-fill" style="width: \${pct}%; background: \${color};"></div>
                  </div>
                  <span class="balance-val" style="color: \${color};">\${pct}%</span>
                </div>
              </div>
            \`;
          }
        } else {
          balancesHtml = '<div style="font-size: 11px; color: var(--text-dim); text-align: center;">No model quota cache available</div>';
        }

        html += \`
          <div class="account-card \${isActive ? 'active-account' : ''}">
            <div>
              <div class="account-card-header">
                <div class="account-info-wrap">
                  <div class="account-avatar">\${initial}</div>
                  <div class="account-text-details">
                    <div class="account-name-row">
                      <span class="account-name">\${acc.alias || acc.name || 'Antigravity User'}</span>
                      <span class="plan-badge">\${planText}</span>
                    </div>
                    <div class="account-email" title="\${acc.email}">\${acc.email}</div>
                  </div>
                </div>
                \${isActive ? '<span class="active-badge-tag">● Active</span>' : ''}
              </div>

              <div class="account-balances-box">
                \${balancesHtml}
              </div>
            </div>

            <div class="account-card-footer">
              <span class="account-last-sync">
                \${acc.lastRefreshedAt ? 'Synced ' + new Date(acc.lastRefreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Ready'}
              </span>
              <div class="account-card-actions">
                <button class="btn btn-secondary btn-sm" onclick="refreshAccount('\${acc.email}')" title="Refresh Quota Balances">
                  🔄
                </button>
                <button class="btn btn-danger btn-sm" onclick="deleteAccount('\${acc.email}')" title="Remove Account">
                  🗑️
                </button>
                \${!isActive ? \`
                  <button class="btn btn-primary btn-sm" onclick="switchAccount('\${acc.email}')" title="1-Click Switch Active Account">
                    ⚡ Switch
                  </button>
                \` : \`
                  <button class="btn btn-secondary btn-sm" disabled style="opacity: 0.6;">
                    ✓ In Use
                  </button>
                \`}
              </div>
            </div>
          </div>
        \`;
      }

      grid.innerHTML = html;
    }

    function filterAccounts(query) {
      accountSearchQuery = query;
      renderAccounts(currentAccounts, currentActiveEmail, currentIsAutoRotate);
    }

    // Render Autopilot Tab UI
    function renderAutopilot(autoEnabled, choice, isCdp) {
      const toggle = document.getElementById('masterAutoAcceptToggle');
      const toggleLabel = document.getElementById('masterAutoAcceptLabel');
      const autoBadge = document.getElementById('autoStatusBadge');

      if (toggle) toggle.checked = !!autoEnabled;
      if (toggleLabel) toggleLabel.textContent = autoEnabled ? 'ACTIVE' : 'PAUSED';
      if (autoBadge) {
        autoBadge.textContent = autoEnabled ? 'ON' : 'OFF';
        if (autoEnabled) {
          autoBadge.style.background = 'rgba(63, 185, 80, 0.2)';
          autoBadge.style.color = 'var(--accent-green-bright)';
        } else {
          autoBadge.style.background = 'rgba(255, 255, 255, 0.08)';
          autoBadge.style.color = 'var(--text-muted)';
        }
      }

      // Update CDP Indicator
      const cdpInd = document.getElementById('cdpIndicator');
      const cdpTitle = document.getElementById('cdpStatusTitle');
      const cdpSub = document.getElementById('cdpStatusSub');

      if (cdpInd && cdpTitle && cdpSub) {
        if (isCdp) {
          cdpInd.classList.remove('offline');
          cdpTitle.textContent = 'CDP Port 9333 Connected (100% Hands-Free)';
          cdpSub.textContent = 'Full DOM-level autopilot is active for Chat prompts & tools.';
        } else {
          cdpInd.classList.add('offline');
          cdpTitle.textContent = 'Standard Mode Active (Port 9333 Offline)';
          cdpSub.textContent = 'Auto-approves edits and commands. Relaunch with Port 9333 for 100% hands-free chat prompts.';
        }
      }

      // Update Option Cards selection
      for (let i = 1; i <= 3; i++) {
        const card = document.getElementById('optionCard-' + i);
        const btnText = document.getElementById('optionBtnText-' + i);
        if (card && btnText) {
          if (choice === i) {
            card.classList.add('selected');
            btnText.textContent = '✓ Active Preference';
          } else {
            card.classList.remove('selected');
            btnText.textContent = (i > 1 && !isCdp) ? 'Requires Port 9333' : 'Select Option ' + i;
          }
        }
      }
    }

    // Render Activity History Tab UI
    function renderHistory(history, summary) {
      const container = document.getElementById('historyListArea');
      const countBadge = document.getElementById('historyCountBadge');
      const todayPill = document.getElementById('historyTodayPill');
      const paginationInfo = document.getElementById('historyPaginationInfo');
      const pageIndicator = document.getElementById('pageIndicator');
      const prevBtn = document.getElementById('prevPageBtn');
      const nextBtn = document.getElementById('nextPageBtn');

      const all = history || [];
      if (countBadge) countBadge.textContent = all.length;

      if (todayPill) {
        if (summary && summary.logCountToday > 0) {
          todayPill.textContent = '🔥 Used Today: -' + summary.totalUsedTodayPct + '% across ' + summary.logCountToday + ' turns';
        } else {
          todayPill.textContent = '🔥 Total: ' + all.length + ' logged turns';
        }
      }

      if (!container) return;

      const filtered = all.filter(item => {
        if (!historySearchQuery) return true;
        const q = historySearchQuery.toLowerCase();
        return (item.promptTitle && item.promptTitle.toLowerCase().includes(q)) ||
               (item.groupName && item.groupName.toLowerCase().includes(q)) ||
               (item.bucketDisplayName && item.bucketDisplayName.toLowerCase().includes(q));
      });

      if (filtered.length === 0) {
        container.innerHTML = \`
          <div style="padding: 36px; text-align: center; color: var(--text-muted); background: var(--bg-card); border-radius: var(--radius-md); border: 1px dashed var(--border-subtle);">
            No quota activity recorded yet. As you prompt AI models, consumption will appear here automatically.
          </div>
        \`;
        if (paginationInfo) paginationInfo.textContent = 'Showing 0 of 0';
        return;
      }

      const totalItems = filtered.length;
      const totalPages = Math.ceil(totalItems / HISTORY_PAGE_SIZE) || 1;
      if (currentHistoryPage > totalPages) currentHistoryPage = totalPages;

      const startIdx = (currentHistoryPage - 1) * HISTORY_PAGE_SIZE;
      const pageItems = filtered.slice(startIdx, startIdx + HISTORY_PAGE_SIZE);

      let html = '';
      for (const item of pageItems) {
        const d = new Date(item.timestamp);
        const dateStr = d.toLocaleDateString();
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const pctUsed = item.usedPct.toFixed(1);
        const remPct = item.remainingPct.toFixed(1);
        const promptDisplay = item.promptTitle ? '"' + item.promptTitle + '"' : (item.groupName + ' · ' + item.bucketDisplayName);

        html += \`
          <div class="history-card">
            <div class="history-item-left">
              <div class="history-prompt-title" title="\${item.promptTitle ? item.promptTitle.replace(/"/g, '&quot;') : ''}">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-blue-bright); flex-shrink: 0;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                <span>\${promptDisplay}</span>
              </div>
              <div class="history-item-meta">
                <span>\${item.groupName} · \${item.bucketDisplayName}</span>
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

      container.innerHTML = html;

      if (paginationInfo) {
        paginationInfo.textContent = 'Showing ' + (startIdx + 1) + '–' + Math.min(startIdx + HISTORY_PAGE_SIZE, totalItems) + ' of ' + totalItems + ' activities';
      }
      if (pageIndicator) {
        pageIndicator.textContent = 'Page ' + currentHistoryPage + ' of ' + totalPages;
      }
      if (prevBtn) prevBtn.disabled = currentHistoryPage <= 1;
      if (nextBtn) nextBtn.disabled = currentHistoryPage >= totalPages;
    }

    function changeHistoryPage(delta) {
      currentHistoryPage += delta;
      renderHistory(currentHistory, currentSummary);
    }

    function filterHistory(query) {
      historySearchQuery = query;
      currentHistoryPage = 1;
      renderHistory(currentHistory, currentSummary);
    }

    // Event Listener for Messages from Extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'updateQuota') {
        currentQuota = msg.data;
        const errBanner = document.getElementById('errorBanner');
        if (errBanner) errBanner.classList.remove('visible');
        renderQuotas(currentQuota);
      } else if (msg.type === 'quotaError') {
        const errBanner = document.getElementById('errorBanner');
        const errMsg = document.getElementById('errorMessage');
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('connectionStatusText');
        if (errBanner && errMsg) {
          errMsg.textContent = msg.message || 'Unable to connect to Language Server.';
          errBanner.classList.add('visible');
        }
        if (statusDot) statusDot.classList.add('offline');
        if (statusText) statusText.textContent = 'Language Server Offline';
      } else if (msg.type === 'updateAccounts') {
        currentAccounts = msg.accounts;
        currentActiveEmail = msg.activeEmail;
        currentIsAutoRotate = msg.isAutoRotate;
        renderAccounts(currentAccounts, currentActiveEmail, currentIsAutoRotate);
        if (currentQuota) renderQuotas(currentQuota);
      } else if (msg.type === 'updateAutoAccept') {
        currentAutoAccept = msg.enabled;
        currentAutoChoice = msg.choice;
        renderAutopilot(currentAutoAccept, currentAutoChoice, currentIsCdp);
      } else if (msg.type === 'updateAutoAcceptChoice') {
        currentAutoChoice = msg.choice;
        renderAutopilot(currentAutoAccept, currentAutoChoice, currentIsCdp);
      } else if (msg.type === 'updateActivityHistory') {
        currentHistory = msg.history;
        currentSummary = msg.todaySummary;
        renderHistory(currentHistory, currentSummary);
      }
    });

    // Initial Renders
    renderQuotas(currentQuota);
    renderAccounts(currentAccounts, currentActiveEmail, currentIsAutoRotate);
    renderAutopilot(currentAutoAccept, currentAutoChoice, currentIsCdp);
    renderHistory(currentHistory, currentSummary);

    // Live local countdown ticker every 20 seconds
    setInterval(() => {
      if (currentQuota) renderQuotas(currentQuota);
    }, 20000);
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
