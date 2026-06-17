# Codex Chat Completions Bridge 优化设计

## 1. 有状态对话支持

### 目标
支持 `previous_response_id` 和 `conversation` 参数，实现多轮对话。

### 设计方案
- 使用内存存储对话历史（可扩展到 Redis/数据库）
- 每个对话有唯一 ID
- 对话历史自动清理（LRU 策略）

### 实现细节
```javascript
class ConversationManager {
  constructor(maxSize = 1000, ttlMs = 3600000) {
    this.conversations = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  getConversation(id) {
    const conv = this.conversations.get(id);
    if (!conv) return null;
    if (Date.now() - conv.lastAccess > this.ttlMs) {
      this.conversations.delete(id);
      return null;
    }
    conv.lastAccess = Date.now();
    return conv;
  }

  createConversation(messages) {
    const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.conversations.set(id, {
      id,
      messages,
      lastAccess: Date.now()
    });
    this.cleanup();
    return id;
  }

  cleanup() {
    if (this.conversations.size <= this.maxSize) return;
    const entries = [...this.conversations.entries()]
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const toDelete = entries.slice(0, entries.length - this.maxSize);
    for (const [id] of toDelete) {
      this.conversations.delete(id);
    }
  }
}
```

## 2. 原生工具模拟

### 目标
将 `web_search`、`image_generation` 等原生工具转换为 function tools。

### 设计方案
```javascript
const NATIVE_TOOL_SIMULATIONS = {
  web_search: {
    type: "function",
    function: {
      name: "web_search",
      description: "搜索网络信息",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" }
        },
        required: ["query"]
      }
    }
  },
  image_generation: {
    type: "function",
    function: {
      name: "image_generation",
      description: "生成图片",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "图片描述" },
          size: { type: "string", enum: ["256x256", "512x512", "1024x1024"] }
        },
        required: ["prompt"]
      }
    }
  }
};
```

## 3. 配置增强

### 目标
支持 `.env` 文件和配置文件。

### 实现
```javascript
import dotenv from 'dotenv';
dotenv.config();

// 支持配置文件
const config = {
  port: process.env.PORT || 8787,
  host: process.env.BRIDGE_HOST || '127.0.0.1',
  upstreamBaseUrl: process.env.UPSTREAM_BASE_URL,
  upstreamApiKey: process.env.UPSTREAM_API_KEY,
  upstreamModel: process.env.UPSTREAM_MODEL,
  enableReasoning: process.env.BRIDGE_ENABLE_REASONING === '1'
};
```

## 4. Token 估算改进

### 目标
使用更精确的 token 估算算法。

### 实现
```javascript
function estimateTokens(text) {
  if (!text) return 0;
  // 中文字符大约 1 token/字
  // 英文单词大约 1 token/词
  // 代码大约 1 token/4 字符
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
  const otherChars = text.length - chineseChars - 
    (text.match(/[a-zA-Z]+/g) || []).join('').length;
  
  return chineseChars + englishWords + Math.ceil(otherChars / 4);
}
```

## 实施计划

1. **阶段 1**：实现有状态对话支持
2. **阶段 2**：实现原生工具模拟
3. **阶段 3**：配置增强
4. **阶段 4**：Token 估算改进
5. **阶段 5**：测试和文档更新
