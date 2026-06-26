import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { handleRequest } from "../src/server.js";

test("bridge 把 /v1/responses 请求转到上游 Chat Completions 并转回 function_call", async (t) => {
  let receivedChatRequest;

  const upstream = http.createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    receivedChatRequest = await readJson(request);

    writeJson(response, 200, {
      id: "chatcmpl_local",
      created: 123,
      model: receivedChatRequest.model,
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "call_local_1",
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
  });

  await listen(upstream);
  t.after(() => upstream.close());

  const bridge = http.createServer((request, response) => {
    handleRequest(request, response, {
      chatCompletionsUrl: `${serverUrl(upstream)}/v1/chat/completions`,
      upstreamApiKey: "test-key",
      strictNativeTools: false
    }).catch((error) => {
      writeJson(response, 500, { error: error.message });
    });
  });

  await listen(bridge);
  t.after(() => bridge.close());

  const response = await fetch(`${serverUrl(bridge)}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-model-name",
      input: [{ type: "message", role: "user", content: "执行 pwd" }],
      tools: [
        {
          type: "function",
          name: "shell",
          parameters: { type: "object", properties: {} }
        }
      ]
    })
  });

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(receivedChatRequest.model, "codex-model-name");
  assert.equal(receivedChatRequest.messages[0].role, "system");
  assert.match(receivedChatRequest.messages[0].content, /Codex Bridge/);
  assert.equal(receivedChatRequest.messages[1].content, "执行 pwd");
  assert.equal(receivedChatRequest.tools[0].function.name, "shell");
  assert.deepEqual(body.output, [
    {
      type: "function_call",
      id: "call_local_1",
      call_id: "call_local_1",
      name: "shell",
      arguments: "{\"cmd\":\"pwd\"}",
      status: "completed"
    }
  ]);
});

test("bridge 透传客户端的模型名（不覆盖）", async (t) => {
  let receivedChatRequest;

  const upstream = http.createServer(async (request, response) => {
    receivedChatRequest = await readJson(request);
    writeJson(response, 200, {
      id: "chatcmpl_model",
      created: 123,
      model: receivedChatRequest.model,
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }]
    });
  });

  await listen(upstream);
  t.after(() => upstream.close());

  const bridge = http.createServer((request, response) => {
    handleRequest(request, response, {
      chatCompletionsUrl: `${serverUrl(upstream)}/v1/chat/completions`,
      upstreamApiKey: "test-key",
      strictNativeTools: false
    }).catch((error) => {
      writeJson(response, 500, { error: error.message });
    });
  });

  await listen(bridge);
  t.after(() => bridge.close());

  const response = await fetch(`${serverUrl(bridge)}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-model-name",
      instructions: "保持简洁",
      input: "你好"
    })
  });

  assert.equal(response.status, 200);
  assert.equal(receivedChatRequest.model, "codex-model-name");
  assert.deepEqual(receivedChatRequest.messages, [
    { role: "system", content: "保持简洁" },
    { role: "user", content: "你好" }
  ]);
});

test("bridge 支持查询已创建的 response", async (t) => {
  const upstream = http.createServer(async (request, response) => {
    await readJson(request);
    writeJson(response, 200, {
      id: "chatcmpl_lookup",
      created: 123,
      model: "glm-5",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "可以查询" } }]
    });
  });

  await listen(upstream);
  t.after(() => upstream.close());

  const bridge = http.createServer((request, response) => {
    handleRequest(request, response, {
      chatCompletionsUrl: `${serverUrl(upstream)}/v1/chat/completions`,
      upstreamApiKey: "test-key",
      model: "glm-5",
      strictNativeTools: false
    }).catch((error) => {
      writeJson(response, 500, { error: error.message });
    });
  });

  await listen(bridge);
  t.after(() => bridge.close());

  const createResponse = await fetch(`${serverUrl(bridge)}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "codex-model-name", input: "你好" })
  });
  const created = await createResponse.json();

  const lookupResponse = await fetch(`${serverUrl(bridge)}/v1/responses/${created.id}`);
  const lookedUp = await lookupResponse.json();

  assert.equal(lookupResponse.status, 200);
  assert.equal(lookedUp.id, created.id);
  assert.equal(lookedUp.output_text, "可以查询");
});

test("bridge 对非法 JSON 返回 OpenAI 风格错误", async (t) => {
  const bridge = http.createServer((request, response) => {
    handleRequest(request, response, {
      chatCompletionsUrl: "http://127.0.0.1:1/v1/chat/completions",
      upstreamApiKey: "test-key",
      model: "glm-5",
      strictNativeTools: false
    }).catch((error) => {
      writeJson(response, 500, { error: error.message });
    });
  });

  await listen(bridge);
  t.after(() => bridge.close());

  const response = await fetch(`${serverUrl(bridge)}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{"
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.type, "invalid_request_error");
  assert.equal(body.error.code, "invalid_json");
});

