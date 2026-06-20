import assert from "node:assert/strict";
import test from "node:test";
import {
  createStreamConverter,
  fromChatCompletionsResponse,
  buildCodexToolContext,
  mapTools,
  normalizeInputToMessages,
  stripHiddenReasoning,
  toChatCompletionsRequest,
  UnsupportedNativeToolError,
  validateToolCalls,
  buildRetryMessages,
  buildCustomToolCallHistoryArguments,
  replayCustomToolCall
} from "../src/adapter.js";
import {
  resolveChatCompletionsUrl } from "../src/server.js";

test("把 Responses function tools 映射为 Chat Completions tools", () => {
  const { chatRequest } = toChatCompletionsRequest({
    model: "gpt-4.1-mini",
    input: "读取 package.json",
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "读取文件",
        strict: true,
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"]
        }
      }
    ]
  }, { injectCodexBehavior: false });

  assert.equal(chatRequest.store, false);
  assert.deepEqual(chatRequest.messages, [{ role: "user", content: "读取 package.json" }]);
  assert.deepEqual(chatRequest.tools[0], {
    type: "function",
    function: {
      name: "read_file",
      description: "读取文件",
      strict: true,
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    }
  });
});

test("有工具时注入 Codex 工作行为约束", () => {
  const { chatRequest } = toChatCompletionsRequest({
    model: "gpt-4.1-mini",
    input: "帮我改文件",
    tools: [
      {
        type: "function",
        name: "apply_patch",
        parameters: { type: "object", properties: {} }
      }
    ]
  });

  assert.equal(chatRequest.messages[0].role, "system");
  assert.match(chatRequest.messages[0].content, /必须调用可用的 function tool/);
  assert.match(chatRequest.messages[0].content, /不要只输出整段代码/);
  assert.match(chatRequest.messages[0].content, /调用 apply_patch/);
});

test("把 Responses instructions 前置为 Chat system 消息", () => {
  const { chatRequest } = toChatCompletionsRequest({
    model: "gpt-4.1-mini",
    instructions: "你是一个严谨的代码助手。",
    input: [{ type: "message", role: "user", content: "检查测试" }]
  });

  assert.deepEqual(chatRequest.messages, [
    { role: "system", content: "你是一个严谨的代码助手。" },
    { role: "user", content: "检查测试" }
  ]);
});

test("把 max_output_tokens 映射为 Chat max_tokens", () => {
  const { chatRequest } = toChatCompletionsRequest({
    model: "gpt-4.1-mini",
    input: "保持简短",
    max_output_tokens: 128
  });

  assert.equal(chatRequest.max_tokens, 128);
  assert.equal("max_output_tokens" in chatRequest, false);
});

test("非推理模式隐藏 think 标签内容", () => {
  assert.equal(stripHiddenReasoning("<think>内部推理</think>最终答案"), "最终答案");

  const response = fromChatCompletionsResponse({
    id: "chatcmpl_1",
    created: 123,
    model: "glm-5",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "<think>草稿</think>完成" } }]
  }, { responseId: "resp_fixed" });

  assert.equal(response.output_text, "完成");
});

test("返回 Responses 风格 response id", () => {
  const response = fromChatCompletionsResponse({
    id: "chatcmpl_1",
    created: 123,
    model: "glm-5",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "完成" } }]
  }, { responseId: "resp_fixed" });

  assert.equal(response.id, "resp_fixed");
  assert.equal(response.output[0].id, "resp_fixed_msg");
});

test("工具调用缺少 id 时生成稳定 call_id", () => {
  const response = fromChatCompletionsResponse({
    id: "chatcmpl_1",
    created: 123,
    model: "glm-5",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [
            {
              type: "function",
              function: { name: "shell", arguments: "{\"cmd\":\"pwd\"}" }
            }
          ]
        }
      }
    ]
  }, { responseId: "resp_fixed" });

  assert.equal(response.output[0].call_id, "call_resp_fixed_0");
});

