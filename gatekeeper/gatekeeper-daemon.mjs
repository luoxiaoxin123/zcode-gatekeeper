#!/usr/bin/env node
// ============================================================================
// gatekeeper daemon —— 常驻守卫进程
//
// 收益：LLM 连接常驻（免每次冷启动的 DNS/TLS 握手）、决策缓存与任务状态驻内存、
//       配置文件热重载（客户端每次请求带上四个配置文件的 mtime 签名，不一致即重载）。
//
// 由 gatekeeper.mjs 客户端按需拉起（detached），无需手工运行；手工调试：
//   node gatekeeper-daemon.mjs            # 前台运行，日志同时打到 stdout
//   node gatekeeper.mjs shutdown-daemon   # 通过客户端停止
//
// 协议（127.0.0.1:daemonPort，行分隔 JSON）：
//   请求: {"op":"ping"} | {"op":"shutdown"} |
//         {"op":"hook","mode":"review","payload":{...hook输入...},"sigs":[...mtime],"env":{"fullAccessGuard":bool?}}
//   响应: {"ok":true} | {"exitCode":0|2,"stdout":"...","stderr":"..."}
// ============================================================================

import net from 'node:net';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { SCRIPT_DIR, STATE_DIR, loadAll, configSigs, memDeps, decide } from './core.mjs';

const LOG = path.join(STATE_DIR, 'daemon.log');
function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try { appendFileSync(LOG, line + '\n'); } catch { /* 忽略 */ }
  if (!process.env.GATEKEEPER_DAEMON_QUIET) console.log(line);
}

let all = loadAll();
let deps = memDeps();
const PORT = all.config.daemonPort | 0 || 47811;
let llmWarm = false;

function reloadIfStale(sigs) {
  if (!Array.isArray(sigs)) return;
  const cur = configSigs();
  if (sigs.some((v, i) => v !== cur[i])) {
    all = loadAll();
    log('config hot-reloaded (sigs changed)');
  }
}

// 并发去重：同一请求（同 mode+payload+env）并发到达时共享一次决策，避免重复打 LLM
const inflight = new Map();
async function handleHook(req) {
  reloadIfStale(req.sigs);
  const env = req.env || {};
  const effective = env.fullAccessGuard != null
    ? { ...all, config: { ...all.config, fullAccessGuard: all.config.fullAccessGuard || env.fullAccessGuard === true } }
    : all;
  const key = req.mode + '|' + JSON.stringify(req.payload) + '|' + (env.fullAccessGuard ? 1 : 0);
  if (inflight.has(key)) {
    log('hook dedup (in-flight shared)');
    return inflight.get(key);
  }
  const t0 = Date.now();
  const p = (async () => {
    const result = await decide({ mode: req.mode, payload: req.payload }, deps, effective);
    log(`hook ${req.mode}/${req.payload?.tool_name || '?'} -> exit=${result.exitCode} (${Date.now() - t0}ms, llmWarm=${llmWarm})`);
    return result;
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

// allowHalfOpen: true —— 客户端会半关闭（write+end），hook 判定是异步的（LLM 数秒），
// 默认模式下 Node 会在收到 FIN 时自动关闭本端，响应就写进了一条已死的连接。
const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  let buf = '';
  socket.setEncoding('utf8');
  socket.setTimeout(42_000, () => socket.destroy());          // 兜底：不允许超过 hook 超时

  const dispatch = async (line) => {
    // 协议异常/未知 op 一律返回 {ok:false}（无 exitCode 字段）——客户端据此降级内联做完整审查，
    // 绝不能返回 {exitCode:0}（会被当作"明确放行"决策，形成 fail-open）。
    let res = { ok: false, error: 'unknown op' };
    try {
      const req = line.trim() ? JSON.parse(line.trim()) : null;
      if (!req || req.op === 'ping') {
        res = { ok: true, llmWarm, version: 1 };
      } else if (req.op === 'shutdown') {
        socket.write(JSON.stringify({ ok: true, bye: true }) + '\n', () => { log('shutdown by request'); process.exit(0); });
        return;
      } else if (req.op === 'hook') {
        res = await handleHook(req);
      }
    } catch (e) {
      res = { ok: false, error: 'request error: ' + (e?.message || e) };
      log('request error: ' + (e?.message || e));
    }
    socket.write(JSON.stringify(res) + '\n', () => { try { socket.end(); } catch { /* 忽略 */ } });
  };

  socket.on('data', (chunk) => {                               // 行分帧：收到完整一行立即处理
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) dispatch(line.trim());
    }
  });
  socket.on('end', () => { if (buf.trim()) { const rest = buf; buf = ''; dispatch(rest.trim()); } });
  socket.on('error', () => { /* 客户端断开等，忽略 */ });
});

server.on('error', async (e) => {
  if (e.code === 'EADDRINUSE') {
    const alive = await ping(PORT, 400).catch(() => null);
    if (alive?.ok) { log('daemon already running on port ' + PORT + ' — exit quietly'); process.exit(0); }
    log('port ' + PORT + ' occupied but no daemon responding — exit 1');
    process.exit(1);
  }
  log('server error: ' + (e?.message || e));
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  log('daemon listening on 127.0.0.1:' + PORT + ' (model=' + all.config.model + ', guard=' + all.config.fullAccessGuard + ')');
  // 预热：开一条到审查端点的 TLS 连接，让第一次真实审查免握手
  setTimeout(async () => {
    try {
      const t0 = Date.now();
      const res = await fetch(all.config.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + all.config.apiKey },
        body: JSON.stringify({ model: all.config.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await res.json().catch(() => {});
      llmWarm = true;
      log('llm connection warmed in ' + (Date.now() - t0) + 'ms');
    } catch (e) {
      llmWarm = false;
      log('llm warmup failed (will retry implicitly on first review): ' + (e?.message || e));
    }
  }, 300);
});

async function ping(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = '';
    s.setEncoding('utf8');
    const to = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, timeoutMs);
    s.on('connect', () => s.write(JSON.stringify({ op: 'ping' }) + '\n'));
    s.on('data', (c) => {
      buf += c;
      if (buf.includes('\n')) {
        clearTimeout(to);
        try { resolve(JSON.parse(buf)); } catch { resolve(null); }
        s.end();
      }
    });
    s.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

// 兜底：防止被遗留为孤儿进程后无法退出。setTimeout 上限为 2^31-1 ≈ 24.8 天（再大会溢出 32 位
// 整数被截成 1ms，导致 daemon 启动即退出），到期后自动退出，客户端会按需重新拉起。
setTimeout(() => { log('max lifetime reached, exiting'); process.exit(0); }, 2 ** 31 - 1).unref();
