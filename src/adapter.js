import { simulateNativeTool, isSimulatableTool } from './tool-simulator.js';
import { estimateTokens } from './token-estimator.js';

const CHAT_ROLES = new Set(["system", "developer", "user", "assistant"]);
const NATIVE_TOOL_TYPES = new Set([
  "web_search",
  "local_shell",
  "computer_use",
  "tool_search",
  "web_search_preview",
  "image_generation",
  "code_interpreter",
  "computer_use_preview",
  "file_search"
]);

const GENERIC_CODEX_TOOL_TYPES = new Set([
  "web_search",
  "local_shell",
  "computer_use",
  "tool_search",
  "web_search_preview",
  "computer_use_preview"
]);

const CODEX_BRIDGE_BEHAVIOR_PROMPT = [
  "你正在通过 Codex Bridge 为 Codex Desktop 工作。你的行为必须像原生 Codex 模型一样：",
  "1. 需要读取文件、列目录、搜索代码、执行命令、修改文件或运行测试时，必须调用可用的 function tool，不要用自然语言假装已经完成。",
  "2. 修改文件时，优先使用 Codex 提供的编辑/patch 工具；不要只输出整段代码让用户手动复制。",
  "3. 工具调用参数必须是严格 JSON 字符串，字段名和类型要符合工具 schema。",
  "4. 工具返回结果后，再基于真实结果继续下一步；不要编造文件内容、命令输出或测试结果。",
  "5. 最终回复只总结已经真实完成和验证过的内容。"
].join("\n");

const APPLY_PATCH_BEHAVIOR_PROMPT = [
  "本轮存在 apply_patch 文件编辑工具时，必须遵守：",
  "1. 需要编辑文件时调用 apply_patch，不要把 patch 放在普通 assistant 文本里。",
  "2. patch 内容必须使用 *** Begin Patch / *** End Patch 格式，并只包含本次必要改动。",
  "3. 不要用自然语言描述“我已修改文件”来代替 apply_patch 工具调用。",
  "4. 修改后需要继续调用命令/测试工具验证，除非用户明确不要求。"
].join("\n");

const TOOL_NAME_ALIASES = new Map([
  ["patch", "apply_patch"],
  ["applypatch", "apply_patch"],
  ["apply_patch_tool", "apply_patch"],
  ["edit_file", "apply_patch"],
  ["file_edit", "apply_patch"],
  ["modify_file", "apply_patch"],
  ["shell", "exec_command"],
  ["bash", "exec_command"],
  ["terminal", "exec_command"],
  ["run_command", "exec_command"]
]);

export class UnsupportedNativeToolError extends Error {
  constructor(tool) {
    super(`原生工具 ${tool?.type ?? "unknown"} 不能直接转接到 Chat Completions function tool`);
    this.name = "UnsupportedNativeToolError";
    this.tool = tool;
  }
}

export function toChatCompletionsRequest(responsesRequest, options = {}) {
  if (!responsesRequest || typeof responsesRequest !== "object") {
    throw new TypeError("请求体必须是对象");
  }

  const warnings = [];
  // 处理有状态对话
  let messages = [];
  let conversationId = null;
  
  // 不再使用 conversationManager 存储历史
  // Codex Desktop 会自己管理对话历史，每次发送完整的 input
  const toolContext = buildCodexToolContext(responsesRequest.tools ?? []);
  messages = normalizeInputToMessages(responsesRequest.input ?? [], { toolContext });
  
  // conversationId 用于 session 关联，不用于对话历史存储
  conversationId = responsesRequest.previous_response_id || responsesRequest.conversation || null;

  const tools = mapTools(responsesRequest.tools ?? [], {
    onUnsupportedNativeTool: options.onUnsupportedNativeTool ?? "warn",
    warnings,
    simulateNativeTools: options.simulateNativeTools ?? false,
    toolContext
  });

  messages = prependInstructions(messages, buildInstructions(responsesRequest.instructions, {
    injectCodexBehavior: options.injectCodexBehavior ?? true,
    toolNames: tools.map((tool) => tool?.function?.name).filter(Boolean)
  }));

  const chatRequest = {
    model: responsesRequest.model,
    messages: messages,
    store: false
  };

  // 流式请求时添加 stream_options 以获取 usage 信息
  if (responsesRequest.stream) {
    chatRequest.stream_options = { include_usage: true };
  }

  // reasoning.effort → 上游格式映射
  if (responsesRequest.reasoning?.effort) {
    chatRequest.reasoning_effort = mapReasoningEffort(responsesRequest.reasoning.effort);
  }

  // 推理模式：只在明确启用时才发送 thinking 参数
  // 不发送 thinking 字段 = 让上游自行决定是否启用推理
  if (options.enableReasoning === true) {
    chatRequest.thinking = { type: "enabled" };
  }

  if (tools.length > 0) {
    chatRequest.tools = tools;
    chatRequest.tool_choice = mapToolChoice(responsesRequest.tool_choice, toolContext);
  }

  copyKnownGenerationOptions(responsesRequest, chatRequest);

  return { 
    chatRequest, 
    warnings, 
    conversationId,
    toolContext
  };
}

export function fromChatCompletionsResponse(chatResponse, options = {}) {
  const choice = chatResponse?.choices?.[0];
  const message = choice?.message ?? {};
  const output = [];
  const responseId = options.responseId ?? normalizeResponseId(chatResponse?.id);
  const content = stripHiddenReasoning(message.content ?? "", options);

  // 官方 Responses API 顺序：message 在前，function_call 在后
  const repairedToolCall = maybeRepairTextToolCall(content, { ...options, responseId });
  const hasToolCalls = (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) || repairedToolCall;

  // 混合输出清洗：同时有文本和工具调用时，精简文本为简短说明
  if (content.length > 0 && !repairedToolCall) {
    const cleanedContent = hasToolCalls ? cleanMixedOutputText(content) : content;
    if (cleanedContent.length > 0) {
      output.push({
        type: "message",
        id: `${responseId}_msg`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: cleanedContent, annotations: [] }]
      });
    }
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (let index = 0; index < message.tool_calls.length; index += 1) {
      const toolCall = message.tool_calls[index];
      if (toolCall.type !== "function") continue;
      const callId = toolCall.id || `call_${responseId}_${index}`;
      output.push(remapToolCallItem({
        type: "function_call",
        id: callId,
        call_id: callId,
        name: toolCall.function?.name,
        arguments: toolCall.function?.arguments ?? "{}",
        status: "completed"
      }, options.toolContext));
    }
  }

  if (repairedToolCall) {
    output.push(remapToolCallItem(repairedToolCall, options.toolContext));
  }

  return {
    id: responseId,
    object: "response",
    created_at: chatResponse?.created ?? Math.floor(Date.now() / 1000),
    status: "completed",
    background: false,
    completed_at: Math.floor(Date.now() / 1000),
    error: null,
    frequency_penalty: options.request?.frequency_penalty ?? 0,
    incomplete_details: null,
    instructions: options.request?.instructions ?? null,
    max_output_tokens: options.request?.max_output_tokens ?? null,
    max_tool_calls: options.request?.max_tool_calls ?? null,
    model: chatResponse?.model,
    moderation: null,
    output,
    parallel_tool_calls: options.request?.parallel_tool_calls ?? true,
    presence_penalty: options.request?.presence_penalty ?? 0,
    previous_response_id: options.request?.previous_response_id ?? null,
    reasoning: options.request?.reasoning ?? { context: "current_turn", effort: "none", summary: null },
    service_tier: options.request?.service_tier ?? "default",
    store: false,
    temperature: options.request?.temperature ?? 1,
    text: options.request?.text ?? { format: { type: "text" }, verbosity: "medium" },
    tool_choice: options.request?.tool_choice ?? "auto",
    top_logprobs: options.request?.top_logprobs ?? 0,
    top_p: options.request?.top_p ?? 0.98,
    truncation: options.request?.truncation ?? "disabled",
    output_text: getOutputText(output),
    usage: normalizeUsage(chatResponse?.usage),
    finish_reason: choice?.finish_reason
  };
}

