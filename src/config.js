/**
 * 配置模块 - 支持环境变量和 .env 文件
 * 提供配置验证和默认值管理
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 默认配置
const DEFAULT_CONFIG = {
  // 服务器配置
  host: '127.0.0.1',
  port: 8787,
  
  // 上游配置（仅 upstreamBaseUrl 必填，model/key 由客户端提供）
  upstreamBaseUrl: '',
  upstreamApiKey: '',
  model: '',
  
  // 功能配置
  enableReasoning: false,
  strictNativeTools: false,
  simulateNativeTools: false,
  repairTextToolCalls: true,
  toolProgressMode: 'preface',
  
  // 对话管理配置
  conversationMaxSize: 1000,
  conversationTtlMs: 3600000,
  
  // Token 估算配置
  tokenEstimationEnabled: true,
  
  // 工具调用重试配置
  toolCallRetry: false,
  maxToolCallRetries: 0,

  // 上游限流/连接韧性配置
  upstreamMaxRetries: 1,
  upstreamRetryBaseDelayMs: 1000,
  upstreamMaxRetryDelayMs: 15000,
  upstreamConcurrency: 8
};

/**
 * 加载 .env 文件
 * @param {string} envPath - .env 文件路径
 * @returns {Object} 环境变量键值对
 */
export function loadEnvFile(envPath) {
  if (!envPath) {
    // 尝试查找常见的 .env 文件位置
    const possiblePaths = [
      '.env',
      '../.env',
      '../../.env'
    ];
    
    for (const path of possiblePaths) {
      const fullPath = resolve(process.cwd(), path);
      if (existsSync(fullPath)) {
        envPath = fullPath;
        break;
      }
    }
  }
  
  if (!envPath || !existsSync(envPath)) {
    return {};
  }
  
  try {
    const content = readFileSync(envPath, 'utf-8');
    const envVars = {};
    
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      
      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      // 解析 KEY=VALUE 格式
      const equalsIndex = trimmed.indexOf('=');
      if (equalsIndex === -1) continue;
      
      const key = trimmed.substring(0, equalsIndex).trim();
      let value = trimmed.substring(equalsIndex + 1).trim();
      
      // 移除引号
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      envVars[key] = value;
    }
    
    return envVars;
  } catch (error) {
    console.warn(`警告：无法加载 .env 文件 ${envPath}: ${error.message}`);
    return {};
  }
}

/**
 * 解析命令行参数
 * @param {Array} argv - 命令行参数数组
 * @returns {Object} 解析后的参数
 */
export function parseArgs(argv) {
  const args = {};
  
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    
    if (arg === '--host') {
      args.host = argv[++i];
    } else if (arg === '--port') {
      args.port = parseInt(argv[++i], 10);
    } else if (arg === '--upstream-base-url') {
      args.upstreamBaseUrl = argv[++i];
    } else if (arg === '--upstream-api-key') {
      args.upstreamApiKey = argv[++i];
    } else if (arg === '--model') {
      args.model = argv[++i];
    } else if (arg === '--enable-reasoning') {
      args.enableReasoning = true;
    } else if (arg === '--strict-native-tools') {
      args.strictNativeTools = true;
    } else if (arg === '--simulate-native-tools') {
      args.simulateNativeTools = true;
    } else if (arg === '--no-repair-text-tool-calls') {
      args.repairTextToolCalls = false;
    } else if (arg === '--tool-progress-mode') {
      args.toolProgressMode = argv[++i];
    } else if (arg === '--no-tool-call-retry') {
      args.toolCallRetry = false;
    } else if (arg === '--max-tool-call-retries') {
      args.maxToolCallRetries = parseInt(argv[++i], 10);
    } else if (arg === '--upstream-max-retries') {
      args.upstreamMaxRetries = parseInt(argv[++i], 10);
    } else if (arg === '--upstream-retry-base-delay-ms') {
      args.upstreamRetryBaseDelayMs = parseInt(argv[++i], 10);
    } else if (arg === '--upstream-max-retry-delay-ms') {
      args.upstreamMaxRetryDelayMs = parseInt(argv[++i], 10);
    } else if (arg === '--upstream-concurrency') {
      args.upstreamConcurrency = parseInt(argv[++i], 10);
    } else if (arg === '--env-file') {
      args.envFile = argv[++i];
    } else if (arg.startsWith('--')) {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  
  return args;
}

function envInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

function envBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === '1' || value === 'true';
}