test("可将纯文本 JSON 工具调用修复为 function_call", () => {
  const response = fromChatCompletionsResponse({
    id: "chatcmpl_1",
    created: 123,
    model: "glm-5",
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "{\"name\":\"shell\",\"arguments\":{\"cmd\":\"pwd\"}}"
        }
      }
    ]
  }, {
    responseId: "resp_fixed",
    repairTextToolCalls: true,
    availableToolNames: ["shell"]
  });

  assert.deepEqual(response.output, [
    {
      type: "function_call",
      id: "call_resp_fixed_0",
      call_id: "call_resp_fixed_0",
      name: "shell",
      arguments: "{\"cmd\":\"pwd\"}",
      status: "completed"
    }
  ]);
});

test("可将 fenced patch 文本修复为 apply_patch function_call", () => {
  const patch = [
    "```patch",
    "*** Begin Patch",
    "*** Update File: README.md",
    "@@",
    "-旧内容",
    "+新内容",
    "*** End Patch",
    "```"
  ].join("\n");

  const response = fromChatCompletionsResponse({
    id: "chatcmpl_patch",
    created: 123,
    model: "glm-5",
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: patch }
      }
    ]
  }, {
    responseId: "resp_patch",
    repairTextToolCalls: true,
    availableToolNames: ["apply_patch"],
    availableTools: [
      {
        type: "function",
        function: {
          name: "apply_patch",
          parameters: {
            type: "object",
            properties: { patch: { type: "string" } },
            required: ["patch"]
          }
        }
      }
    ]
  });

  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].name, "apply_patch");
  assert.deepEqual(JSON.parse(response.output[0].arguments), {
    patch: [
      "*** Begin Patch",
      "*** Update File: README.md",
      "@@",
      "-旧内容",
      "+新内容",
      "*** End Patch"
    ].join("\n")
  });
});

test("可将 edit_file 别名修复为 apply_patch", () => {
  const response = fromChatCompletionsResponse({
    id: "chatcmpl_alias",
    created: 123,
    model: "glm-5",
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "{\"name\":\"edit_file\",\"arguments\":\"*** Begin Patch\\n*** End Patch\"}"
        }
      }
    ]
  }, {
    responseId: "resp_alias",
    repairTextToolCalls: true,
    availableToolNames: ["apply_patch"],
    availableTools: [
      {
        type: "function",
        function: {
          name: "apply_patch",
          parameters: {
            type: "object",
            properties: { input: { type: "string" } }
          }
        }
      }
    ]
  });

  assert.equal(response.output[0].name, "apply_patch");
  assert.deepEqual(JSON.parse(response.output[0].arguments), {
    input: "*** Begin Patch\n*** End Patch"
  });
});

test("保留 function_call 和 function_call_output 的 call_id 顺序", () => {
  const messages = normalizeInputToMessages([
    { type: "message", role: "user", content: "查目录" },
    {
      type: "function_call",
      call_id: "call_1",
      name: "shell",
      arguments: "{\"cmd\":\"ls\"}"
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "package.json\nsrc"
    }
  ]);

  assert.deepEqual(messages, [
    { role: "user", content: "查目录" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" }
        }
      ]
    },
    { role: "tool", tool_call_id: "call_1", content: "package.json\nsrc" }
  ]);
});

test("把 Chat tool_calls 映射回 Responses function_call", () => {
  const response = fromChatCompletionsResponse({
    id: "chatcmpl_1",
    created: 123,
    model: "gpt-4.1-mini",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: {
                name: "shell",
                arguments: "{\"cmd\":\"pwd\"}"
              }
            }
          ]
        }
      }
    ]
  });

  assert.deepEqual(response.output, [
    {
      type: "function_call",
      id: "call_abc",
      call_id: "call_abc",
      name: "shell",
      arguments: "{\"cmd\":\"pwd\"}",
      status: "completed"
    }
  ]);
});

test("Codex 内建工具默认转换为 function proxy，无法代理的原生工具严格模式报错", () => {
  const warnings = [];
  const tools = mapTools([{ type: "web_search" }], { warnings });

  assert.equal(tools.length, 1);
  assert.equal(tools[0].function.name, "web_search");
  assert.match(warnings[0], /转换为 function proxy/);

  assert.throws(
    () => mapTools([{ type: "image_generation" }], { onUnsupportedNativeTool: "error" }),
    UnsupportedNativeToolError
  );
});