function normalizeResponseId(id) {
  if (typeof id === "string" && id.startsWith("resp_")) return id;
  return `resp_${Date.now()}`;
}

function normalizeUsage(usage) {
  // 原生 Responses API 总是返回 usage 对象，即使值为 0
  if (!usage) {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  }
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const result = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage.total_tokens ?? inputTokens + outputTokens
  };
  // 透传上游的缓存 token 信息（对齐原生 Responses API 的 cached_input_tokens）
  if (usage.prompt_tokens_details?.cached_tokens ?? usage.cached_input_tokens) {
    result.input_tokens_details = { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cached_input_tokens };
  }
  if (usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_output_tokens) {
    result.output_tokens_details = { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_output_tokens };
  }
  return result;
}

// ---- 流式转换：Chat Completions SSE delta → Responses API SSE 事件 ----

/**
 * 创建一个流式转换器，把 Chat Completions 的 SSE delta 分片累积并转为
 * Responses API 的 SSE 事件数组。每次调用 processChunk 返回本次新产生的事件。
 */
export function createStreamConverter(responseId, model, options = {}) {
  let started = false;
  let finished = false;
  let outputIndex = 0;
  let textItemActive = false;
  let textItemCompleted = false;
  let textContentIndex = 0;
  let sequenceNumber = 0;
  let accumulatedText = "";
  let emittedMessageText = "";
  let pendingTextDeltas = [];
  let hasSeenToolCall = false;
  const deferMessageUntilFinish = options.deferMessageUntilFinish === true;
  const toolProgressMode = options.toolProgressMode ?? "preface";
  const suppressStreamingAssistantMessage = deferMessageUntilFinish;
  const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
  const responseSuffix = responseId.replace(/^resp_/, "");
  const messageItemId = `msg_${responseSuffix}`;
  const reasoningItemId = `rs_${responseSuffix}`;
  const enableReasoning = options.enableReasoning === true;
  const textFilter = createReasoningFilter({ enabled: !enableReasoning });

  // 按 tool call index 跟踪累积状态
  const toolContext = options.toolContext ?? createEmptyToolContext();
  const toolCallStates = new Map(); // index → { id, name, args }

  function flush(events) {
    const result = events.splice(0);
    return result;
  }

  function seq(event) {
    event.sequence_number = sequenceNumber++;
    return event;
  }

  function emitBufferedMessage(events) {
    if (textItemActive || pendingTextDeltas.length === 0) return;
    events.push(seq({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        type: "message",
        id: messageItemId,
        role: "assistant",
        status: "in_progress",
        content: [],
        phase: null
      }
    }));
    events.push(seq({
      type: "response.content_part.added",
      output_index: outputIndex,
      content_index: textContentIndex,
      item_id: messageItemId,
      part: { type: "output_text", text: "", annotations: [], logprobs: [] }
    }));
    for (const deltaText of pendingTextDeltas) {
      emittedMessageText += deltaText;
      events.push(seq({
        type: "response.output_text.delta",
        output_index: outputIndex,
        content_index: textContentIndex,
        item_id: messageItemId,
        delta: deltaText,
        logprobs: [],
        obfuscation: makeObfuscation(sequenceNumber)
      }));
    }
    pendingTextDeltas = [];
    textItemActive = true;
  }

  function completeActiveMessage(events, phase = null) {
    if (!textItemActive || textItemCompleted) return;
    events.push(seq({
      type: "response.output_text.done",
      output_index: outputIndex,
      content_index: textContentIndex,
      item_id: messageItemId,
      text: emittedMessageText,
      logprobs: []
    }));
    events.push(seq({
      type: "response.content_part.done",
      output_index: outputIndex,
      content_index: textContentIndex,
      item_id: messageItemId,
      part: { type: "output_text", text: emittedMessageText, annotations: [], logprobs: [] }
    }));
    events.push(seq({
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        type: "message",
        id: messageItemId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: emittedMessageText, annotations: [], logprobs: [] }],
        phase
      }
    }));
    textItemCompleted = true;
  }

  function emitBufferedTextAsReasoning(events) {
    if (accumulatedText.length === 0) return;
    events.push(seq({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        type: "reasoning",
        id: reasoningItemId,
        summary: [],
        status: "in_progress"
      }
    }));
    events.push(seq({
      type: "response.reasoning_summary_part.added",
      output_index: outputIndex,
      item_id: reasoningItemId,
      summary_index: 0,
      part: { type: "summary_text", text: "" }
    }));
    events.push(seq({
      type: "response.reasoning_summary_text.delta",
      output_index: outputIndex,
      item_id: reasoningItemId,
      summary_index: 0,
      delta: accumulatedText,
      obfuscation: makeObfuscation(sequenceNumber)
    }));
    events.push(seq({
      type: "response.reasoning_summary_text.done",
      output_index: outputIndex,
      item_id: reasoningItemId,
      summary_index: 0,
      text: accumulatedText
    }));
    events.push(seq({
      type: "response.reasoning_summary_part.done",
      output_index: outputIndex,
      item_id: reasoningItemId,
      summary_index: 0,
      part: { type: "summary_text", text: accumulatedText }
    }));
    events.push(seq({
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        type: "reasoning",
        id: reasoningItemId,
        summary: [{ type: "summary_text", text: accumulatedText }],
        status: "completed"
      }
    }));
  }

  function responseSnapshot(status, output = [], usage = undefined) {
    return {
      id: responseId,
      object: "response",
      created_at: createdAt,
      status,
      background: false,
      completed_at: status === "completed" ? Math.floor(Date.now() / 1000) : null,
      error: null,
      frequency_penalty: 0,
      incomplete_details: null,
      instructions: options.instructions ?? null,
      max_output_tokens: options.maxOutputTokens ?? null,
      max_tool_calls: null,
      model,
      moderation: null,
      output,
      parallel_tool_calls: options.parallelToolCalls ?? true,
      presence_penalty: 0,
      previous_response_id: options.previousResponseId ?? null,
      reasoning: options.reasoning ?? { context: "current_turn", effort: "none", summary: null },
      service_tier: status === "completed" ? "default" : "auto",
      store: false,
      temperature: options.temperature ?? 1,
      text: options.text ?? { format: { type: "text" }, verbosity: "medium" },
      tool_choice: options.toolChoice ?? "auto",
      top_logprobs: 0,
      top_p: options.topP ?? 0.98,
      truncation: options.truncation ?? "disabled",
      usage
    };
  }

  return {
    processChunk(chunk) {
      const events = [];
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta;
      const finishReason = choice?.finish_reason;

      if (!started) {
        const initialSnapshot = responseSnapshot("in_progress", []);
        events.push(seq({
          type: "response.created",
          response: initialSnapshot
        }));
        events.push(seq({
          type: "response.in_progress",
          response: initialSnapshot
        }));
        started = true;
      }

      // 文本内容：只在 enableReasoning 时输出 reasoning_content，否则只用 content
      let textDelta = enableReasoning 
        ? (delta?.content || delta?.reasoning_content)
        : delta?.content;

      textDelta = textFilter.push(textDelta);
      if (textDelta && textDelta.length > 0) {
        accumulatedText += textDelta;
        if (textItemActive && !textItemCompleted && !(deferMessageUntilFinish && hasSeenToolCall)) {
          emittedMessageText += textDelta;
          events.push(seq({
            type: "response.output_text.delta",
            output_index: outputIndex,
            content_index: textContentIndex,
            item_id: messageItemId,
            delta: textDelta,
            logprobs: [],
            obfuscation: makeObfuscation(sequenceNumber)
          }));
        } else if (deferMessageUntilFinish || hasSeenToolCall) {
          pendingTextDeltas.push(textDelta);
        } else {
          pendingTextDeltas.push(textDelta);
          emitBufferedMessage(events);
        }
      }

      // 工具调用
      if (Array.isArray(delta?.tool_calls)) {
        if (!hasSeenToolCall && delta.tool_calls.length > 0 && deferMessageUntilFinish && toolProgressMode === "preface" && pendingTextDeltas.length > 0) {
          emitBufferedMessage(events);
          completeActiveMessage(events, "tool_preface");
        }
        hasSeenToolCall = hasSeenToolCall || delta.tool_calls.length > 0;
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;

          if (tc.id || !toolCallStates.has(idx)) {
            // 新工具调用开始
            toolCallStates.set(idx, {
              callId: tc.id ?? `call_${responseId}_${idx}`,
              itemId: null,
              name: tc.function?.name ?? "",
              args: ""
            });
          }

          const state = toolCallStates.get(idx);
          if (!state) continue;

          if (tc.function?.name && !state.name) {
            state.name = tc.function.name;
          }

          if (tc.function?.arguments) {
            state.args += tc.function.arguments;
          }

          // 第一个分片到达时发出 output_item.added
          if (!state.emitted) {
            const itemOutputIndex = outputIndex + (textItemActive ? 1 : 0) + idx;
            state.itemId = makeToolItemId(responseId, idx, state.name, toolContext);
            const addedItem = remapToolCallItem({
              type: "function_call",
              id: state.itemId,
              call_id: state.callId,
              name: state.name,
              arguments: "",
              status: "in_progress"
            }, toolContext);
            events.push(seq({
              type: "response.output_item.added",
              output_index: itemOutputIndex,
              item: addedItem
            }));
            state.emitted = true;
            state.itemOutputIndex = itemOutputIndex;
          }

          if (tc.function?.arguments) {
            const partialItem = remapToolCallItem({
              type: "function_call",
              id: state.itemId,
              call_id: state.callId,
              name: state.name,
              arguments: state.args,
              status: "in_progress"
            }, toolContext);
            if (partialItem.type !== "custom_tool_call") {
              events.push(seq({
                type: "response.function_call_arguments.delta",
                output_index: state.itemOutputIndex,
                item_id: state.itemId,
                call_id: state.callId,
                delta: tc.function.arguments,
                obfuscation: makeObfuscation(sequenceNumber)
              }));
            }
            // custom_tool_call: 累积 input，在 finish 时拆 token 发 delta
            if (partialItem.type === "custom_tool_call") {
              state.pendingCustomInput = partialItem.input ?? "";
            }
          }
        }
      }

      // 结束
      if (finishReason) {
        if (finished) return flush(events); // 已经发过 completed，跳过
        finished = true;
        const shouldEmitAssistantMessage = !hasSeenToolCall && accumulatedText.length > 0;
        const shouldEmitAssistantStreamEvents = shouldEmitAssistantMessage;
        if (shouldEmitAssistantStreamEvents) {
          emitBufferedMessage(events);
        }
        if (textItemActive && shouldEmitAssistantStreamEvents) {
          completeActiveMessage(events, toolCallStates.size === 0 ? "final_answer" : null);
        }

        if (hasSeenToolCall && accumulatedText.length > 0 && toolProgressMode === "reasoning") {
          emitBufferedTextAsReasoning(events);
        }

        for (const [idx, state] of toolCallStates) {
          if (!state.emitted) continue;
          const doneItem = remapToolCallItem({
            type: "function_call",
            id: state.itemId,
            call_id: state.callId,
            name: state.name,
            arguments: state.args,
            status: "completed"
          }, toolContext);
          if (doneItem.type === "custom_tool_call" && doneItem.input) {
            // 拆成小 delta 逐 token 发出，模拟原生 Codex 流式 patch 输入
            const input = doneItem.input;
            for (let i = 0; i < input.length; i += 40) {
              events.push(seq({
                type: "response.custom_tool_call_input.delta",
                output_index: state.itemOutputIndex,
                item_id: state.itemId,
                call_id: state.callId,
                delta: input.slice(i, i + 40),
                obfuscation: makeObfuscation(sequenceNumber)
              }));
            }
          }
          const donePayload = {
            type: doneItem.type === "custom_tool_call"
              ? "response.custom_tool_call_input.done"
              : "response.function_call_arguments.done",
            output_index: state.itemOutputIndex,
            item_id: state.itemId,
            call_id: state.callId
          };
          if (doneItem.type === "custom_tool_call") {
            donePayload.input = doneItem.input ?? "";
          } else {
            donePayload.arguments = doneItem.arguments ?? state.args;
          }
          events.push(seq(donePayload));
          events.push(seq({
            type: "response.output_item.done",
            output_index: state.itemOutputIndex,
            item: doneItem
          }));
        }

        const outputItems = [];
        if (hasSeenToolCall && accumulatedText.length > 0 && toolProgressMode === "reasoning") {
          outputItems.push({
            type: "reasoning",
            id: reasoningItemId,
            summary: [{ type: "summary_text", text: accumulatedText }],
            status: "completed"
          });
        }
        if (shouldEmitAssistantMessage) {
          outputItems.push({
            type: "message",
            id: messageItemId,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: accumulatedText, annotations: [] }],
            phase: toolCallStates.size === 0 ? "final_answer" : null
          });
        }
        for (const [idx, state] of toolCallStates) {
          outputItems.push(remapToolCallItem({
            type: "function_call",
            id: state.itemId,
            call_id: state.callId,
            name: state.name,
            arguments: state.args,
            status: "completed"
          }, toolContext));
        }

        const completedSnapshot = {
          ...responseSnapshot("completed", outputItems, normalizeUsage(chunk?.usage)),
          output_text: getOutputText(outputItems)
        };
        events.push(seq({
          type: "response.completed",
          response: completedSnapshot
        }));
      }

      return flush(events);
    },

    /** 上游断连时强制发 completed，避免客户端挂死 */
    forceFinish() {
      if (finished) return [];
      return this.processChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    },

    /** 检查是否已发过 completed */
    isFinished() {
      return finished;
    }
  };
}

