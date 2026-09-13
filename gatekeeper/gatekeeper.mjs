#!/usr/bin/env node
// ============================================================================
// ZCode「Auto 审批员」gatekeeper —— 对标 Claude Code auto mode 的外置审查 hook
// 审查提示词与判定结构参照 Claude Code 真实源码（yolo-classifier-prompts）。
//
// 本文件是 hook 入口（哑客户端）：优先把请求转发给常驻守护进程
// gatekeeper-daemon.mjs（热连接 + 内存缓存，按需自动拉起）；
// 守护进程不可用时自动降级为内联模式（core.mjs 原逻辑，行为不变）。
//
// 由 ZCode hooks 注册调用（四个入口，见 ../README.md）：
//   node gatekeeper.mjs capture-prompt        # UserPromptSubmit：捕获任务上下文
//   node gatekeeper.mjs capture-tool          # PostToolUse：记录近期动作
//   node gatekeeper.mjs review                # PreToolUse / PermissionRequest
//   node gatekeeper.mjs shutdown-daemon       # 停止守护进程（维护用）
//
// 决策协议：deny → exit 2 + stderr 理由；allow → exit 0（PermissionRequest 输出决策 JSON）；
//           ask → exit 0 无输出（回落 ZCode 原生权限弹窗）
// ============================================================================

import net from 'node:net';
import { spawn } from 'node:child_process';
import { statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILES = ['config.json', 'policy.md', 'allowlist.txt', 'dangerlist.txt'];

function loadJsonFile(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

// 安全退出：销毁 stdin → 设 exitCode → 事件循环自然排空（Windows 直接 process.exit
// 会触发 libuv 断言崩溃，exit=127 会被 ZCode 误判为 hook 错误）
function exitWith(code, stdout = '', stderr = '') {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  try { process.stdin.destroy(); } catch { /* 已关闭 */ }
  process.exitCode = code;
  const t = setTimeout(() => { try { process.exit(process.exitCode || 0); } catch { /* 忽略 */ } }, 250);
  if (typeof t.unref === 'function') t.unref();
}

function readStdin(ms = 5000) {
  return new Promise(resolve => {
    let data = '';
    const t = setTimeout(() => resolve(data), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => { clearTimeout(t); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(data); });
  });
}

function sigs() {
  return CONFIG_FILES.map(f => {
    try { return statSync(path.join(SCRIPT_DIR, f)).mtimeMs; } catch { return -1; }
  });
}

// ---- 守护进程通道 -----------------------------------------------------------
function tryProxy(port, reqObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const dbg = (m) => { if (process.env.GATEKEEPER_DEBUG) process.stderr.write('[gk-debug|sock] ' + m + '\n'); };
    const s = net.connect(port, '127.0.0.1');
    let buf = '';
    s.setEncoding('utf8');
    const to = setTimeout(() => { dbg('timeout, buf=' + JSON.stringify(buf).slice(0, 120)); s.destroy(); reject(new Error('proxy timeout')); }, timeoutMs);
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(to); s.destroy(); fn(arg); };
    s.on('connect', () => { dbg('connected'); s.write(JSON.stringify(reqObj) + '\n'); s.end(); });
    s.on('data', c => {
      dbg('data: ' + JSON.stringify(String(c)).slice(0, 120));
      buf += c;
      if (buf.includes('\n')) {
        try { finish(resolve, JSON.parse(buf)); } catch (e) { finish(reject, e); }
      }
    });
    s.on('close', () => { if (!done) finish(reject, new Error('connection closed before response')); });
    s.on('error', e => finish(reject, e));
  });
}

function spawnDaemon(daemonPath) {
  try {
    const child = spawn(process.execPath, [daemonPath], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env, cwd: SCRIPT_DIR,
    });
    child.unref();
    return true;
  } catch { return false; }
}

async function proxyOrStartDaemon(port, mode, payload) {
  const dbg = (m) => { if (process.env.GATEKEEPER_DEBUG) process.stderr.write('[gk-debug] ' + m + '\n'); };
  // 探测一律用无副作用的 ping；完整 hook 请求只发一次（避免重复触发 LLM）
  const ping = (ms) => tryProxy(port, { op: 'ping' }, ms).catch(() => null);
  let up = (await ping(300))?.ok;
  if (!up) {
    dbg('daemon not reachable, spawning…');
    spawnDaemon(path.join(SCRIPT_DIR, 'gatekeeper-daemon.mjs'));
    for (let waited = 0; waited <= 2500; waited += 150) {
      await new Promise(r => setTimeout(r, 150));
      if ((await ping(400))?.ok) { up = true; dbg('daemon ready after ' + (waited + 150) + 'ms'); break; }
    }
  }
  if (!up) { dbg('daemon never came up → 内联降级'); throw new Error('daemon not reachable'); }
  return tryProxy(port, { op: 'hook', mode, payload, sigs: sigs(), env: { fullAccessGuard: ['1', 'true', 'yes', 'on'].includes(String(process.env.GATEKEEPER_FULL_ACCESS_GUARD || '').toLowerCase()) ? true : undefined } }, 42_000);
}

async function main() {
  const mode = process.argv[2] || '';

  // ---- 管理命令（不读 stdin，即秒响应）----
  if (['install', 'uninstall', 'enable', 'disable', 'status', 'approve', 'shutdown-daemon'].includes(mode)) {
    const { runControl } = await import('./control.mjs');
    const code = await runControl(process.argv.slice(2));
    exitWith(code ?? 0);
    return;
  }

  const raw = await readStdin();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { payload = null; }

  const cfg = loadJsonFile(path.join(SCRIPT_DIR, 'config.json'), {});
  const daemonEnabled = cfg.daemon !== false && !process.env.GATEKEEPER_NO_DAEMON;
  const port = cfg.daemonPort | 0 || 47811;

  if (daemonEnabled && (mode === 'review' || mode === 'capture-prompt' || mode === 'capture-tool')) {
    try {
      const r = await proxyOrStartDaemon(port, mode, payload);
      if (r && typeof r.exitCode === 'number') return exitWith(r.exitCode, r.stdout || '', r.stderr || '');
      // ping 应答等非 hook 结果 → 视为通道异常，走内联
    } catch { /* 落入内联 */ }
  }

  // ---- 内联模式（daemon 关闭/不可达时的原逻辑）----
  const { loadAll, fileDeps, decide } = await import('./core.mjs');
  const result = await decide({ mode, payload }, fileDeps(), loadAll());
  exitWith(result.exitCode, result.stdout, result.stderr);
}

main().catch(e => {
  process.stderr.write('【Auto 审批员·异常】' + (e?.message || String(e)) + '\n');
  try { process.stdin.destroy(); } catch { /* 忽略 */ }
  process.exitCode = 1;
  const t = setTimeout(() => { try { process.exit(1); } catch { /* 忽略 */ } }, 250);
  if (typeof t.unref === 'function') t.unref();
});