test("Codex custom apply_patch 转为结构化 proxy functions", () => {
  const { chatRequest, toolContext } = toChatCompletionsRequest({
    model: "glm-5",
    input: "改 README",
    tools: [
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply patch",
        format: { type: "grammar", definition: "begin_patch end_patch add_hunk" }
      }
    ]
  }, { injectCodexBehavior: false });

  const names = chatRequest.tools.map((tool) => tool.function.name);
  assert.deepEqual(names, [
    "apply_patch_add_file",
    "apply_patch_delete_file",
    "apply_patch_update_file",
    "apply_patch_replace_file",
    "apply_patch_batch"
  ]);
  assert.equal(toolContext.customTools.get("apply_patch_batch").kind, "apply_patch");
});

test("apply_patch proxy tool_call 回映射为 custom_tool_call", () => {
  const toolContext = buildCodexToolContext([
    { type: "custom", name: "apply_patch", format: { definition: "begin_patch end_patch" } }
  ]);

  const response = fromChatCompletionsResponse({
    id: "chatcmpl_patch_proxy",
    created: 123,
    model: "glm-5",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [
            {
              id: "call_patch",
              type: "function",
              function: {
                name: "apply_patch_update_file",
                arguments: JSON.stringify({
                  path: "README.md",
                  hunks: [{ lines: [{ op: "remove", text: "旧" }, { op: "add", text: "新" }] }]
                })
              }
            }
          ]
        }
      }
    ]
  }, { responseId: "resp_patch_proxy", toolContext });

  assert.equal(response.output[0].type, "custom_tool_call");
  assert.equal(response.output[0].name, "apply_patch");
  assert.equal(response.output[0].input, [
    "*** Begin Patch",
    "*** Update File: README.md",
    "@@",
    "-旧",
    "+新",
    "*** End Patch"
  ].join("\n"));
});

test("namespace 工具扁平化给上游，返回时还原 namespace", () => {
  const request = {
    model: "glm-5",
    input: "列文件",
    tools: [
      {
        type: "namespace",
        name: "mcp__server__",
        tools: [
          {
            type: "function",
            name: "list_files",
            description: "列文件",
            parameters: { type: "object", properties: {} }
          }
        ]
      }
    ]
  };

  const { chatRequest, toolContext } = toChatCompletionsRequest(request, { injectCodexBehavior: false });
  assert.equal(chatRequest.tools[0].function.name, "mcp__server__list_files");

  const response = fromChatCompletionsResponse({
    id: "chatcmpl_ns",
    created: 123,
    model: "glm-5",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [
            {
              id: "call_ns",
              type: "function",
              function: { name: "mcp__server__list_files", arguments: "{}" }
            }
          ]
        }
      }
    ]
  }, { responseId: "resp_ns", toolContext });

  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].name, "list_files");
  assert.equal(response.output[0].namespace, "mcp__server__");
});

test("支持 previous_response_id/conversation 有状态引用", () => {
  const { conversationId } = toChatCompletionsRequest({
    model: "gpt-4.1-mini",
    previous_response_id: "resp_123",
    input: "继续"
  });
  // conversationId 用于 session 关联，不用于对话历史存储
  assert.equal(typeof conversationId, 'string', '应该返回 conversationId');
});

test("支持国产模型常见 OpenAI-compatible base url 拼接", () => {
  assert.equal(
    resolveChatCompletionsUrl("https://dashscope.aliyuncs.com/compatible-mode/v1"),
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
  );
  assert.equal(
    resolveChatCompletionsUrl("https://qianfan.baidubce.com/v2/coding"),
    "https://qianfan.baidubce.com/v2/coding/chat/completions"
  );
  assert.equal(
    resolveChatCompletionsUrl("https://api.example.com/v1/chat/completions"),
    "https://api.example.com/v1/chat/completions"
  );
});