test("bridge 流式工具轮会丢弃上游混入的过程文本，避免提前触发 assistant message", async (t) => {
  const upstream = http.createServer(async (request, response) => {
    await readJson(request);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    writeSse(response, {
      id: "chatcmpl_stream_tool_preface",
      model: "glm-5",
      choices: [{ index: 0, delta: { content: "我先检查一下项目。" }, finish_reason: null }]
    });
    writeSse(response, {
      id: "chatcmpl_stream_tool_preface",
      model: "glm-5",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_stream_1",
            type: "function",
            function: { name: "shell", arguments: "{\"cmd\":\"pwd\"}" }
          }]
        },
        finish_reason: null
      }]
    });
    writeSse(response, {
      id: "chatcmpl_stream_tool_preface",
      model: "glm-5",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
    });
    response.end("data: [DONE]\n\n");
  });

  await listen(upstream);
  t.after(() => upstream.close());

  const bridge = http.createServer((request, response) => {
    handleRequest(request, response, {
      chatCompletionsUrl: `${serverUrl(upstream)}/v1/chat/completions`,
      upstreamApiKey: "test-key",
      strictNativeTools: false
    }).catch((error) => {
      writeJson(response, 500, { error: error.message });
    });
  });

  await listen(bridge);
  t.after(() => bridge.close());

  const response = await fetch(`${serverUrl(bridge)}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-model-name",
      stream: true,
      input: [{ type: "message", role: "user", content: "看一下当前目录" }],
      tools: [
        {
          type: "function",
          name: "shell",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] }
        }
      ]
    })
  });

  const events = parseSseEvents(await response.text());
  const messageEvents = events.filter((event) => event.type === "response.output_item.added" && event.item?.type === "message");
  const textDeltas = events.filter((event) => event.type === "response.output_text.delta");
  const doneMessage = events.find((event) => event.type === "response.output_item.done" && event.item?.type === "message");
  const completed = events.find((event) => event.type === "response.completed");

  assert.equal(response.status, 200);
  assert.equal(messageEvents.length, 1);
  assert.equal(textDeltas.map((event) => event.delta).join(""), "我先检查一下项目。");
  assert.equal(doneMessage.item.phase, "tool_preface");
  assert.equal(completed.response.output.some((item) => item.type === "message"), false);
  assert.equal(completed.response.output.some((item) => item.type === "reasoning"), false);
  assert.equal(completed.response.output.find((item) => item.type === "function_call").name, "shell");
});

test("bridge 带工具列表的纯文本流式回复应在结束时发出 assistant message", async (t) => {
  const upstream = http.createServer(async (request, response) => {
    await readJson(request);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    writeSse(response, {
      id: "chatcmpl_stream_text_with_tools",
      model: "glm-5",
      choices: [{ index: 0, delta: { content: "你好！" }, finish_reason: null }]
    });
    writeSse(response, {
      id: "chatcmpl_stream_text_with_tools",
      model: "glm-5",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    });
    response.end("data: [DONE]\n\n");
  });

  await listen(upstream);
  t.after(() => upstream.close());

  const bridge = http.createServer((request, response) => {
    handleRequest(request, response, {
      chatCompletionsUrl: `${serverUrl(upstream)}/v1/chat/completions`,
      upstreamApiKey: "test-key",
      strictNativeTools: false
    }).catch((error) => {
      writeJson(response, 500, { error: error.message });
    });
  });

  await listen(bridge);
  t.after(() => bridge.close());

  const response = await fetch(`${serverUrl(bridge)}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-model-name",
      stream: true,
      input: [{ type: "message", role: "user", content: "你好" }],
      tools: [
        {
          type: "function",
          name: "shell",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] }
        }
      ]
    })
  });

  const events = parseSseEvents(await response.text());
  const textDeltas = events.filter((event) => event.type === "response.output_text.delta");
  const doneMessage = events.find((event) => event.type === "response.output_item.done" && event.item?.type === "message");
  const completed = events.find((event) => event.type === "response.completed");

  assert.equal(response.status, 200);
  assert.equal(textDeltas.map((event) => event.delta).join(""), "你好！");
  assert.equal(doneMessage.item.phase, "final_answer");
  assert.equal(completed.response.output_text, "你好！");
});

