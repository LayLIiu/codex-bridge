#!/usr/bin/env node
import http from "node:http";
import { stdin, stdout, stderr, exit } from "node:process";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createStreamConverter,
  fromChatCompletionsResponse,
  toChatCompletionsRequest,
  validateToolCalls,
  buildRetryMessages
} from "./adapter.js";
import { loadConfig } from "./config.js";
import { estimateTokens } from "./token-estimator.js";
import {
  ensureSession,
  registerResponseId,
  lookupSessionByResponseId,
  writeTurnContext,
  writeTaskStarted,
  writeUserMessageEvent,
  writeAgentMessageEvent,
  writeTokenCount,
  writeTaskComplete,
  writeDeveloperMessage,
  writeUserMessage,
  writeAssistantResponse,
  writeFunctionCall,
  writeFunctionCallOutput,
  writeEvent
} from "./session-writer.js";

const responseStore = new Map();
const MAX_STORED_RESPONSES = 200;

// 调试日志：记录最近一次完整的请求/响应转换
let lastDebugEntry = null;
let activeUpstreamRequests = 0;
const upstreamQueue = [];

// 文件日志：写入 ~/.codex/bridge-debug.log
const LOG_DIR = join(process.env.HOME ?? "/tmp", ".codex");
const LOG_FILE = join(LOG_DIR, "bridge-debug.log");

function fileLog(entry) {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

function clearLogFile() {
  try {
    if (existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, "");
  } catch {}
}

function summarizeRequestInputForLog(input) {
  const items = Array.isArray(input) ? input : input === undefined ? [] : [input];
  return items.map((item) => {
    if (typeof item === "string") {
      return { type: "message", role: "user", content: item.slice(0, 200) };
    }
    if (!item || typeof item !== "object") {
      return { type: typeof item, content: item };
    }
    return {
      type: item.type,
      role: item.role,
      content: typeof item.content === "string" ? item.content.slice(0, 200) : item.content
    };
  });
}

/**
 * 带重试的 fetch：对 5xx、429 和网络错误做退避重试。
 */
async function fetchWithRetry(url, options, config = {}) {
  const maxRetries = config.upstreamMaxRetries ?? 1;
  const concurrency = config.upstreamConcurrency ?? 2;
  const baseDelayMs = config.upstreamRetryBaseDelayMs ?? 1000;
  const maxDelayMs = config.upstreamMaxRetryDelayMs ?? 15000;
  let lastError = null;

  const releaseSlot = await acquireUpstreamSlot(concurrency);
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await fetch(url, options);
        // 5xx 或 429（限流）时重试
        if ((resp.status >= 500 || resp.status === 429) && attempt < maxRetries) {
          const delayMs = getRetryDelayMs(resp, attempt, baseDelayMs, maxDelayMs);
          stderr.write(`[bridge] 上游返回 ${resp.status}，${delayMs}ms 后重试 (${attempt + 1}/${maxRetries})\n`);
          await sleep(delayMs);
          continue;
        }
        return resp;
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          const delayMs = Math.min(baseDelayMs * (attempt + 1), maxDelayMs);
          stderr.write(`[bridge] 请求异常: ${err.message}，${delayMs}ms 后重试 (${attempt + 1}/${maxRetries})\n`);
          await sleep(delayMs);
        }
      }
    }
    throw lastError ?? new Error("fetchWithRetry: 所有重试均失败");
  } finally {
    releaseSlot();
  }
}

async function main() {
  const config = loadConfig();
  config.chatCompletionsUrl = resolveChatCompletionsUrl(config.upstreamBaseUrl);

  const server = http.createServer((request, response) => {
    handleRequest(request, response, config).catch((error) => {
      writeJson(response, error.statusCode ?? 500, {
        error: { message: error.message, type: error.type ?? "bridge_error" }
      });
    });
  });

  server.listen(config.port, config.host, () => {
    stdout.write(`Codex Chat bridge 已启动：http://${config.host}:${config.port}/v1/responses\n`);
    stdout.write(`上游 Chat Completions：${config.chatCompletionsUrl}\n`);
  });

  if (!stdin.isTTY) {
    stdin.resume();
  }
}

