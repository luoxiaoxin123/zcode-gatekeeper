#!/usr/bin/env bash
# gatekeeper 决策路径单测：直接以管道喂 hook 样例输入，校验退出码与输出
# 用法: bash test.sh   （在本文件所在目录执行）
# 说明：决策缓存按「任务+工具+参数」全局共享，因此每个 LLM 用例使用独立命令避免碰撞；
#       依赖真实审查模型的灰区判定只作为观察项打印，不做硬断言。
set -u
cd "$(dirname "$0")/gatekeeper" || cd "$(dirname "$0")"
rm -rf state          # 清掉决策缓存与会话状态，保证测试确定性
GK="node gatekeeper.mjs"
pass=0; fail=0

check() { # $1=用例名 $2=期望退出码 $3=实际退出码 $4=附加检查(grep模式,可空) $5=实际输出
  local ok=1
  [ "$2" = "$3" ] || ok=0
  if [ -n "$4" ]; then echo "$5" | grep -q "$4" || ok=0; fi
  if [ "$ok" = 1 ]; then pass=$((pass+1)); echo "PASS  $1 (exit=$3)"
  else fail=$((fail+1)); echo "FAIL  $1 (期望 exit=$2 $( [ -n "$4" ] && echo "/ 输出含 '$4'" ), 实际 exit=$3)"; echo "---- 输出 ----"; echo "$5" | head -5; echo "--------------"; fi
}

observe() { # $1=用例名 $2=实际退出码 $3=实际输出 —— 只打印不判分
  echo "OBSERVE  $1 (exit=$2)"; echo "$3" | head -2
}

run() { # $1=layer $2=json  → 设置 OUT/RC（强制内联模式，保证确定性）
  OUT=$(printf '%s' "$2" | GATEKEEPER_NO_DAEMON=1 $GK review --layer="$1" 2>&1); RC=$?
}

# ---------- 硬层（PreToolUse --layer=hard） ----------
run hard '{"hook_event_name":"PreToolUse","session_id":"t1","tool_name":"Read","tool_input":{"file_path":"a.txt"},"cwd":"C:/x"}'
check "只读工具 Read → 静默放行" 0 "$RC" "" "$OUT"

run hard '{"hook_event_name":"PreToolUse","session_id":"t1","tool_name":"Bash","tool_input":{"command":"ls -la"},"cwd":"C:/x"}'
check "硬层 ls → 静默放行" 0 "$RC" "" "$OUT"

run hard '{"hook_event_name":"PreToolUse","session_id":"t1","tool_name":"Bash","tool_input":{"command":"rm -rf /"},"cwd":"C:/x"}'
check "硬层 rm -rf / → 拦截" 2 "$RC" "灾难命令黑名单" "$OUT"

run hard '{"hook_event_name":"PreToolUse","session_id":"t1","tool_name":"Bash","tool_input":{"command":"rm -rf ~"},"cwd":"C:/x"}'
check "硬层 rm -rf ~ → 拦截" 2 "$RC" "" "$OUT"

run hard '{"hook_event_name":"PreToolUse","session_id":"t1","tool_name":"Bash","tool_input":{"command":"cat log && rm -rf /"},"cwd":"C:/x"}'
check "复合命令夹带 rm -rf / → 拦截" 2 "$RC" "" "$OUT"

run hard '{"hook_event_name":"PreToolUse","session_id":"t1","tool_name":"Bash","tool_input":{"command":"Remove-Item -Recurse -Force C:\\"},"cwd":"C:/x"}'
check "PowerShell 盘根递归删除 → 拦截" 2 "$RC" "" "$OUT"

run hard '{"hook_event_name":"PreToolUse","session_id":"t1","tool_name":"Bash","tool_input":{"command":"mkfs.ext4 /dev/sda1"},"cwd":"C:/x"}'
check "mkfs → 拦截" 2 "$RC" "" "$OUT"

run hard '{"hook_event_name":"PreToolUse","session_id":"t1","tool_name":"Bash","tool_input":{"command":"rm -rf node_modules/.cache"},"cwd":"C:/x"}'
check "rm -rf 项目子目录 → 不拦（灰区交 LLM）" 0 "$RC" "" "$OUT"
run hard '{"hook_event_name":"PreToolUse","session_id":"t1","tool_name":"Bash","tool_input":{"command":"rm -rf ~/projects/demo"},"cwd":"C:/x"}'
check "rm -rf 家目录子目录 → 不拦" 0 "$RC" "" "$OUT"
run hard '{"hook_event_name":"PreToolUse","session_id":"t1","tool_name":"Bash","tool_input":{"command":"Remove-Item -Recurse -Force C:\\temp\\myapp\\build"},"cwd":"C:/x"}'
check "PowerShell 删项目内 build → 不拦" 0 "$RC" "" "$OUT"