test("bridge 修复模型用文本输出的 JSON 工具调用", async (t) => {
  const upstream = http.createServer(async (request, response) => {
    await readJson(request);
    writeJson(response, 200, {
      id: "chatcmpl_repair",
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
    });
  });

  await listen(upstream);
  t.after(() => upstream.close());

  const bridge = http.createServer((request, response) => {
    handleRequest(request, response, {
      chatCompletionsUrl: `${serverUrl(upstream)}/v1/chat/completions`,
      upstreamApiKey: "test-key",
      model: "glm-5",
      strictNativeTools: false,
      repairTextToolCalls: true
    }).catch((error) => {
      writeJson(response, 500, { error: error.message });
    });
  });

  await listen(bridge);
  t.after(() => bridge.close());

  const response = await fetch(`${serverUrl(bridge)}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-model-name",
      input: "执行 pwd",
      tools: [
        {
          type: "function",
          name: "shell",
          parameters: { type: "object", properties: {} }
        }
      ]
    })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.output[0].type, "function_call");
  assert.equal(body.output[0].name, "shell");
  assert.equal(body.output[0].arguments, "{\"cmd\":\"pwd\"}");
});

test("bridge 修复模型输出的 patch 文本为 apply_patch 调用", async (t) => {
  const upstream = http.createServer(async (request, response) => {
    await readJson(request);
    writeJson(response, 200, {
      id: "chatcmpl_patch",
      created: 123,
      model: "glm-5",
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: [
              "```patch",
              "*** Begin Patch",
              "*** Update File: README.md",
              "@@",
              "-旧内容",
              "+新内容",
              "*** End Patch",
              "```"
            ].join("\n")
          }
        }
      ]
    });
  });

  await listen(upstream);
  t.after(() => upstream.close());

  const bridge = http.createServer((request, response) => {
    handleRequest(request, response, {
      chatCompletionsUrl: `${serverUrl(upstream)}/v1/chat/completions`,
      upstreamApiKey: "test-key",
      model: "glm-5",
      strictNativeTools: false,
      repairTextToolCalls: true
    }).catch((error) => {
      writeJson(response, 500, { error: error.message });
    });
  });

  await listen(bridge);
  t.after(() => bridge.close());

  const response = await fetch(`${serverUrl(bridge)}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-model-name",
      input: "修改 README",
      tools: [
        {
          type: "function",
          name: "apply_patch",
          parameters: {
            type: "object",
            properties: { patch: { type: "string" } }
          }
        }
      ]
    })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.output[0].type, "function_call");
  assert.equal(body.output[0].name, "apply_patch");
  assert.match(JSON.parse(body.output[0].arguments).patch, /\*\*\* Begin Patch/);
});

test("bridge 会把 custom_tool_call_output 传给上游，便于模型生成已完成收尾", async (t) => {
  let receivedChatRequest;

  const upstream = http.createServer(async (request, response) => {
    receivedChatRequest = await readJson(request);
    writeJson(response, 200, {
      id: "chatcmpl_patch_done",
      created: 123,
      model: receivedChatRequest.model,
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "README 已编辑完成。"
          }
        }
      ]
    });
  });

  await listen(upstream);
  t.after(() => upstream.close());

  const bridge = http.createServer((request, response) => {
    handleRequest(request, response, {
      chatCompletionsUrl: `${serverUrl(upstream)}/v1/chat/completions`,
      upstreamApiKey: "test-key",
      strictNativeTools: false
    }).catch((error) => {
      writeJson(response, 500, { error: error.message });
    });
  });

  await listen(bridge);
  t.after(() => bridge.close());

  const response = await fetch(`${serverUrl(bridge)}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-model-name",
      input: [
        {
          type: "custom_tool_call",
          id: "ctc_1",
          call_id: "ctc_1",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Update File: README.md\n@@\n-旧内容\n+新内容\n*** End Patch"
        },
        {
          type: "custom_tool_call_output",
          call_id: "ctc_1",
          output: "Success"
        }
      ],
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          format: { definition: "begin_patch end_patch" }
        }
      ]
    })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(receivedChatRequest.messages[0].role, "system");
  assert.equal(receivedChatRequest.messages[1].role, "assistant");
  assert.equal(receivedChatRequest.messages[1].tool_calls[0].id, "ctc_1");
  assert.equal(receivedChatRequest.messages[2].role, "tool");
  assert.equal(receivedChatRequest.messages[2].tool_call_id, "ctc_1");
  assert.equal(receivedChatRequest.messages[2].content, "Success");
  assert.equal(body.output_text, "README 已编辑完成。");
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server) {
  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function writeSse(response, body) {
  response.write(`data: ${JSON.stringify(body)}\n\n`);
}

function parseSseEvents(text) {
  return text
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) return null;
      const data = dataLine.slice(5).trim();
      if (!data || data === "[DONE]") return null;
      return JSON.parse(data);
    })
    .filter(Boolean);
}