export async function handleRequest(request, response, config) {
  const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);

  if (request.method === "OPTIONS") {
    return writeEmpty(response, 204);
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return writeJson(response, 200, {
      ok: true,
      service: "codex-bridge",
      upstream: config.chatCompletionsUrl ?? null,
      model: "passthrough (由客户端提供)",
      logFile: LOG_FILE
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/debug/clear-log") {
    clearLogFile();
    return writeJson(response, 200, { ok: true, message: "日志已清空" });
  }

  if (request.method === "GET" && url.pathname === "/v1/debug/last") {
    if (!lastDebugEntry) {
      return writeJson(response, 404, { error: "还没有记录任何请求", hint: "发一次 /v1/responses 请求后重试" });
    }
    return writeJson(response, 200, lastDebugEntry);
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    return writeJson(response, 200, {
      object: "list",
      models: [
        { id: "passthrough", slug: "passthrough", display_name: "Model provided by client", object: "model", created: Date.now(), owned_by: "bridge" }
      ]
    });
  }

  const responseMatch = url.pathname.match(/^\/v1\/responses\/([^/]+)$/);
  if (responseMatch && request.method === "GET") {
    const stored = responseStore.get(responseMatch[1]);
    if (!stored) {
      return writeJson(response, 404, makeError("未找到指定 response", "not_found_error", "response_not_found"));
    }
    return writeJson(response, 200, stored);
  }

  if (responseMatch && request.method === "DELETE") {
    const deleted = responseStore.delete(responseMatch[1]);
    return writeJson(response, 200, {
      id: responseMatch[1],
      object: "response.deleted",
      deleted
    });
  }

  if (request.method !== "POST" || url.pathname !== "/v1/responses") {
    return writeJson(response, 404, makeError("只支持 POST /v1/responses", "not_found_error"));
  }

  let responsesRequest;
  try {
    responsesRequest = await readJsonBody(request);
  } catch (error) {
    return writeJson(response, 400, makeError(`JSON 请求体解析失败：${error.message}`, "invalid_request_error", "invalid_json"));
  }

  // 文件日志：记录完整请求
  fileLog({
    event: "request_incoming",
    tools: responsesRequest.tools?.map(t => ({ type: t.type, name: t.name ?? t.function?.name })) ?? [],
    model: responsesRequest.model,
    input: summarizeRequestInputForLog(responsesRequest.input),
    stream: responsesRequest.stream ?? false
  });

  const { chatRequest, warnings, conversationId, toolContext } = toChatCompletionsRequest(responsesRequest, {
    onUnsupportedNativeTool: config.strictNativeTools ? "error" : "warn",
    enableReasoning: config.enableReasoning,
    simulateNativeTools: config.simulateNativeTools ?? false
  });

  // ── Session 关联 ──
  const previousResponseId = responsesRequest.previous_response_id || responsesRequest.conversation;
  const existingSession = previousResponseId ? lookupSessionByResponseId(previousResponseId) : null;
  const model = responsesRequest.model ?? 'unknown';
  const effort = responsesRequest.reasoning?.effort ?? 'medium';
  const inputItems = Array.isArray(responsesRequest.input) ? responsesRequest.input : [];

  let sessionId;
  let isNewSession = false;
  if (existingSession) {
    sessionId = existingSession.sessionId;
  } else {
    // 提取工具列表给 session_meta
    const tools = (responsesRequest.tools ?? []).map(t => ({
      name: t.name ?? t.function?.name ?? '',
      description: t.description ?? t.function?.description ?? '',
      deferLoading: false,
    }));

    // 提取 system prompt
    const systemMsg = chatRequest.messages?.find(m => m.role === 'system' || m.role === 'developer');
    const systemPrompt = typeof systemMsg?.content === 'string' ? systemMsg.content : '';

    const { sessionId: newSessionId } = ensureSession(conversationId, {
      model,
      modelProvider: 'bridge',
      cwd: process.cwd(),
      systemPrompt,
      tools,
      effort,
    });
    sessionId = newSessionId;
    isNewSession = true;
  }

  // ── 写入 turn 结构 ──
  const turnId = writeTurnContext(sessionId, {
    model,
    cwd: process.cwd(),
    effort,
  });

  writeTaskStarted(sessionId, turnId);

  // 新 session 写入 developer 消息（system prompt / instructions）
  if (isNewSession) {
    // 优先使用 Responses API 的 instructions 字段
    if (responsesRequest.instructions && typeof responsesRequest.instructions === 'string') {
      writeDeveloperMessage(sessionId, responsesRequest.instructions);
    } else {
      // 从 messages 里找 system/developer 消息
      const systemMsg = chatRequest.messages?.find(m => m.role === 'system' || m.role === 'developer');
      if (systemMsg?.content) {
        writeDeveloperMessage(sessionId, systemMsg.content);
      }
    }
  }

  // 写入用户消息（response_item + event_msg）
  const lastUserMsg = chatRequest.messages?.findLast(m => m.role === 'user');
  if (lastUserMsg?.content) {
    const userText = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : lastUserMsg.content;
    writeUserMessage(sessionId, userText);
    writeUserMessageEvent(sessionId, typeof userText === 'string' ? userText : JSON.stringify(userText));
  }

  // 写入 input 中的 function_call 和 function_call_output
  for (const item of inputItems) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call' && item.call_id) {
      writeFunctionCall(sessionId, item.call_id, item.name ?? '', item.arguments ?? '{}');
    }
    if (item.type === 'function_call_output' && item.call_id) {
      writeFunctionCallOutput(sessionId, item.call_id, typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''));
    }
  }

  // ── 转发请求 ──
  if (responsesRequest.stream) {
    return handleStreamRequest(request, response, config, chatRequest, warnings, sessionId, turnId, toolContext, responsesRequest);
  }

  // 非流式（带连接重试）
  let upstreamResponse;
  try {
    upstreamResponse = await fetchWithRetry(config.chatCompletionsUrl, {
      method: "POST",
      headers: buildUpstreamHeaders(request, config),
      body: JSON.stringify(chatRequest)
    }, config);
  } catch (err) {
    writeTaskComplete(sessionId, turnId, '');
    return writeJson(response, 502, makeUpstreamError(`上游不可达: ${err.message}`, 502, null));
  }

  const upstreamBodyText = await upstreamResponse.text();
  const upstreamBody = parseJsonOrRaw(upstreamBodyText);

  if (!upstreamResponse.ok) {
    writeTaskComplete(sessionId, turnId, '');
    return writeJson(response, upstreamResponse.status, makeUpstreamError("上游 Chat Completions 请求失败", upstreamResponse.status, upstreamBody, upstreamResponse));
  }

  let responsesBody = fromChatCompletionsResponse(upstreamBody, {
    responseId: makeResponseId(),
    repairTextToolCalls: config.repairTextToolCalls ?? true,
    availableToolNames: getChatToolNames(chatRequest),
    availableTools: chatRequest.tools ?? [],
    toolContext,
    request: responsesRequest
  });
  if (warnings.length > 0) {
    responsesBody.bridge_warnings = warnings;
  }

  // ── 工具调用验证与重试 ──
  const shouldRetry = config.toolCallRetry !== false;
  const maxRetries = shouldRetry ? (config.maxToolCallRetries ?? 1) : 0;
  const toolNames = getChatToolNames(chatRequest);
  let retryCount = 0;

  while (retryCount < maxRetries) {
    const issues = validateToolCalls(responsesBody.output ?? [], toolNames);
    if (issues.length === 0) break;

    stderr.write(`[bridge] 工具调用验证发现 ${issues.length} 个问题，发起第 ${retryCount + 1} 次重试
`);
    for (const issue of issues) {
      stderr.write(`  - ${issue.name}: ${issue.description}
`);
    }

    const retryMessages = buildRetryMessages(chatRequest.messages, responsesBody.output, issues);
    const retryRequest = { ...chatRequest, messages: retryMessages };

    let retryOk = false;
    try {
      const retryResp = await fetchWithRetry(config.chatCompletionsUrl, {
        method: "POST",
        headers: buildUpstreamHeaders(request, config),
        body: JSON.stringify(retryRequest)
      }, config);
      const retryText = await retryResp.text();
      const retryBody = parseJsonOrRaw(retryText);

      if (retryResp.ok) {
        responsesBody = fromChatCompletionsResponse(retryBody, {
          responseId: makeResponseId(),
          repairTextToolCalls: config.repairTextToolCalls ?? true,
          availableToolNames: toolNames,
          availableTools: chatRequest.tools ?? [],
          toolContext,
          request: responsesRequest
        });
        if (!responsesBody.bridge_warnings) responsesBody.bridge_warnings = [];
        responsesBody.bridge_warnings.push(`工具调用重试第 ${retryCount + 1} 次成功`);
        retryOk = true;
      } else {
        stderr.write(`[bridge] 重试请求失败: ${retryResp.status}
`);
      }
    } catch (err) {
      stderr.write(`[bridge] 重试请求异常: ${err.message}
`);
    }

    retryCount++;
    if (retryOk) break;
  }

  // 写入 assistant 响应
  const assistantOutput = responsesBody.output?.find(o => o.type === 'message');
  const lastAgentText = assistantOutput?.content?.[0]?.text ?? '';

  if (lastAgentText) {
    writeAgentMessageEvent(sessionId, lastAgentText);
    writeAssistantResponse(sessionId, lastAgentText);
  }

  // 写入 function_call
  for (const item of (responsesBody.output ?? [])) {
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      writeFunctionCall(sessionId, item.call_id, item.name, item.arguments ?? item.input ?? '');
      writeEvent(sessionId, 'tool_call', {
        turn_id: turnId,
        call_id: item.call_id,
        name: item.name,
        status: 'completed'
      });
    }
  }

  // token 统计（对齐 Codex Desktop info 结构）
  const usage = responsesBody.usage;
  if (usage) {
    writeTokenCount(sessionId, usage.input_tokens ?? 0, usage.output_tokens ?? 0);
  }

  // task_complete
  writeTaskComplete(sessionId, turnId, lastAgentText);

  // 注册 response ID
  registerResponseId(responsesBody.id, sessionId);
  rememberResponse(responsesBody);

  // 记录调试信息
  lastDebugEntry = {
    timestamp: new Date().toISOString(),
    request: {
      original: responsesRequest,
      converted: chatRequest,
      warnings
    },
    response: responsesBody,
    retries: retryCount > 0 ? retryCount : undefined
  };

  // 文件日志：记录完整响应
  fileLog({
    event: "response_outgoing",
    responseId: responsesBody.id,
    output: responsesBody.output?.map(o => ({
      type: o.type,
      name: o.name,
      call_id: o.call_id,
      action: o.action,
      operation: o.operation,
      content: o.content?.map(c => ({ type: c.type, text: c.text?.slice(0, 200) }))
    }))
  });

  writeJson(response, 200, responsesBody);
}

