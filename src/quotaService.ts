import * as https from 'https';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import {
  LanguageServerConnection,
  ParsedQuotaInfo,
  QuotaBucket,
  QuotaGroup,
  QuotaSummaryResponse,
} from './types';

const execAsync = promisify(exec);

export class QuotaService extends EventEmitter {
  private static instance: QuotaService;
  private cachedConnection: LanguageServerConnection | null = null;
  private lastQuotaInfo: ParsedQuotaInfo | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;
  private isRefreshing: boolean = false;
  private outputChannel: vscode.OutputChannel;

  private constructor() {
    super();
    this.outputChannel = vscode.window.createOutputChannel('AI Model Limit Monitor');
    this.log('QuotaService initialized.');
  }

  public static getInstance(): QuotaService {
    if (!QuotaService.instance) {
      QuotaService.instance = new QuotaService();
    }
    return QuotaService.instance;
  }

  public log(message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  public showOutputChannel(): void {
    this.outputChannel.show();
  }

  public getLastQuotaInfo(): ParsedQuotaInfo | null {
    return this.lastQuotaInfo;
  }

  public startPolling(intervalSeconds: number = 30): void {
    this.stopPolling();
    this.refresh();
    const intervalMs = Math.max(5, intervalSeconds) * 1000;
    this.log(`Starting polling every ${intervalSeconds}s.`);
    this.pollingTimer = setInterval(() => {
      this.refresh();
    }, intervalMs);
  }

  public stopPolling(): void {
    if (this.pollingTimer) {
      this.log('Stopping polling.');
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  private refreshPromise: Promise<ParsedQuotaInfo | null> | null = null;

  public async refresh(forceFresh: boolean = false): Promise<ParsedQuotaInfo | null> {
    if (this.refreshPromise) {
      if (!forceFresh) {
        return this.lastQuotaInfo || this.refreshPromise;
      }
      try {
        await this.refreshPromise;
      } catch {}
    }

    this.refreshPromise = this.doRefresh(forceFresh).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(forceFresh: boolean = false): Promise<ParsedQuotaInfo | null> {
    this.isRefreshing = true;

    try {
      if (forceFresh) {
        this.log('Force fresh refresh requested. Clearing cached connection.');
        this.cachedConnection = null;
      }

      // 1. Try with cached connection first (only during routine background polling)
      if (this.cachedConnection && !forceFresh) {
        this.log(`Testing cached connection (port ${this.cachedConnection.port}, PID ${this.cachedConnection.pid})...`);
        try {
          const quota = await this.fetchQuotaFromEndpoint(
            this.cachedConnection.port,
            this.cachedConnection.csrfToken,
            1500
          );
          if (quota && quota.response && quota.response.groups) {
            const userInfo = await this.fetchUserStatusFromEndpoint(
              this.cachedConnection.port,
              this.cachedConnection.csrfToken,
              1200
            );
            const parsed = this.parseQuotaResponse(quota, userInfo);
            this.lastQuotaInfo = parsed;
            this.emit('quotaUpdated', parsed);
            this.isRefreshing = false;
            return parsed;
          }
        } catch (err: any) {
          this.log(`Cached connection failed: ${err.message || err}. Invalidating cache.`);
          this.cachedConnection = null;
        }
      }

      // 2. Discover running language server processes (prioritizing newest process)
      this.log('Discovering running Language Server processes...');
      const connection = await this.discoverAndConnect();
      if (connection) {
        this.log(`Connection established! Using port ${connection.port}, PID ${connection.pid}`);
        this.cachedConnection = connection;
        const quota = connection.initialQuota || await this.fetchQuotaFromEndpoint(
          connection.port,
          connection.csrfToken,
          2500
        );
        if (quota && quota.response && quota.response.groups) {
          const userInfo = await this.fetchUserStatusFromEndpoint(
            connection.port,
            connection.csrfToken,
            1500
          );
          const parsed = this.parseQuotaResponse(quota, userInfo);
          this.lastQuotaInfo = parsed;
          this.emit('quotaUpdated', parsed);
          this.isRefreshing = false;
          return parsed;
        }
      }

      this.log('ERROR: Unable to connect to any Antigravity Language Server.');
      const err = new Error('Unable to connect to Antigravity Language Server.');
      this.emit('error', err);
      throw err;
    } catch (err: any) {
      this.log(`ERROR in refresh loop: ${err.message || err}`);
      this.emit('error', err);
      return this.lastQuotaInfo;
    } finally {
      this.isRefreshing = false;
    }
  }

  private async discoverAndConnect(): Promise<LanguageServerConnection | null> {
    const candidates = await this.findCandidateProcesses();
    if (candidates.length === 0) {
      this.log('No language_server processes found in process list.');
      return null;
    }

    this.log(`Found ${candidates.length} candidate processes.`);

    // Try candidates in priority order
    for (const candidate of candidates) {
      this.log(`Testing candidate PID ${candidate.pid} (isIde: ${candidate.isIde}) with ports: ${candidate.ports.join(', ')}`);
      
      if (candidate.ports.length === 0) continue;

      // Test candidate ports in parallel with fast timeout
      const probePromises = candidate.ports.map(async (port) => {
        const res = await this.fetchQuotaFromEndpoint(port, candidate.csrfToken, 1500);
        if (res && res.response && res.response.groups) {
          return { port, res };
        }
        throw new Error(`Port ${port} returned empty/invalid response`);
      });

      try {
        const winner = await Promise.any(probePromises);
        this.log(`SUCCESS on PID ${candidate.pid} via port ${winner.port}!`);
        return {
          pid: candidate.pid,
          csrfToken: candidate.csrfToken,
          port: winner.port,
          isIde: candidate.isIde,
          initialQuota: winner.res,
        };
      } catch {
        this.log(`Candidate PID ${candidate.pid} failed on all ports.`);
      }
    }

    return null;
  }

  private async findCandidateProcesses(): Promise<Array<{
    pid: string;
    csrfToken: string;
    ports: number[];
    isIde: boolean;
    numPid: number;
    createTime?: number;
  }>> {
    const platform = os.platform();
    const candidates: Array<{
      pid: string;
      csrfToken: string;
      ports: number[];
      isIde: boolean;
      numPid: number;
      createTime?: number;
    }> = [];

    this.log(`Scanning processes on platform: ${platform}`);

    if (platform === 'darwin' || platform === 'linux') {
      try {
        const { stdout: psOut } = await execAsync('ps aux', { encoding: 'utf8', timeout: 4000 });
        const lines = psOut.split('\n');

        for (const line of lines) {
          if (line.includes('language_server') && line.includes('--csrf_token')) {
            // Ignore standalone hub processes with https_server_port 0 which do not serve quota
            if (
              line.includes('--subclient_type hub') ||
              (line.includes('--https_server_port 0') && !line.includes('--extension_server_port'))
            ) {
              continue;
            }

            const pidMatch = line.trim().match(/^\S+\s+(\d+)/);
            const csrfMatch = line.match(/--csrf_token\s+([a-f0-9-]+)/i);
            if (pidMatch && csrfMatch) {
              const pid = pidMatch[1];
              const csrfToken = csrfMatch[1];
              const isIde =
                line.includes('--subclient_type ide') ||
                line.includes('antigravity-ide');

              const extPortMatch = line.match(/--extension_server_port\s+(\d+)/);
              const guessedPorts: number[] = [];
              if (extPortMatch) {
                const basePort = parseInt(extPortMatch[1], 10);
                for (let i = 1; i <= 6; i++) {
                  guessedPorts.push(basePort + i);
                }
              }

              // Get actual listening ports via lsof/netstat
              const activePorts = await this.getListeningPortsForPid(pid);
              
              // Merge actual ports and guessed ports (keeping actual ports first)
              const ports = Array.from(new Set([...activePorts, ...guessedPorts]));

              this.log(`Discovered candidate PID ${pid} (Active: ${activePorts.join(',')} | Guessed: ${guessedPorts.join(',')})`);
              candidates.push({
                pid,
                csrfToken,
                ports,
                isIde,
                numPid: parseInt(pid, 10) || 0,
              });
            }
          }
        }
      } catch (err: any) {
        this.log(`Error discovering processes via ps: ${err.message || err}`);
      }
    } else if (platform === 'win32') {
      try {
        const psScript = `$ProgressPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { ($_.Name -like '*language_server*') -and ($_.CommandLine -like '*--csrf_token*') } | Select-Object ProcessId, CommandLine, CreationDate | ConvertTo-Json -Compress`;
        const base64Script = Buffer.from(psScript, 'utf16le').toString('base64');
        const { stdout: rawOut } = await execAsync(`powershell -NoProfile -NonInteractive -EncodedCommand ${base64Script}`, {
          encoding: 'utf8',
          timeout: 5000,
        });

        const jsonStart = rawOut.indexOf('[');
        const jsonStartObj = rawOut.indexOf('{');
        const startIdx = (jsonStart !== -1 && jsonStartObj !== -1)
          ? Math.min(jsonStart, jsonStartObj)
          : (jsonStart !== -1 ? jsonStart : jsonStartObj);

        const cleanJson = startIdx !== -1 ? rawOut.substring(startIdx).trim() : rawOut.trim();
        const items = JSON.parse(cleanJson);
        const list = Array.isArray(items) ? items : [items];

        for (const item of list) {
          if (item && item.CommandLine && item.CommandLine.includes('--csrf_token')) {
            if (
              item.CommandLine.includes('--subclient_type hub') ||
              (item.CommandLine.includes('--https_server_port 0') && !item.CommandLine.includes('--extension_server_port'))
            ) {
              continue;
            }

            const pid = String(item.ProcessId);
            const csrfMatch = item.CommandLine.match(/--csrf_token\s+([a-f0-9-]+)/i);
            if (csrfMatch) {
              const csrfToken = csrfMatch[1];
              const isIde = item.CommandLine.includes('antigravity');
              
              const extPortMatch = item.CommandLine.match(/--extension_server_port\s+(\d+)/);
              const guessedPorts: number[] = [];
              if (extPortMatch) {
                const basePort = parseInt(extPortMatch[1], 10);
                for (let i = 1; i <= 6; i++) {
                  guessedPorts.push(basePort + i);
                }
              }

              const activePorts = await this.getListeningPortsForPid(pid);
              const ports = Array.from(new Set([...activePorts, ...guessedPorts]));

              let createTime = 0;
              if (item.CreationDate) {
                const numMatch = String(item.CreationDate).match(/\d+/);
                if (numMatch) {
                  createTime = parseInt(numMatch[0], 10);
                } else {
                  createTime = new Date(item.CreationDate).getTime() || 0;
                }
              }
              this.log(`Discovered Windows candidate PID ${pid} (Active: ${activePorts.join(',')} | Guessed: ${guessedPorts.join(',')} | Created: ${createTime})`);
              candidates.push({
                pid,
                csrfToken,
                ports,
                isIde,
                numPid: parseInt(pid, 10) || 0,
                createTime,
              });
            }
          }
        }
      } catch (err: any) {
        this.log(`Windows process search error: ${err.message || err}`);
      }
    }

    // Sort priority: isIde first, then newest process by CreationDate (falling back to PID)
    candidates.sort((a, b) => {
      if (b.isIde !== a.isIde) return (b.isIde ? 1 : 0) - (a.isIde ? 1 : 0);
      if (b.createTime && a.createTime && b.createTime !== a.createTime) {
        return b.createTime - a.createTime;
      }
      return b.numPid - a.numPid;
    });

    return candidates;
  }

  private static readonly IGNORED_PORTS = new Set([9333, 9222, 9229]);

  private async getListeningPortsForPid(pid: string): Promise<number[]> {
    const platform = os.platform();
    const ports: number[] = [];

    if (platform === 'darwin' || platform === 'linux') {
      const lsofPaths = [
        '/usr/sbin/lsof',
        '/usr/bin/lsof',
        '/sbin/lsof',
        '/bin/lsof',
        'lsof'
      ];
      
      for (const lsofPath of lsofPaths) {
        try {
          const { stdout: lsofOut } = await execAsync(`${lsofPath} -nP -a -p ${pid} -iTCP -sTCP:LISTEN`, {
            encoding: 'utf8',
            timeout: 2000,
          });
          if (lsofOut) {
            const matches = [...lsofOut.matchAll(/:(\d+)\s+\(LISTEN\)/g)];
            for (const m of matches) {
              const p = parseInt(m[1], 10);
              if (!isNaN(p) && !QuotaService.IGNORED_PORTS.has(p) && !ports.includes(p)) {
                ports.push(p);
              }
            }
            if (ports.length > 0) break;
          }
        } catch {}
      }

      if (ports.length === 0) {
        const netstatPaths = ['/usr/sbin/netstat', '/usr/bin/netstat', '/sbin/netstat', '/bin/netstat', 'netstat'];
        for (const netstatPath of netstatPaths) {
          try {
            const { stdout: netstatOut } = await execAsync(`${netstatPath} -anp 2>/dev/null | grep ${pid}`, {
              encoding: 'utf8',
              timeout: 2000,
            });
            const matches = [...netstatOut.matchAll(/127\.0\.0\.1:(\d+)/g)];
            for (const m of matches) {
              const p = parseInt(m[1], 10);
              if (!isNaN(p) && !QuotaService.IGNORED_PORTS.has(p) && !ports.includes(p)) {
                ports.push(p);
              }
            }
            if (ports.length > 0) break;
          } catch {}
        }
      }
    } else if (platform === 'win32') {
      try {
        const winDir = process.env.SystemRoot || 'C:\\Windows';
        const { stdout: netstatOut } = await execAsync(`"${winDir}\\System32\\netstat.exe" -ano`, {
          encoding: 'utf8',
          timeout: 2500,
        });
        const lines = netstatOut.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.endsWith(` ${pid}`) && trimmed.includes('LISTENING')) {
            const match = trimmed.match(/127\.0\.0\.1:(\d+)/);
            if (match) {
              const p = parseInt(match[1], 10);
              if (!isNaN(p) && !QuotaService.IGNORED_PORTS.has(p) && !ports.includes(p)) {
                ports.push(p);
              }
            }
          }
        }
      } catch {}
    }

    return ports;
  }

  private async fetchUserStatusFromEndpoint(
    port: number,
    csrfToken: string,
    timeoutMs: number = 1500
  ): Promise<{ name?: string; email?: string; planName?: string } | null> {
    return new Promise((resolve) => {
      let isSettled = false;
      const timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          try { req.destroy(); } catch {}
          resolve(null);
        }
      }, timeoutMs);

      const payload = JSON.stringify({});
      const req = https.request(
        {
          hostname: '127.0.0.1',
          port: port,
          path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
          method: 'POST',
          rejectUnauthorized: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'x-codeium-csrf-token': csrfToken,
            'Connect-Protocol-Version': '1',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            clearTimeout(timer);
            if (isSettled) return;
            isSettled = true;
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(data);
                const user = parsed.userStatus;
                if (user) {
                  resolve({
                    name: user.name,
                    email: user.email,
                    planName: user.planStatus?.planInfo?.planName || user.plan,
                  });
                  return;
                }
              } catch {}
            }
            resolve(null);
          });
        }
      );

      req.on('error', () => {
        clearTimeout(timer);
        if (!isSettled) {
          isSettled = true;
          resolve(null);
        }
      });

      req.write(payload);
      req.end();
    });
  }

  private async fetchQuotaFromEndpoint(
    port: number,
    csrfToken: string,
    timeoutMs: number = 2000
  ): Promise<QuotaSummaryResponse | null> {
    return new Promise((resolve, reject) => {
      let isSettled = false;

      // Hard safety timer to prevent any TLS handshake / unresponding socket hang
      const timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          try {
            req.destroy(new Error('Request timed out'));
          } catch {}
          reject(new Error(`Request to port ${port} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const cleanup = () => clearTimeout(timer);

      const payload = JSON.stringify({});
      const req = https.request(
        {
          hostname: '127.0.0.1',
          port: port,
          path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
          method: 'POST',
          rejectUnauthorized: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'x-codeium-csrf-token': csrfToken,
            'Connect-Protocol-Version': '1',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            cleanup();
            if (isSettled) return;
            isSettled = true;
            if (res.statusCode === 200) {
              try {
                const parsed: QuotaSummaryResponse = JSON.parse(data);
                resolve(parsed);
              } catch (e) {
                reject(new Error(`JSON parse error: ${e}`));
              }
            } else {
              reject(new Error(`HTTP status ${res.statusCode}: ${data}`));
            }
          });
        }
      );

      req.on('error', (err) => {
        cleanup();
        if (isSettled) return;
        isSettled = true;
        reject(err);
      });

      req.write(payload);
      req.end();
    });
  }

  private parseQuotaResponse(
    data: QuotaSummaryResponse,
    userInfo?: { name?: string; email?: string; planName?: string } | null
  ): ParsedQuotaInfo {
    const groups: QuotaGroup[] = data.response?.groups || [];
    let lowest = 1.0;

    for (const group of groups) {
      const weeklyBucket = group.buckets?.find(
        (b) => b.window === 'weekly' || b.bucketId.includes('weekly')
      );
      const isWeeklyExhausted =
        weeklyBucket &&
        typeof weeklyBucket.remainingFraction === 'number' &&
        weeklyBucket.remainingFraction <= 0;

      for (const bucket of group.buckets || []) {
        // If weekly is exhausted or explicitly marked disabled by LSP
        if (
          bucket.disabled ||
          (isWeeklyExhausted && (bucket.window === '5h' || bucket.bucketId.includes('5h')))
        ) {
          bucket.disabled = true;
        }

        if (typeof bucket.remainingFraction === 'number') {
          // If bucket is disabled or weekly limit is 0, effective fraction is 0
          const effective = bucket.disabled ? 0 : bucket.remainingFraction;
          if (effective < lowest) {
            lowest = effective;
          }
        }
      }
    }

    return {
      groups,
      description: data.response?.description,
      lastUpdated: new Date(),
      lowestFraction: lowest,
      userEmail: userInfo?.email,
      userName: userInfo?.name,
      planName: userInfo?.planName,
    };
  }

  /**
   * Helper utility to format remaining duration until reset
   */
  public static formatTimeUntilReset(resetTimeIso?: string): string {
    if (!resetTimeIso) return '';
    const resetDate = new Date(resetTimeIso);
    const now = new Date();
    const diffMs = resetDate.getTime() - now.getTime();

    if (diffMs <= 0) return 'Resetting now';

    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const days = Math.floor(diffMinutes / (60 * 24));
    const hours = Math.floor((diffMinutes % (60 * 24)) / 60);
    const minutes = diffMinutes % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);

    return parts.join(' ');
  }

  /**
   * Helper to format percentage (0-100%)
   */
  public static formatPercentage(fraction: number): string {
    return `${Math.round(fraction * 100)}%`;
  }
}