function makeToolItemId(responseId, index, toolName, toolContext) {
  const suffix = responseId.replace(/^resp_/, "");
  const customSpec = toolContext?.customTools?.get(toolName);
  const prefix = customSpec ? "ctc" : "fc";
  return `${prefix}_${suffix}_${index}`;
}

function makeObfuscation(seed) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let value = "";
  let n = Math.abs(Number(seed) || 0) + 17;
  for (let i = 0; i < 14; i += 1) {
    n = (n * 1103515245 + 12345) >>> 0;
    value += alphabet[n % alphabet.length];
  }
  return value;
}

export function normalizeInputToMessages(input, options = {}) {
  const toolContext = options.toolContext ?? createEmptyToolContext();
  const items = Array.isArray(input) ? input : [input];
  let messages = [];

  for (const item of items) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }

    if (!item || typeof item !== "object") continue;

    if (item.type === "message" || CHAT_ROLES.has(item.role)) {
      messages.push({
        role: normalizeRole(item.role),
        content: normalizeContent(item.content)
      });
      continue;
    }

    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id ?? item.id,
            type: "function",
            function: {
              name: item.name,
              arguments: stringifyArguments(item.arguments)
            }
          }
        ]
      });
      continue;
    }

    if (item.type === "custom_tool_call") {
      const { name, arguments: args } = buildCustomToolHistoryArguments(item.name, item.input ?? item.arguments ?? "", toolContext);
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id ?? item.id,
            type: "function",
            function: {
              name,
              arguments: args
            }
          }
        ]
      });
      continue;
    }

    // 原生 local_shell_call → 转回 shell 代理工具
    if (item.type === "local_shell_call") {
      const command = item.action?.command ?? "";
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id ?? item.id,
            type: "function",
            function: {
              name: "shell",
              arguments: JSON.stringify({ command })
            }
          }
        ]
      });
      continue;
    }

    // 原生 apply_patch_call → 转回 apply_patch 代理工具
    if (item.type === "apply_patch_call") {
      const patchText = rebuildApplyPatchText(item.operation);
      const { name, arguments: args } = buildCustomToolHistoryArguments("apply_patch", patchText, toolContext);
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id ?? item.id,
            type: "function",
            function: {
              name,
              arguments: args
            }
          }
        ]
      });
      continue;
    }

    // 原生 local_shell_call_output / apply_patch_call_output → tool 消息
    if (item.type === "local_shell_call_output" || item.type === "apply_patch_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "")
      });
      continue;
    }

    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id ?? item.tool_call_id,
        content: stringifyToolOutput(item.output)
      });
    }
  }

  // 上下文压缩：如果消息太长，截断早期消息
  messages = compressMessages(messages);

  return messages;
}

