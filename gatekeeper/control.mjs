#!/usr/bin/env node
// ============================================================================
// gatekeeper 管理命令 —— install / uninstall / enable / disable / status / approve
// 由 gatekeeper.mjs 分发调用，例如：
//   node gatekeeper.mjs install              # 一键安装：复制文件到 ~/.zcode/gatekeeper 并注册 hooks
//   node gatekeeper.mjs uninstall [--purge]  # 一键卸载：反注册 hooks（--purge 连文件一起删）
//   node gatekeeper.mjs enable / disable     # 只切换 hooks.enabled 开关
//   node gatekeeper.mjs status               # 查看安装/运行状态
//   node gatekeeper.mjs approve "<命令>"      # 一次性放行（精确匹配、用后即焚、10 分钟 TTL）
// ============================================================================

import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME_ZCODE = path.join(os.homedir(), '.zcode');
const TARGET_DIR = path.join(HOME_ZCODE, 'gatekeeper');
const USER_CONFIG = path.join(HOME_ZCODE, 'cli', 'config.json');
const HOOK_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'PreToolUse', 'PermissionRequest'];
const INSTALL_FILES = ['gatekeeper.mjs', 'gatekeeper-daemon.mjs', 'core.mjs', 'control.mjs', 'policy.md', 'allowlist.txt', 'dangerlist.txt', 'config.json', 'config.example.json'];
// 判定某 hook 条目是否属于本工具（安装/卸载只动自己的条目，不碰用户其他 hooks）
const MARKER = /[\\/]gatekeeper[\\/]gatekeeper\.mjs$/i;

const out = (m) => console.log(m);
const loadJson = (f, fb) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fb; } };
const saveJson = (f, o) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(o, null, 2) + '\n'); };
const backup = (f) => { try { const b = f + '.bak-gk-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, ''); writeFileSync(b, readFileSync(f)); return b; } catch { return null; } };

// hooks 实际运行位置：已安装优先，否则当前脚本目录
function runtimeDir() {
  return existsSync(path.join(TARGET_DIR, 'gatekeeper.mjs')) ? TARGET_DIR : SCRIPT_DIR;
}

function isOurHook(h) {
  return h && typeof h.command === 'string' && /node/i.test(path.basename(h.command))
    && Array.isArray(h.args) && h.args[0] && MARKER.test(h.args[0]);
}

function mkEntries(script) {
  const mk = (args, timeoutMs) => ({ type: 'process', command: process.execPath, args: [script, ...args], timeoutMs });
  return {
    UserPromptSubmit: [{ hooks: [mk(['capture-prompt'], 5000)] }],
    PostToolUse: [{ hooks: [mk(['capture-tool'], 5000)] }],
    PreToolUse: [{ hooks: [mk(['review', '--layer=hard'], 50000)] }],
    PermissionRequest: [{ hooks: [mk(['review', '--layer=full'], 45000)] }],
  };
}

function pingDaemon(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = '';
    s.setEncoding('utf8');
    const to = setTimeout(() => { s.destroy(); resolve(null); }, timeoutMs);
    s.on('connect', () => s.write(JSON.stringify({ op: 'ping' }) + '\n'));
    s.on('data', d => { buf += d; if (buf.includes('\n')) { clearTimeout(to); s.destroy(); try { resolve(JSON.parse(buf)); } catch { resolve(null); } } });
    s.on('error', () => { clearTimeout(to); resolve(null); });
  });
}

// ---------------------------------------------------------------- 安装 ------
async function cmdInstall() {
  mkdirSync(TARGET_DIR, { recursive: true });
  let copied = 0;
  for (const f of INSTALL_FILES) {
    const src = path.join(SCRIPT_DIR, f);
    if (!existsSync(src)) continue;
    // 升级安装时保留用户已调好的配置，只在首次安装时带入
    if (f === 'config.json' && existsSync(path.join(TARGET_DIR, f))) continue;
    cpSync(src, path.join(TARGET_DIR, f));
    copied++;
  }
  out(`✓ 已复制 ${copied} 个文件 → ${TARGET_DIR}`);

  // 首次安装没有 config.json（仓库不含真实密钥）→ 从模板生成
  if (!existsSync(path.join(TARGET_DIR, 'config.json'))) {
    cpSync(path.join(SCRIPT_DIR, 'config.example.json'), path.join(TARGET_DIR, 'config.json'));
    out('✓ 已从模板生成 config.json —— 请编辑填入你的审查端点（baseUrl/apiKey/model）');
  }

  if (!existsSync(USER_CONFIG)) {
    out(`✗ 未找到用户配置 ${USER_CONFIG} —— 请确认 ZCode 已安装过并至少启动过一次`);
    return 1;
  }
  const bak = backup(USER_CONFIG);
  const cfg = loadJson(USER_CONFIG, {});
  const hooks = cfg.hooks || { enabled: true };
  hooks.enabled = true;
  const events = hooks.events = hooks.events || {};
  const entries = mkEntries(path.join(TARGET_DIR, 'gatekeeper.mjs'));
  for (const ev of HOOK_EVENTS) {
    // 先清掉本工具旧条目（支持从旧路径升级），再追加
    events[ev] = (events[ev] || [])
      .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurHook(h)) }))
      .filter(g => (g.hooks || []).length > 0);
    events[ev] = [...events[ev], ...entries[ev]];
  }
  cfg.hooks = hooks;
  saveJson(USER_CONFIG, cfg);
  out(`✓ hooks 已注册（备份：${bak}）`);

  const targetCfg = loadJson(path.join(TARGET_DIR, 'config.json'), {});
  if (!targetCfg.apiKey || targetCfg.apiKey === 'PENDING') {
    out('⚠ 尚未配置审查端点：请编辑 ' + path.join(TARGET_DIR, 'config.json') + ' 填入 baseUrl / apiKey / model');
  }
  if (SCRIPT_DIR.toLowerCase() !== TARGET_DIR.toLowerCase()) {
    try { spawnSelfShutdown(); } catch { /* 忽略 */ }
  }
  out('');
  out('安装完成。使用前两件事：');
  out('  1. 重启 ZCode 会话（hooks 在会话启动时加载）');
  out('  2. 确认 ' + path.join(TARGET_DIR, 'config.json') + ' 里的审查端点可用');
  out('卸载：node ' + path.join(TARGET_DIR, 'gatekeeper.mjs') + ' uninstall --purge');
  return 0;
}

