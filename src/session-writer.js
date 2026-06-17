/**
 * Session Writer - 将 bridge 对话写入 Codex Desktop 兼容的 JSONL 文件
 *
 * 格式严格对齐 Codex Desktop 的 session 日志：
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-{timestamp}-{sessionId}.jsonl
 *
 * 同一个对话（由 previous_response_id 关联）共用一个 JSONL 文件，
 * 多轮请求追加写入，与 Codex Desktop 的行为一致。
 *
 * sessionId 会写入文件名，让 findSessionFileByThreadId 能找到。
 */

import { mkdirSync, appendFileSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

const SESSION_BASE = join(homedir(), '.codex', 'sessions');
const INDEX_PATH = join(homedir(), '.codex', 'session_index.jsonl');

// ─── 内部工具函数 ────────────────────────────────────────────

function getDateDir() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return join(SESSION_BASE, String(y), m, d);
}

function makeTimestamp() {
  return new Date().toISOString();
}

function makeUUID() {
  return crypto.randomUUID();
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function makeFilename(sessionId) {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `rollout-${ts}-${sessionId}.jsonl`;
}

function writeJsonl(filePath, entry) {
  try {
    appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[session-writer] write failed:', err.message);
  }
}

/** 尝试获取 cwd 对应的 git 信息 */
function getGitInfo(cwd) {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, timeout: 3000, encoding: 'utf8' }).trim();
    const hash = execSync('git rev-parse HEAD', { cwd, timeout: 3000, encoding: 'utf8' }).trim();
    return { branch, commit_hash: hash };
  } catch {
    return null;
  }
}

/** 获取当前时区名称 */
function getTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/** 获取当前日期 YYYY-MM-DD */
function getCurrentDate() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Session 映射管理 ────────────────────────────────────────

const sessionMap = new Map();

/**
 * 创建或复用 session 文件。
 *
 * @param {string|null} conversationId - 来自 previous_response_id / conversation
 * @param {Object} meta - { model, modelProvider, cwd, systemPrompt, tools, effort }
 * @returns {{ filePath: string, sessionId: string, isNew: boolean }}
 */
export function ensureSession(conversationId, meta = {}) {
  if (conversationId && sessionMap.has(conversationId)) {
    const existing = sessionMap.get(conversationId);
    return { filePath: existing.filePath, sessionId: existing.sessionId, isNew: false };
  }

  const sessionId = makeUUID();
  const dir = getDateDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const filePath = join(dir, makeFilename(sessionId));
  const cwd = meta.cwd ?? process.cwd();

  // ── session_meta（对齐 Codex Desktop）──
  const gitInfo = getGitInfo(cwd);
  const model = meta.model ?? 'unknown';
  const effort = meta.effort ?? 'medium';

  writeJsonl(filePath, {
    timestamp: makeTimestamp(),
    type: 'session_meta',
    payload: {
      id: sessionId,
      timestamp: makeTimestamp(),
      cwd,
      originator: 'Codex Bridge',
      cli_version: '1.0.0-bridge',
      source: meta.source ?? 'bridge',
      model_provider: meta.modelProvider ?? 'bridge',
      model,
      model_reasoning_effort: effort,
      thread_source: 'user',
      base_instructions: {
        text: meta.systemPrompt ?? ''
      },
      ...(gitInfo ? { git: gitInfo } : {}),
      dynamic_tools: meta.tools ?? [],
    },
  });

  const record = { filePath, sessionId, turnCount: 0, cwd, model, effort, turnStartedAt: 0, turnFirstTokenAt: 0 };
  const key = conversationId ?? sessionId;
  sessionMap.set(key, record);

  return { filePath, sessionId, isNew: true };
}

export function findSession(sessionId) {
  for (const [, record] of sessionMap) {
    if (record.sessionId === sessionId) return record;
  }
  return null;
}

// ─── 写入函数 ──────────────────────────────────────────────

/**
 * 写入 turn_context（对齐 Codex Desktop 完整字段）
 */