export function stripHiddenReasoning(text, options = {}) {
  if (options.enableReasoning === true || typeof text !== "string") return text ?? "";
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trimStart();
}

function createReasoningFilter({ enabled }) {
  let buffer = "";
  let insideThink = false;

  return {
    push(delta) {
      if (!enabled || typeof delta !== "string" || delta.length === 0) return delta ?? "";

      buffer += delta;
      let visible = "";

      while (buffer.length > 0) {
        if (insideThink) {
          const endIndex = buffer.toLowerCase().indexOf("</think>");
          if (endIndex === -1) {
            buffer = buffer.slice(Math.max(0, buffer.length - 8));
            return visible;
          }
          buffer = buffer.slice(endIndex + "</think>".length);
          insideThink = false;
          continue;
        }

        const startIndex = buffer.toLowerCase().indexOf("<think>");
        if (startIndex === -1) {
          const keep = longestPossibleThinkPrefix(buffer);
          visible += buffer.slice(0, buffer.length - keep);
          buffer = buffer.slice(buffer.length - keep);
          return visible;
        }

        visible += buffer.slice(0, startIndex);
        buffer = buffer.slice(startIndex + "<think>".length);
        insideThink = true;
      }

      return visible;
    }
  };
}

function longestPossibleThinkPrefix(text) {
  const marker = "<think>";
  const lower = text.toLowerCase();
  for (let length = Math.min(marker.length - 1, lower.length); length > 0; length -= 1) {
    if (marker.startsWith(lower.slice(-length))) return length;
  }
  return 0;
}

function getOutputText(output) {
  return output
    .filter((item) => item.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content)
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

// 估算单条消息的 token 数
function estimateMessageTokens(msg) {
  if (!msg) return 0;
  
  let tokens = 0;
  
  // 角色 token
  tokens += 4;
  
  // 内容 token
  if (typeof msg.content === 'string') {
    tokens += estimateTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === 'text' && part.text) {
        tokens += estimateTokens(part.text);
      }
    }
  }
  
  // 工具调用 token
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += estimateTokens(JSON.stringify(tc));
    }
  }
  
  // 工具结果 token
  if (msg.role === 'tool' && msg.content) {
    tokens += estimateTokens(msg.content);
  }
  
  return tokens;
}

// 上下文压缩：保留系统消息 + 最近的消息，截断中间部分
function compressMessages(messages, maxTokens = 120000) {
  // 先估算总 token
  let totalTokens = 0;
  for (const msg of messages) {
    totalTokens += estimateMessageTokens(msg);
  }

  if (totalTokens <= maxTokens) return messages;

  // 需要压缩：保留第一条（通常是系统消息）+ 最近的消息
  const systemMessages = [];
  const otherMessages = [];

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      systemMessages.push(msg);
    } else {
      otherMessages.push(msg);
    }
  }

  // 从后往前保留消息，直到接近 token 限制
  const keptMessages = [];
  let keptTokens = 0;
  const systemTokens = systemMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const availableTokens = maxTokens - systemTokens;

  for (let i = otherMessages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(otherMessages[i]);
    if (keptTokens + msgTokens > availableTokens * 0.9) break;
    keptMessages.unshift(otherMessages[i]);
    keptTokens += msgTokens;
  }

  // 如果截断了，添加一条提示消息
  if (keptMessages.length < otherMessages.length) {
    const droppedCount = otherMessages.length - keptMessages.length;
    keptMessages.unshift({
      role: "user",
      content: `[上下文已压缩：省略了 ${droppedCount} 条早期消息以节省 token]`
    });
  }

  return [...systemMessages, ...keptMessages];
}

function createEmptyToolContext() {
  return {
    customTools: new Map(),
    functionTools: new Map(),
    hasCustomTools: false,
    hasNamespaceTools: false
  };
}

export function buildCodexToolContext(responseTools = []) {
  const context = createEmptyToolContext();

  for (const rawTool of responseTools) {
    if (typeof rawTool === "string" && rawTool.length > 0) {
      context.customTools.set(rawTool, { originalName: rawTool, kind: "raw" });
      context.hasCustomTools = true;
      continue;
    }

    if (!rawTool || typeof rawTool !== "object") continue;

    if (rawTool.type === "custom") {
      const name = rawTool.name;
      if (!name) continue;
      const kind = detectCustomToolKind(rawTool);
      context.customTools.set(name, { originalName: name, kind });
      if (kind === "apply_patch") {
        for (const action of ["add_file", "delete_file", "update_file", "replace_file", "batch"]) {
          context.customTools.set(`${name}_${action}`, { originalName: name, kind, action });
        }
      }
      context.hasCustomTools = true;
      continue;
    }

    if (rawTool.type === "function") {
      const name = rawTool.name ?? rawTool.function?.name;
      if (name) context.functionTools.set(name, { name, namespace: "" });
      continue;
    }

    if (rawTool.type === "namespace") {
      addNamespaceToolsToContext(context, rawTool);
      continue;
    }

    if (GENERIC_CODEX_TOOL_TYPES.has(rawTool.type)) {
      const name = rawTool.name || rawTool.type;
      context.customTools.set(name, { originalName: name, kind: "builtin" });
      context.hasCustomTools = true;
    }
  }

  return context;
}

function detectCustomToolKind(tool) {
  if (tool.name === "apply_patch") return "apply_patch";
  const grammar = tool.format?.definition ?? tool.grammar?.definition ?? "";
  if (
    typeof grammar === "string" &&
    grammar.includes("begin_patch") &&
    grammar.includes("end_patch")
  ) {
    return "apply_patch";
  }
  if (tool.name === "exec") return "exec";
  return "raw";
}

function addNamespaceToolsToContext(context, namespaceTool) {
  const namespace = namespaceTool.name ?? "";
  const children = Array.isArray(namespaceTool.tools) ? namespaceTool.tools : [];
  for (const child of children) {
    if (!child || typeof child !== "object" || child.type !== "function") continue;
    const name = child.name ?? child.function?.name;
    if (!name) continue;
    const flatName = flattenNamespaceToolName(namespace, name);
    if (context.functionTools.has(flatName) && !context.functionTools.get(flatName)?.namespace) continue;
    context.functionTools.set(flatName, { namespace, name });
    context.hasNamespaceTools = true;
  }
}

function flattenNamespaceToolName(namespace, name) {
  if (!namespace) return name;
  if (!name) return namespace;
  if (namespace.endsWith("__") || name.startsWith("__")) return `${namespace}${name}`;
  return `${namespace}__${name}`;
}

