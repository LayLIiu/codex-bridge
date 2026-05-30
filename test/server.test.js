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
      modelOverride: "qwen-test",
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
  assert.equal(receivedChatRequest.model, "qwen-test");
  assert.equal(receivedChatRequest.messages[0].content, "执行 pwd");
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