/**
 * 加载配置
 * 优先级：命令行参数 > 环境变量 > .env 文件 > 默认值
 * @param {Array} argv - 命令行参数数组
 * @returns {Object} 配置对象
 */
export function loadConfig(argv = process.argv) {
  const args = parseArgs(argv);
  
  // 加载 .env 文件
  const envFileVars = args.envFile ? loadEnvFile(args.envFile) : loadEnvFile();
  
  // 辅助函数：按优先级取值
  function pick(...values) {
    for (const v of values) {
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return values[values.length - 1];
  }

  // 合并配置（优先级：命令行 > 环境变量 > .env 文件 > 默认值）
  const config = {
    host: pick(args.host, process.env.BRIDGE_HOST, envFileVars.BRIDGE_HOST, DEFAULT_CONFIG.host),
    port: pick(args.port, envInt(process.env.PORT), envInt(envFileVars.PORT), DEFAULT_CONFIG.port),
    upstreamBaseUrl: pick(args.upstreamBaseUrl, process.env.UPSTREAM_BASE_URL, envFileVars.UPSTREAM_BASE_URL, DEFAULT_CONFIG.upstreamBaseUrl),
    upstreamApiKey: pick(args.upstreamApiKey, process.env.UPSTREAM_API_KEY, envFileVars.UPSTREAM_API_KEY, DEFAULT_CONFIG.upstreamApiKey),
    model: pick(args.model, process.env.UPSTREAM_MODEL, envFileVars.UPSTREAM_MODEL, DEFAULT_CONFIG.model),
    enableReasoning: pick(args.enableReasoning, envBool(process.env.BRIDGE_ENABLE_REASONING), envBool(envFileVars.BRIDGE_ENABLE_REASONING), DEFAULT_CONFIG.enableReasoning),
    strictNativeTools: pick(args.strictNativeTools, envBool(process.env.BRIDGE_STRICT_NATIVE_TOOLS), envBool(envFileVars.BRIDGE_STRICT_NATIVE_TOOLS), DEFAULT_CONFIG.strictNativeTools),
    simulateNativeTools: pick(args.simulateNativeTools, envBool(process.env.BRIDGE_SIMULATE_NATIVE_TOOLS), envBool(envFileVars.BRIDGE_SIMULATE_NATIVE_TOOLS), DEFAULT_CONFIG.simulateNativeTools),
    repairTextToolCalls: pick(args.repairTextToolCalls, envBool(process.env.BRIDGE_REPAIR_TEXT_TOOL_CALLS), envBool(envFileVars.BRIDGE_REPAIR_TEXT_TOOL_CALLS), DEFAULT_CONFIG.repairTextToolCalls),
    toolProgressMode: pick(args.toolProgressMode, process.env.BRIDGE_TOOL_PROGRESS_MODE, envFileVars.BRIDGE_TOOL_PROGRESS_MODE, DEFAULT_CONFIG.toolProgressMode),
    toolCallRetry: pick(args.toolCallRetry, envBool(process.env.BRIDGE_TOOL_CALL_RETRY), envBool(envFileVars.BRIDGE_TOOL_CALL_RETRY), DEFAULT_CONFIG.toolCallRetry),
    maxToolCallRetries: pick(args.maxToolCallRetries, envInt(process.env.BRIDGE_MAX_TOOL_CALL_RETRIES), envInt(envFileVars.BRIDGE_MAX_TOOL_CALL_RETRIES), DEFAULT_CONFIG.maxToolCallRetries),
    upstreamMaxRetries: pick(args.upstreamMaxRetries, envInt(process.env.BRIDGE_UPSTREAM_MAX_RETRIES), envInt(envFileVars.BRIDGE_UPSTREAM_MAX_RETRIES), DEFAULT_CONFIG.upstreamMaxRetries),
    upstreamRetryBaseDelayMs: pick(args.upstreamRetryBaseDelayMs, envInt(process.env.BRIDGE_UPSTREAM_RETRY_BASE_DELAY_MS), envInt(envFileVars.BRIDGE_UPSTREAM_RETRY_BASE_DELAY_MS), DEFAULT_CONFIG.upstreamRetryBaseDelayMs),
    upstreamMaxRetryDelayMs: pick(args.upstreamMaxRetryDelayMs, envInt(process.env.BRIDGE_UPSTREAM_MAX_RETRY_DELAY_MS), envInt(envFileVars.BRIDGE_UPSTREAM_MAX_RETRY_DELAY_MS), DEFAULT_CONFIG.upstreamMaxRetryDelayMs),
    upstreamConcurrency: pick(args.upstreamConcurrency, envInt(process.env.BRIDGE_UPSTREAM_CONCURRENCY), envInt(envFileVars.BRIDGE_UPSTREAM_CONCURRENCY), DEFAULT_CONFIG.upstreamConcurrency),
    conversationMaxSize: pick(envInt(process.env.BRIDGE_CONVERSATION_MAX_SIZE), envInt(envFileVars.BRIDGE_CONVERSATION_MAX_SIZE), DEFAULT_CONFIG.conversationMaxSize),
    conversationTtlMs: pick(envInt(process.env.BRIDGE_CONVERSATION_TTL_MS), envInt(envFileVars.BRIDGE_CONVERSATION_TTL_MS), DEFAULT_CONFIG.conversationTtlMs),
    tokenEstimationEnabled: pick(envBool(process.env.BRIDGE_TOKEN_ESTIMATION_ENABLED), envBool(envFileVars.BRIDGE_TOKEN_ESTIMATION_ENABLED), DEFAULT_CONFIG.tokenEstimationEnabled)
  };
  
  // 验证配置
  validateConfig(config);
  
  return config;
}

/**
 * 验证配置
 * @param {Object} config - 配置对象
 */
export function validateConfig(config) {
  if (!config.upstreamBaseUrl) {
    console.warn('警告：未配置上游基础 URL，请通过环境变量或命令行参数设置 UPSTREAM_BASE_URL');
  }
  
  if (config.port < 1 || config.port > 65535) {
    throw new Error(`端口号无效: ${config.port}，应在 1-65535 之间`);
  }
  
  if (config.conversationMaxSize < 1) {
    throw new Error(`对话最大数量无效: ${config.conversationMaxSize}，应大于 0`);
  }
  
  if (config.conversationTtlMs < 1000) {
    throw new Error(`对话过期时间无效: ${config.conversationTtlMs}，应大于等于 1000ms`);
  }

  if (config.upstreamMaxRetries < 0) {
    throw new Error(`上游最大重试次数无效: ${config.upstreamMaxRetries}，应大于等于 0`);
  }

  if (config.upstreamConcurrency < 1) {
    throw new Error(`上游并发数无效: ${config.upstreamConcurrency}，应大于等于 1`);
  }

  if (!['preface', 'reasoning', 'silent'].includes(config.toolProgressMode)) {
    throw new Error(`工具过程文字模式无效: ${config.toolProgressMode}，应为 preface、reasoning 或 silent`);
  }
}

/**
 * 获取默认配置
 * @returns {Object} 默认配置对象
 */
export function getDefaultConfig() {
  return { ...DEFAULT_CONFIG };
}