function makeNamespaceProxyTools(namespaceTool, context) {
  const namespace = namespaceTool.name ?? "";
  const namespaceDescription = namespaceTool.description ?? "";
  const children = Array.isArray(namespaceTool.tools) ? namespaceTool.tools : [];
  const tools = [];

  for (const child of children) {
    if (!child || typeof child !== "object" || child.type !== "function") continue;
    const name = child.name ?? child.function?.name;
    if (!name) continue;
    const flatName = flattenNamespaceToolName(namespace, name);
    const spec = context.functionTools.get(flatName);
    if (namespace && spec && spec.namespace === "") continue;
    const childDescription = child.description ?? child.function?.description ?? "";
    tools.push({
      type: "function",
      function: {
        name: flatName,
        description: combineDescriptions(namespaceDescription, childDescription),
        parameters: child.parameters ?? child.function?.parameters ?? { type: "object", properties: {} },
        ...((child.strict ?? child.function?.strict) === undefined ? {} : { strict: child.strict ?? child.function?.strict })
      }
    });
  }

  return tools;
}

function combineDescriptions(first, second) {
  const a = typeof first === "string" ? first.trim() : "";
  const b = typeof second === "string" ? second.trim() : "";
  if (!a) return b || undefined;
  if (!b) return a;
  return `${a}\n\n${b}`;
}

function makeGenericCustomProxyTool(name, description) {
  const desc = description
    ? `${description}\n\n这是 Codex freeform/custom 工具代理。把原始工具输入放在 input 字段，不要再包 markdown。`
    : `Codex freeform/custom 工具代理：${name}。把原始工具输入放在 input 字段。`;
  return {
    type: "function",
    function: {
      name,
      description: desc,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          input: { type: "string", description: "原始工具输入文本。" }
        },
        required: ["input"]
      }
    }
  };
}

function makeApplyPatchProxyTools(name, description) {
  return [
    makeFunctionTool(`${name}_add_file`, patchProxyDescription(description, "add_file", "新增一个文件，提供路径和完整内容。"), {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "目标文件路径。" },
        content: { type: "string", description: "完整文件内容，不要包含 patch 的 + 前缀。" }
      },
      required: ["path", "content"]
    }),
    makeFunctionTool(`${name}_delete_file`, patchProxyDescription(description, "delete_file", "删除一个文件，提供路径。"), {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "目标文件路径。" }
      },
      required: ["path"]
    }),
    makeFunctionTool(`${name}_update_file`, patchProxyDescription(description, "update_file", "修改一个已有文件，提供结构化 hunks。"), {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "目标文件路径。" },
        move_to: { type: "string", description: "可选，移动到的新路径。" },
        hunks: applyPatchHunksSchema()
      },
      required: ["path", "hunks"]
    }),
    makeFunctionTool(`${name}_replace_file`, patchProxyDescription(description, "replace_file", "替换一个已有文件，提供路径和完整新内容。"), {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "目标文件路径。" },
        content: { type: "string", description: "完整替换内容。" }
      },
      required: ["path", "content"]
    }),
    makeFunctionTool(`${name}_batch`, patchProxyDescription(description, "batch", "一次提交多个文件编辑操作。"), {
      type: "object",
      additionalProperties: false,
      properties: {
        operations: {
          type: "array",
          description: "按顺序执行的文件编辑操作。",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["add_file", "delete_file", "update_file", "replace_file"] },
              path: { type: "string" },
              move_to: { type: "string" },
              content: { type: "string" },
              hunks: applyPatchHunksSchema()
            },
            required: ["type", "path"]
          }
        }
      },
      required: ["operations"]
    })
  ];
}

function makeFunctionTool(name, description, parameters) {
  return { type: "function", function: { name, description, parameters: normalizeToolParameters(parameters) } };
}

/**
 * 规范化 tool parameters，补齐严格校验所需字段。
 * 部分上游镜像在未提供 required/type/properties 时会报错：
 * "Invalid schema for function ...: None is not of type 'array'"
 */
function normalizeToolParameters(params) {
  if (!params || typeof params !== "object") {
    return { type: "object", properties: {}, required: [] };
  }
  const result = { ...params };
  if (!result.type) result.type = "object";
  if (!result.properties) result.properties = {};
  if (!result.required) result.required = [];
  return result;
}

/**
 * reasoning.effort 映射：Codex 的 effort 级别 → 上游格式
 * ccx 支持 6 级：none/auto/minimal/low/medium/high/xhigh
 */
function mapReasoningEffort(effort) {
  switch (effort) {
    case "none": return "none";
    case "auto": return "auto";
    case "minimal": return "low";
    case "low": return "low";
    case "medium": return "medium";
    case "high": return "high";
    case "xhigh": return "high";
    default: return "auto";
  }
}

function patchProxyDescription(description, action, fallback) {
  return description ? `${description}（proxy action: ${action}）` : fallback;
}

function applyPatchHunksSchema() {
  return {
    type: "array",
    description: "结构化 patch hunk。context 可选，lines 内 op 为 context/add/remove。",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        context: { type: "string" },
        lines: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["context", "add", "remove"] },
              text: { type: "string" }
            },
            required: ["op", "text"]
          }
        }
      },
      required: ["lines"]
    }
  };
}

function remapToolCallItem(item, toolContext = createEmptyToolContext()) {
  if (!item || item.type !== "function_call") return item;

  const namespaceSpec = toolContext.functionTools.get(item.name);
  if (namespaceSpec?.namespace) {
    return {
      ...item,
      name: namespaceSpec.name,
      namespace: namespaceSpec.namespace
    };
  }

  const customSpec = toolContext.customTools.get(item.name);
  if (!customSpec) return item;

  if (customSpec.kind === "apply_patch") {
    const input = reconstructCustomToolInput(customSpec, item.name, item.arguments ?? "{}");
    return {
      type: "custom_tool_call",
      id: item.id,
      call_id: item.call_id,
      name: customSpec.originalName,
      input,
      status: item.status ?? "completed"
    };
  }

  if (customSpec.kind === "exec" || customSpec.kind === "builtin") {
    const input = reconstructCustomToolInput(customSpec, item.name, item.arguments ?? "{}");
    return {
      type: "custom_tool_call",
      id: item.id,
      call_id: item.call_id,
      name: customSpec.originalName,
      input,
      status: item.status ?? "completed"
    };
  }

  const input = reconstructCustomToolInput(customSpec, item.name, item.arguments ?? "{}");
  return {
    type: "custom_tool_call",
    id: item.id,
    call_id: item.call_id,
    name: customSpec.originalName,
    input,
    status: item.status ?? "completed"
  };
}

/**
 * 将 apply_patch_call 的 operation 转回 V4A patch 格式
 * 用于 history replay
 */
function rebuildApplyPatchText(operation) {
  if (!operation) return "";
  const { type, path, diff } = operation;

  if (type === "create_file") {
    return `*** Begin Patch\n*** Add File: ${path}\n${diff}\n*** End Patch`;
  }
  if (type === "delete_file") {
    return `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch`;
  }
  if (type === "update_file") {
    return `*** Begin Patch\n*** Update File: ${path}\n${diff}\n*** End Patch`;
  }
  // 兜底
  return diff || "";
}

function reconstructCustomToolInput(spec, upstreamName, rawArguments) {
  if (spec.kind === "apply_patch") {
    return applyPatchInputFromProxyArguments(rawArguments, spec.action ?? proxyActionFromName(upstreamName));
  }

  const parsed = parseJsonObject(rawArguments);
  if (typeof parsed?.input === "string") return parsed.input;
  return typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments ?? {});
}

