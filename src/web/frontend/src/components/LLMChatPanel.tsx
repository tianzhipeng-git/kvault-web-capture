import { useEffect, useMemo, useState } from "react";
import { Bot, Check, Loader2, RotateCcw, Send, X } from "lucide-react";
import { toast } from "sonner";
import { api, type LlmChatMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface LLMChatPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  promptName: string;
  title?: string;
  placeholder?: string;
  applyLabel?: string;
  contextSummary?: Array<{
    label: string;
    value: string;
  }>;
  resetKey?: string | number;
  buildContext: (userInput: string, history: LlmChatMessage[]) => Record<string, unknown>;
  onApply: (content: string) => void | Promise<void>;
}

export function LLMChatPanel({
  open,
  onOpenChange,
  promptName,
  title = "规则编辑助手",
  placeholder = "写下你希望规则怎么调整",
  applyLabel = "应用结果",
  contextSummary = [],
  resetKey,
  buildContext,
  onApply,
}: LLMChatPanelProps) {
  const [messages, setMessages] = useState<LlmChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const latestAssistantMessage = useMemo(
    () => [...messages].reverse().find((message) => message.role === "assistant") ?? null,
    [messages],
  );
  const canClearChat = messages.length > 0 || draft.length > 0;

  useEffect(() => {
    setMessages([]);
    setDraft("");
  }, [promptName, resetKey]);

  const sendMessage = async () => {
    const userInput = draft.trim();
    if (!userInput || isSending) return;

    const history = messages;
    const userMessage: LlmChatMessage = { role: "user", content: userInput };
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setIsSending(true);

    try {
      const response = await api.llmChat({
        promptName,
        context: buildContext(userInput, history),
        history,
      });
      setMessages((current) => [...current, { role: "assistant", content: response.content }]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "助手调用失败。");
    } finally {
      setIsSending(false);
    }
  };

  const applyLatest = async () => {
    if (!latestAssistantMessage || isApplying) return;
    setIsApplying(true);
    try {
      await onApply(latestAssistantMessage.content);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "应用失败。");
    } finally {
      setIsApplying(false);
    }
  };

  const clearChat = () => {
    setMessages([]);
    setDraft("");
    toast.success("已清除本次对话记录。");
  };

  return (
    <div
      className={cn(
        "fixed bottom-0 right-0 top-0 z-[70] w-full max-w-[440px] border-l bg-background shadow-2xl transition-transform duration-200",
        open ? "translate-x-0" : "translate-x-full",
      )}
      aria-hidden={!open}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2">
              <Bot className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <div className="truncate font-semibold">{title}</div>
                <div className="truncate text-xs text-muted-foreground">{promptName}</div>
              </div>
            </div>
            <Button type="button" variant="ghost" size="icon" className="shrink-0" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          {contextSummary.length > 0 && (
            <div className="mt-3 rounded-md border bg-muted/20 p-3 text-xs">
              <div className="mb-2 font-medium text-muted-foreground">当前编辑目标</div>
              <div className="space-y-1.5">
                {contextSummary.map((item) => (
                  <div key={item.label} className="grid grid-cols-[72px_1fr] gap-2">
                    <div className="text-muted-foreground">{item.label}</div>
                    <div className="min-w-0 break-words font-medium">{item.value || "-"}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2 text-xs"
              disabled={!canClearChat || isSending || isApplying}
              onClick={clearChat}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              清除聊天记录
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {messages.length === 0 && (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              规则编辑建议会在这里生成。
            </div>
          )}
          {messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={cn(
                "rounded-md border p-3 text-sm",
                message.role === "user" ? "bg-muted/30" : "bg-background",
              )}
            >
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                {message.role === "user" ? "你" : "助手"}
              </div>
              <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">
                {message.content}
              </pre>
            </div>
          ))}
          {isSending && (
            <div className="flex items-center gap-2 rounded-md border p-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              生成中...
            </div>
          )}
        </div>

        <div className="border-t p-4 space-y-3">
          <textarea
            className="h-28 w-full resize-none rounded-md border bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                void sendMessage();
              }
            }}
          />
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              disabled={!latestAssistantMessage || isApplying}
              onClick={applyLatest}
            >
              {isApplying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {applyLabel}
            </Button>
            <Button type="button" className="gap-2" disabled={!draft.trim() || isSending} onClick={sendMessage}>
              {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              发送
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
