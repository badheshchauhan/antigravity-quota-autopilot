import * as vscode from 'vscode';
import { QuotaService } from '../quotaService';
import { AutoAcceptService } from '../autoAcceptService';
import { ParsedQuotaInfo, QuotaBucket, QuotaGroup } from '../types';
import { getAccountRepo, getAccountService } from '../accountsManager';

/**
 * Renders a high-resolution, ultra-compact text progress bar (10 blocks).
 * Combines full blocks, partial eighth blocks, and shade blocks for sub-block precision.
 */
export function renderCompactBar(fraction: number, totalBlocks = 10): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const partials = ['░', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
  const val = clamped * totalBlocks;
  const full = Math.floor(val);
  const remainder = val - full;
  const pIdx = Math.round(remainder * 8);

  let bar = '█'.repeat(full);
  if (full < totalBlocks) {
    bar += partials[pIdx];
    bar += '░'.repeat(Math.max(0, totalBlocks - full - 1));
  }
  return bar.slice(0, totalBlocks);
}

export class QuotaTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
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

      // Calculate summary badge on group header (e.g. "5h: 79%  •  Wk: 24%")
      let g5hPct: string | null = null;
      let gWkPct: string | null = null;
      for (const b of group.buckets) {
        const isWk = b.window === 'weekly' || (b.displayName || '').toLowerCase().includes('weekly');
        if (b.disabled) {
          if (isWk) gWkPct = '0%';
          else g5hPct = '0%';
        } else {
          const p = QuotaService.formatPercentage(b.remainingFraction);
          if (isWk) gWkPct = p;
          else g5hPct = p;
        }
      }

      const parts: string[] = [];
      if (g5hPct) parts.push(`5h: ${g5hPct}`);
      if (gWkPct) parts.push(`Wk: ${gWkPct}`);
      this.description = parts.length > 0 ? parts.join('  •  ') : `${group.buckets.length} limits`;
      this.tooltip = group.description || group.displayName;
    } else if (itemType === 'bucket' && bucket) {
      this.contextValue = 'quotaBucket';

      // Clean, concise labels without redundant "Remaining"
      const lowerName = (bucket.displayName || '').toLowerCase();
      const isWeekly = bucket.window === 'weekly' || lowerName.includes('weekly') || lowerName.includes('week');
      const cleanLabel = isWeekly ? 'Weekly Limit' : '5-Hour Limit';
      this.label = cleanLabel;

      if (bucket.disabled) {
        this.description = 'Exhausted (Weekly limit reached)';
        this.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
        this.tooltip = new vscode.MarkdownString(
          `### ${cleanLabel}\n\n` +
          `- **Status:** Exhausted / Does not apply\n` +
          `- **Reason:** Weekly quota limit reached for this model tier\n` +
          (bucket.description ? `\n_${bucket.description}_` : '')
        );
      } else {
        const pct = QuotaService.formatPercentage(bucket.remainingFraction);
        const bar = renderCompactBar(bucket.remainingFraction, 10);
        const timeUntil = bucket.resetTime ? QuotaService.formatTimeUntilReset(bucket.resetTime) : '';

        if (timeUntil) {
          this.description = `${bar} ${pct}  •  ↺ ${timeUntil}`;
        } else {
          this.description = `${bar} ${pct}`;
        }

        // Color-coded status indicator
        if (bucket.remainingFraction >= 0.50) {
          this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
        } else if (bucket.remainingFraction >= 0.20) {
          this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
        } else if (bucket.remainingFraction > 0) {
          this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));
        } else {
          this.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.red'));
        }

        this.tooltip = new vscode.MarkdownString(
          `### ${cleanLabel} (${isWeekly ? 'Weekly Window' : '5-Hour Window'})\n\n` +
          `- **Remaining:** ${pct} (${Math.round(bucket.remainingFraction * 100)}%)\n` +
          `- **Visual Meter:** \`${bar}\`\n` +
          (bucket.resetTime ? `- **Resets in:** ${timeUntil}\n` : '') +
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
      let activePlan = quota?.planName ? quota.planName.toUpperCase() : 'PRO';
      if (accountRepo) {
        try {
          const accounts = await accountRepo.getAllAccounts();
          accountsCount = accounts.length;
          const dbEmail = await accountRepo.getActiveAccountEmail();
          if (dbEmail) activeEmail = dbEmail;
          const activeAcc = accounts.find(a => a.email === activeEmail);
          if (activeAcc?.plan && activeAcc.plan !== 'unknown') {
            activePlan = activeAcc.plan.toUpperCase();
          }
        } catch (e) {}
      }

      // ── 1. Active Account Banner (At the top of sidebar) ──
      if (activeEmail) {
        items.push(
          new QuotaTreeItem(
            activeEmail,
            vscode.TreeItemCollapsibleState.None,
            'action',
            undefined,
            undefined,
            `${activePlan}  •  Active`,
            {
              command: 'antigravity-account.switchAccount',
              title: 'Switch Account'
            },
            { icon: 'account', color: 'charts.green' }
          )
        );
      }

      // ── 2. Model Quota Groups (Front & Center - Expanded by Default!) ──
      if (quota && quota.groups && quota.groups.length > 0) {
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
      } else if (!quota) {
        if (this.lastError) {
          items.push(
            new QuotaTreeItem(
              'Language Server Offline',
              vscode.TreeItemCollapsibleState.None,
              'error',
              undefined,
              undefined,
              'Click to reconnect'
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
              'Reading live limits'
            )
          );
        }
      }

      // ── 3. Quick Controls & Tools (Cleanly situated below limits) ──
      // Switch Active Account
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

      // Add Google Account
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

      // Auto-Accept Prompts
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

      // Refresh limits (with Last Synced time in description)
      const syncTimeStr = quota ? `Synced ${quota.lastUpdated.toLocaleTimeString()}` : 'Language Server';
      items.push(
        new QuotaTreeItem(
          'Refresh Limits Now',
          vscode.TreeItemCollapsibleState.None,
          'action',
          undefined,
          undefined,
          syncTimeStr,
          {
            command: 'antigravityLimitMonitor.refresh',
            title: 'Refresh Limits'
          },
          { icon: 'refresh', color: 'charts.purple' }
        )
      );

      // Open AI Limits Dashboard (At bottom, non-obtrusive full view)
      items.push(
        new QuotaTreeItem(
          'Open AI Limits Dashboard',
          vscode.TreeItemCollapsibleState.None,
          'action',
          undefined,
          undefined,
          'Full Gauges & History',
          {
            command: 'antigravityLimitMonitor.showDashboard',
            title: 'Show Dashboard'
          },
          { icon: 'dashboard', color: 'textLink.foreground' }
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