export function writeTurnContext(sessionId, meta = {}) {
  const record = findSession(sessionId);
  if (!record) return;
  record.turnCount++;

  const cwd = meta.cwd ?? record.cwd ?? process.cwd();
  const model = meta.model ?? record.model ?? 'unknown';
  const effort = meta.effort ?? record.effort ?? 'medium';
  const turnId = meta.turnId ?? makeUUID();

  writeJsonl(record.filePath, {
    timestamp: makeTimestamp(),
    type: 'turn_context',
    payload: {
      turn_id: turnId,
      cwd,
      workspace_roots: [cwd],
      current_date: getCurrentDate(),
      timezone: getTimezone(),
      approval_policy: 'never',
      sandbox_policy: { type: 'danger-full-access' },
      permission_profile: { type: 'disabled' },
      model,
      personality: 'friendly',
      collaboration_mode: {
        mode: 'default',
        settings: {
          model,
          reasoning_effort: effort,
          developer_instructions: '# Collaboration Mode: Default\n\nYou are now in Default mode.\n',
        },
      },
      multi_agent_version: 'v1',
      realtime_active: false,
      effort,
      summary: 'auto',
    },
  });

  return turnId;
}

/**
 * 写入 event_msg: task_started
 */
export function writeTaskStarted(sessionId, turnId, modelContextWindow = 128000) {
  const record = findSession(sessionId);
  if (!record) return;
  record.turnStartedAt = Date.now();

  writeJsonl(record.filePath, {
    timestamp: makeTimestamp(),
    type: 'event_msg',
    payload: {
      type: 'task_started',
      turn_id: turnId,
      started_at: unixNow(),
      model_context_window: modelContextWindow,
      collaboration_mode_kind: 'default',
    },
  });
}

/**
 * 写入 event_msg: user_message
 */
export function writeUserMessageEvent(sessionId, message, meta = {}) {
  const record = findSession(sessionId);
  if (!record) return;

  writeJsonl(record.filePath, {
    timestamp: makeTimestamp(),
    type: 'event_msg',
    payload: {
      type: 'user_message',
      client_id: meta.clientId ?? makeUUID(),
      message: typeof message === 'string' ? message : JSON.stringify(message),
      images: meta.images ?? [],
      local_images: meta.localImages ?? [],
      text_elements: meta.textElements ?? [],
    },
  });
}

/**
 * 写入 event_msg: agent_message
 */
export function writeAgentMessageEvent(sessionId, message) {
  const record = findSession(sessionId);
  if (!record) return;
  if (!record.turnFirstTokenAt) record.turnFirstTokenAt = Date.now();

  writeJsonl(record.filePath, {
    timestamp: makeTimestamp(),
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: typeof message === 'string' ? message : '',
      phase: null,
      memory_citation: null,
    },
  });
}

/**
 * 写入 event_msg: token_count（对齐 Codex Desktop info 结构）
 */
export function writeTokenCount(sessionId, inputTokens = 0, outputTokens = 0, meta = {}) {
  const record = findSession(sessionId);
  if (!record) return;

  const totalUsage = {
    input_tokens: inputTokens,
    cached_input_tokens: meta.cachedInputTokens ?? 0,
    output_tokens: outputTokens,
    reasoning_output_tokens: meta.reasoningOutputTokens ?? 0,
    total_tokens: inputTokens + outputTokens,
  };

  writeJsonl(record.filePath, {
    timestamp: makeTimestamp(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: totalUsage,
        last_token_usage: meta.lastTokenUsage ?? totalUsage,
        model_context_window: meta.modelContextWindow ?? 128000,
      },
      rate_limits: {
        limit_id: 'bridge',
        limit_name: null,
        primary: null,
        secondary: null,
        credits: null,
        individual_limit: null,
        plan_type: null,
        rate_limit_reached_type: null,
      },
    },
  });
}

/**
 * 写入 event_msg: task_complete
 */
