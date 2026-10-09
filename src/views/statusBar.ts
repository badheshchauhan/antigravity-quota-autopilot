import * as vscode from 'vscode';
import { QuotaService } from '../quotaService';
import { TaskSessionService } from '../taskSessionService';
import { AutoAcceptService } from '../autoAcceptService';
import { ParsedQuotaInfo, QuotaBucket, QuotaGroup } from '../types';

export class StatusBarManager implements vscode.Disposable {
  private geminiStatusBarItem: vscode.StatusBarItem;
  private claudeStatusBarItem: vscode.StatusBarItem;
  private autoAcceptStatusBarItem: vscode.StatusBarItem;
  private quotaService: QuotaService;
  private taskSessionService: TaskSessionService;
  private autoAcceptService: AutoAcceptService;
  private lastQuota: ParsedQuotaInfo | undefined;

  constructor(
    quotaService: QuotaService,
    taskSessionService?: TaskSessionService,
    autoAcceptService?: AutoAcceptService
  ) {
    this.quotaService = quotaService;
    this.taskSessionService = taskSessionService || TaskSessionService.getInstance();
    this.autoAcceptService = autoAcceptService || AutoAcceptService.getInstance();

    // Create 3 separate items so they can have independent colors!
    this.geminiStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
    this.geminiStatusBarItem.command = 'antigravityLimitMonitor.openQuickMenu';
    
    this.claudeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    this.claudeStatusBarItem.command = 'antigravityLimitMonitor.openQuickMenu';

    this.autoAcceptStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.autoAcceptStatusBarItem.command = 'antigravityLimitMonitor.toggleAutoAccept';

    this.render();
    this.geminiStatusBarItem.show();
    this.claudeStatusBarItem.show();
    this.autoAcceptStatusBarItem.show();

    // Event listeners
    this.quotaService.on('quotaUpdated', (quota: ParsedQuotaInfo) => {
      this.lastQuota = quota;
      this.render();
    });
    this.quotaService.on('error', (err: Error) => this.showQuotaError(err));
    this.taskSessionService.on('activityLogged', () => this.render());
    this.taskSessionService.on('historyCleared', () => this.render());
    this.autoAcceptService.on('stateChanged', () => this.render());
    this.autoAcceptService.on('choiceChanged', () => this.render());
  }

  public update(quota: ParsedQuotaInfo): void {
    this.lastQuota = quota;
    this.render();
  }


  private toBoldNumbers(str: string): string {
    const boldMap: { [key: string]: string } = {
      '0': '𝟬', '1': '𝟭', '2': '𝟮', '3': '𝟯', '4': '𝟰',
      '5': '𝟱', '6': '𝟲', '7': '𝟳', '8': '𝟴', '9': '𝟵'
    };
    return str.replace(/[0-9]/g, match => boldMap[match] || match);
  }

  private applyColorToItem(item: vscode.StatusBarItem, lowestFraction: number, defaultColor: string) {
    const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
    const showAlertColors = config.get<boolean>('showStatusAlertColors', true);

    if (showAlertColors) {
      if (lowestFraction < 0.20) {
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
      } else if (lowestFraction < 0.50) {
        item.backgroundColor = undefined;
        item.color = new vscode.ThemeColor('charts.blue');
      } else {
        item.backgroundColor = undefined;
        item.color = new vscode.ThemeColor('charts.green');
      }
    } else {
      item.backgroundColor = undefined;
      item.color = undefined;
    }
  }

