# 小红书 / 博客文案

## 标题备选

1. 我做了一个 Codex Bridge，让 Codex 能接国产模型了
2. Codex Desktop + 国产大模型：终于跑通工具调用闭环
3. 一个本地桥接层，把 Responses API 翻译成 Chat Completions
4. 让 GLM / 通义千问 / 千帆进入 Codex 工作流
5. Codex Bridge 开源：给 Codex 接第三方模型的一层翻译器

## 小红书正文版本 A：自然分享

最近折腾 Codex Desktop 的时候发现一个问题：

Codex 走的是 OpenAI Responses API，但很多国产模型 / 第三方模型服务，暴露的是 Chat Completions API。

这两个协议不完全一样，尤其是工具调用、流式事件、function_call 这些地方，不能简单把 Base URL 一换就完事。

所以我写了一个本地 Bridge：

Codex Desktop → Bridge → 国产模型服务

它主要做几件事：

- 把 Responses API 转成 Chat Completions API
- 把上游模型的 tool_calls 转回 Codex 能识别的 function_call
- 支持流式输出
- 支持 apply_patch 文件编辑和 diff 体验
- 修复一些模型把工具调用写成普通文本的问题
- 对 429 / 5xx 做退避重试
- 写入 Codex 风格 Session JSONL

现在接 GLM、通义千问、百度千帆、自建 OpenAI-compatible 服务都方便很多。

它不是官方后端替代品，也不会把模型能力变成 GPT，但可以把 Codex 的工具调用工作流尽量接起来。

项目已开源：
https://github.com/LayLIiu/codex-bridge

如果你也在折腾 Codex + 国产模型，可以试试。

## 小红书正文版本 B：技术一点

做了一个 Codex Bridge，本质是一个本地协议转换层。

背景：

Codex Desktop 调用的是 `/v1/responses`，而很多国产模型服务只支持 `/v1/chat/completions`。

差异不只是 URL：

- message 结构不同
- tool call 结构不同
- 流式 SSE 事件不同
- `function_call_output` 回传方式不同
- `apply_patch` 这类工具要额外适配

Bridge 做的事就是：

1. 接收 Codex 的 Responses 请求
2. 转换成 Chat Completions 请求
3. 发给上游模型
4. 把 `content` / `tool_calls` 转回 Codex 的 Responses 事件
5. 让 Codex runtime 继续执行本地工具

现在已经支持：

- SSE 流式输出
- function tool 调用闭环
- apply_patch 文件编辑适配
- 文本 JSON 工具调用修复
- 工具调用畸形重试
- 429 限流退避
- Codex Session JSONL 持久化

默认还做了一个体验优化：工具调用前模型说的"我先看看项目结构"会显示出来，但不会被 Codex 当成最终总结提前折叠。

项目地址：
https://github.com/LayLIiu/codex-bridge

## 博客开头

我最近写了一个小项目：Codex Bridge。

它的目标很简单：让 Codex Desktop 能使用更多 OpenAI-compatible 的国产模型或自建模型服务。

Codex Desktop 本身使用的是 OpenAI Responses API，而国内很多模型服务实现的是 Chat Completions API。两者在普通聊天上看起来相似，但一旦进入 Codex 最重要的场景——工具调用、文件编辑、流式输出——差异就会变得非常明显。

Codex Bridge 就是放在两者之间的一个本地协议转换层。它负责把 Codex 发出的 Responses 请求转换为 Chat Completions 请求，再把模型返回的文本和工具调用转换回 Codex 能识别的 Responses 事件。

## 博客长文版

# Codex Bridge：让 Codex Desktop 接入国产模型的一层协议桥

最近我在折腾 Codex Desktop 接入第三方模型时，遇到了一个很典型的问题：很多国产模型服务都提供了 OpenAI-compatible 的 Chat Completions API，但 Codex Desktop 主要使用的是 OpenAI Responses API。

乍一看，这两个 API 都是"发消息，收回复"，但真正用到 Codex 的核心体验时，差异就会很明显：流式事件不一样，工具调用格式不一样，`function_call_output` 的回传方式也不一样。尤其是文件编辑、执行命令、工具调用这些场景，不能只靠换一个 Base URL 解决。

所以我写了 Codex Bridge。

它的定位很简单：一个跑在本地的协议转换层。

```
Codex Desktop -> Codex Bridge -> 上游 Chat Completions 模型
```

Bridge 接收 Codex 发出的 `/v1/responses` 请求，把它转换成上游模型能理解的 `/chat/completions` 请求。上游返回 `content` 或 `tool_calls` 后，Bridge 再把它转换回 Codex 能识别的 Responses 事件。

目前它已经支持：

- SSE 流式响应转换
- function tool 调用双向映射
- `apply_patch` 文件编辑适配
- 模型把工具调用写成文本 JSON 时自动修复
- 工具调用参数畸形时自动重试
- 上游 429 / 5xx 时退避重试
- Codex 风格 Session JSONL 持久化

我觉得最关键的不是"让 Codex 换一个模型聊天"，而是让第三方模型尽量进入 Codex 原本的工作流：能读文件、能执行命令、能改代码、能把工具结果带回下一轮推理。

当然，Bridge 不是官方后端，也不会把模型能力变成 GPT。它解决的是协议和体验适配问题，最终工具调用质量仍然取决于上游模型本身。

项目已经开源：

https://github.com/LayLIiu/codex-bridge

如果你也在尝试 Codex + 国产模型 / 自建模型，可以拿去试试。

## 博客结构建议

1. 背景：为什么 Codex 不能直接接很多国产模型
2. 核心问题：Responses API 和 Chat Completions API 的差异
3. 解决方案：本地 Bridge 协议转换
4. 工具调用：如何把 `tool_calls` 映射回 Codex 的 `function_call`
5. 文件编辑：为什么 `apply_patch` 是 Codex 体验的关键
6. 体验优化：工具过程文字、流式事件、429 重试
7. 局限：Bridge 不是官方后端，模型能力仍取决于上游
8. 使用方法：启动 Bridge，把 Codex Base URL 指向 `127.0.0.1:8787/v1`

## 标签

#Codex #AI编程 #国产大模型 #开源项目 #程序员日常 #AI工具 #通义千问 #GLM #百度千帆 #OpenAICompatible