test("createStreamConverter 把 Chat delta 转为 Responses SSE 事件", () => {
  const converter = createStreamConverter("resp_test", "glm-5");

  // 第一个 chunk：开始 + 文本内容
  let events = converter.processChunk({
    id: "chatcmpl_1",
    choices: [{ index: 0, delta: { content: "你好，" } }]
  });

  const types = events.map((e) => e.type);
  assert.ok(types.includes("response.created"));
  assert.ok(types.includes("response.output_item.added"));
  assert.ok(types.includes("response.content_part.added"));
  assert.ok(types.includes("response.output_text.delta"));
  assert.equal(events[0].response.background, false);
  assert.equal(events[0].response.service_tier, "auto");
  assert.match(events.find((e) => e.type === "response.output_item.added").item.id, /^msg_/);
  assert.equal(events.find((e) => e.type === "response.output_text.delta").item_id.startsWith("msg_"), true);

  // 第二个 chunk：继续文本
  events = converter.processChunk({
    id: "chatcmpl_1",
    choices: [{ index: 0, delta: { content: "当前目录" } }]
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "response.output_text.delta");

  // 最后一个 chunk：结束
  events = converter.processChunk({
    id: "chatcmpl_1",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
  });
  const finalTypes = events.map((e) => e.type);
  assert.ok(finalTypes.includes("response.content_part.done"));
  assert.ok(finalTypes.includes("response.output_item.done"));
  assert.ok(finalTypes.includes("response.completed"));
});

test("createStreamConverter 跨 chunk 隐藏 think 内容", () => {
  const converter = createStreamConverter("resp_think", "glm-5");

  let events = converter.processChunk({
    choices: [{ index: 0, delta: { content: "<thi" } }]
  });
  assert.equal(events.filter((e) => e.type === "response.output_text.delta").length, 0);

  events = converter.processChunk({
    choices: [{ index: 0, delta: { content: "nk>草稿</think>答案" } }]
  });

  const textEvents = events.filter((e) => e.type === "response.output_text.delta");
  assert.equal(textEvents.length, 1);
  assert.equal(textEvents[0].delta, "答案");
});


test("createStreamConverter 处理流式 tool_calls", () => {
  const converter = createStreamConverter("resp_tool", "glm-5");

  // 第一个 delta：工具调用 id
  let events = converter.processChunk({
    id: "chatcmpl_2",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: "call_x1", type: "function", function: { name: "shell", arguments: "" } }
          ]
        }
      }
    ]
  });
  // 应该有 response.created 和 output_item.added
  const addedEvents = events.filter((e) => e.type === "response.output_item.added");
  assert.ok(addedEvents.length > 0);
  assert.equal(addedEvents[0].item.type, "function_call");
  assert.equal(addedEvents[0].item.name, "shell");
  assert.match(addedEvents[0].item.id, /^fc_/);
  assert.equal(addedEvents[0].item.call_id, "call_x1");

  // 参数分片
  events = converter.processChunk({
    id: "chatcmpl_2",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: '{"cmd":"ls"}' } }
          ]
        }
      }
    ]
  });
  const argEvents = events.filter((e) => e.type === "response.function_call_arguments.delta");
  assert.ok(argEvents.length > 0);
  assert.equal(argEvents[0].call_id, "call_x1");
  assert.match(argEvents[0].item_id, /^fc_/);
  assert.equal(typeof argEvents[0].obfuscation, "string");
  assert.equal(argEvents[0].delta, '{"cmd":"ls"}');

  // 结束
  events = converter.processChunk({
    id: "chatcmpl_2",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  });
  const doneTypes = events.map((e) => e.type);
  assert.ok(doneTypes.includes("response.function_call_arguments.done"));
  assert.ok(doneTypes.includes("response.output_item.done"));
  assert.ok(doneTypes.includes("response.completed"));
});

test("createStreamConverter 为缺失 id 的流式 tool_call 兜底", () => {
  const converter = createStreamConverter("resp_tool_missing", "glm-5");

  const events = converter.processChunk({
    id: "chatcmpl_3",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, type: "function", function: { name: "shell", arguments: "{\"cmd\":\"pwd\"}" } }
          ]
        }
      }
    ]
  });

  const added = events.find((e) => e.type === "response.output_item.added" && e.item?.type === "function_call");
  assert.equal(added.item.call_id, "call_resp_tool_missing_0");
  assert.match(added.item.id, /^fc_/);
});

