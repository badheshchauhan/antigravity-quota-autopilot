import * as vscode from 'vscode';
import { QuotaService } from '../quotaService';
import { AutoAcceptService } from '../autoAcceptService';
import { ParsedQuotaInfo, QuotaBucket, QuotaGroup } from '../types';
import { getAccountRepo, getAccountService } from '../accountsManager';

export class QuotaTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: 'action' | 'group' | 'bucket' | 'info' | 'error',
    public readonly group?: QuotaGroup,
    public readonly bucket?: QuotaBucket,
    public readonly infoText?: string,
    public readonly customCommand?: vscode.Command,
    public readonly customIcon?: { icon: string; color?: string }
  ) {
    super(label, collapsibleState);

    if (customCommand) {
      this.command = customCommand;
    }

    if (itemType === 'action') {
      this.contextValue = 'quotaAction';
      this.description = infoText;
      if (customIcon) {
        this.iconPath = new vscode.ThemeIcon(
          customIcon.icon,
          customIcon.color ? new vscode.ThemeColor(customIcon.color) : undefined
        );
      }
    } else if (itemType === 'group' && group) {
      this.contextValue = 'quotaGroup';
      const isGemini = group.displayName.toLowerCase().includes('gemini');
      this.iconPath = isGemini
        ? new vscode.ThemeIcon('sparkle', new vscode.ThemeColor('charts.blue'))
        : new vscode.ThemeIcon('hubot', new vscode.ThemeColor('charts.purple'));
      this.description = `${group.buckets.length} limits`;
      this.tooltip = group.description || group.displayName;
    } else if (itemType === 'bucket' && bucket) {
      this.contextValue = 'quotaBucket';

      if (bucket.disabled) {
        this.description = 'Does not apply (Weekly limit reached)';
        this.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
        this.tooltip = new vscode.MarkdownString(
          `**${bucket.displayName}**\n\n` +
          `- Status: **Does not apply** (Weekly limit reached)\n` +
          (bucket.description ? `\n_${bucket.description}_` : '')
        );
      } else {
        const pct = QuotaService.formatPercentage(bucket.remainingFraction);
        const totalBlocks = 8;
        const filledBlocks = Math.round(bucket.remainingFraction * totalBlocks);
        const emptyBlocks = totalBlocks - filledBlocks;
        const bar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);

        const extraDesc = bucket.window === 'weekly' ? '(Weekly)' : '(5h)';

        if (bucket.resetTime) {
          const timeUntil = QuotaService.formatTimeUntilReset(bucket.resetTime);
          this.description = `${bar} ${pct} ${extraDesc} ↻ ${timeUntil}`;
        } else {
          this.description = `${bar} ${pct} ${extraDesc}`;
        }

        // Color coded status icon
        if (bucket.remainingFraction >= 0.50) {
          this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
        } else if (bucket.remainingFraction >= 0.20) {
          this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
        } else {
          this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));
        }

        this.tooltip = new vscode.MarkdownString(
          `### ${bucket.displayName}\n\n` +
          `- **Remaining:** ${pct} (${bucket.remainingFraction * 100}%)\n` +
          `- **Window:** ${extraDesc}\n` +
          (bucket.resetTime ? `- **Resets in:** ${QuotaService.formatTimeUntilReset(bucket.resetTime)}\n` : '') +
          (bucket.description ? `\n_${bucket.description}_` : '')
        );
      }
    } else if (itemType === 'error') {
      this.contextValue = 'quotaError';
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
      this.description = infoText || 'Click to retry';
      this.tooltip = 'Click to retry connecting to Antigravity Language Server';
      this.command = {
        command: 'antigravityLimitMonitor.refresh',
        title: 'Retry Limit Monitor',
      };
    } else if (itemType === 'info') {
      this.contextValue = 'quotaInfo';
      this.iconPath = label === 'Account' ? new vscode.ThemeIcon('account') : new vscode.ThemeIcon('clock');
      this.description = infoText;
    }
  }
}