  private render(): void {
    const isAuto = this.autoAcceptService.getStatus();
    const isCdp = this.autoAcceptService.getIsCdpAvailable();
    const autoStatus = isAuto ? (isCdp ? 'Auto:ON' : 'Auto:ON(Std)') : 'Auto:OFF';

    this.autoAcceptStatusBarItem.text = `$(zap) ${autoStatus}`;
    this.autoAcceptStatusBarItem.color = isAuto ? new vscode.ThemeColor('charts.green') : undefined;
    this.autoAcceptStatusBarItem.tooltip = this.buildCombinedTooltip();

    if (!this.lastQuota) return;

    const geminiGroup = this.lastQuota.groups.find(g => g.displayName.toLowerCase().includes('gemini'));
    const claudeGroup = this.lastQuota.groups.find(g => g.displayName.toLowerCase().includes('claude') || g.displayName.toLowerCase().includes('gpt') || g.displayName.toLowerCase().includes('3p'));

    const gemini5h = this.findBucket(geminiGroup, '5h');
    const geminiWeekly = this.findBucket(geminiGroup, 'weekly');
    const claude5h = this.findBucket(claudeGroup, '5h');
    const claudeWeekly = this.findBucket(claudeGroup, 'weekly');

    const getBothPct = (daily: QuotaBucket | undefined, weekly: QuotaBucket | undefined) => {
      let dStr = '--';
      let wStr = '--';
      let minFrac = 1.0;
      
      if (daily) {
        if (daily.disabled || (weekly && weekly.remainingFraction <= 0)) {
          dStr = '0%';
          minFrac = 0;
        } else {
          dStr = QuotaService.formatPercentage(daily.remainingFraction);
          minFrac = Math.min(minFrac, daily.remainingFraction);
        }
      }
      if (weekly) {
        if (weekly.disabled || weekly.remainingFraction <= 0) {
          wStr = '0%';
          minFrac = 0;
        } else {
          wStr = QuotaService.formatPercentage(weekly.remainingFraction);
          minFrac = Math.min(minFrac, weekly.remainingFraction);
        }
      }
      
      if (!daily && !weekly) return { text: '100%', minFrac: 1.0 };
      return { text: `$(history) ${this.toBoldNumbers(dStr)}   $(calendar) ${this.toBoldNumbers(wStr)}`, minFrac };
    };

    const gData = getBothPct(gemini5h, geminiWeekly);
    const cData = getBothPct(claude5h, claudeWeekly);

    const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
    const format = config.get<string>('statusBarFormat', 'all');

    if (format === 'geminiOnly') {
      this.claudeStatusBarItem.hide();
      this.geminiStatusBarItem.text = `$(sparkle) ${gData.text}`;
      this.applyColorToItem(this.geminiStatusBarItem, gData.minFrac, 'charts.blue');
      this.geminiStatusBarItem.tooltip = this.buildCombinedTooltip();
      this.geminiStatusBarItem.show();
      return;
    }

    if (format === 'fiveHourOnly') {
      const g5hStr = gemini5h ? (gemini5h.disabled ? '0%' : QuotaService.formatPercentage(gemini5h.remainingFraction)) : '--';
      const c5hStr = claude5h ? (claude5h.disabled || (claudeWeekly && claudeWeekly.remainingFraction <= 0) ? '0%' : QuotaService.formatPercentage(claude5h.remainingFraction)) : '--';
      this.geminiStatusBarItem.text = `$(sparkle) ${this.toBoldNumbers(g5hStr)}`;
      this.applyColorToItem(this.geminiStatusBarItem, gData.minFrac, 'charts.blue');
      this.geminiStatusBarItem.tooltip = this.buildCombinedTooltip();

      this.claudeStatusBarItem.text = `$(hubot) ${this.toBoldNumbers(c5hStr)}`;
      this.applyColorToItem(this.claudeStatusBarItem, cData.minFrac, 'charts.purple');
      this.claudeStatusBarItem.tooltip = this.buildCombinedTooltip();

      this.geminiStatusBarItem.show();
      this.claudeStatusBarItem.show();
      return;
    }

    if (format === 'compact') {
      const lowestFrac = Math.min(gData.minFrac, cData.minFrac);
      const lowestPct = Math.round(lowestFrac * 100);
      this.claudeStatusBarItem.hide();
      this.geminiStatusBarItem.text = `$(sparkle) ${this.toBoldNumbers(lowestPct + '%')}`;
      this.applyColorToItem(this.geminiStatusBarItem, lowestFrac, 'charts.blue');
      this.geminiStatusBarItem.tooltip = this.buildCombinedTooltip();
      this.geminiStatusBarItem.show();
      return;
    }

    this.geminiStatusBarItem.text = `$(sparkle) ${gData.text}`;
    this.applyColorToItem(this.geminiStatusBarItem, gData.minFrac, 'charts.blue');
    this.geminiStatusBarItem.tooltip = this.buildCombinedTooltip();
    this.geminiStatusBarItem.show();

    this.claudeStatusBarItem.text = `$(hubot) ${cData.text}`;
    this.applyColorToItem(this.claudeStatusBarItem, cData.minFrac, 'charts.purple');
    this.claudeStatusBarItem.tooltip = this.buildCombinedTooltip();
    this.claudeStatusBarItem.show();
  }