test("createStreamConverter 对 custom apply_patch 输出官方 custom_tool_call 事件", () => {
  const toolContext = buildCodexToolContext([
    { type: "custom", name: "apply_patch", format: { definition: "begin_patch end_patch" } }
  ]);
  const converter = createStreamConverter("resp_custom", "glm-5", { toolContext });

  let events = converter.processChunk({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_patch",
          type: "function",
          function: {
            name: "apply_patch_update_file",
            arguments: JSON.stringify({
              path: "README.md",
              hunks: [{ lines: [{ op: "remove", text: "旧" }, { op: "add", text: "新" }] }]
            })
          }
        }]
      }
    }]
  });

  const added = events.find((event) => event.type === "response.output_item.added");
  assert.equal(added.item.type, "custom_tool_call");
  assert.match(added.item.id, /^ctc_/);
  assert.equal(added.item.call_id, "call_patch");

  events = converter.processChunk({
    choices: [{ delta: {}, finish_reason: "tool_calls" }]
  });
  const delta = events.find((event) => event.type === "response.custom_tool_call_input.delta");
  const done = events.find((event) => event.type === "response.custom_tool_call_input.done");
  assert.match(delta.item_id, /^ctc_/);
  // delta 拆成 12 字符小段，拼接后应该包含完整 patch
  const allDeltas = events.filter((event) => event.type === "response.custom_tool_call_input.delta");
  assert.ok(allDeltas.length > 1, `应该拆成多个 delta，实际 ${allDeltas.length}`);
  const joined = allDeltas.map((e) => e.delta).join("");
  assert.match(joined, /\*\*\* Begin Patch/);
  assert.match(done.input, /\*\*\* Update File: README\.md/);
});

// ── 工具调用验证与重试测试 ──

test("validateToolCalls 检测非法 JSON 参数", () => {
  const issues = validateToolCalls([
    {
      type: "function_call",
      id: "call_1",
      call_id: "call_1",
      name: "shell",
      arguments: "{invalid json",
      status: "completed"
    }
  ], ["shell"]);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].name, "shell");
  assert.match(issues[0].description, /不是合法 JSON/);
});

test("validateToolCalls 检测工具名不存在", () => {
  const issues = validateToolCalls([
    {
      type: "function_call",
      id: "call_2",
      call_id: "call_2",
      name: "nonexistent_tool",
      arguments: "{}",
      status: "completed"
    }
  ], ["shell", "apply_patch"]);

  assert.equal(issues.length, 1);
  assert.match(issues[0].description, /不在可用工具列表中/);
});

test("validateToolCalls 检测缺少 arguments", () => {
  const issues = validateToolCalls([
    {
      type: "function_call",
      id: "call_3",
      call_id: "call_3",
      name: "shell",
      status: "completed"
    }
  ], ["shell"]);

  assert.equal(issues.length, 1);
  assert.match(issues[0].description, /缺少 arguments/);
});

test("validateToolCalls 对合法工具调用返回空列表", () => {
  const issues = validateToolCalls([
    {
      type: "function_call",
      id: "call_4",
      call_id: "call_4",
      name: "shell",
      arguments: '{"cmd":"ls"}',
      status: "completed"
    }
  ], ["shell"]);

  assert.equal(issues.length, 0);
});

test("validateToolCalls 忽略非 function_call 项", () => {
  const issues = validateToolCalls([
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      content: [{ type: "output_text", text: "好的" }]
    }
  ], ["shell"]);

  assert.equal(issues.length, 0);
});

test("buildRetryMessages 构建修正请求", () => {
  const originalMessages = [
    { role: "system", content: "你是一个助手" },
    { role: "user", content: "帮我执行 ls" }
  ];

  const issues = [
    { callId: "call_bad", name: "shell", description: "参数不是合法 JSON" }
  ];

  const retryMessages = buildRetryMessages(originalMessages, [
    {
      type: "function_call",
      id: "call_bad",
      call_id: "call_bad",
      name: "shell",
      arguments: "{broken",
      status: "completed"
    }
  ], issues);

  assert.equal(retryMessages.length, 4);
  assert.equal(retryMessages[0].role, "system");
  assert.equal(retryMessages[1].role, "user");
  assert.equal(retryMessages[2].role, "assistant");
  assert.equal(retryMessages[2].tool_calls[0].function.name, "shell");
  assert.equal(retryMessages[3].role, "user");
  assert.match(retryMessages[3].content, /修正后重新输出/);
});