function spawnSelfShutdown() {
  // 从旧位置拉起的 daemon 需要停掉，避免双实例占端口（新实例会自动拉起）
  try { spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'gatekeeper.mjs'), 'shutdown-daemon'], { stdio: 'ignore', timeout: 8000 }); } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------- 卸载 ------
async function cmdUninstall(purge) {
  // 停 daemon（新旧位置都试一次）
  for (const dir of [TARGET_DIR, SCRIPT_DIR]) {
    const script = path.join(dir, 'gatekeeper.mjs');
    if (existsSync(script)) {
      try { spawnSync(process.execPath, [script, 'shutdown-daemon'], { stdio: 'ignore', timeout: 8000 }); } catch { /* 忽略 */ }
    }
  }
  if (!existsSync(USER_CONFIG)) { out('✗ 未找到用户配置 ' + USER_CONFIG); return 1; }
  const bak = backup(USER_CONFIG);
  const cfg = loadJson(USER_CONFIG, {});
  if (cfg.hooks?.events) {
    for (const ev of Object.keys(cfg.hooks.events)) {
      cfg.hooks.events[ev] = (cfg.hooks.events[ev] || [])
        .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurHook(h)) }))
        .filter(g => (g.hooks || []).length > 0);
      if (!cfg.hooks.events[ev].length) delete cfg.hooks.events[ev];
    }
    if (!Object.keys(cfg.hooks.events).length) delete cfg.hooks.events;
    if (!Object.keys(cfg.hooks).filter(k => k !== 'enabled').length) delete cfg.hooks;
    saveJson(USER_CONFIG, cfg);
    out(`✓ hooks 已反注册（备份：${bak}）`);
  } else {
    out('未发现本工具的 hooks，无需反注册');
  }
  if (purge) {
    if (existsSync(TARGET_DIR) && TARGET_DIR.toLowerCase() !== SCRIPT_DIR.toLowerCase()) {
      rmSync(TARGET_DIR, { recursive: true, force: true });
      out('✓ 已删除安装目录 ' + TARGET_DIR);
    } else {
      out('跳过删除：安装目录与当前脚本目录相同');
    }
  } else {
    out('文件保留在 ' + (existsSync(TARGET_DIR) ? TARGET_DIR : SCRIPT_DIR) + '（加 --purge 可一并删除）');
  }
  out('重启 ZCode 会话后彻底生效。');
  return 0;
}

// ---------------------------------------------------------------- 开关 ------
async function cmdSetEnabled(on) {
  const cfg = loadJson(USER_CONFIG, {});
  if (!cfg.hooks?.events) {
    out(on ? '✗ 尚未安装（先运行 install）' : '✗ 尚未安装，无需禁用');
    return 1;
  }
  const bak = backup(USER_CONFIG);
  cfg.hooks.enabled = on;
  saveJson(USER_CONFIG, cfg);
  out(`✓ hooks.enabled = ${on}${bak ? '（备份：' + bak + '）' : ''}。重启 ZCode 会话后生效。`);
  return 0;
}

