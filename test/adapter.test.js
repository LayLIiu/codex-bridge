import assert from "node:assert/strict";
import test from "node:test";
import {
  createStreamConverter,
  fromChatCompletionsResponse,
  mapTools,
  normalizeInputToMessages,
  toChatCompletionsRequest,
  UnsupportedNativeToolError
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
  });

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

test("原生工具默认降级为 warning，严格模式报错", () => {
  const warnings = [];
  const tools = mapTools([{ type: "web_search" }], { warnings });

  assert.deepEqual(tools, []);
  assert.match(warnings[0], /已跳过原生工具 web_search/);

  assert.throws(
    () => mapTools([{ type: "image_generation" }], { onUnsupportedNativeTool: "error" }),
    UnsupportedNativeToolError
  );
});

test("拒绝 previous_response_id/conversation 这类有状态引用", () => {
  assert.throws(
    () =>
      toChatCompletionsRequest({
        model: "gpt-4.1-mini",
        previous_response_id: "resp_123",
        input: "继续"
      }),
    /只支持 stateless/
  );
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