export function writeTaskComplete(sessionId, turnId, lastAgentMessage = '') {
  const record = findSession(sessionId);
  if (!record) return;

  const now = Date.now();
  const startedAt = record.turnStartedAt || now;
  const firstTokenAt = record.turnFirstTokenAt || now;
  const durationMs = now - startedAt;
  const timeToFirstTokenMs = firstTokenAt - startedAt;

  // 重置追踪
  record.turnStartedAt = 0;
  record.turnFirstTokenAt = 0;

  writeJsonl(record.filePath, {
    timestamp: makeTimestamp(),
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: turnId,
      last_agent_message: lastAgentMessage,
      completed_at: Math.floor(now / 1000),
      duration_ms: durationMs,
      time_to_first_token_ms: Math.max(0, timeToFirstTokenMs),
    },
  });
}

/**
 * 写入 response_item: developer message
 */
export function writeDeveloperMessage(sessionId, text) {
  const record = findSession(sessionId);
  if (!record) return;

  const content = typeof text === 'string'
    ? [{ type: 'input_text', text }]
    : Array.isArray(text) ? text : [{ type: 'input_text', text: String(text) }];

  writeJsonl(record.filePath, {
    timestamp: makeTimestamp(),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content,
    },
  });
}

/**
 * 写入 response_item: user message
 */
export function writeUserMessage(sessionId, text) {
  const record = findSession(sessionId);
  if (!record) return;

  const content = typeof text === 'string'
    ? [{ type: 'input_text', text }]
    : Array.isArray(text) ? text : [{ type: 'input_text', text: JSON.stringify(text) }];

  writeJsonl(record.filePath, {
    timestamp: makeTimestamp(),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content,
    },
  });
}

/**
 * 写入 response_item: assistant message
 */
export function writeAssistantResponse(sessionId, text) {
  const record = findSession(sessionId);
  if (!record) return;

  const content = typeof text === 'string'
    ? [{ type: 'output_text', text }]
    : Array.isArray(text) ? text : [{ type: 'output_text', text: String(text) }];

  writeJsonl(record.filePath, {
    timestamp: makeTimestamp(),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content,
    },
  });
}

/**
 * 写入 response_item: function_call
 */
export function writeFunctionCall(sessionId, callId, name, args) {
  const record = findSession(sessionId);
  if (!record) return;

  writeJsonl(record.filePath, {
    timestamp: makeTimestamp(),
    type: 'response_item',
    payload: {
      type: 'function_call',
      call_id: callId,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    },
  });
}

/**
 * 写入 response_item: function_call_output
 */
export function writeFunctionCallOutput(sessionId, callId, output) {
  const record = findSession(sessionId);
  if (!record) return;

  writeJsonl(record.filePath, {
    timestamp: makeTimestamp(),
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
    },
  });
}

/** 通用 event_msg 写入（向后兼容） */
export function writeEvent(sessionId, eventType, payload = {}) {
  const record = findSession(sessionId);
  if (!record) return;
  writeJsonl(record.filePath, { timestamp: makeTimestamp(), type: 'event_msg', payload: { type: eventType, ...payload } });
}

// ─── responseId → sessionId 映射 ────────────────────────────

const responseIdMap = new Map();

export function registerResponseId(responseId, sessionId) {
  if (responseId) {
    responseIdMap.set(responseId, sessionId);
    const record = findSession(sessionId);
    if (record) {
      sessionMap.set(responseId, record);
    }
  }
}

export function lookupSessionByResponseId(previousResponseId) {
  if (!previousResponseId) return null;
  const sessionId = responseIdMap.get(previousResponseId);
  if (sessionId) return findSession(sessionId);
  return sessionMap.get(previousResponseId) ?? null;
}

// ─── Session Index ──────────────────────────────────────────

function appendToIndex(sessionId, threadName) {
  try {
    const entry = {
      id: sessionId,
      thread_name: threadName || '',
      updated_at: makeTimestamp(),
    };
    appendFileSync(INDEX_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[session-writer] index write failed:', err.message);
  }
}

/**
 * 更新 session 索引中的 thread_name
 */
export function updateSessionName(sessionId, name) {
  appendToIndex(sessionId, name);
}
