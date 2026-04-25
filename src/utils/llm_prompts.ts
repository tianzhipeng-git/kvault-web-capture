import nunjucks from 'nunjucks';
import { fileURLToPath } from 'url';

export interface PromptMessage {
    role: string;
    text: string;
}

export interface PromptDefinition {
    id: string;
    name: string;
    system_prompt: string;
    messages?: PromptMessage[];
    resp_json_schema?: any;
}

export interface RenderedMessage {
    role: string;
    content: string;
}

/**
 * 异步提交 GraphQL 请求到 Directus
 *
 * @param query GraphQL 查询字符串
 * @param variables GraphQL 变量字典
 * @param host Directus 服务地址，默认从环境变量 DIRECTUS_HOST 获取
 * @param token Directus 访问令牌，默认从环境变量 DIRECTUS_TOKEN 获取
 * @param isSystem 是否使用系统 GraphQL 端点 (/graphql/system)
 * @param retries 重试次数; 默认1, 即只执行一次不重试. (Python版默认3)
 */
export async function graphqlRequest(
    query: string,
    variables?: Record<string, any>,
    host?: string,
    token?: string,
    isSystem: boolean = false,
    retries: number = 3
): Promise<any> {
    const finalHost = host ?? process.env.DIRECTUS_HOST;
    const finalToken = token ?? process.env.DIRECTUS_TOKEN;

    if (!finalHost) {
        throw new Error("host 必须提供，或在环境变量 DIRECTUS_HOST 中设置");
    }
    if (!finalToken) {
        throw new Error("token 必须提供，或在环境变量 DIRECTUS_TOKEN 中设置");
    }

    // 确保 host 末尾没有斜杠
    const cleanHost = finalHost.replace(/\/+$/, '');
    const endpoint = isSystem ? `${cleanHost}/graphql/system` : `${cleanHost}/graphql`;

    const headers = {
        "Authorization": `Bearer ${finalToken}`,
        "Content-Type": "application/json",
    };

    const payload: Record<string, any> = { query };
    if (variables) {
        payload.variables = variables;
    }

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            // 设置超时 (120s 对应 Python 的 timeout)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 120000);

            const response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`HTTPStatusError: ${response.status} ${response.statusText}: ${text}`);
            }

            const result = await response.json();

            // 检查 GraphQL 错误
            if (result.errors) {
                throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
            }

            return result;
        } catch (error: any) {
            // 已经是最后一次尝试，直接抛出
            if (attempt === retries - 1) {
                throw error;
            }

            // 如果是客户端错误且不是 429，不重试
            if (error.message && error.message.startsWith('HTTPStatusError: ')) {
                const match = error.message.match(/HTTPStatusError: (\d+)/);
                if (match) {
                    const status = parseInt(match[1], 10);
                    if (status >= 400 && status < 500 && status !== 429) {
                        throw error;
                    }
                }
            }

            // 等待后重试
            console.log(`Attempt ${attempt} failed, will retry: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    // 理论上不可达
    throw new Error("Unexpected error in graphqlRequest");
}

/**
 * 从 Directus.ai_prompts 表中获取 Prompt 定义。
 * - 不传 version: 取该 name 下最新的，按 date_updated 倒序。
 * - 传 version: 使用 Directus 的版本化接口按 (id, version) 精确获取指定版本。
 */
export async function fetchPrompt(promptName: string, version?: string): Promise<PromptDefinition> {
    // 先按 name 查出一条主记录（用于拿 id）
    const baseQuery = `
    query GetPromptBase($name: String!) {
      ai_prompts(
        filter: {
          name: { _eq: $name }
        }
        sort: ["-date_updated"]
        limit: 1
      ) {
        id
        name
        system_prompt
        messages
        resp_json_schema
      }
    }
    `;

    const baseResult = await graphqlRequest(baseQuery, { name: promptName }, undefined, undefined, false, 3);
    const baseItems = baseResult?.data?.ai_prompts || [];

    if (baseItems.length === 0) {
        throw new Error(`未在 Directus.ai_prompts 中找到已发布的 prompt: name=${promptName}`);
    }

    const baseItem = baseItems[0];

    // 如果没有指定 version，直接使用当前已发布版本
    if (!version) {
        return baseItem;
    }

    // 指定了 version，则通过版本接口查询对应版本
    const versionQuery = `
    query GetPromptByVersion($id: ID!, $version: String!) {
      ai_prompts_by_version(version: $version, id: $id) {
        id
        name
        system_prompt
        messages
        resp_json_schema
      }
    }
    `;

    const versionResult = await graphqlRequest(versionQuery, { id: baseItem.id, version }, undefined, undefined, false, 3);
    const versionItem = versionResult?.data?.ai_prompts_by_version;

    if (!versionItem) {
        throw new Error(`未在 Directus.ai_prompts 中找到指定版本的 prompt: name=${promptName}, version=${version}`);
    }

    return versionItem;
}

export function renderPrompt(
    prompt: PromptDefinition,
    promptName: string,
    context?: Record<string, any>,
    extraUserMsg?: string
): RenderedMessage[] {
    const ctx = context || {};

    const systemPrompt = prompt.system_prompt;
    if (typeof systemPrompt !== 'string') {
        throw new Error(`prompt ${promptName} 的 system_prompt 不是字符串`);
    }

    // 使用 nunjucks 替代 jinja2 (关闭 autoescape 防止转义 prompt 里的引号等符号)
    nunjucks.configure({ autoescape: false });
    const renderedSystemPrompt = nunjucks.renderString(systemPrompt, ctx);

    const msgs: RenderedMessage[] = [];
    msgs.push({ role: 'system', content: renderedSystemPrompt });

    if (prompt.messages && Array.isArray(prompt.messages)) {
        for (const msg of prompt.messages) {
            if (!msg || typeof msg !== 'object') continue;

            const role = msg.role;
            const msgTemplate = msg.text;

            if (typeof role !== 'string' || typeof msgTemplate !== 'string') continue;

            const msgText = nunjucks.renderString(msgTemplate, ctx);
            msgs.push({ role, content: msgText });
        }
    }

    if (extraUserMsg) {
        msgs.push({ role: 'user', content: extraUserMsg });
    }

    return msgs;
}

export async function fetchAndRenderPrompt(
    promptName: string,
    version?: string,
    context?: Record<string, any>,
    extraUserMsg?: string
): Promise<RenderedMessage[]> {
    const prompt = await fetchPrompt(promptName, version);
    return renderPrompt(prompt, promptName, context, extraUserMsg);
}

// Equivalent to `if __name__ == "__main__":`
if (typeof process !== 'undefined' && process.argv[1]) {
    try {
        const urlObj = new URL(import.meta.url);
        if (urlObj.protocol === 'file:') {
            const currentFile = fileURLToPath(import.meta.url);
            if (process.argv[1] === currentFile) {
                console.log("sss");
                fetchPrompt("test-prompt-emoji", "Main").then(prompt => {
                    console.log("Raw Prompt:", prompt);
                    const rendered = renderPrompt(prompt, "test-prompt-emoji", {
                        date: new Date().toLocaleDateString(),
                        aa: "张三"
                    });
                    console.log("Rendered Messages:", rendered);
                }).catch(console.error);
            }
        }
    } catch (e) {
        // ignore
    }
}