test("buildRetryMessages 同时处理文本和工具调用", () => {
  const retryMessages = buildRetryMessages(
    [{ role: "user", content: "test" }],
    [
      { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "好的，我来执行" }] },
      { type: "function_call", id: "c1", call_id: "c1", name: "shell", arguments: "{bad", status: "completed" }
    ],
    [{ callId: "c1", name: "shell", description: "参数不是合法 JSON" }]
  );

  assert.equal(retryMessages[1].role, "assistant");
  assert.ok(retryMessages[1].content);
  assert.ok(retryMessages[1].tool_calls);
});

// ── 混合输出清洗测试 ──

test("混合输出时清洗废话文本", () => {
  const response = fromChatCompletionsResponse({
    id: "chatcmpl_mixed",
    created: 123,
    model: "glm-5",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "好的，我来帮你执行这个命令。",
        tool_calls: [{
          id: "call_m1",
          type: "function",
          function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" }
        }]
      }
    }]
  }, { responseId: "resp_mixed" });

  // 废话文本应该被清洗掉，output 只有 function_call
  const messages = response.output.filter(o => o.type === "message");
  const toolCalls = response.output.filter(o => o.type === "function_call");

  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "shell");
  // 纯废话被清除，不再输出 message
  assert.equal(messages.length, 0);
});

test("混合输出时保留有实质信息的文本", () => {
  const response = fromChatCompletionsResponse({
    id: "chatcmpl_mixed2",
    created: 123,
    model: "glm-5",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "测试结果显示有 2 个失败用例，需要修复 src/utils.js 中的边界检查。",
        tool_calls: [{
          id: "call_m2",
          type: "function",
          function: { name: "apply_patch", arguments: "{\"patch\":\"*** Begin Patch\\n*** End Patch\"}" }
        }]
      }
    }]
  }, { responseId: "resp_mixed2" });

  const messages = response.output.filter(o => o.type === "message");
  const toolCalls = response.output.filter(o => o.type === "function_call");

  assert.equal(toolCalls.length, 1);
  // 有实质信息的文本被保留
  assert.equal(messages.length, 1);
  assert.match(messages[0].content[0].text, /2 个失败用例/);
});

test("纯文本无工具调用时不清洗", () => {
  const response = fromChatCompletionsResponse({
    id: "chatcmpl_pure",
    created: 123,
    model: "glm-5",
    choices: [{
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: "好的，我来帮你分析这个问题。首先需要看一下代码结构。"
      }
    }]
  }, { responseId: "resp_pure" });

  const messages = response.output.filter(o => o.type === "message");
  assert.equal(messages.length, 1);
  assert.match(messages[0].content[0].text, /好的/);
});

test("buildCustomToolCallHistoryArguments 把 apply_patch 历史转成上游 proxy", () => {
  const ctx = buildCodexToolContext([
    { type: "custom", name: "apply_patch", format: { definition: "*** Begin Patch\n*** End Patch" } }
  ]);

  // 单操作 → add_file proxy
  const patch1 = "*** Begin Patch\n*** Add File: src/foo.js\n+console.log('hello');\n*** End Patch";
  const r1 = buildCustomToolCallHistoryArguments(ctx, "apply_patch", patch1);
  assert.equal(r1.name, "apply_patch_add_file");
  const args1 = JSON.parse(r1.arguments);
  assert.equal(args1.path, "src/foo.js");
  assert.ok(args1.content.includes("console.log"));

  // 多操作 → batch proxy
  const patch2 = [
    "*** Begin Patch",
    "*** Add File: a.js\n+aaa",
    "*** Delete File: b.js",
    "*** End Patch"
  ].join("\n");
  const r2 = buildCustomToolCallHistoryArguments(ctx, "apply_patch", patch2);
  assert.equal(r2.name, "apply_patch_batch");
  const args2 = JSON.parse(r2.arguments);
  assert.ok(Array.isArray(args2.operations));
  assert.equal(args2.operations.length, 2);
});

test("replayCustomToolCall 简化版回放不依赖 toolContext", () => {
  const patch = "*** Begin Patch\n*** Delete File: old.js\n*** End Patch";
  const r = replayCustomToolCall("apply_patch", patch);
  assert.equal(r.name, "apply_patch_delete_file");
  const args = JSON.parse(r.arguments);
  assert.equal(args.path, "old.js");

  // 非 apply_patch 工具 → 直接包装 input
  const r2 = replayCustomToolCall("web_search", "query text");
  assert.equal(r2.name, "web_search");
  const args2 = JSON.parse(r2.arguments);
  assert.equal(args2.input, "query text");
});

