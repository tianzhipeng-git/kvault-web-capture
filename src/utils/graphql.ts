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
  retries: number = 3,
): Promise<any> {
  const finalHost = host ?? process.env.DIRECTUS_HOST;
  const finalToken = token ?? process.env.DIRECTUS_TOKEN;

  if (!finalHost) {
    throw new Error('host 必须提供，或在环境变量 DIRECTUS_HOST 中设置');
  }
  if (!finalToken) {
    throw new Error('token 必须提供，或在环境变量 DIRECTUS_TOKEN 中设置');
  }

  const cleanHost = finalHost.replace(/\/+$/, '');
  const endpoint = isSystem ? `${cleanHost}/graphql/system` : `${cleanHost}/graphql`;

  const headers = {
    Authorization: `Bearer ${finalToken}`,
    'Content-Type': 'application/json',
  };

  const payload: Record<string, any> = { query };
  if (variables) {
    payload.variables = variables;
  }

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTPStatusError: ${response.status} ${response.statusText}: ${text}`);
      }

      const result = await response.json();

      if (result.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
      }

      return result;
    } catch (error: any) {
      if (attempt === retries - 1) {
        throw error;
      }

      if (error.message && error.message.startsWith('HTTPStatusError: ')) {
        const match = error.message.match(/HTTPStatusError: (\d+)/);
        if (match) {
          const status = parseInt(match[1], 10);
          if (status >= 400 && status < 500 && status !== 429) {
            throw error;
          }
        }
      }

      console.log(`Attempt ${attempt} failed, will retry: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw new Error('Unexpected error in graphqlRequest');
}