test("bridge 自动重试畸形工具调用", async (t) => {
  let callCount = 0;

  const upstream = http.createServer(async (request, response) => {
    callCount++;
    const chatRequest = await readJson(request);

    if (callCount === 1) {
      // 第一次返回非法 JSON 参数
      writeJson(response, 200, {
        id: "chatcmpl_bad",
        created: 123,
        model: chatRequest.model,
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            tool_calls: [{
              id: "call_bad_1",
              type: "function",
              function: { name: "shell", arguments: "{broken" }
            }]
          }
        }]
      });
    } else {
      // 重试时返回合法参数
      writeJson(response, 200, {
        id: "chatcmpl_good",
        created: 123,
        model: chatRequest.model,
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            tool_calls: [{
              id: "call_good_1",
              type: "function",
              function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" }
            }]
          }
        }]
      });
    }
  });

  await listen(upstream);
  t.after(() => upstream.close());

  const bridge = http.createServer((request, response) => {
    handleRequest(request, response, {
      chatCompletionsUrl: `${serverUrl(upstream)}/v1/chat/completions`,
      upstreamApiKey: "test-key",
      modelOverride: "test-model",
      strictNativeTools: false,
      toolCallRetry: true,
      maxToolCallRetries: 1
    }).catch((error) => {
      writeJson(response, 500, { error: error.message });
    });
  });

  await listen(bridge);
  t.after(() => bridge.close());

  const resp = await fetch(`${serverUrl(bridge)}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-model-name",
      input: "列出文件",
      tools: [{
        type: "function",
        name: "shell",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] }
      }]
    })
  });

  const body = await resp.json();

  assert.equal(resp.status, 200);
  assert.equal(callCount, 2, "应该发两次请求（原始 + 重试）");
  assert.equal(body.output[0].type, "function_call");
  assert.equal(body.output[0].name, "shell");
  assert.equal(JSON.parse(body.output[0].arguments).cmd, "ls");
  assert.ok(body.bridge_warnings.some(w => /重试/.test(w)), "应该有重试警告");
});

test("bridge 不重试合法工具调用", async (t) => {
  let callCount = 0;

  const upstream = http.createServer(async (request, response) => {
    callCount++;
    const chatRequest = await readJson(request);

    writeJson(response, 200, {
      id: "chatcmpl_ok",
      created: 123,
      model: chatRequest.model,
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [{
            id: "call_ok_1",
            type: "function",
            function: { name: "shell", arguments: "{\"cmd\":\"pwd\"}" }
          }]
        }
      }]
    });
  });

  await listen(upstream);
  t.after(() => upstream.close());

  const bridge = http.createServer((request, response) => {
    handleRequest(request, response, {
      chatCompletionsUrl: `${serverUrl(upstream)}/v1/chat/completions`,
      upstreamApiKey: "test-key",
      modelOverride: "test-model",
      strictNativeTools: false,
      toolCallRetry: true,
      maxToolCallRetries: 1
    }).catch((error) => {
      writeJson(response, 500, { error: error.message });
    });
  });

  await listen(bridge);
  t.after(() => bridge.close());

  const resp = await fetch(`${serverUrl(bridge)}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-model-name",
      input: "当前目录",
      tools: [{
        type: "function",
        name: "shell",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] }
      }]
    })
  });

  assert.equal(resp.status, 200);
  assert.equal(callCount, 1, "合法工具调用不应该触发重试");
});