test("stream 请求自动加 stream_options.include_usage", () => {
  const { chatRequest } = toChatCompletionsRequest({
    model: "glm-5",
    input: [{ type: "message", role: "user", content: "hi" }],
    stream: true
  });
  assert.deepEqual(chatRequest.stream_options, { include_usage: true });
});

test("非 stream 请求不加 stream_options", () => {
  const { chatRequest } = toChatCompletionsRequest({
    model: "glm-5",
    input: [{ type: "message", role: "user", content: "hi" }]
  });
  assert.equal(chatRequest.stream_options, undefined);
});

test("tool parameters 自动补齐 required/type/properties", () => {
  const { chatRequest } = toChatCompletionsRequest({
    model: "glm-5",
    input: [{ type: "message", role: "user", content: "hi" }],
    tools: [{
      type: "function",
      name: "test_tool",
      description: "desc",
      parameters: { description: "missing all fields" }
    }]
  });
  const params = chatRequest.tools[0].function.parameters;
  assert.equal(params.type, "object");
  assert.deepEqual(params.properties, {});
  assert.deepEqual(params.required, []);
  assert.equal(params.description, "missing all fields");
});

test("reasoning.effort 映射到上游格式", () => {
  const { chatRequest: r1 } = toChatCompletionsRequest({
    model: "glm-5",
    input: [{ type: "message", role: "user", content: "hi" }],
    reasoning: { effort: "medium" }
  });
  assert.equal(r1.reasoning_effort, "medium");

  const { chatRequest: r2 } = toChatCompletionsRequest({
    model: "glm-5",
    input: [{ type: "message", role: "user", content: "hi" }],
    reasoning: { effort: "none" }
  });
  assert.equal(r2.reasoning_effort, "none");

  const { chatRequest: r3 } = toChatCompletionsRequest({
    model: "glm-5",
    input: [{ type: "message", role: "user", content: "hi" }],
    reasoning: { effort: "xhigh" }
  });
  assert.equal(r3.reasoning_effort, "high");
});

test("local_shell proxy tool_call 回映射为 custom_tool_call", () => {
  const toolContext = buildCodexToolContext([
    { type: "local_shell" }
  ]);

  const response = fromChatCompletionsResponse({
    id: "chatcmpl_shell",
    created: 123,
    model: "glm-5",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_shell",
          type: "function",
          function: { name: "local_shell", arguments: JSON.stringify({ command: "ls -la" }) }
        }]
      }
    }]
  }, { responseId: "resp_shell", toolContext });

  assert.equal(response.output[0].type, "custom_tool_call");
  assert.equal(response.output[0].name, "local_shell");
  assert.equal(response.output[0].input, JSON.stringify({ command: "ls -la" }));
});

test("local_shell_call history 转回 shell 代理工具", () => {
  const messages = normalizeInputToMessages([
    { type: "local_shell_call", call_id: "c1", action: { command: "pwd" }, status: "completed" },
    { type: "local_shell_call_output", call_id: "c1", output: "/Users/test" }
  ]);
  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].tool_calls[0].function.name, "shell");
  assert.equal(messages[1].role, "tool");
  assert.equal(messages[1].content, "/Users/test");
});

test("apply_patch_call history 转回 apply_patch 代理工具", () => {
  const toolContext = buildCodexToolContext([
    { type: "custom", name: "apply_patch", format: { definition: "begin_patch end_patch" } }
  ]);
  const messages = normalizeInputToMessages([
    {
      type: "apply_patch_call", call_id: "c2", name: "apply_patch",
      operation: { type: "create_file", path: "new.js", diff: "content" },
      status: "completed"
    },
    { type: "apply_patch_call_output", call_id: "c2", output: "ok" }
  ], { toolContext });
  assert.equal(messages[0].role, "assistant");
  assert.ok(messages[0].tool_calls[0].function.name.includes("apply_patch"));
  assert.equal(messages[1].role, "tool");
  assert.equal(messages[1].content, "ok");
});
