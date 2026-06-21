const $url      = document.getElementById('url');
const $btnStart = document.getElementById('btnStart');
const $btnStop  = document.getElementById('btnStop');
const $dot      = document.getElementById('dot');
const $status   = document.getElementById('statusText');
const $bridgeUrl = document.getElementById('bridgeUrl');
const $btnCopy  = document.getElementById('btnCopy');
const $log      = document.getElementById('log');

// ── state ──
let running = false;

// ── persist last URL ──
$url.value = localStorage.getItem('bridge_url') || '';
$url.addEventListener('input', () => {
  localStorage.setItem('bridge_url', $url.value);
});

// ── start ──
$btnStart.addEventListener('click', async () => {
  const url = $url.value.trim();
  if (!url) { $url.focus(); return; }

  $btnStart.disabled = true;
  appendLog('> 启动中...\n');

  const res = await window.bridge.start(url);
  if (res.ok) {
    setRunning(true);
  } else {
    appendLog('> 启动失败: ' + (res.error || '未知错误') + '\n');
    $btnStart.disabled = false;
  }
});

// ── stop ──
$btnStop.addEventListener('click', async () => {
  $btnStop.disabled = true;
  appendLog('> 正在停止...\n');
  await window.bridge.stop();
});

// ── copy ──
$btnCopy.addEventListener('click', () => {
  const text = document.getElementById('bridgeUrlText').textContent;
  navigator.clipboard.writeText(text).then(() => {
    $btnCopy.textContent = '已复制';
    setTimeout(() => { $btnCopy.textContent = '复制'; }, 1200);
  });
});

// ── events from main ──
window.bridge.onLog(text => {
  appendLog(text);
});

window.bridge.onStopped(code => {
  setRunning(false);
  appendLog('> Bridge 已停止 (code: ' + code + ')\n');
});

// ── helpers ──
function setRunning(v) {
  running = v;
  $btnStart.disabled = v;
  $btnStop.disabled  = !v;
  $dot.className     = 'dot ' + (v ? 'dot-on' : 'dot-off');
  $status.textContent = v ? '运行中' : '未运行';
  $bridgeUrl.classList.toggle('show', v);
  $url.disabled = v;
}

function appendLog(text) {
  $log.textContent += text;
  $log.scrollTop = $log.scrollHeight;
}
