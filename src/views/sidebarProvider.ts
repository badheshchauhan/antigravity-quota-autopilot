import * as vscode from 'vscode';
import { QuotaService } from '../quotaService';
import { ParsedQuotaInfo, QuotaBucket, QuotaGroup } from '../types';

export class QuotaTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: 'group' | 'bucket' | 'info' | 'error',
    public readonly group?: QuotaGroup,
    public readonly bucket?: QuotaBucket,
    public readonly infoText?: string
  ) {
    super(label, collapsibleState);

    if (itemType === 'group' && group) {
      this.contextValue = 'quotaGroup';
      this.iconPath = group.displayName.toLowerCase().includes('gemini')
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
        
        let extraDesc = bucket.window === 'weekly' ? '(W)' : '(D)';
        
        if (bucket.resetTime) {
          const timeUntil = QuotaService.formatTimeUntilReset(bucket.resetTime);
          this.description = `${bar} ${pct} ${extraDesc} ↻ ${timeUntil}`;
        } else {
          this.description = `${bar} ${pct} ${extraDesc}`;
        }

        // Icon based on percentage
        if (bucket.remainingFraction >= 0.50) {
          this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
        } else if (bucket.remainingFraction >= 0.20) {
          this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
        } else {
          this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));
        }

        this.tooltip = new vscode.MarkdownString(
          `**${bucket.displayName}**\n\n` +
          `- Remaining: **${pct}**\n` +
          (bucket.resetTime ? `- Resets in: **${QuotaService.formatTimeUntilReset(bucket.resetTime)}**\n` : '') +
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
  private lastError: Error | null = null;

  constructor(quotaService: QuotaService) {
    this.quotaService = quotaService;

    this.quotaService.on('quotaUpdated', () => {
      this.lastError = null;
      this._onDidChangeTreeData.fire();
    });
    this.quotaService.on('error', (err: Error) => {
      this.lastError = err;
      this._onDidChangeTreeData.fire();
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: QuotaTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: QuotaTreeItem): Promise<QuotaTreeItem[]> {
    const quota = this.quotaService.getLastQuotaInfo();

    if (!quota) {
      if (this.lastError) {
        return [
          new QuotaTreeItem(
            'Language Server Offline',
            vscode.TreeItemCollapsibleState.None,
            'error',
            undefined,
            undefined,
            'Click to retry'
          ),
        ];
      }

      return [
        new QuotaTreeItem(
          'Connecting to Language Server...',
          vscode.TreeItemCollapsibleState.None,
          'info',
          undefined,
          undefined,
          'Please wait'
        ),
      ];
    }

    if (!element) {
      // Root level: return groups + last updated
      const items: QuotaTreeItem[] = [];

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