function applyPatchInputFromProxyArguments(rawArguments, action) {
  const args = parseJsonObject(rawArguments);
  if (!args) return typeof rawArguments === "string" ? normalizePatchText(rawArguments) : "";

  if (typeof args.input === "string" && action) {
    const nested = parseJsonObject(args.input);
    if (nested) Object.assign(args, { ...nested, ...args });
  }

  const operations = [];
  if (action === "add_file") {
    operations.push({ type: "add_file", path: args.path, content: args.content });
  } else if (action === "delete_file") {
    operations.push({ type: "delete_file", path: args.path });
  } else if (action === "update_file") {
    operations.push({ type: "update_file", path: args.path, move_to: args.move_to, hunks: args.hunks });
  } else if (action === "replace_file") {
    operations.push({ type: "replace_file", path: args.path, content: args.content });
  } else if (action === "batch" && Array.isArray(args.operations)) {
    operations.push(...args.operations);
  } else if (typeof args.input === "string") {
    return normalizePatchText(args.input);
  } else if (typeof args.patch === "string") {
    return normalizePatchText(args.patch);
  } else if (typeof args.raw_patch === "string") {
    return normalizePatchText(args.raw_patch);
  }

  return buildApplyPatchInput(operations.length > 0 ? operations : [{ type: "batch" }]);
}

function buildApplyPatchInput(operations) {
  const lines = ["*** Begin Patch"];
  for (const operation of operations) {
    if (!operation || typeof operation !== "object") continue;
    const type = operation.type;
    if (type === "add_file") {
      lines.push(`*** Add File: ${operation.path ?? ""}`);
      for (const line of splitPatchContent(operation.content ?? "")) lines.push(`+${line}`);
    } else if (type === "delete_file") {
      lines.push(`*** Delete File: ${operation.path ?? ""}`);
    } else if (type === "update_file") {
      lines.push(`*** Update File: ${operation.path ?? ""}`);
      if (operation.move_to) lines.push(`*** Move to: ${operation.move_to}`);
      const hunks = Array.isArray(operation.hunks) ? operation.hunks : [];
      for (const hunk of hunks) {
        lines.push(hunk?.context ? `@@ ${hunk.context}` : "@@");
        const hunkLines = Array.isArray(hunk?.lines) ? hunk.lines : [];
        for (const line of hunkLines) {
          lines.push(`${patchLinePrefix(line?.op)}${line?.text ?? ""}`);
        }
      }
    } else if (type === "replace_file") {
      lines.push(`*** Delete File: ${operation.path ?? ""}`);
      lines.push(`*** Add File: ${operation.path ?? ""}`);
      for (const line of splitPatchContent(operation.content ?? "")) lines.push(`+${line}`);
    }
  }
  lines.push("*** End Patch");
  return lines.join("\n");
}

function splitPatchContent(content) {
  return String(content ?? "").replace(/\n$/, "").split("\n");
}

function patchLinePrefix(op) {
  if (op === "add") return "+";
  if (op === "remove" || op === "delete") return "-";
  return " ";
}

function proxyActionFromName(name) {
  for (const action of ["add_file", "delete_file", "update_file", "replace_file", "batch"]) {
    if (name?.endsWith(`_${action}`)) return action;
  }
  return "";
}

function buildCustomToolHistoryArguments(originalName, input, toolContext) {
  const spec = toolContext.customTools.get(originalName);
  if (spec?.kind === "apply_patch" || originalName === "apply_patch" || String(input).includes("*** Begin Patch")) {
    const operations = parseApplyPatchOperations(String(input ?? ""));
    if (operations.length === 1) {
      const action = operations[0].type;
      return { name: `${originalName}_${action}`, arguments: JSON.stringify(singlePatchOperationArguments(operations[0])) };
    }
    return { name: `${originalName}_batch`, arguments: JSON.stringify({ operations }) };
  }
  return { name: spec?.originalName ?? originalName, arguments: JSON.stringify({ input: String(input ?? "") }) };
}

function parseApplyPatchOperations(input) {
  if (typeof input !== "string" || !input.includes("*** Begin Patch")) return [];
  const lines = input.split("\n");
  const operations = [];
  let current = null;
  let currentHunk = null;

  const pushCurrent = () => {
    if (current) operations.push(current);
    current = null;
    currentHunk = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "*** Begin Patch" || line === "*** End Patch") continue;
    if (line.startsWith("*** Add File: ")) {
      pushCurrent();
      current = { type: "add_file", path: line.slice(14), content: "" };
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      pushCurrent();
      current = { type: "delete_file", path: line.slice(17) };
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      pushCurrent();
      current = { type: "update_file", path: line.slice(17), hunks: [] };
      continue;
    }
    if (line.startsWith("*** Move to: ") && current?.type === "update_file") {
      current.move_to = line.slice(13);
      continue;
    }
    if (line.startsWith("@@") && current?.type === "update_file") {
      currentHunk = { context: line.slice(2).trim(), lines: [] };
      current.hunks.push(currentHunk);
      continue;
    }
    if (!current) continue;
    if (current.type === "add_file" && line.startsWith("+")) {
      current.content += `${line.slice(1)}\n`;
    } else if (current.type === "update_file" && currentHunk) {
      const prefix = line[0];
      if (prefix === "+" || prefix === "-" || prefix === " ") {
        currentHunk.lines.push({
          op: prefix === "+" ? "add" : prefix === "-" ? "remove" : "context",
          text: line.slice(1)
        });
      }
    }
  }

  pushCurrent();
  return operations;
}

function singlePatchOperationArguments(operation) {
  if (operation.type === "add_file" || operation.type === "replace_file") {
    return { path: operation.path, content: operation.content ?? "" };
  }
  if (operation.type === "delete_file") return { path: operation.path };
  if (operation.type === "update_file") {
    return {
      path: operation.path,
      ...(operation.move_to ? { move_to: operation.move_to } : {}),
      hunks: operation.hunks ?? []
    };
  }
  return operation;
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function mapTools(responseTools, {
  onUnsupportedNativeTool = "warn",
  warnings = [],
  simulateNativeTools = false,
  toolContext = buildCodexToolContext(responseTools)
} = {}) {
  const tools = [];
  const seenNames = new Set();

  const pushTool = (tool) => {
    const name = tool?.function?.name;
    if (typeof name === "string" && name.length > 0) {
      if (seenNames.has(name)) return;
      seenNames.add(name);
    }
    tools.push(tool);
  };

  for (const tool of responseTools) {
    if (typeof tool === "string" && tool.length > 0) {
      pushTool(makeGenericCustomProxyTool(tool, ""));
      continue;
    }

    if (!tool || typeof tool !== "object") continue;

    if (tool.type === "function") {
      const name = tool.name ?? tool.function?.name;
      pushTool({
        type: "function",
        function: {
          name,
          description: tool.description ?? tool.function?.description,
          parameters: normalizeToolParameters(tool.parameters ?? tool.function?.parameters),
          ...((tool.strict ?? tool.function?.strict) === undefined ? {} : { strict: tool.strict ?? tool.function?.strict })
        }
      });
      continue;
    }

    if (tool.type === "custom") {
      const name = tool.name;
      if (!name) continue;
      const spec = toolContext.customTools.get(name);
      if (spec?.kind === "apply_patch") {
        for (const proxy of makeApplyPatchProxyTools(name, tool.description ?? "")) {
          pushTool(proxy);
        }
      } else {
        pushTool(makeGenericCustomProxyTool(name, tool.description ?? ""));
      }
      continue;
    }

    if (tool.type === "namespace") {
      for (const namespaceTool of makeNamespaceProxyTools(tool, toolContext)) {
        pushTool(namespaceTool);
      }
      continue;
    }

    if (GENERIC_CODEX_TOOL_TYPES.has(tool.type)) {
      const name = tool.name || tool.type;
      pushTool(makeGenericCustomProxyTool(name, tool.description ?? ""));
      warnings.push(`已将 Codex 原生工具 ${tool.type} 转换为 function proxy：${name}。`);
      continue;
    }

    if (NATIVE_TOOL_TYPES.has(tool.type)) {
      if (simulateNativeTools && isSimulatableTool(tool.type)) {
        // 将原生工具转换为 function tool
        const simulatedTool = simulateNativeTool(tool);
        if (simulatedTool) {
          pushTool(simulatedTool);
          warnings.push(`已将原生工具 ${tool.type} 转换为 function tool 进行模拟。`);
          continue;
        }
      }
      
      if (onUnsupportedNativeTool === "error") {
        throw new UnsupportedNativeToolError(tool);
      }
      warnings.push(`已跳过原生工具 ${tool.type}：Chat Completions 不能直接本地调度该类工具，请替换为 function tool。`);
      continue;
    }

    warnings.push(`已跳过未知工具 ${tool.type ?? "unknown"}。`);
  }

  return tools;
}

function mapToolChoice(toolChoice, toolContext = createEmptyToolContext()) {
  if (!toolChoice || toolChoice === "auto") return "auto";
  if (toolChoice === "none") return "none";
  if (toolChoice === "required") return "required";
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const namespace = toolChoice.namespace ?? toolChoice.function?.namespace;
    const name = toolChoice.name ?? toolChoice.function?.name;
    if (namespace && name) {
      return {
        type: "function",
        function: { name: flattenNamespaceToolName(namespace, name) }
      };
    }
    return {
      type: "function",
      function: { name }
    };
  }
  if (typeof toolChoice === "object" && toolChoice.type === "custom") {
    const name = toolChoice.name;
    const spec = toolContext.customTools.get(name);
    if (!spec) return "auto";
    return {
      type: "function",
      function: { name: spec.kind === "apply_patch" ? `${name}_batch` : name }
    };
  }
  return "auto";
}

