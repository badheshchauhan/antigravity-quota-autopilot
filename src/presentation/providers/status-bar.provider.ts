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

    // Summarize Gemini vs Claude limits if cached
    if (activeAccount.balances && Object.keys(activeAccount.balances).length > 0) {
      let geminiVal: number | undefined;
      let claudeVal: number | undefined;
      for (const [k, v] of Object.entries(activeAccount.balances)) {
        const num = typeof v === 'number' ? v : (v && typeof v === 'object' && 'value' in v ? Number(v.value) : undefined);
        if (num === undefined || isNaN(num)) continue;
        const lower = k.toLowerCase();
        if (lower.startsWith('chat') || lower.startsWith('tab') || lower.startsWith('tap')) continue;
        if (lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus') || lower.includes('gpt')) {
          if (claudeVal === undefined || num < claudeVal) claudeVal = num;
        } else if (lower.includes('gemini') || lower.includes('flash') || lower.includes('pro')) {
          if (geminiVal === undefined || num > geminiVal) geminiVal = num;
        }
      }
      if (geminiVal !== undefined || claudeVal !== undefined) {
        md.appendMarkdown(`\n---\n\n**Quota Limits**\n\n`);
        if (geminiVal !== undefined) {
          md.appendMarkdown(`- **✨ Gemini (Google):** \`${geminiVal}%\`\n`);
        }
        if (claudeVal !== undefined) {
          md.appendMarkdown(`- **🤖 Claude (3P):** \`${claudeVal}%\`\n`);
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