// ---------------------------------------------------------------- 状态 ------
async function cmdStatus() {
  const cfg = loadJson(USER_CONFIG, {});
  const rd = runtimeDir();
  const rcfg = loadJson(path.join(rd, 'config.json'), {});
  out('── 安装状态 ──────────────────────────');
  out('安装目录   : ' + (existsSync(path.join(TARGET_DIR, 'gatekeeper.mjs')) ? TARGET_DIR : '（未安装，运行目录 ' + SCRIPT_DIR + '）'));
  out('hooks 注册 : ' + (cfg.hooks?.events
    ? HOOK_EVENTS.map(ev => ev + (cfg.hooks.events[ev] ? ' ✓' : ' ✗')).join('  ') + '  enabled=' + cfg.hooks.enabled
    : '未注册'));
  out('运行目录   : ' + rd);
  out('── 审查端点 ──────────────────────────');
  out('endpoint   : ' + (rcfg.baseUrl || '（未配置）'));
  out('model      : ' + (rcfg.model || '（未配置）'));
  out('apiKey     : ' + (rcfg.apiKey ? String(rcfg.apiKey).slice(0, 6) + '…（已配置）' : '（未配置）'));
  out('fullAccessGuard: ' + (rcfg.fullAccessGuard === true ? '开（完全访问守卫）' : '关（确认模式）'));
  out('── 运行时 ────────────────────────────');
  const pong = rcfg.daemon === false ? null : await pingDaemon(rcfg.daemonPort | 0 || 47811);
  out('daemon     : ' + (pong?.ok ? '运行中 (llmWarm=' + pong.llmWarm + ')' : '未运行（调用时自动拉起）'));
  let approved = 0;
  try {
    const list = JSON.parse(readFileSync(path.join(rd, 'state', 'approved.json'), 'utf8'));
    approved = list.filter(e => Date.now() - (e.ts || 0) <= 10 * 60 * 1000).length;
  } catch { /* 无文件 */ }
  out('待用批准   : ' + approved + ' 条（10 分钟 TTL）');
  try {
    const lines = readFileSync(path.join(rd, 'state', 'audit.jsonl'), 'utf8').trim().split('\n').slice(-3);
    out('最近审计   :');
    for (const l of lines) out('  ' + l.slice(0, 150));
  } catch { out('最近审计   : （无）'); }
  return 0;
}

// ---------------------------------------------------------------- 批准 ------
async function cmdApprove(args) {
  const yes = args.includes('--yes');
  const isLast = args.includes('--last');
  let cmd = args.filter(a => a !== '--yes' && a !== '--last').join(' ').trim();
  const stateDir = process.env.GATEKEEPER_STATE_DIR || path.join(runtimeDir(), 'state');
  if (isLast) {
    // 批准最近一条被拒命令（从队列弹出，避免重复批准陈旧条目）
    const list = loadJson(path.join(stateDir, 'denied.json'), []);
    if (!Array.isArray(list) || !list.length) { out('没有可批准的最近被拒命令'); return 1; }
    cmd = String(list[list.length - 1].cmd || '');
    list.pop();
    saveJson(path.join(stateDir, 'denied.json'), list);
    if (!cmd) { out('最近被拒记录为空，无法批准'); return 1; }
  }
  if (!cmd) { out('用法: node gatekeeper.mjs approve "<完整命令>" [--last] [--yes]'); return 1; }
  if (!process.stdin.isTTY && !yes) {
    out('✗ 非交互环境拒绝批准（防止模型自行给自己放行）。');
    out('  如用户已明确授权，请由用户在终端亲自执行本命令，或追加 --yes。');
    return 1;
  }
  if (!yes && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise(res => rl.question('确认一次性放行该命令？[y/N] ', res));
    rl.close();
    if (!/^y(es)?$/i.test((ans || '').trim())) { out('已取消'); return 1; }
  }
  process.env.GATEKEEPER_STATE_DIR = process.env.GATEKEEPER_STATE_DIR || path.join(runtimeDir(), 'state');
  const { approvedAdd } = await import('./core.mjs');
  approvedAdd(cmd);
  out('✓ 已一次性批准（10 分钟内有效、精确匹配原命令、用后即焚）：' + cmd.slice(0, 120));
  out('  现在让模型重试该命令即可。');
  return 0;
}

// ---------------------------------------------------------------- 入口 ------
export async function runControl(argv) {
  const cmd = argv[0];
  switch (cmd) {
    case 'install': return cmdInstall();
    case 'uninstall': return cmdUninstall(argv.includes('--purge'));
    case 'enable': return cmdSetEnabled(true);
    case 'disable': return cmdSetEnabled(false);
    case 'status': return cmdStatus();
    case 'approve': return cmdApprove(argv.slice(1));
    case 'shutdown-daemon': {
      const rd = runtimeDir();
      const port = loadJson(path.join(rd, 'config.json'), {}).daemonPort | 0 || 47811;
      const pong = await pingDaemon(port, 600);
      if (!pong?.ok) { out('daemon 未在运行'); return 0; }
      await new Promise(res => {
        const s = net.connect(port, '127.0.0.1');
        s.on('connect', () => s.write(JSON.stringify({ op: 'shutdown' }) + '\n'));
        s.on('data', () => { out('✓ daemon 已停止'); res(); });
        s.on('error', () => { out('daemon 连接失败'); res(); });
        setTimeout(res, 2000);
      });
      return 0;
    }
    default:
      out('未知管理命令: ' + cmd);
      out('可用: install | uninstall [--purge] | enable | disable | status | approve "<命令>" | shutdown-daemon');
      return 1;
  }
}