test("bridge 遇到 429 时按 Retry-After 重试", async (t) => {
  let callCount = 0;

  const upstream = http.createServer(async (request, response) => {
    callCount++;
    await readJson(request);

    if (callCount === 1) {
      response.writeHead(429, {
        "content-type": "application/json; charset=utf-8",
        "retry-after": "0.001"
      });
      response.end(JSON.stringify({ error: { message: "rate limited" } }));
      return;
    }

    writeJson(response, 200, {
      id: "chatcmpl_after_retry",
      created: 123,
      model: "glm-5",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "重试成功" } }]
    });
  });

  await listen(upstream);
  t.after(() => upstream.close());

  const bridge = http.createServer((request, response) => {
    handleRequest(request, response, {
      chatCompletionsUrl: `${serverUrl(upstream)}/v1/chat/completions`,
      upstreamApiKey: "test-key",
      model: "glm-5",
      strictNativeTools: false,
      upstreamMaxRetries: 1,
      upstreamRetryBaseDelayMs: 50,
      upstreamMaxRetryDelayMs: 50
    }).catch((error) => {
      writeJson(response, 500, { error: error.message });
    });
  });

  await listen(bridge);
  t.after(() => bridge.close());

  const resp = await fetch(`${serverUrl(bridge)}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "codex-model-name", input: "你好" })
  });
  const body = await resp.json();

  assert.equal(resp.status, 200);
  assert.equal(callCount, 2);
  assert.equal(body.output_text, "重试成功");
});

test("bridge 最终 429 时返回清晰的限流错误", async (t) => {
  const upstream = http.createServer(async (request, response) => {
    await readJson(request);
    response.writeHead(429, {
      "content-type": "application/json; charset=utf-8",
      "retry-after": "7"
    });
    response.end(JSON.stringify({ error: { message: "too many requests" } }));
  });

  await listen(upstream);
  t.after(() => upstream.close());

  const bridge = http.createServer((request, response) => {
    handleRequest(request, response, {
      chatCompletionsUrl: `${serverUrl(upstream)}/v1/chat/completions`,
      upstreamApiKey: "test-key",
      model: "glm-5",
      strictNativeTools: false,
      upstreamMaxRetries: 0
    }).catch((error) => {
      writeJson(response, 500, { error: error.message });
    });
  });

  await listen(bridge);
  t.after(() => bridge.close());

  const resp = await fetch(`${serverUrl(bridge)}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "codex-model-name", input: "你好" })
  });
  const body = await resp.json();

  assert.equal(resp.status, 429);
  assert.equal(body.error.type, "upstream_rate_limited");
  assert.equal(body.error.code, "upstream_rate_limited");
  assert.equal(body.error.retry_after, "7");
});
