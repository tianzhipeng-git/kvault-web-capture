export type FeishuBotResponse = Record<string, unknown>;

export type FeishuPostContent = Array<Array<Record<string, unknown>>>;

export interface FeishuSimpleBotOptions {
  /**
   * Webhook 地址最后一段的 ID, 例如:
   * https://open.feishu.cn/open-apis/bot/v2/hook/xxxx-xxxx-xxxx-xxxx-xxxx
   *
   * 如果为空则从环境变量 FEISHU_BOT_WEBHOOK_ID 读取。
   */
  webhookId?: string;
  /**
   * 请求超时时间(秒), 默认 10 秒。
   */
  timeoutSeconds?: number;
}

const FEISHU_BOT_WEBHOOK_ID_ENV = 'FEISHU_BOT_WEBHOOK_ID';
const DEFAULT_TIMEOUT_SECONDS = 10;
const MAX_ATTEMPTS = 3;
const RETRY_WAIT_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createTimeoutSignal(timeoutSeconds: number): AbortSignal | undefined {
  if (timeoutSeconds <= 0) {
    return undefined;
  }

  return AbortSignal.timeout(timeoutSeconds * 1000);
}

function isFeishuErrorResponse(data: FeishuBotResponse): boolean {
  const statusCode = data.StatusCode;

  return statusCode !== undefined && statusCode !== 0;
}

/**
 * 飞书群机器人 Webhook 简单封装。
 *
 * 适用场景:
 * - 任务执行结果通知
 * - 报警/异常告警
 * - 日常文本或富文本(post)消息推送
 *
 * 文档:
 * https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 */
export class FeishuSimpleBot {
  readonly webhookUrl: string;

  private readonly timeoutSeconds: number;

  constructor(options: FeishuSimpleBotOptions = {}) {
    const webhookId = options.webhookId ?? process.env[FEISHU_BOT_WEBHOOK_ID_ENV];

    if (!webhookId) {
      throw new Error(
        `FeishuSimpleBot 需要提供 webhookId 或环境变量 ${FEISHU_BOT_WEBHOOK_ID_ENV}`,
      );
    }

    this.webhookUrl = `https://open.feishu.cn/open-apis/bot/v2/hook/${webhookId}`;
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  }

  /**
   * 低级发送接口, 负责真正向 Webhook 推送。
   */
  async send(payload: Record<string, unknown>): Promise<FeishuBotResponse> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.sendOnce(payload);
      } catch (error) {
        lastError = error;

        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_WAIT_MS);
        }
      }
    }

    throw lastError;
  }

  /**
   * 发送纯文本消息。
   *
   * https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot#b3a35286
   */
  async sendText(content: string): Promise<FeishuBotResponse> {
    return this.send({
      msg_type: 'text',
      content: {
        text: content,
      },
    });
  }

  /**
   * 发送富文本(post)消息。
   *
   * @param title 标题
   * @param content 二维数组结构, 对应飞书 post 的 content 字段
   * @param lang 语言 key, 默认 zh_cn
   */
  async sendPost(
    title: string,
    content: FeishuPostContent,
    lang = 'zh_cn',
  ): Promise<FeishuBotResponse> {
    return this.send({
      msg_type: 'post',
      content: {
        post: {
          [lang]: {
            title,
            content,
          },
        },
      },
    });
  }

  private async sendOnce(payload: Record<string, unknown>): Promise<FeishuBotResponse> {
    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: createTimeoutSignal(this.timeoutSeconds),
    });

    if (!response.ok) {
      throw new Error(`Feishu bot send failed: HTTP ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as FeishuBotResponse;

    // 飞书机器人协议: {"StatusCode":0, "StatusMessage":"success"}
    // StatusCode 可能不存在, 此时认为由调用方自行解析。
    if (isFeishuErrorResponse(data)) {
      throw new Error(`Feishu bot send failed: ${JSON.stringify(data)}`);
    }

    return data;
  }
}
