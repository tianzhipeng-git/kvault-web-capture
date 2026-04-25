import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

interface ModelConfig {
	base_url: string;
	api_key: string;
	model_name: string;
	display_name: string;
	use_proxy?: boolean;
}

interface LLMConfig {
	models: Record<string, ModelConfig>;
	default: string;
}

const _clients: Record<string, OpenAI> = {};
let _config: LLMConfig | null = null;

/**
 * 加载并解析 YAML 配置文件
 */
export function loadLLMConfig(): LLMConfig {
	if (_config) return _config;

	// 使用 process.cwd() 获取项目根目录来读取配置，保证在 Next.js Server Components 或 API 路由下都可以正确定位
	const configPath = path.join(process.cwd(), 'src/utils/llm_config.yaml');
	try {
		const fileContents = fs.readFileSync(configPath, 'utf8');

		// 动态替换环境变量，形式如 ${VAR_NAME}
		// 如果环境变量不存在，则替换为空字符串
		const envSubstituted = fileContents.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
			return process.env[envVar] || '';
		});

		_config = yaml.load(envSubstituted) as LLMConfig;
	} catch (e) {
		console.error('Failed to load llm_config.yaml', e);
		throw new Error('llm_config.yaml 读取或解析失败');
	}

	if (!_config || !_config.models) {
		throw new Error('llm_config.yaml 格式错误或缺少 models 配置');
	}

	return _config;
}

/**
 * 获取特定模型的 OpenAI 客户端实例
 * @param modelKey yaml配置文件中的模型键名
 */
export function getOpenAIClient(modelKey?: string): OpenAI {
	const config = loadLLMConfig();

	// 兼容通过环境变量指定的方式
	const key = modelKey || process.env.LLM_MODEL || config.default;
	const modelConfig = config.models[key];

	if (!modelConfig) {
		throw new Error(`在 llm_config.yaml 中未找到该模型的配置: ${key}`);
	}

	// 优先复用当前内存中初始化好的 Client
	if (_clients[key]) return _clients[key];

	const options: any = {
		baseURL: modelConfig.base_url.replace(/\/$/, ''),
		apiKey: modelConfig.api_key,
	};

	// 如果开启了代理，则注入 ProxyAgent 与自定义 fetch 以绕过 Next.js 对原生 fetch 的代理屏蔽
	if (modelConfig.use_proxy) {
		const proxyUrl = process.env.https_proxy || process.env.http_proxy || 'http://127.0.0.1:7890';
		const dispatcher = new ProxyAgent({
			uri: proxyUrl,
			keepAliveTimeout: 10,       // 毫秒：缩短 Keep-Alive，防止复用已经被代理断开的"死连接"
			keepAliveMaxTimeout: 10,    // 毫秒
			headersTimeout: 60000,      // 毫秒：等待大模型返回响应头的最大时间 (比如 60 秒)
			bodyTimeout: 300000         // 毫秒：接收响应体的最大时间
		});
		options.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
			// 将请求通过 undici 转发代理
			return undiciFetch(input as any, {
				...init,
				dispatcher
			} as any);
		};
	}

	const client = new OpenAI(options);
	_clients[key] = client;

	return client;
}

/**
 * 检查目前是否配置了 LLM
 */
export function isLLMConfigured(): boolean {
	try {
		const config = loadLLMConfig();

		return !!config && !!config.models;
	} catch {
		return false;
	}
}

/**
 * 调用 LLM chat completion
 */
export async function chatCompletion(
	messages: ChatCompletionMessageParam[],
	options?: {
		model?: string;
		temperature?: number;
		response_format?: { type: 'json_object' | 'text' };
	},
): Promise<string> {
	const config = loadLLMConfig();

	// options?.model 用作去找这套配置（匹配 YAML 里的 key）
	const key = options?.model || process.env.LLM_MODEL || config.default;
	const modelConfig = config.models[key];

	if (!modelConfig) {
		throw new Error(`未找到指定的模型配置: ${key}`);
	}

	const client = getOpenAIClient(key);

	const response = await client.chat.completions.create({
		// 转换成服务商真正的模型名称
		model: modelConfig.model_name,
		messages,
		temperature: options?.temperature ?? 0.2,
		...(options?.response_format ? { response_format: options.response_format } : {}),
	});

	const content = response.choices?.[0]?.message?.content;
	if (!content) {
		throw new Error('LLM 返回为空');
	}

	return content;
}

export type { ChatCompletionMessageParam };

// main 入口测试
if (typeof process !== 'undefined' && process.argv[1]) {
	const { fileURLToPath } = await import('node:url');
	try {
		const urlObj = new URL(import.meta.url);
		if (urlObj.protocol === 'file:') {
			const currentFile = fileURLToPath(import.meta.url);
			if (process.argv[1] === currentFile) {
				const dotenv = await import('dotenv');
				dotenv.config();

				const { fetchAndRenderPrompt } = await import('./llm_prompts.js');

				console.log("测试 fetchAndRenderPrompt 和 chatCompletion...");
				fetchAndRenderPrompt("test-prompt-emoji", "Main", {
					date: new Date().toLocaleDateString(),
					aa: "我是张三, 请跟我打个招呼!"
				}).then(async (messages) => {
					console.log("渲染的 Prompt:", messages);
					const response = await chatCompletion(messages as ChatCompletionMessageParam[], {
						model: "gemini-3-flash"
					});
					console.log("LLM 返回内容:", response);
				}).catch(console.error);
			}
		}
	} catch (e) {
		// ignore
	}
}