async function handleStreamRequest(request, response, config, chatRequest, warnings, sessionId, turnId, toolContext, responsesRequest = {}) {
  chatRequest.stream = true;
  chatRequest.stream_options = { include_usage: true };

  let upstreamResponse;
  try {
    upstreamResponse = await fetchWithRetry(config.chatCompletionsUrl, {
      method: "POST",
      headers: buildUpstreamHeaders(request, config),
      body: JSON.stringify(chatRequest)
    }, config);
  } catch (err) {
    writeTaskComplete(sessionId, turnId, '');
    return writeJson(response, 502, makeUpstreamError(`上游不可达: ${err.message}`, 502, null));
  }

  if (!upstreamResponse.ok) {
    const bodyText = await upstreamResponse.text();
    writeTaskComplete(sessionId, turnId, '');
    return writeJson(response, upstreamResponse.status, makeUpstreamError("上游 Chat Completions 流式请求失败", upstreamResponse.status, parseJsonOrRaw(bodyText), upstreamResponse));
  }

  response.writeHead(200, {
    ...commonHeaders(),
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });

  const responseId = makeResponseId();
  const converter = createStreamConverter(responseId, chatRequest.model, {
    enableReasoning: config.enableReasoning,
    toolContext,
    instructions: responsesRequest.instructions ?? null,
    maxOutputTokens: responsesRequest.max_output_tokens ?? null,
    previousResponseId: responsesRequest.previous_response_id ?? null,
    reasoning: responsesRequest.reasoning
      ? { context: "current_turn", effort: responsesRequest.reasoning.effort ?? "none", summary: responsesRequest.reasoning.summary ?? null }
      : undefined,
    toolChoice: responsesRequest.tool_choice ?? "auto",
    parallelToolCalls: responsesRequest.parallel_tool_calls ?? true,
    temperature: responsesRequest.temperature ?? 1,
    topP: responsesRequest.top_p ?? 0.98,
    truncation: responsesRequest.truncation ?? "disabled"
  });

  if (warnings.length > 0) {
    for (const w of warnings) {
      response.write(`data: ${JSON.stringify({ type: "bridge.warning", warning: w })}\n\n`);
    }
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // 收集流式内容
  let assistantContent = "";
  const toolCallMap = new Map();
  let lastUsage = null; // 收集最后一个 chunk 的 usage
  let completedResponse = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }

        // 收集 usage
        if (chunk?.usage) {
          lastUsage = chunk.usage;
        }

        const events = converter.processChunk(chunk);
        for (const event of events) {
          stderr.write(`[bridge] event: ${event.type}\n`);
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

          // 收集助手文本
          if (event.type === "response.output_text.delta" && event.delta) {
            assistantContent += event.delta;
          }

          // 收集工具调用 — 从 output_item.added 拿 id 和 name
          if (event.type === "response.output_item.added" && (event.item?.type === "function_call" || event.item?.type === "custom_tool_call")) {
            const callId = event.item.call_id ?? event.item.id;
            toolCallMap.set(callId, { id: callId, name: event.item.name ?? "", arguments: "", type: event.item.type });
            writeEvent(sessionId, 'tool_call_started', {
              turn_id: turnId,
              call_id: callId,
              name: event.item.name ?? ''
            });
          }

          // 工具调用参数 delta
          if (event.type === "response.function_call_arguments.delta" || event.type === "response.custom_tool_call_input.delta") {
            const callId = event.call_id ?? event.item?.call_id;
            if (callId && toolCallMap.has(callId)) {
              toolCallMap.get(callId).arguments += event.delta ?? event.arguments ?? "";
            } else if (callId) {
              toolCallMap.set(callId, { id: callId, name: "", arguments: event.delta ?? event.arguments ?? "" });
            }
          }

          // 工具调用参数完成
          if (event.type === "response.output_item.done" && (event.item?.type === "function_call" || event.item?.type === "custom_tool_call")) {
            const callId = event.item.call_id ?? event.item.id;
            if (callId && toolCallMap.has(callId)) {
              const tc = toolCallMap.get(callId);
              if (!tc.name && event.item.name) tc.name = event.item.name;
              if (event.item.arguments && tc.arguments !== event.item.arguments) {
                tc.arguments = event.item.arguments;
              } else if (event.item.input && tc.arguments !== event.item.input) {
                tc.arguments = event.item.input;
              }
              writeEvent(sessionId, 'tool_call_completed', {
                turn_id: turnId,
                call_id: callId,
                name: tc.name,
                arguments: tc.arguments
              });
            }
          }

          if (event.type === "response.completed") {
            completedResponse = event.response;
          }
        }
      }
    }
  } catch (err) {
    stderr.write(`流式转发异常：${err.message}\n`);
  } finally {
    // ── 写入 JSONL（对齐 Codex Desktop 格式）──
    if (assistantContent) {
      writeAgentMessageEvent(sessionId, assistantContent);
      writeAssistantResponse(sessionId, assistantContent);
    }

    for (const [, tc] of toolCallMap) {
      writeFunctionCall(sessionId, tc.id, tc.name, tc.arguments);
    }

    // token 统计（使用上游返回的 usage 或兜底估算）
    let inputTokens = lastUsage?.prompt_tokens ?? 0;
    let outputTokens = lastUsage?.completion_tokens ?? 0;
    if (!lastUsage && config.tokenEstimationEnabled !== false) {
      // 兜底估算：基于文本和工具调用参数的字符数
      let outputEstimate = estimateTokens(assistantContent ?? "");
      for (const [, tc] of toolCallMap) {
        outputEstimate += estimateTokens(tc.arguments ?? "");
      }
      outputTokens = outputTokens || outputEstimate;
      inputTokens = inputTokens || Math.round(outputTokens * 2.5);
    }
    writeTokenCount(sessionId, inputTokens, outputTokens);

    // task_complete
    writeTaskComplete(sessionId, turnId, assistantContent);

    // 注册 response ID
    registerResponseId(responseId, sessionId);
    if (completedResponse) {
      if (!completedResponse.usage) {
        if (lastUsage) {
          completedResponse.usage = normalizeChatUsage(lastUsage);
        } else if (config.tokenEstimationEnabled !== false) {
          completedResponse.usage = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
        }
      }
      rememberResponse(completedResponse);
    }

    // 文件日志：记录流式响应结果
    fileLog({
      event: "stream_response_done",
      responseId,
      toolCalls: Array.from(toolCallMap.values()).map(tc => ({
        id: tc.id, name: tc.name, type: tc.type, arguments: tc.arguments?.slice(0, 500)
      })),
      assistantContent: assistantContent?.slice(0, 500)
    });

    response.end();
  }
}

