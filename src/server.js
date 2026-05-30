#!/usr/bin/env node
import http from "node:http";
import { stdin, stdout, stderr, exit } from "node:process";
import { pathToFileURL } from "node:url";
import {
  createStreamConverter,
  fromChatCompletionsResponse,
  toChatCompletionsRequest
} from "./adapter.js";

const DEFAULT_PORT = 8787;

async function main() {
  const config = readConfig(process.argv.slice(2));
  const server = http.createServer((request, response) => {
    handleRequest(request, response, config).catch((error) => {
      writeJson(response, error.statusCode ?? 500, {
        error: {
          message: error.message,
          type: error.type ?? "bridge_error"
        }
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

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { ok: true });
    return;
  }

  // Codex 启动时会请求 /v1/models，返回基础模型列表
  if (request.method === "GET" && url.pathname === "/v1/models") {
    const model = config.modelOverride ?? "default";
    writeJson(response, 200, {
      object: "list",
      models: [
        { id: model, slug: model, display_name: model, object: "model", created: Date.now(), owned_by: "bridge" }
      ]
    });
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/v1/responses") {
    writeJson(response, 404, {
      error: {
        message: "只支持 POST /v1/responses",
        type: "not_found"
      }
    });
    return;
  }

  const responsesRequest = await readJsonBody(request);
  const { chatRequest, warnings } = toChatCompletionsRequest(responsesRequest, {
    modelOverride: config.modelOverride,
    onUnsupportedNativeTool: config.strictNativeTools ? "error" : "warn"
  });

  if (responsesRequest.stream) {
    return handleStreamRequest(response, config, chatRequest, warnings);
  }

  // 非流式路径
  const upstreamResponse = await fetch(config.chatCompletionsUrl, {
    method: "POST",
    headers: buildUpstreamHeaders(request, config),
    body: JSON.stringify(chatRequest)
  });

  const upstreamBodyText = await upstreamResponse.text();
  const upstreamBody = parseJsonOrRaw(upstreamBodyText);

  if (!upstreamResponse.ok) {
    writeJson(response, upstreamResponse.status, {
      error: {
        message: "上游 Chat Completions 请求失败",
        type: "upstream_error",
        upstream_status: upstreamResponse.status,
        upstream: upstreamBody
      }
    });
    return;
  }

  const responsesBody = fromChatCompletionsResponse(upstreamBody);
  if (warnings.length > 0) {
    responsesBody.bridge_warnings = warnings;
  }

  writeJson(response, 200, responsesBody);
}

async function handleStreamRequest(response, config, chatRequest, warnings) {
  chatRequest.stream = true;
  chatRequest.stream_options = { include_usage: true };

  const upstreamResponse = await fetch(config.chatCompletionsUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.upstreamApiKey}` },
    body: JSON.stringify(chatRequest)
  });

  if (!upstreamResponse.ok) {
    const bodyText = await upstreamResponse.text();
    writeJson(response, upstreamResponse.status, {
      error: {
        message: "上游 Chat Completions 流式请求失败",
        type: "upstream_error",
        upstream_status: upstreamResponse.status,
        upstream: parseJsonOrRaw(bodyText)
      }
    });
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });

  const responseId = `resp_${Date.now()}`;
  const converter = createStreamConverter(responseId, chatRequest.model);

  if (warnings.length > 0) {
    for (const w of warnings) {
      response.write(`data: ${JSON.stringify({ type: "bridge.warning", warning: w })}\n\n`);
    }
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        const events = converter.processChunk(chunk);
        for (const event of events) {
          stderr.write(`[bridge] event: ${event.type}\n`);
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      }
    }
  } catch (err) {
    stderr.write(`流式转发异常：${err.message}\n`);
  } finally {
    response.end();
  }
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
    /\/v\d+(\/.*)?$/.test(path) ||
    path.endsWith("/coding") ||
    path.endsWith("/compatible-mode/v1");

  url.pathname = looksLikeOpenAiCompatibleBase
    ? `${path}/chat/completions`
    : `${path}/v1/chat/completions`;

  return url.toString();
}

function readConfig(argv) {
  const args = parseArgs(argv);
  const baseUrl = args.upstreamBaseUrl ?? process.env.UPSTREAM_BASE_URL ?? process.env.OPENAI_BASE_URL;

  return {
    host: args.host ?? process.env.BRIDGE_HOST ?? "127.0.0.1",
    port: Number(args.port ?? process.env.PORT ?? DEFAULT_PORT),
    upstreamApiKey: args.upstreamApiKey ?? process.env.UPSTREAM_API_KEY ?? process.env.OPENAI_API_KEY,
    chatCompletionsUrl: args.chatCompletionsUrl ?? resolveChatCompletionsUrl(baseUrl),
    modelOverride: args.model ?? process.env.UPSTREAM_MODEL,
    strictNativeTools: args.strictNativeTools
  };
}

function parseArgs(argv) {
  const args = { strictNativeTools: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    else if (arg === "--port") args.port = argv[++index];
    else if (arg === "--upstream-base-url") args.upstreamBaseUrl = argv[++index];
    else if (arg === "--chat-completions-url") args.chatCompletionsUrl = argv[++index];
    else if (arg === "--upstream-api-key") args.upstreamApiKey = argv[++index];
    else if (arg === "--model") args.model = argv[++index];
    else if (arg === "--strict-native-tools") args.strictNativeTools = true;
    else throw new Error(`未知参数：${arg}`);
  }

  return args;
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
  const authorization = config.upstreamApiKey
    ? `Bearer ${config.upstreamApiKey}`
    : request.headers.authorization;

  if (authorization) headers.authorization = authorization;
  return headers;
}

function parseJsonOrRaw(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    stderr.write(`${error.message}\n`);
    exit(1);
  });
}