# ---------- 完整层（PermissionRequest --layer=full） ----------
run full '{"hook_event_name":"PermissionRequest","session_id":"t2","tool_name":"Bash","tool_input":{"command":"git status"},"cwd":"C:/x"}'
check "完整层 git status → allow JSON" 0 "$RC" "permissionDecision" "$OUT"

run full '{"hook_event_name":"PermissionRequest","session_id":"t2","tool_name":"Write","tool_input":{"file_path":"C:/x/src/a.ts","content":"x"},"cwd":"C:/x"}'
check "完整层 cwd 内写文件 → allow JSON" 0 "$RC" "permissionDecision" "$OUT"

# 死端点 fail-closed：每个用例独立命令，避免共享缓存碰撞
OUT=$(printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"t3","tool_name":"Bash","tool_input":{"command":"npm run build-dead-a"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 GATEKEEPER_BASE_URL="http://127.0.0.1:9" $GK review --layer=full 2>&1); RC=$?
check "死端点 A → fail-closed 拒绝" 2 "$RC" "审查器不可用" "$OUT"

OUT=$(printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"t4","tool_name":"Bash","tool_input":{"command":"npm run build-dead-b"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 GATEKEEPER_BASE_URL="http://127.0.0.1:9" $GK review --layer=full 2>&1); RC=$?
check "死端点 B（未改配置，仍应拒绝）" 2 "$RC" "" "$OUT"

# 真实端点灰区判定：只观察不判分（LLM 结论随任务/模型可能合理变化）
OUT=$(printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"t5","tool_name":"Bash","tool_input":{"command":"npm run build-real"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 $GK review --layer=full 2>&1); RC=$?
observe "真实端点·灰区命令" "$RC" "$OUT"

OUT=$(printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"t5","tool_name":"Write","tool_input":{"file_path":"C:/Users/luo/other/b.ts","content":"x"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 $GK review --layer=full 2>&1); RC=$?
observe "真实端点·工作区外写入" "$RC" "$OUT"

# ---------- 完全访问守卫（fullAccessGuard） ----------
OUT=$(printf '%s' '{"hook_event_name":"PreToolUse","session_id":"g1","tool_name":"Bash","tool_input":{"command":"npm run build-dead-c"},"cwd":"C:/x"}' | GATEKEEPER_FULL_ACCESS_GUARD=1 GATEKEEPER_NO_DAEMON=1 GATEKEEPER_BASE_URL="http://127.0.0.1:9" $GK review --layer=hard 2>&1); RC=$?
check "守卫开启：PreToolUse 灰区+死端点 → fail-closed 拒绝" 2 "$RC" "审查器不可用" "$OUT"

OUT=$(printf '%s' '{"hook_event_name":"PreToolUse","session_id":"g2","tool_name":"Bash","tool_input":{"command":"npm run build-off"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 $GK review --layer=hard 2>&1); RC=$?
check "守卫关闭：PreToolUse 灰区 → 静默放行无 LLM" 0 "$RC" "" "$OUT"

# ---------- 守护进程冒烟（daemon 模式：client → 127.0.0.1 → 热连接 LLM） ----------
node gatekeeper.mjs shutdown-daemon >/dev/null 2>&1
GATEKEEPER_BASE_URL="http://127.0.0.1:9" node gatekeeper-daemon.mjs >/dev/null 2>&1 &
sleep 1.5
OUT=$(printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"d1","tool_name":"Bash","tool_input":{"command":"npm run daemon-dead"},"cwd":"C:/x"}' | node gatekeeper.mjs review --layer=hard 2>&1); RC=$?
check "daemon 通道：死端点 → fail-closed 拒绝" 2 "$RC" "审查器不可用" "$OUT"
node gatekeeper.mjs shutdown-daemon >/dev/null 2>&1

# ---------- extraBody 注入（自定义思考程度等厂商私有参数） ----------
node -e 'const http=require("http"),fs=require("fs");http.createServer((q,r)=>{let b="";q.on("data",c=>b+=c);q.on("end",()=>{fs.writeFileSync("state/echo-body.json",b);r.setHeader("Content-Type","application/json");r.end(JSON.stringify({choices:[{message:{content:JSON.stringify({shouldBlock:false,reason:""})}}]}))})}).listen(47991,()=>console.log("up"))' >/dev/null 2>&1 &
SRV=$!
sleep 1
OUT=$(printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"eb","tool_name":"Bash","tool_input":{"command":"npm run echo-test"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 GATEKEEPER_EXTRA_BODY='{"chat_template_kwargs":{"enable_thinking":false}}' GATEKEEPER_BASE_URL="http://127.0.0.1:47991/v1" $GK review --layer=full 2>&1); RC=$?
check "extraBody 注入 → 正常判定放行" 0 "$RC" "permissionDecision" "$OUT"
if grep -q '"enable_thinking":false' state/echo-body.json 2>/dev/null; then pass=$((pass+1)); echo "PASS  extraBody 字段已进入请求体"; else fail=$((fail+1)); echo "FAIL  extraBody 字段未进入请求体"; fi
if grep -q "从用户键盘输入直接捕获" state/echo-body.json 2>/dev/null; then pass=$((pass+1)); echo "PASS  防注入溯源标记已进入提示词"; else fail=$((fail+1)); echo "FAIL  防注入溯源标记缺失"; fi
kill $SRV 2>/dev/null

# ---------- dangerlist 收紧回归：常见绝对路径子目录不拦 ----------
run hard '{"hook_event_name":"PreToolUse","session_id":"t9","tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/build"},"cwd":"C:/x"}'
check "rm -rf /tmp/build → 不拦（灰区交 LLM）" 0 "$RC" "" "$OUT"

# ---------- approve 一次性放行（deny 逃生舱） ----------
GATEKEEPER_STATE_DIR="$PWD/state" node gatekeeper.mjs approve "rm -rf /" --yes >/dev/null 2>&1
run hard '{"hook_event_name":"PreToolUse","session_id":"ap","tool_name":"Bash","tool_input":{"command":"rm -rf /"},"cwd":"C:/x"}'
check "已批准命令 → 放行并消费" 0 "$RC" "" "$OUT"
run hard '{"hook_event_name":"PreToolUse","session_id":"ap","tool_name":"Bash","tool_input":{"command":"rm -rf /"},"cwd":"C:/x"}'
check "批准用后即焚 → 再执行仍拦截" 2 "$RC" "灾难命令黑名单" "$OUT"

# ---------- onUncertain：拿不准的三种落地（种子缓存 ask 判定） ----------
seedask(){ node -e '
const crypto=require("crypto");
const task="(未捕获到任务上下文)";
const cmd="npm run uncertain-"+process.argv[1];
const key=crypto.createHash("sha256").update(task+"|Bash|"+JSON.stringify({command:cmd})).digest("hex").slice(0,24);
require("fs").writeFileSync("state/cache.json",JSON.stringify({[key]:{decision:"ask",reason:"模拟拿不准",ts:Date.now()}}));
' "$1"; }
seedask a
OUT=$(printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"u1","tool_name":"Bash","tool_input":{"command":"npm run uncertain-a"},"cwd":"C:/x"}' | GATEKEEPER_ON_UNCERTAIN=deny GATEKEEPER_NO_DAEMON=1 $GK review --layer=full 2>&1); RC=$?
check "onUncertain=deny → 拿不准也硬拒" 2 "$RC" "拒绝" "$OUT"
seedask b
OUT=$(printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"u1","tool_name":"Bash","tool_input":{"command":"npm run uncertain-b"},"cwd":"C:/x"}' | GATEKEEPER_ON_UNCERTAIN=prompt GATEKEEPER_NO_DAEMON=1 $GK review --layer=full 2>&1); RC=$?
check "onUncertain=prompt → 静默交原生弹窗" 0 "$RC" "" "$OUT"
seedask c
OUT=$(printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"u1","tool_name":"Bash","tool_input":{"command":"npm run uncertain-c"},"cwd":"C:/x"}' | GATEKEEPER_ON_UNCERTAIN=allow GATEKEEPER_NO_DAEMON=1 $GK review --layer=full 2>&1); RC=$?
check "onUncertain=allow → 放行 JSON" 0 "$RC" "permissionDecision" "$OUT"

# ---------- approve --last（批准最近被拒命令） ----------
run hard '{"hook_event_name":"PreToolUse","session_id":"l1","tool_name":"Bash","tool_input":{"command":"rm -rf ~"},"cwd":"C:/x"}'
check "deny 先行（进入 --last 队列）" 2 "$RC" "" "$OUT"
GATEKEEPER_STATE_DIR="$PWD/state" node gatekeeper.mjs approve --last --yes >/dev/null 2>&1
run hard '{"hook_event_name":"PreToolUse","session_id":"l1","tool_name":"Bash","tool_input":{"command":"rm -rf ~"},"cwd":"C:/x"}'
check "approve --last → 放行并消费" 0 "$RC" "" "$OUT"
run hard '{"hook_event_name":"PreToolUse","session_id":"l1","tool_name":"Bash","tool_input":{"command":"rm -rf ~"},"cwd":"C:/x"}'
check "消费后再执行仍拦截" 2 "$RC" "" "$OUT"

# ---------- 安全修复回归：复合命令缺口 / 状态文件投毒 / 自批 / dangerlist 变体 ----------
OUT=$(printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"f1","tool_name":"Bash","tool_input":{"command":"echo hi\nrm -rf ~/important"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 GATEKEEPER_BASE_URL="http://127.0.0.1:9" $GK review --layer=full 2>&1); RC=$?
check "换行拼接 → 不再进白名单（灰区→fail-closed）" 2 "$RC" "审查器不可用" "$OUT"
OUT=$(printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"f1","tool_name":"Bash","tool_input":{"command":"echo hi & rm -rf ~/important"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 GATEKEEPER_BASE_URL="http://127.0.0.1:9" $GK review --layer=full 2>&1); RC=$?
check "单个 & 拼接 → 不再进白名单" 2 "$RC" "审查器不可用" "$OUT"
OUT=$(printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"f1","tool_name":"Bash","tool_input":{"command":"echo hacked > /tmp/pwned.txt"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 GATEKEEPER_BASE_URL="http://127.0.0.1:9" $GK review --layer=full 2>&1); RC=$?
check "重定向 → 不再进白名单" 2 "$RC" "审查器不可用" "$OUT"
OUT=$(printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"f1","tool_name":"Bash","tool_input":{"command":"find / -delete"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 GATEKEEPER_BASE_URL="http://127.0.0.1:9" $GK review --layer=full 2>&1); RC=$?
check "find / -delete → 移出白名单（灰区）" 2 "$RC" "审查器不可用" "$OUT"
OUT=$(printf '%s' '{"hook_event_name":"PreToolUse","session_id":"f2","tool_name":"Bash","tool_input":{"command":"echo x > approved.json"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 $GK review --layer=hard 2>&1); RC=$?
check "状态文件写入 → 确定性拒绝" 2 "$RC" "状态文件" "$OUT"
run hard '{"hook_event_name":"PreToolUse","session_id":"f2","tool_name":"Bash","tool_input":{"command":"rm -rf /"},"cwd":"C:/x"}'
check "投毒失败后 rm -rf / 仍被黑名单拦截" 2 "$RC" "灾难命令黑名单" "$OUT"
OUT=$(printf '%s' '{"hook_event_name":"PreToolUse","session_id":"f3","tool_name":"Bash","tool_input":{"command":"node gatekeeper.mjs approve \"rm -rf /\" --yes"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 $GK review --layer=hard 2>&1); RC=$?
check "模型自批 approve → 确定性拒绝" 2 "$RC" "自批" "$OUT"
OUT=$(printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"f4","tool_name":"Bash","tool_input":{"command":"del /f /s /q C:\\"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 $GK review --layer=hard 2>&1); RC=$?
check "del /f /s /q C:\\ → 拦截（flag 顺序无关）" 2 "$RC" "灾难命令黑名单" "$OUT"
OUT=$(printf '%s' '{"hook_event_name":"PreToolUse","session_id":"f4","tool_name":"Bash","tool_input":{"command":"Remove-Item -Recurse -Force C:\\*"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 $GK review --layer=hard 2>&1); RC=$?
check "Remove-Item C:\\* → 拦截" 2 "$RC" "灾难命令黑名单" "$OUT"
OUT=$(printf '%s' '{"hook_event_name":"PreToolUse","session_id":"f4","tool_name":"Bash","tool_input":{"command":"Format-Volume -DriveLetter C"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 $GK review --layer=hard 2>&1); RC=$?
check "Format-Volume → 拦截" 2 "$RC" "灾难命令黑名单" "$OUT"
OUT=$(printf '%s' '{"hook_event_name":"PermissionRequest","session_id":"f5","tool_name":"Bash","tool_input":{"command":"del /s /q C:/x/project/build"},"cwd":"C:/x"}' | GATEKEEPER_NO_DAEMON=1 GATEKEEPER_BASE_URL="http://127.0.0.1:9" $GK review --layer=full 2>&1); RC=$?
check "负例：项目子目录 del /s → 灰区（不误拦）" 2 "$RC" "审查器不可用" "$OUT"
run hard '{"hook_event_name":"PreToolUse","session_id":"f6","tool_name":"Bash","tool_input":{"command":"git status"},"cwd":"C:/x"}'
check "白名单健康：git status 仍直通" 0 "$RC" "" "$OUT"

echo "=============================="
echo "PASS=$pass FAIL=$fail"
exit $fail
