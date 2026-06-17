import { simulateNativeTool, isSimulatableTool } from './tool-simulator.js';
import { estimateTokens } from './token-estimator.js';

const CHAT_ROLES = new Set(["system", "developer", "user", "assistant"]);
const NATIVE_TOOL_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "image_generation",
  "code_interpreter",
  "computer_use_preview",
  "file_search"
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
  messages = normalizeInputToMessages(responsesRequest.input ?? []);
  
  // conversationId 用于 session 关联，不用于对话历史存储
  conversationId = responsesRequest.previous_response_id || responsesRequest.conversation || null;

  const tools = mapTools(responsesRequest.tools ?? [], {
    onUnsupportedNativeTool: options.onUnsupportedNativeTool ?? "warn",
    warnings,
    simulateNativeTools: options.simulateNativeTools ?? false
  });

  messages = prependInstructions(messages, buildInstructions(responsesRequest.instructions, {
    injectCodexBehavior: options.injectCodexBehavior ?? true,
    toolNames: tools.map((tool) => tool?.function?.name).filter(Boolean)
  }));

  const chatRequest = {
    model: options.modelOverride ?? responsesRequest.model,
    messages: messages,
    store: false
  };

  // 推理模式：只在明确启用时才发送 thinking 参数
  // 不发送 thinking 字段 = 让上游自行决定是否启用推理
  if (options.enableReasoning === true) {
    chatRequest.thinking = { type: "enabled" };
  }

  if (tools.length > 0) {
    chatRequest.tools = tools;
    chatRequest.tool_choice = mapToolChoice(responsesRequest.tool_choice);
  }

  copyKnownGenerationOptions(responsesRequest, chatRequest);

  return { 
    chatRequest, 
    warnings, 
    conversationId
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
      output.push({
        type: "function_call",
        id: callId,
        call_id: callId,
        name: toolCall.function?.name,
        arguments: toolCall.function?.arguments ?? "{}",
        status: "completed"
      });
    }
  }

  if (repairedToolCall) {
    output.push(repairedToolCall);
  }

  return {
    id: responseId,
    object: "response",
    created_at: chatResponse?.created ?? Math.floor(Date.now() / 1000),
    model: chatResponse?.model,
    status: "completed",
    output,
    output_text: getOutputText(output),
    usage: normalizeUsage(chatResponse?.usage),
    error: null,
    incomplete_details: null,
    finish_reason: choice?.finish_reason
  };
}

function normalizeResponseId(id) {
  if (typeof id === "string" && id.startsWith("resp_")) return id;
  return `resp_${Date.now()}`;
}

function normalizeUsage(usage) {
  if (!usage) return undefined;
  return {
    input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0
  };
}

// ---- 流式转换：Chat Completions SSE delta → Responses API SSE 事件 ----

/**
 * 创建一个流式转换器，把 Chat Completions 的 SSE delta 分片累积并转为
 * Responses API 的 SSE 事件数组。每次调用 processChunk 返回本次新产生的事件。
 */