function normalizeRole(role) {
  if (role === "developer") return "system";
  if (CHAT_ROLES.has(role)) return role;
  return "user";
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.input_text === "string") return part.input_text;
      if (typeof part.output_text === "string") return part.output_text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function buildInstructions(instructions, { injectCodexBehavior, toolNames = [] }) {
  const parts = [];
  if (typeof instructions === "string" && instructions.trim().length > 0) {
    parts.push(instructions.trim());
  }
  if (injectCodexBehavior && toolNames.length > 0) {
    parts.push(CODEX_BRIDGE_BEHAVIOR_PROMPT);
  }
  if (injectCodexBehavior && toolNames.includes("apply_patch")) {
    parts.push(APPLY_PATCH_BEHAVIOR_PROMPT);
  }
  return parts.join("\n\n");
}

function prependInstructions(messages, instructions) {
  if (typeof instructions !== "string" || instructions.trim().length === 0) {
    return messages;
  }

  const normalizedInstructions = instructions.trim();
  if (messages.length > 0 && messages[0].role === "system") {
    return [
      { ...messages[0], content: mergeText(messages[0].content, normalizedInstructions) },
      ...messages.slice(1)
    ];
  }

  return [{ role: "system", content: normalizedInstructions }, ...messages];
}

function maybeRepairTextToolCall(content, options) {
  if (options.repairTextToolCalls !== true || typeof content !== "string") return null;
  const availableToolNames = new Set(options.availableToolNames ?? []);
  if (availableToolNames.size === 0) return null;
  const availableTools = options.availableTools ?? [];

  const patch = extractPatchBlock(content);
  if (patch && availableToolNames.has("apply_patch")) {
    return makeFunctionCall({
      responseId: options.responseId,
      index: 0,
      name: "apply_patch",
      args: makeToolArguments("apply_patch", patch, availableTools)
    });
  }

  const parsed = parseToolCallLikeJson(content);
  if (!parsed) return null;

  const rawName = parsed.name ?? parsed.tool ?? parsed.function?.name;
  const name = normalizeToolName(rawName, availableToolNames);
  if (!name) return null;

  const args = parsed.arguments ?? parsed.args ?? parsed.parameters ?? parsed.function?.arguments ?? {};
  if (name === "apply_patch" && typeof args === "string" && args.includes("*** Begin Patch")) {
    return makeFunctionCall({
      responseId: options.responseId,
      index: 0,
      name,
      args: makeToolArguments(name, args, availableTools)
    });
  }

  return makeFunctionCall({
    responseId: options.responseId,
    index: 0,
    name,
    args
  });
}

function makeFunctionCall({ responseId, index, name, args }) {
  const callId = `call_${responseId ?? "repaired"}_${index}`;
  return {
    type: "function_call",
    id: callId,
    call_id: callId,
    name,
    arguments: stringifyArguments(args),
    status: "completed"
  };
}

function normalizeToolName(name, availableToolNames) {
  if (typeof name !== "string" || name.length === 0) return null;
  if (availableToolNames.has(name)) return name;
  const normalized = name.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
  const alias = TOOL_NAME_ALIASES.get(normalized);
  if (alias && availableToolNames.has(alias)) return alias;
  return null;
}

function extractPatchBlock(content) {
  const fenced = content.match(/```(?:patch|diff)?\s*([\s\S]*?\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch)\s*```/i);
  if (fenced) return fenced[1].trim();

  const start = content.indexOf("*** Begin Patch");
  const end = content.indexOf("*** End Patch");
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(start, end + "*** End Patch".length).trim();
  }

  return null;
}

function makeToolArguments(name, value, availableTools) {
  const normalizedValue = name === "apply_patch" ? normalizePatchText(value) : value;
  const tool = availableTools.find((candidate) => candidate?.function?.name === name);
  const properties = tool?.function?.parameters?.properties ?? {};
  if ("patch" in properties) return { patch: normalizedValue };
  if ("input" in properties) return { input: normalizedValue };
  if ("content" in properties) return { content: normalizedValue };
  if ("text" in properties) return { text: normalizedValue };
  return { patch: normalizedValue };
}

function normalizePatchText(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\\n/g, "\n");
}

function parseToolCallLikeJson(content) {
  const trimmed = content.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim()
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // 继续尝试下一种包裹格式。
    }
  }

  return null;
}

function mergeText(existing, extra) {
  const existingText = typeof existing === "string" ? existing.trim() : normalizeContent(existing).trim();
  if (!existingText) return extra;
  return `${extra}\n\n${existingText}`;
}

function stringifyArguments(args) {
  if (typeof args === "string") return args;
  return JSON.stringify(args ?? {});
}

function stringifyToolOutput(output) {
  if (typeof output === "string") return output;
  return JSON.stringify(output ?? "");
}

function copyKnownGenerationOptions(source, target) {
  const keys = [
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "presence_penalty",
    "frequency_penalty",
    "seed",
    "stop",
    "user"
  ];

  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key];
  }

  if (source.max_output_tokens !== undefined && target.max_tokens === undefined) {
    target.max_tokens = source.max_output_tokens;
  }
}

// ─── 混合输出清洗 ────────────────────────────────────────────

/**
 * 当回复同时包含文本和工具调用时，精简文本内容。
 * 去掉"好的我来帮你"之类的废话，保留有实质信息的部分。
 * 如果文本全是废话则返回空字符串，让 output 只保留工具调用。
 */
function cleanMixedOutputText(text) {
  if (typeof text !== "string" || text.length === 0) return "";

  // 常见的"废话"模式：以这些开头的句子通常是填充
  const fillerPatterns = [
    /^(好的|我来|我来帮你|让我|我来执行|正在|我来查看|我来修改|我来运行|好的，|我来为你)/,
    /^(I'll |Let me |I will |I am going to |Sure,? |OK,? )/i,
  ];

  const lines = text.split("\n");
  const kept = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const isFiller = fillerPatterns.some(p => p.test(trimmed));
    if (!isFiller) {
      kept.push(line);
    }
  }

  // 如果全是废话，返回空字符串（不输出 message，只保留工具调用）
  if (kept.length === 0) return "";

  return kept.join("\n").trim();
}