  public showQuotaError(err: Error): void {
    this.geminiStatusBarItem.text = `$(warning) Offline`;
    this.geminiStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    
    this.claudeStatusBarItem.text = ``;
    this.claudeStatusBarItem.hide();
  }

  private findBucket(group: QuotaGroup | undefined, window: '5h' | 'weekly'): QuotaBucket | undefined {
    if (!group || !group.buckets || group.buckets.length === 0) return undefined;
    const match =
      group.buckets.find((b) => b.window === window) ||
      group.buckets.find((b) => b.bucketId.includes(window)) ||
      group.buckets.find((b) =>
        window === '5h'
          ? b.displayName.toLowerCase().includes('5-hour') || b.displayName.toLowerCase().includes('five hour')
          : b.displayName.toLowerCase().includes('weekly')
      );
    if (match) return match;
    if (window === 'weekly' && group.buckets.length === 1) return group.buckets[0];
    return undefined;
  }

  private buildCombinedTooltip(errorMessage?: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    const isAuto = this.autoAcceptService.getStatus();
    const choice = this.autoAcceptService.getChoice();
    const choiceLabel = this.autoAcceptService.getChoiceLabel();
    const isCdp = this.autoAcceptService.getIsCdpAvailable();
    const modeBadge = isCdp ? 'CDP Mode' : 'Standard Mode';

    md.appendMarkdown(`### $(zap) Auto-Accept: **${isAuto ? '$(check) ON' : '$(circle-slash) OFF'}** *(${modeBadge})*\n\n`);
    md.appendMarkdown(`Current setting: **Option ${choice} — ${choiceLabel}**\n\n`);

    if (errorMessage) {
      md.appendMarkdown(`---\n\n$(warning) *Offline: ${errorMessage}*\n\n`);
    } else if (this.lastQuota && this.lastQuota.groups.length > 0) {
      md.appendMarkdown(`---\n\n### $(graph) AI Limits\n\n`);
      for (const group of this.lastQuota.groups) {
        const icon = group.displayName.toLowerCase().includes('gemini') ? '$(sparkle)' : '$(hubot)';
        md.appendMarkdown(`**${icon} ${group.displayName}**\n\n`);
        for (const bucket of group.buckets) {
          const pct = QuotaService.formatPercentage(bucket.remainingFraction);
          const rst = bucket.resetTime ? ` *(resets in ${QuotaService.formatTimeUntilReset(bucket.resetTime)})*` : '';
          md.appendMarkdown(`- **${bucket.displayName}:** \`${pct}\`${rst}\n`);
        }
        md.appendMarkdown(`\n`);
      }
    }
    
    md.appendMarkdown(`\n\n[$(dashboard) Dashboard](command:antigravityLimitMonitor.showDashboard) | [$(refresh) Refresh](command:antigravityLimitMonitor.refresh) | [$(settings-gear) Settings](command:antigravityLimitMonitor.openQuickMenu)`);
    return md;
  }

  public dispose(): void {
    this.geminiStatusBarItem.dispose();
    this.claudeStatusBarItem.dispose();
    this.autoAcceptStatusBarItem.dispose();
  }
}