export function createStreamConverter(responseId, model, options = {}) {
  let started = false;
  let outputIndex = 0;
  let textItemActive = false;
  let textContentIndex = 0;
  let sequenceNumber = 0;
  let accumulatedText = "";
  const enableReasoning = options.enableReasoning === true;
  const textFilter = createReasoningFilter({ enabled: !enableReasoning });

  // 按 tool call index 跟踪累积状态
  const toolCallStates = new Map(); // index → { id, name, args }

  function flush(events) {
    const result = events.splice(0);
    return result;
  }

  function seq(event) {
    event.sequence_number = sequenceNumber++;
    return event;
  }

  return {
    processChunk(chunk) {
      const events = [];
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta;
      const finishReason = choice?.finish_reason;

      if (!started) {
        events.push(seq({
          type: "response.created",
          response: {
            id: responseId,
            object: "response",
            model,
            status: "in_progress",
            output: []
          }
        }));
        events.push(seq({
          type: "response.in_progress",
          response: {
            id: responseId,
            object: "response",
            model,
            status: "in_progress",
            output: []
          }
        }));
        started = true;
      }

      // 文本内容：只在 enableReasoning 时输出 reasoning_content，否则只用 content
      let textDelta = enableReasoning 
        ? (delta?.content || delta?.reasoning_content)
        : delta?.content;

      textDelta = textFilter.push(textDelta);
      if (textDelta) {
        accumulatedText += textDelta;
        if (!textItemActive) {
          events.push(seq({
            type: "response.output_item.added",
            output_index: outputIndex,
            item: {
              type: "message",
              id: `${responseId}_msg`,
              role: "assistant",
              status: "in_progress",
              content: []
            }
          }));
          events.push(seq({
            type: "response.content_part.added",
            output_index: outputIndex,
            content_index: textContentIndex,
            part: { type: "output_text", text: "", annotations: [] }
          }));
          textItemActive = true;
        }
        events.push(seq({
          type: "response.output_text.delta",
          output_index: outputIndex,
          content_index: textContentIndex,
          delta: textDelta
        }));
      }

      // 工具调用
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;

          if (tc.id || !toolCallStates.has(idx)) {
            // 新工具调用开始
            toolCallStates.set(idx, {
              id: tc.id ?? `call_${responseId}_${idx}`,
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
            events.push(seq({
              type: "response.output_item.added",
              output_index: itemOutputIndex,
              item: {
                type: "function_call",
                id: state.id,
                call_id: state.id,
                name: state.name,
                arguments: "",
                status: "in_progress"
              }
            }));
            state.emitted = true;
            state.itemOutputIndex = itemOutputIndex;
          }

          if (tc.function?.arguments) {
            events.push(seq({
              type: "response.function_call_arguments.delta",
              output_index: state.itemOutputIndex,
              item_id: state.id,
              call_id: state.id,
              delta: tc.function.arguments
            }));
          }
        }
      }

      // 结束
      if (finishReason) {
        if (textItemActive) {
          events.push(seq({
            type: "response.output_text.done",
            output_index: outputIndex,
            content_index: textContentIndex,
            text: accumulatedText
          }));
          events.push(seq({
            type: "response.content_part.done",
            output_index: outputIndex,
            content_index: textContentIndex,
            part: { type: "output_text", text: accumulatedText, annotations: [] }
          }));
          events.push(seq({
            type: "response.output_item.done",
            output_index: outputIndex,
            item: {
              type: "message",
              id: `${responseId}_msg`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: accumulatedText, annotations: [] }]
            }
          }));
        }

        for (const [idx, state] of toolCallStates) {
          if (!state.emitted) continue;
          events.push(seq({
            type: "response.function_call_arguments.done",
            output_index: state.itemOutputIndex,
            item_id: state.id,
            call_id: state.id,
            arguments: state.args
          }));
          events.push(seq({
            type: "response.output_item.done",
            output_index: state.itemOutputIndex,
            item: {
              type: "function_call",
              id: state.id,
              call_id: state.id,
              name: state.name,
              arguments: state.args,
              status: "completed"
            }
          }));
        }

          const outputItems = [];
        if (accumulatedText) {
          outputItems.push({
            type: "message",
            id: `${responseId}_msg`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: accumulatedText, annotations: [] }]
          });
        }
        for (const [idx, state] of toolCallStates) {
          outputItems.push({
            type: "function_call",
            id: state.id,
            call_id: state.id,
            name: state.name,
            arguments: state.args,
            status: "completed"
          });
        }

        events.push(seq({
          type: "response.completed",
          response: {
            id: responseId,
            object: "response",
            model,
            status: "completed",
            output: outputItems,
            output_text: getOutputText(outputItems),
            usage: normalizeUsage(chunk?.usage)
          }
        }));
      }

      return flush(events);
    }
  };
}

export function normalizeInputToMessages(input) {
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

export function mapTools(responseTools, { onUnsupportedNativeTool = "warn", warnings = [], simulateNativeTools = false } = {}) {
  const tools = [];

  for (const tool of responseTools) {
    if (!tool || typeof tool !== "object") continue;

    if (tool.type === "function") {
      tools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? { type: "object", properties: {} },
          ...(tool.strict === undefined ? {} : { strict: tool.strict })
        }
      });
      continue;
    }

    if (NATIVE_TOOL_TYPES.has(tool.type)) {
      if (simulateNativeTools && isSimulatableTool(tool.type)) {
        // 将原生工具转换为 function tool
        const simulatedTool = simulateNativeTool(tool);
        if (simulatedTool) {
          tools.push(simulatedTool);
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

function mapToolChoice(toolChoice) {
  if (!toolChoice || toolChoice === "auto") return "auto";
  if (toolChoice === "none") return "none";
  if (toolChoice === "required") return "required";
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    return {
      type: "function",
      function: { name: toolChoice.name ?? toolChoice.function?.name }
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
