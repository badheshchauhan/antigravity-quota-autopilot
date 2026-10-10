/**
 * Status Bar Provider
 * 
 * Manages the VS Code status bar item for the extension.
 * Displays the currently active account and its credit balance.
 * Provides a quick click action to switch accounts.
 */

import * as vscode from 'vscode';
import { IAccountRepository } from '../../core/domain/repositories/account.repository';
import { I18nService } from '../../i18n/i18n.service';
import { AccountStatus } from '../../core/domain/models/account.model';
import { AccountService } from '../../features/accounts/account.service';
import { getFriendlyModelName } from '../../core/utils/model.utils';
import { isEmailMatch } from '../../core/utils/account.utils';

export class StatusBarProvider implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;

  constructor(
    private accountRepo: IAccountRepository,
    private accountService: AccountService
  ) {
    // Create item aligned to the right, priority 103 (neatly positioned with other Antigravity items)
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
    this.statusBarItem.command = 'antigravity-account.switchAccount';
    
    // Perform initial render
    this.update();
  }

  /**
   * Refreshes the status bar display based on the current active account.
   */
  async update(): Promise<void> {
    const activeEmail = await this.accountService.getActiveAntigravityEmail();
    const i18n = I18nService.getInstance();

    if (activeEmail === undefined) {
      // Database read error, preserve current status bar state
      return;
    }

    if (!activeEmail) {
      this.statusBarItem.text = `$(account) ${i18n.t('statusBar.noAccount')}`;
      this.statusBarItem.tooltip = i18n.t('statusBar.tooltip');
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.show();
      return;
    }

    const activeAccount = (await this.accountRepo.getAllAccounts()).find(
      a => isEmailMatch(a.email, activeEmail)
    ) || null;
    if (!activeAccount) {
      this.statusBarItem.text = `$(account) ${activeEmail}`;
      this.statusBarItem.tooltip = i18n.t('statusBar.tooltip');
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.show();
      return;
    }

    // Clean display name: e.g. $(account) badheshchauhan
    const displayName = activeAccount.alias || activeAccount.name || activeAccount.email.split('@')[0];
    this.statusBarItem.text = `$(account) ${displayName}`;
    
    // Build clean Markdown tooltip with summarized limits
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.appendMarkdown(`### $(account) **${displayName}**\n\n`);
    md.appendMarkdown(`- **Email:** \`${activeAccount.email}\`\n`);
    if (activeAccount.plan && activeAccount.plan !== 'unknown') {
      md.appendMarkdown(`- **Plan:** \`${activeAccount.plan.toUpperCase()}\`\n`);
    }

    // Helper to format countdown string
    const formatResetCountdown = (resetTimeStr?: string): string => {
      if (!resetTimeStr) return '';
      const t = new Date(resetTimeStr).getTime();
      if (isNaN(t)) return '';
      const diffMs = Math.max(0, t - Date.now());
      const totalMinutes = Math.floor(diffMs / 60000);
      const days = Math.floor(totalMinutes / (60 * 24));
      const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
      const mins = totalMinutes % 60;
      if (days > 0) return ` _(resets in ${days}d ${hours}h)_`;
      if (hours > 0) return ` _(resets in ${hours}h ${mins}m)_`;
      return ` _(resets in ${mins}m)_`;
    };

    // Summarize Gemini vs Claude 5-Hour & Weekly limits if cached
    if (activeAccount.balances && Object.keys(activeAccount.balances).length > 0) {
      let g5h: { val: number; resetTime?: string } | undefined;
      let gWk: { val: number; resetTime?: string } | undefined;
      let cWk: { val: number; resetTime?: string } | undefined;
      let c5h: { val: number; resetTime?: string } | undefined;

      for (const [k, v] of Object.entries(activeAccount.balances)) {
        let num: number | undefined;
        let resetTime: string | undefined;
        let windowTag: string | undefined;
        if (typeof v === 'number') {
          num = v;
        } else if (v && typeof v === 'object' && 'value' in v) {
          num = Number((v as any).value);
          resetTime = (v as any).resetTime;
          windowTag = (v as any).window;
        }
        if (num === undefined || isNaN(num)) continue;
        const lower = k.toLowerCase();
        if (lower.startsWith('chat') || lower.startsWith('tab') || lower.startsWith('tap')) continue;

        const isWeekly = windowTag === 'weekly' || lower.includes('weekly') || lower.includes('week');

        if (lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus') || lower.includes('gpt') || lower.includes('3p')) {
          if (isWeekly) {
            if (!cWk || num < cWk.val) cWk = { val: num, resetTime };
          } else {
            if (!c5h || num < c5h.val) c5h = { val: num, resetTime };
          }
        } else if (lower.includes('gemini') || lower.includes('flash') || lower.includes('pro')) {
          if (isWeekly) {
            if (!gWk || num < gWk.val) gWk = { val: num, resetTime };
          } else {
            if (!g5h || num < g5h.val) g5h = { val: num, resetTime };
          }
        }
      }

      if (g5h || gWk || cWk || c5h) {
        md.appendMarkdown(`\n---\n\n**Quota Limits (5h & Weekly)**\n\n`);
        if (g5h) {
          md.appendMarkdown(`- **✨ Gemini (5-Hour):** \`${g5h.val}%\`${formatResetCountdown(g5h.resetTime)}\n`);
        }
        if (gWk) {
          md.appendMarkdown(`- **📅 Gemini (Weekly):** \`${gWk.val}%\`${formatResetCountdown(gWk.resetTime)}\n`);
        }
        if (cWk) {
          md.appendMarkdown(`- **🤖 Claude (Weekly):** \`${cWk.val}%\`${formatResetCountdown(cWk.resetTime)}\n`);
        }
        if (c5h) {
          md.appendMarkdown(`- **⚡ Claude (5-Hour):** \`${c5h.val}%\`${formatResetCountdown(c5h.resetTime)}\n`);
        }
      }
    }

    md.appendMarkdown(`\n[$(arrow-swap) Switch Account](command:antigravity-account.switchAccount) | [$(dashboard) Dashboard](command:antigravityLimitMonitor.showDashboard)\n`);
    this.statusBarItem.tooltip = md;

    // Apply color coding based on health status (only error if expired/ineligible)
    if (activeAccount.status === AccountStatus.DEPLETED || activeAccount.status === AccountStatus.ERROR || activeAccount.status === AccountStatus.TOKEN_EXPIRED) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      this.statusBarItem.backgroundColor = undefined; // Clean default theme color
    }

    this.statusBarItem.show();
  }

  /**
   * Cleans up the UI element when the extension is deactivated.
   */
  dispose() {
    this.statusBarItem.dispose();
  }
}