// ─── 辅助函数 ───────────────────────────────────────────────

function makeUUID() {
  return crypto.randomUUID();
}

function makeResponseId() {
  return `resp_${makeUUID().replace(/-/g, "")}`;
}

function rememberResponse(response) {
  if (!response?.id) return;
  responseStore.set(response.id, response);
  while (responseStore.size > MAX_STORED_RESPONSES) {
    const oldestKey = responseStore.keys().next().value;
    responseStore.delete(oldestKey);
  }
}

function acquireUpstreamSlot(maxConcurrency) {
  if (activeUpstreamRequests < maxConcurrency) {
    activeUpstreamRequests++;
    return Promise.resolve(releaseUpstreamSlot);
  }

  return new Promise((resolve) => {
    upstreamQueue.push(resolve);
  }).then(() => releaseUpstreamSlot);
}

function releaseUpstreamSlot() {
  const next = upstreamQueue.shift();
  if (next) {
    next();
    return;
  }
  activeUpstreamRequests = Math.max(0, activeUpstreamRequests - 1);
}

function getChatToolNames(chatRequest) {
  return (chatRequest.tools ?? [])
    .map((tool) => tool?.function?.name)
    .filter((name) => typeof name === "string" && name.length > 0);
}

export function resolveChatCompletionsUrl(baseUrl) {
  if (!baseUrl) {
    throw new Error("缺少 UPSTREAM_BASE_URL，例如 https://api.example.com/compatible-mode/v1");
  }
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (url.pathname.endsWith("/chat/completions")) return url.toString();
  const path = url.pathname;
  const looksLikeOpenAiCompatibleBase =
    /\/v\d+(\/.*)?$/.test(path) || path.endsWith("/coding") || path.endsWith("/compatible-mode/v1");
  url.pathname = looksLikeOpenAiCompatibleBase ? `${path}/chat/completions` : `${path}/v1/chat/completions`;
  return url.toString();
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

function buildUpstreamHeaders(request, config) {
  const headers = { "content-type": "application/json" };
  // 直接透传客户端的 Authorization，config 里的 key 仅作为兜底
  const authorization = request.headers.authorization || (config.upstreamApiKey ? `Bearer ${config.upstreamApiKey}` : null);
  if (authorization) headers.authorization = authorization;
  return headers;
}

function parseJsonOrRaw(text) {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(response, attempt, baseDelayMs, maxDelayMs) {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  if (retryAfterMs !== null) return Math.min(retryAfterMs, maxDelayMs);
  return Math.min(baseDelayMs * (attempt + 1), maxDelayMs);
}

function parseRetryAfterMs(value) {
  if (!value) return null;

  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const retryAt = Date.parse(value);
  if (!Number.isNaN(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return null;
}

function makeError(message, type, code, param = null) {
  return {
    error: {
      message,
      type,
      code: code ?? null,
      param
    }
  };
}

function makeUpstreamError(message, status, upstream, upstreamResponse = null) {
  const retryAfter = upstreamResponse ? upstreamResponse.headers.get("retry-after") : null;
  const isRateLimited = status === 429;
  return {
    error: {
      message,
      type: isRateLimited ? "upstream_rate_limited" : "upstream_error",
      code: isRateLimited ? "upstream_rate_limited" : "upstream_request_failed",
      param: null,
      upstream_status: status,
      retry_after: retryAfter,
      upstream
    }
  };
}

function normalizeChatUsage(usage) {
  return {
    input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0
  };
}

function writeEmpty(response, statusCode) {
  response.writeHead(statusCode, commonHeaders());
  response.end();
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    ...commonHeaders(),
    "content-type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function commonHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-request-id",
    "x-bridge": "codex-chat-completions"
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { stderr.write(`${error.message}\n`); exit(1); });
}
