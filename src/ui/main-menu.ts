/**
 * main-menu.ts — Interactive main menu for /gitnexus.
 *
 * Shows status in the title, with Analyze, Settings, and Help actions.
 */

import spawn from 'cross-spawn';
import { type GitNexusConfig, runGitNexusAnalyze } from '../gitnexus.js';
import type { GitNexusServerApi } from '../server-api.js';
import { openSettingsMenu } from './settings-menu.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type MenuUI = {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, type: 'info' | 'warning' | 'error'): void;
  custom<T>(
    factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
    options?: { overlay?: boolean; overlayOptions?: any },
  ): Promise<T>;
};

export interface MenuContext {
  ui: MenuUI;
  cwd: string;
  cfg: GitNexusConfig;
  state: { augmentEnabled: boolean };
  binaryAvailable: boolean;
  gitnexusCmd: string[];
  spawnEnv: NodeJS.ProcessEnv;
  transportType: 'stdio' | 'http';
  serverApi: GitNexusServerApi | null;
  workspaceDir: string;
  getHookFires: () => number;
  getAugmentHits: () => number;
  findGitNexusIndex: (cwd: string) => boolean;
  clearIndexCache: () => void;
  resetAugmentCaches: () => void;
  setGitnexusCmd: (cmd: string[]) => void;
  setAugmentTimeout: (seconds: number) => void;
  syncState: () => void;
}

// ── Status ──────────────────────────────────────────────────────────────────

async function getStatusLine(mctx: MenuContext): Promise<string> {
  // HTTP mode: use REST API for status
  if (mctx.transportType === 'http' && mctx.serverApi) {
    try {
      const [info, repos] = await Promise.all([mctx.serverApi.info(), mctx.serverApi.listRepos()]);
      const repoSummary = repos.length > 0
        ? repos.map(r => `  ${r.name} (${r.stats.nodes} nodes, ${r.stats.edges} edges)`).join('\n')
        : '  (no repos indexed)';
      const augmentLine = mctx.state.augmentEnabled
        ? `Auto-augment: on (${mctx.getHookFires()} intercepted, ${mctx.getAugmentHits()} enriched)`
        : 'Auto-augment: off';
      return `Server v${info.version} (HTTP)\nRepos (${repos.length}):\n${repoSummary}\n${augmentLine}`;
    } catch {
      return 'Server unreachable';
    }
  }

  // Stdio mode: existing behavior
  if (!mctx.binaryAvailable) return 'gitnexus not installed';
  if (!mctx.findGitNexusIndex(mctx.cwd)) return 'No index \u2014 run /gitnexus analyze';
  const out = await new Promise<string>((resolve_) => {
    let stdout = '';
    const [bin, ...baseArgs] = mctx.gitnexusCmd;
    const proc = spawn(bin, [...baseArgs, 'status'], {
      cwd: mctx.cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: mctx.spawnEnv,
    });
    proc.stdout!.on('data', (chunk: { toString(): string }) => { stdout += chunk.toString(); });
    proc.on('close', () => resolve_(stdout.trim()));
    proc.on('error', () => resolve_(''));
  });
  const augmentLine = mctx.state.augmentEnabled
    ? `Auto-augment: on (${mctx.getHookFires()} intercepted, ${mctx.getAugmentHits()} enriched)`
    : 'Auto-augment: off';
  return (out ? out + '\n' : '') + augmentLine;
}

// ── Analyze ─────────────────────────────────────────────────────────────────

async function runAnalyze(mctx: MenuContext): Promise<void> {
  // HTTP mode: use server API for analysis
  if (mctx.transportType === 'http' && mctx.serverApi) {
    mctx.state.augmentEnabled = false;
    mctx.syncState();
    const { basename } = await import('node:path');
    const repoName = basename(mctx.cwd);
    const target = { path: `${mctx.workspaceDir}/${repoName}` };
    mctx.ui.notify('GitNexus: analyzing on server, this may take a while\u2026', 'info');
    try {
      const result = await mctx.serverApi.analyzeAndWait(target, (status) => {
        mctx.ui.notify(
          `GitNexus: ${status.progress.phase} \u2014 ${status.progress.percent}% ${status.progress.message}`,
          'info',
        );
      });
      mctx.clearIndexCache();
      mctx.resetAugmentCaches();
      if (result.status === 'complete') {
        mctx.state.augmentEnabled = true;
        mctx.syncState();
        mctx.ui.notify('GitNexus: server analysis complete. Knowledge graph ready.', 'info');
      } else {
        mctx.state.augmentEnabled = true;
        mctx.syncState();
        mctx.ui.notify(`GitNexus: analysis failed \u2014 ${result.error || 'unknown error'}`, 'error');
      }
    } catch (err) {
      mctx.state.augmentEnabled = true;
      mctx.syncState();
      mctx.ui.notify(`GitNexus: analysis failed \u2014 ${err instanceof Error ? err.message : 'unknown error'}`, 'error');
    }
    return;
  }

  // Stdio mode: existing behavior
  if (!mctx.binaryAvailable) {
    mctx.ui.notify('gitnexus is not installed. Install: npm i -g gitnexus', 'warning');
    return;
  }
  mctx.state.augmentEnabled = false;
  mctx.syncState();
  mctx.ui.notify('GitNexus: analyzing codebase, this may take a while\u2026', 'info');
  const exitCode = await runGitNexusAnalyze(mctx.cwd);
  if (exitCode === 0) {
    mctx.clearIndexCache();
    mctx.resetAugmentCaches();
    mctx.state.augmentEnabled = true;
    mctx.syncState();
    mctx.ui.notify('GitNexus: analysis complete. Knowledge graph ready.', 'info');
  } else {
    mctx.state.augmentEnabled = true;
    mctx.syncState();
    mctx.ui.notify('GitNexus: analysis failed. Check the terminal for details.', 'error');
  }
}

// ── Help ────────────────────────────────────────────────────────────────────

function showHelp(mctx: MenuContext): void {
  mctx.ui.notify(
    'Subcommands:\n' +
    '  /gitnexus status      — show index & augmentation stats\n' +
    '  /gitnexus analyze     — build/rebuild the knowledge graph\n' +
    '  /gitnexus on|off      — toggle auto-augment\n' +
    '  /gitnexus <pattern>   — manual graph lookup\n' +
    '  /gitnexus query <q>   — search execution flows\n' +
    '  /gitnexus context <n> — callers/callees of a symbol\n' +
    '  /gitnexus impact <n>  — blast radius of a change',
    'info',
  );
}

// ── Main menu ───────────────────────────────────────────────────────────────

export async function openMainMenu(mctx: MenuContext): Promise<void> {
  const mainMenu = async (): Promise<void> => {
    const statusLine = await getStatusLine(mctx);
    const title = `GitNexus\n${statusLine}`;
    const choices = [
      'Analyze',
      'Settings',
      'Help',
    ];
    const choice = await mctx.ui.select(title, choices);
    if (!choice) return;
    if (choice === 'Analyze') {
      await runAnalyze(mctx);
      return mainMenu();
    }
    if (choice === 'Settings') {
      await openSettingsMenu(mctx.ui, mctx.cfg, mctx.state, mctx.syncState);
      return mainMenu();
    }
    if (choice === 'Help') {
      showHelp(mctx);
      return mainMenu();
    }
  };
  await mainMenu();
}