// ─── 工具调用验证与重试 ──────────────────────────────────────

/**
 * 验证工具调用是否合法，返回需要修正的问题列表。
 * 每个 issue 包含 callId、name 和 description。
 */
export function validateToolCalls(output, availableToolNames = []) {
  const toolNameSet = new Set(availableToolNames);
  const issues = [];

  for (const item of output) {
    if (item.type !== "function_call") continue;

    // 1. 工具名不存在
    if (toolNameSet.size > 0 && item.name && !toolNameSet.has(item.name)) {
      const alias = TOOL_NAME_ALIASES.get(item.name.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase());
      if (!alias || !toolNameSet.has(alias)) {
        issues.push({
          callId: item.call_id ?? item.id,
          name: item.name,
          description: `工具名 "${item.name}" 不在可用工具列表中。可用工具：${[...toolNameSet].join(", ")}`
        });
      }
    }

    // 2. arguments 不是合法 JSON
    if (typeof item.arguments === "string") {
      try {
        const parsed = JSON.parse(item.arguments);
        if (typeof parsed !== "object" || parsed === null) {
          issues.push({
            callId: item.call_id ?? item.id,
            name: item.name,
            description: `工具调用参数必须是 JSON 对象，当前解析结果类型为 ${typeof parsed}。`
          });
        }
      } catch {
        issues.push({
          callId: item.call_id ?? item.id,
          name: item.name,
          description: `工具调用参数不是合法 JSON，解析失败。请按工具 schema 输出严格 JSON 参数。`
        });
      }
    } else if (item.arguments === undefined || item.arguments === null || item.arguments === "") {
      issues.push({
        callId: item.call_id ?? item.id,
        name: item.name,
        description: `工具调用缺少 arguments 参数。`
      });
    }

    // 3. 缺少 call_id / id
    if (!item.call_id && !item.id) {
      issues.push({
        callId: "(missing)",
        name: item.name,
        description: `工具调用缺少 call_id，无法与工具结果关联。`
      });
    }
  }

  return issues;
}

/**
 * 构建重试修正消息：把上游返回的畸形工具调用作为 assistant 消息，
 * 追加一条 user 消息要求模型修正。
 */
export function buildRetryMessages(originalMessages, responseOutput, issues) {
  const retryMessages = [...originalMessages];

  // 把上游的输出转为 assistant 消息
  const assistantContent = [];
  const toolCalls = [];

  for (const item of responseOutput) {
    if (item.type === "message" && Array.isArray(item.content)) {
      const text = item.content.filter(p => p.type === "output_text").map(p => p.text).join("");
      if (text) assistantContent.push(text);
    }
    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})
        }
      });
    }
  }

  const assistantMsg = { role: "assistant" };
  if (assistantContent.length > 0) assistantMsg.content = assistantContent.join("\n");
  if (toolCalls.length > 0) {
    assistantMsg.content = assistantMsg.content ?? null;
    assistantMsg.tool_calls = toolCalls;
  }
  if (!assistantMsg.content && !assistantMsg.tool_calls) {
    assistantMsg.content = "";
  }
  retryMessages.push(assistantMsg);

  // 构建修正指令
  const fixInstructions = issues.map((issue, i) =>
    `${i + 1}. 工具 "${issue.name}" (call_id: ${issue.callId}): ${issue.description}`
  ).join("\n");

  retryMessages.push({
    role: "user",
    content: `你上一次回复中的工具调用存在以下问题，请修正后重新输出：\n\n${fixInstructions}\n\n请只输出修正后的工具调用，不要重复之前的对话内容。确保工具名在可用列表中，参数是合法 JSON 对象且符合工具 schema。`
  });

  return retryMessages;
}

// ============================================================
// 历史回放：custom_tool_call → 上游 function call arguments
// ============================================================

/**
 * 把 Codex custom_tool_call 的 input 转成上游 Chat Completions function call arguments，
 * 用于多轮对话历史回放。
 *
 * @param {object} toolContext - buildCodexToolContext 返回的上下文
 * @param {string} originalName - Codex 端的原始工具名（如 "apply_patch"）
 * @param {string} input - custom_tool_call 的 input 文本
 * @returns {{ name: string, arguments: string }} - 上游函数名和 JSON arguments
 */
export function buildCustomToolCallHistoryArguments(toolContext, originalName, input) {
  const spec = toolContext.customTools.get(originalName);

  if (!spec) {
    return { name: originalName, arguments: JSON.stringify({ input }) };
  }

  if (spec.kind === "apply_patch") {
    const parsed = parseApplyPatchOperations(input);
    if (!parsed || parsed.length === 0) {
      return {
        name: `${originalName}_batch`,
        arguments: JSON.stringify({ operations: [], raw_patch: input })
      };
    }
    if (parsed.length === 1) {
      const action = chooseSingleProxyAction(parsed[0].type);
      return {
        name: `${originalName}_${action}`,
        arguments: buildSingleOpArgsJSON(parsed[0])
      };
    }
    return {
      name: `${originalName}_batch`,
      arguments: buildBatchOpsJSON(parsed)
    };
  }

  // 通用 custom tool
  return {
    name: originalName,
    arguments: JSON.stringify({ input })
  };
}

/**
 * 简化版历史回放：不依赖 toolContext，自动检测 apply_patch 并转换。
 * 用于没有完整上下文时的快速转换。
 *
 * @param {string} name - 工具名
 * @param {string} input - custom_tool_call 的 input
 * @returns {{ name: string, arguments: string }} - 上游函数名和 JSON arguments
 */
export function replayCustomToolCall(name, input) {
  if (
    name === "apply_patch" ||
    (typeof input === "string" && input.startsWith("*** Begin Patch") && input.includes("*** End Patch"))
  ) {
    const parsed = parseApplyPatchOperations(input);
    if (!parsed || parsed.length === 0) {
      return {
        name: `${name}_batch`,
        arguments: JSON.stringify({ operations: [], raw_patch: input })
      };
    }
    if (parsed.length === 1) {
      const action = chooseSingleProxyAction(parsed[0].type);
      return {
        name: `${name}_${action}`,
        arguments: buildSingleOpArgsJSON(parsed[0])
      };
    }
    return {
      name: `${name}_batch`,
      arguments: buildBatchOpsJSON(parsed)
    };
  }

  // 通用 custom tool
  return {
    name,
    arguments: JSON.stringify({ input })
  };
}

function chooseSingleProxyAction(opType) {
  if (["add_file", "delete_file", "update_file", "replace_file"].includes(opType)) {
    return opType;
  }
  return "batch";
}

function buildSingleOpArgsJSON(op) {
  switch (op.type) {
    case "add_file":
    case "replace_file":
      return JSON.stringify({ path: op.path, content: op.content });
    case "delete_file":
      return JSON.stringify({ path: op.path });
    case "update_file": {
      const obj = { path: op.path, hunks: op.hunks ?? [] };
      if (op.move_to) obj.move_to = op.move_to;
      return JSON.stringify(obj);
    }
    default:
      return JSON.stringify({ path: op.path });
  }
}

function buildBatchOpsJSON(ops) {
  const batchOps = ops.map(op => {
    const item = { type: op.type, path: op.path };
    if (op.move_to) item.move_to = op.move_to;
    if (op.content) item.content = op.content;
    if (Array.isArray(op.hunks) && op.hunks.length > 0) item.hunks = op.hunks;
    return item;
  });
  return JSON.stringify({ operations: batchOps });
}
