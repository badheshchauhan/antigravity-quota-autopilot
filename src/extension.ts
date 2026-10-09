import * as vscode from 'vscode';
import { QuotaService } from './quotaService';
import { TaskSessionService } from './taskSessionService';
import { AutoAcceptService } from './autoAcceptService';
import { StatusBarManager } from './views/statusBar';
import { QuotaTreeDataProvider } from './views/sidebarProvider';
import { DashboardWebviewPanel } from './views/dashboardWebview';
import { ParsedQuotaInfo, AutoAcceptChoice } from './types';
import { activateAccounts, deactivateAccounts } from './accountsManager';
export * from './api/extension-api';

let quotaService: QuotaService;
let taskSessionService: TaskSessionService;
let autoAcceptService: AutoAcceptService;
let statusBarManager: StatusBarManager;
let treeDataProvider: QuotaTreeDataProvider;
let hasAlertedForLowQuota = false;

export async function activate(context: vscode.ExtensionContext) {
  // ── Initialize Antigravity Accounts Manager ──
  try {
    await activateAccounts(context);
  } catch (err) {
    console.error('Failed to activate Antigravity Account Manager:', err);
  }

  quotaService = QuotaService.getInstance();
  taskSessionService = TaskSessionService.getInstance(context.globalState, quotaService);
  autoAcceptService = AutoAcceptService.getInstance(context.globalState);
  statusBarManager = new StatusBarManager(quotaService, taskSessionService, autoAcceptService);
  treeDataProvider = new QuotaTreeDataProvider(quotaService, autoAcceptService);

  // Register Tree View in Activity Bar
  try {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider(
        'badheshLimitMonitorView',
        treeDataProvider
      )
    );
  } catch (err) {
    console.warn('Failed to register tree view, continuing activation...', err);
  }

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityLimitMonitor.refresh', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Refreshing AI model limits...',
          cancellable: false,
        },
        async () => {
          try {
            const quota = await quotaService.refresh(true);
            if (quota) {
              vscode.window.showInformationMessage(
                `AI Limits refreshed successfully at ${quota.lastUpdated.toLocaleTimeString()}`
              );
            } else {
              const choice = await vscode.window.showErrorMessage(
                'Unable to retrieve AI model limits from Language Server.',
                'Open Logs'
              );
              if (choice === 'Open Logs') {
                quotaService.showOutputChannel();
              }
            }
          } catch (err: any) {
            const choice = await vscode.window.showErrorMessage(
              `Failed to refresh AI model limits: ${err.message || err}`,
              'Open Logs'
            );
            if (choice === 'Open Logs') {
              quotaService.showOutputChannel();
            }
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityLimitMonitor.showDashboard', () => {
      DashboardWebviewPanel.createOrShow(context.extensionUri, quotaService, taskSessionService, autoAcceptService);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityLimitMonitor.toggleAutoAccept', async () => {
      await autoAcceptService.toggle();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityLimitMonitor.setAutoAcceptChoice', async () => {
      const isCdpAvailable = await autoAcceptService.checkCdpPort();
      const currentChoice = autoAcceptService.getChoice();

      const items = [
        {
          label: isCdpAvailable
            ? '$(check) Option 1: Allow this time (Once)'
            : '$(check) Option 1: Standard Auto (Native Engine)',
          description: currentChoice === 1 ? '[Active]' : '',
          detail: isCdpAvailable
            ? 'Auto-approves individual terminal commands and file edits one at a time'
            : 'Auto-executes terminal commands and file edits via IDE native engine (No Port 9333 required)',
          choice: 1 as AutoAcceptChoice,
          disabled: false,
        },
        {
          label: isCdpAvailable
            ? '$(comment-discussion) Option 2: Allow in this conversation (Recommended)'
            : '$(lock) Option 2: In conversation [Requires Debug Port 9333]',
          description: currentChoice === 2 ? '[Active]' : (isCdpAvailable ? '' : '[Locked]'),
          detail: isCdpAvailable
            ? 'Auto-approves operations throughout the active chat conversation'
            : 'Requires Antigravity IDE launched with --remote-debugging-port=9333 to auto-select dialog options',
          choice: 2 as AutoAcceptChoice,
          disabled: !isCdpAvailable,
        },
        {
          label: isCdpAvailable
            ? '$(shield) Option 3: Always allow (Permanent)'
            : '$(lock) Option 3: Always allow [Requires Debug Port 9333]',
          description: currentChoice === 3 ? '[Active]' : (isCdpAvailable ? '' : '[Locked]'),
          detail: isCdpAvailable
            ? 'Permanent approval without asking again'
            : 'Requires Antigravity IDE launched with --remote-debugging-port=9333 for DOM-level auto-selection',
          choice: 3 as AutoAcceptChoice,
          disabled: !isCdpAvailable,
        },
      ];

      const modeTitle = isCdpAvailable ? 'CDP Mode' : 'Standard Mode';
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Select Auto-Accept Option (Current: Option ${currentChoice} · ${modeTitle})`,
      });

      if (selected) {
        if (selected.disabled) {
          vscode.window.showWarningMessage(
            `Option ${selected.choice} requires Antigravity IDE to be launched with --remote-debugging-port=9333. You can continue using Standard Auto without any port.`,
            'Auto-Patch Shortcuts',
            'Dismiss'
          ).then(async (action) => {
            if (action === 'Auto-Patch Shortcuts') {
              const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
              const port = config.get<number>('autoAccept.cdpPort', 9333);
              const res = await autoAcceptService.patchShortcuts(port);
              if (res.newlyPatched > 0) {
                vscode.window.showInformationMessage(
                  `Antigravity shortcuts patched with port ${port}. Please close and reopen Antigravity to activate CDP Autopilot.`
                );
              } else if (res.alreadyPatched > 0) {
                vscode.window.showInformationMessage(
                  `All ${res.alreadyPatched} Antigravity shortcuts already have port ${port}. Please close Antigravity completely and reopen it to activate Port ${port}.`
                );
              }
            }
          });
          return;
        }

        await autoAcceptService.setChoice(selected.choice, true);
        vscode.window.setStatusBarMessage(
          `$(zap) Auto-Accept set to Option ${selected.choice} (${autoAcceptService.getChoiceLabel(selected.choice)})`,
          3000
        );
      }
    })
  );

  // Direct option selection commands from status bar hover tooltip links
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityLimitMonitor.selectOpt1', async () => {
      await autoAcceptService.setChoice(1, true);
      const isCdp = autoAcceptService.getIsCdpAvailable();
      const label = isCdp ? 'Option 1: Allow once' : 'Option 1: Standard Auto';
      vscode.window.setStatusBarMessage(`$(zap) Auto-Accept set to ${label}`, 3000);
    }),
    vscode.commands.registerCommand('antigravityLimitMonitor.selectOpt2', async () => {
      const isCdp = await autoAcceptService.checkCdpPort();
      if (!isCdp) {
        vscode.window.showWarningMessage(
          'Option 2 (In conversation) requires Antigravity IDE to be launched with --remote-debugging-port=9333.',
          'Dismiss'
        );
        return;
      }
      await autoAcceptService.setChoice(2, true);
      vscode.window.setStatusBarMessage('$(zap) Auto-Accept set to Option 2: In conversation (Recommended)', 3000);
    }),
    vscode.commands.registerCommand('antigravityLimitMonitor.relaunchWithPort', async () => {
      const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
      const port = config.get<number>('autoAccept.cdpPort', 9333);
      const action = await vscode.window.showInformationMessage(
        `Antigravity IDE will close and restart with Port ${port} in 2 seconds to activate 100% Hands-free CDP Autopilot. Please ensure all your files are saved.`,
        'Restart Now',
        'Cancel'
      );
      if (action === 'Restart Now') {
        await autoAcceptService.relaunchWithDebugPort(port);
      }
    }),
    vscode.commands.registerCommand('antigravityLimitMonitor.patchShortcuts', async () => {
      const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
      const port = config.get<number>('autoAccept.cdpPort', 9333);
      const res = await autoAcceptService.patchShortcuts(port);
      if (res.newlyPatched > 0) {
        vscode.window.showInformationMessage(
          `Successfully patched ${res.newlyPatched} Antigravity shortcut(s) with --remote-debugging-port=${port}. Please close and reopen Antigravity to activate CDP Autopilot.`
        );
      } else if (res.alreadyPatched > 0) {
        vscode.window.showInformationMessage(
          `All ${res.alreadyPatched} Antigravity shortcut(s) already have --remote-debugging-port=${port}. Please close Antigravity completely and reopen it to activate Port ${port}.`
        );
      } else {
        vscode.window.showWarningMessage(
          `Could not automatically locate Antigravity application shortcuts. Please launch Antigravity with: antigravity --remote-debugging-port=${port}`
        );
      }
    }),
    vscode.commands.registerCommand('antigravityLimitMonitor.selectOpt3', async () => {
      const isCdp = await autoAcceptService.checkCdpPort();
      if (!isCdp) {
        vscode.window.showWarningMessage(
          'Option 3 (Always allow) requires Antigravity IDE to be launched with --remote-debugging-port=9333.',
          'Dismiss'
        );
        return;
      }
      await autoAcceptService.setChoice(3, true);
      vscode.window.setStatusBarMessage('$(zap) Auto-Accept set to Option 3: Always allow (Permanent)', 3000);
    })
  );

  // Quick Action Menu for Auto-Accept
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityLimitMonitor.openAutoAcceptMenu', async () => {
      const isAuto = autoAcceptService.getStatus();
      const currentChoice = autoAcceptService.getChoice();
      const isCdp = await autoAcceptService.checkCdpPort();

      const items: (vscode.QuickPickItem & { action: string; choice?: AutoAcceptChoice; disabled?: boolean })[] = [
        {
          label: isAuto ? '$(circle-slash) Turn OFF Auto-Accept' : '$(zap) Turn ON Auto-Accept',
          description: isAuto ? 'Click to Pause' : 'Click to Enable',
          action: 'toggle',
        },
        {
          label: isCdp ? '$(check) Option 1: Allow this time (Once)' : '$(check) Option 1: Standard Auto (Native Engine)',
          description: currentChoice === 1 ? '[Active]' : '',
          action: 'setChoice',
          choice: 1,
        },
        {
          label: isCdp
            ? '$(comment-discussion) Option 2: Allow in this conversation (Recommended)'
            : '$(lock) Option 2: In conversation [Requires Debug Port 9333]',
          description: currentChoice === 2 ? '[Active]' : (isCdp ? '' : '[Locked]'),
          action: 'setChoice',
          choice: 2,
          disabled: !isCdp,
        },
        {
          label: isCdp
            ? '$(shield) Option 3: Always allow (Permanent)'
            : '$(lock) Option 3: Always allow [Requires Debug Port 9333]',
          description: currentChoice === 3 ? '[Active]' : (isCdp ? '' : '[Locked]'),
          action: 'setChoice',
          choice: 3,
          disabled: !isCdp,
        },
      ];

      const modeTitle = isCdp ? `Opt ${currentChoice} · CDP` : 'Standard';
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Auto-Accept is ${isAuto ? 'ON (' + modeTitle + ')' : 'OFF'} — Select action`,
      });

      if (!selected) return;

      if (selected.action === 'toggle') {
        await autoAcceptService.toggle();
      } else if (selected.action === 'setChoice' && selected.choice) {
        if (selected.disabled) {
          vscode.window.showWarningMessage(
            `Option ${selected.choice} requires Antigravity IDE to be launched with --remote-debugging-port=9333.`,
            'Dismiss'
          );
          return;
        }
        await autoAcceptService.setChoice(selected.choice, true);
        vscode.window.setStatusBarMessage(
          `$(zap) Auto-Accept set to Option ${selected.choice} (${autoAcceptService.getChoiceLabel(selected.choice)})`,
          3000
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityLimitMonitor.showLogs', () => {
      quotaService.showOutputChannel();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityLimitMonitor.clearHistory', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to clear all 1,000 recorded activity logs?',
        'Clear History',
        'Cancel'
      );
      if (confirm === 'Clear History') {
        await taskSessionService.clearHistory();
        vscode.window.showInformationMessage('Activity logs cleared.');
      }
    })
  );

  // Consolidated Status Bar Quick Menu
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityLimitMonitor.openQuickMenu', async () => {
      const summary = taskSessionService.getTodaySummary();
      const activityDesc = summary.logCountToday > 0
        ? `Used today: -${summary.totalUsedTodayPct}% across ${summary.logCountToday} turns`
        : 'View full quota breakdown, live gauges & 1,000 activity logs';

      const isAuto = autoAcceptService.getStatus();
      const autoLabel = isAuto ? '$(zap) Auto-Accept: ON' : '$(circle-slash) Auto-Accept: OFF';
      const autoDesc = isAuto
        ? 'Active — auto-approving file edits & terminal commands (Click to pause)'
        : 'Paused — click to enable hands-free auto-approval';

      const choiceNum = autoAcceptService.getChoice();
      const choiceLabel = autoAcceptService.getChoiceLabel();
      const choiceText = `$(settings-gear) Auto-Accept Option: ${choiceNum} (${choiceLabel})`;

      const items = [
        {
          label: '$(dashboard) Open AI Limits Dashboard',
          description: activityDesc,
          action: 'dashboard',
        },
        {
          label: autoLabel,
          description: autoDesc,
          action: 'toggleAutoAccept',
        },
        {
          label: choiceText,
          description: 'Choose between Allow once, In conversation, or Always allow',
          action: 'setAutoAcceptChoice',
        },
        {
          label: '$(refresh) Refresh AI Limits Now',
          description: 'Fetch latest usage from Language Server',
          action: 'refresh',
        },
        {
          label: '$(settings-gear) Switch Status Bar Format...',
          description: 'Change how limits are shown in the status bar',
          action: 'format',
        },
        {
          label: '$(trash) Clear Activity History Logs...',
          description: 'Clear up to 1,000 saved AI activity records',
          action: 'clearHistory',
        },
        {
          label: '$(account) Switch / Manage Antigravity Accounts...',
          description: '1-Click switch active account, multi-account quotas & countdowns',
          action: 'switchAccount',
        },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Antigravity AI Limits Quick Menu',
      });

      if (!selected) return;

      switch (selected.action) {
        case 'dashboard':
          DashboardWebviewPanel.createOrShow(context.extensionUri, quotaService, taskSessionService, autoAcceptService);
          break;
        case 'toggleAutoAccept':
          vscode.commands.executeCommand('antigravityLimitMonitor.toggleAutoAccept');
          break;
        case 'setAutoAcceptChoice':
          vscode.commands.executeCommand('antigravityLimitMonitor.setAutoAcceptChoice');
          break;
        case 'refresh':
          vscode.commands.executeCommand('antigravityLimitMonitor.refresh');
          break;
        case 'format':
          vscode.commands.executeCommand('antigravityLimitMonitor.toggleDisplayMode');
          break;
        case 'clearHistory':
          vscode.commands.executeCommand('antigravityLimitMonitor.clearHistory');
          break;
        case 'switchAccount':
          vscode.commands.executeCommand('antigravity-account.switchAccount');
          break;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'antigravityLimitMonitor.toggleDisplayMode',
      async () => {
        const modes = [
          {
            label: 'All Active Models (Default)',
            description: 'Show both Gemini & Claude (e.g. Gem: 57% | Cl: 100%)',
            value: 'all',
          },
          {
            label: 'Gemini Only',
            description: 'Show Gemini 5h & Weekly limits',
            value: 'geminiOnly',
          },
          {
            label: '5-Hour Limit Only',
            description: 'Show only 5-hour rolling limits',
            value: 'fiveHourOnly',
          },
          {
            label: 'Compact',
            description: 'Show only lowest percentage badge (e.g. 57%)',
            value: 'compact',
          },
          {
            label: 'Smart Lowest',
            description: 'Automatically highlights the lowest remaining quota',
            value: 'smartLowest',
          },
        ];

        const selected = await vscode.window.showQuickPick(modes, {
          placeHolder: 'Select Status Bar display format',
        });

        if (selected) {
          const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
          await config.update(
            'statusBarFormat',
            selected.value,
            vscode.ConfigurationTarget.Global
          );
          const current = quotaService.getLastQuotaInfo();
          if (current) {
            statusBarManager.update(current);
          }
        }
      }
    )
  );

  // Low quota warning notification check
  quotaService.on('quotaUpdated', (quota: ParsedQuotaInfo) => {
    const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
    const threshold = config.get<number>('lowQuotaWarningThreshold', 20);

    if (threshold > 0 && quota.lowestFraction * 100 <= threshold) {
      if (!hasAlertedForLowQuota) {
        hasAlertedForLowQuota = true;
        const pct = QuotaService.formatPercentage(quota.lowestFraction);
        vscode.window
          .showWarningMessage(
            `Low AI Model Quota: Remaining limit is down to ${pct}!`,
            'Open Dashboard',
            'Dismiss'
          )
          .then((choice) => {
            if (choice === 'Open Dashboard') {
              DashboardWebviewPanel.createOrShow(context.extensionUri, quotaService, taskSessionService, autoAcceptService);
            }
          });
      }
    } else if (quota.lowestFraction * 100 > threshold + 10) {
      // Reset alert state when quota recovers/refreshes
      hasAlertedForLowQuota = false;
    }
  });

  // Watch configuration updates
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antigravityLimitMonitor.refreshIntervalSeconds')) {
        const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
        const interval = config.get<number>('refreshIntervalSeconds', 30);
        quotaService.startPolling(interval);
      }
      if (
        e.affectsConfiguration('antigravityLimitMonitor.statusBarFormat') ||
        e.affectsConfiguration('antigravityLimitMonitor.showStatusAlertColors')
      ) {
        const current = quotaService.getLastQuotaInfo();
        if (current) {
          statusBarManager.update(current);
        }
      }
    })
  );

  // On window focus, check for quota changes in background
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        quotaService.refresh(false).catch(() => {});
      }
    })
  );

  // Start polling
  const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
  const interval = config.get<number>('refreshIntervalSeconds', 10);
  quotaService.startPolling(interval);

  context.subscriptions.push(statusBarManager);
}

export function deactivate() {
  deactivateAccounts();

  if (autoAcceptService) {
    autoAcceptService.dispose();
  }

  if (quotaService) {
    quotaService.stopPolling();
  }

  if (taskSessionService) {
    taskSessionService.dispose();
  }

  if (statusBarManager) {
    statusBarManager.dispose();
  }
}