export class QuotaTreeDataProvider implements vscode.TreeDataProvider<QuotaTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<QuotaTreeItem | undefined | null | void> =
    new vscode.EventEmitter<QuotaTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<QuotaTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private quotaService: QuotaService;
  private autoAcceptService?: AutoAcceptService;
  private lastError: Error | null = null;

  constructor(quotaService: QuotaService, autoAcceptService?: AutoAcceptService) {
    this.quotaService = quotaService;
    this.autoAcceptService = autoAcceptService;

    this.quotaService.on('quotaUpdated', () => {
      this.lastError = null;
      this._onDidChangeTreeData.fire();
    });

    this.quotaService.on('error', (err: Error) => {
      this.lastError = err;
      this._onDidChangeTreeData.fire();
    });

    if (this.autoAcceptService) {
      this.autoAcceptService.on('statusChanged', () => this.refresh());
      this.autoAcceptService.on('choiceChanged', () => this.refresh());
    }

    const accountService = getAccountService();
    if (accountService) {
      accountService.onAccountsChanged(() => this.refresh());
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: QuotaTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: QuotaTreeItem): Promise<QuotaTreeItem[]> {
    const quota = this.quotaService.getLastQuotaInfo();

    if (!element) {
      const items: QuotaTreeItem[] = [];

      // Account repository info
      const accountRepo = getAccountRepo();
      let accountsCount = 0;
      let activeEmail = quota?.userEmail || null;
      if (accountRepo) {
        try {
          const accounts = await accountRepo.getAllAccounts();
          accountsCount = accounts.length;
          const dbEmail = await accountRepo.getActiveAccountEmail();
          if (dbEmail) activeEmail = dbEmail;
        } catch (e) {}
      }

      // ── Active Account Item (Top of sidebar) ──
      if (activeEmail) {
        items.push(
          new QuotaTreeItem(
            `Account: ${activeEmail}`,
            vscode.TreeItemCollapsibleState.None,
            'action',
            undefined,
            undefined,
            quota?.planName ? quota.planName.toUpperCase() : 'Active',
            {
              command: 'antigravity-account.switchAccount',
              title: 'Switch Account'
            },
            { icon: 'account', color: 'charts.green' }
          )
        );
      }

      // ── Quick Controls & Navigation ──
      items.push(
        new QuotaTreeItem(
          'Open AI Limits Dashboard',
          vscode.TreeItemCollapsibleState.None,
          'action',
          undefined,
          undefined,
          'Gauges & Accounts',
          {
            command: 'antigravityLimitMonitor.showDashboard',
            title: 'Show Dashboard'
          },
          { icon: 'dashboard', color: 'textLink.foreground' }
        )
      );

      // Auto-Accept toggle status
      if (this.autoAcceptService) {
        const isAuto = this.autoAcceptService.getStatus();
        const choice = this.autoAcceptService.getChoice();
        const autoLabel = isAuto ? 'Auto-Accept: Active' : 'Auto-Accept: Paused';
        const autoDesc = isAuto ? `Option ${choice}` : 'Click to Enable';
        items.push(
          new QuotaTreeItem(
            autoLabel,
            vscode.TreeItemCollapsibleState.None,
            'action',
            undefined,
            undefined,
            autoDesc,
            {
              command: 'antigravityLimitMonitor.toggleAutoAccept',
              title: 'Toggle Auto-Accept'
            },
            {
              icon: isAuto ? 'zap' : 'circle-slash',
              color: isAuto ? 'charts.green' : 'disabledForeground'
            }
          )
        );
      }

      // Quick Switch Account
      items.push(
        new QuotaTreeItem(
          'Switch Active Account',
          vscode.TreeItemCollapsibleState.None,
          'action',
          undefined,
          undefined,
          accountsCount > 0 ? `${accountsCount} Available` : '1-Click Switch',
          {
            command: 'antigravity-account.switchAccount',
            title: 'Switch Account'
          },
          { icon: 'arrow-swap', color: 'charts.blue' }
        )
      );

      // Add Account
      items.push(
        new QuotaTreeItem(
          'Add Google Account',
          vscode.TreeItemCollapsibleState.None,
          'action',
          undefined,
          undefined,
          'Connect session',
          {
            command: 'antigravity-account.addAccount',
            title: 'Add Account'
          },
          { icon: 'plus', color: 'charts.green' }
        )
      );

      // Refresh limits
      items.push(
        new QuotaTreeItem(
          'Refresh Limits Now',
          vscode.TreeItemCollapsibleState.None,
          'action',
          undefined,
          undefined,
          'Language Server',
          {
            command: 'antigravityLimitMonitor.refresh',
            title: 'Refresh Limits'
          },
          { icon: 'refresh', color: 'charts.purple' }
        )
      );

      if (!quota) {
        if (this.lastError) {
          items.push(
            new QuotaTreeItem(
              'Language Server Offline',
              vscode.TreeItemCollapsibleState.None,
              'error',
              undefined,
              undefined,
              'Click to retry'
            )
          );
        } else {
          items.push(
            new QuotaTreeItem(
              'Connecting to Language Server...',
              vscode.TreeItemCollapsibleState.None,
              'info',
              undefined,
              undefined,
              'Please wait'
            )
          );
        }
        return items;
      }

      if (this.lastError) {
        items.push(
          new QuotaTreeItem(
            'Sync Warning',
            vscode.TreeItemCollapsibleState.None,
            'error',
            undefined,
            undefined,
            'Retry sync'
          )
        );
      }

      // Model Quota Groups
      for (const group of quota.groups) {
        items.push(
          new QuotaTreeItem(
            group.displayName,
            vscode.TreeItemCollapsibleState.Expanded,
            'group',
            group
          )
        );
      }

      // Metadata info
      if (quota.userEmail) {
        items.push(
          new QuotaTreeItem(
            'Account',
            vscode.TreeItemCollapsibleState.None,
            'info',
            undefined,
            undefined,
            `${quota.userEmail}${quota.planName ? ' (' + quota.planName + ')' : ''}`
          )
        );
      }

      items.push(
        new QuotaTreeItem(
          'Last Synced',
          vscode.TreeItemCollapsibleState.None,
          'info',
          undefined,
          undefined,
          quota.lastUpdated.toLocaleTimeString()
        )
      );

      return items;
    }

    if (element.itemType === 'group' && element.group) {
      // Child level: return buckets for this group
      return element.group.buckets.map((bucket) => {
        return new QuotaTreeItem(
          bucket.displayName,
          vscode.TreeItemCollapsibleState.None,
          'bucket',
          element.group,
          bucket
        );
      });
    }

    return [];
  }
}
