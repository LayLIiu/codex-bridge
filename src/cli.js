#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { stdin, stdout, stderr, exit } from "node:process";
import { fromChatCompletionsResponse, toChatCompletionsRequest } from "./adapter.js";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = await readJsonInput(args.file);
  const { chatRequest, warnings } = toChatCompletionsRequest(input, {
    onUnsupportedNativeTool: args.strictNativeTools ? "error" : "warn"
  });

  for (const warning of warnings) {
    stderr.write(`[warn] ${warning}\n`);
  }

  if (args.printOnly) {
    stdout.write(`${JSON.stringify(chatRequest, null, 2)}\n`);
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 OPENAI_API_KEY 环境变量");
  }

  const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(chatRequest)
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = { raw: bodyText };
  }

  if (!response.ok) {
    throw new Error(`OpenAI API 请求失败：HTTP ${response.status} ${JSON.stringify(body)}`);
  }

  stdout.write(`${JSON.stringify(fromChatCompletionsResponse(body), null, 2)}\n`);
}

function parseArgs(argv) {
  const args = {
    file: undefined,
    printOnly: false,
    strictNativeTools: false
  };

  for (const arg of argv) {
    if (arg === "--print") {
      args.printOnly = true;
    } else if (arg === "--strict-native-tools") {
      args.strictNativeTools = true;
    } else if (!args.file) {
      args.file = arg;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  return args;
}

async function readJsonInput(file) {
  const text = file ? await readFile(file, "utf8") : await readStdin();
  return JSON.parse(text);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((error) => {
  stderr.write(`${error.message}\n`);
  exit(1);
});
