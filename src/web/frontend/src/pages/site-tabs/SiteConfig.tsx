import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";


export function SiteConfig({ siteId }: { siteId: number }) {
  const [configStr, setConfigStr] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    api.getSiteConfig(siteId).then(data => {
      setConfigStr(JSON.stringify(data, null, 2));
    });
  }, [siteId]);

  const handleSave = async () => {
    try {
      setIsSaving(true);
      const parsed = JSON.parse(configStr);
      await api.updateSiteConfig(siteId, parsed);
      alert("保存成功");
    } catch (e: any) {
      alert("JSON 格式错误: " + e.message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4 bg-card rounded-xl border p-6 shadow-sm">
      <div className="flex justify-between items-center mb-2">
        <div>
          <h2 className="text-lg font-semibold">规则配置 (JSON)</h2>
          <p className="text-sm text-muted-foreground mt-1">
            定义 URL 黑白名单、Tag 标签匹配规则、以及抓取产物要求。
          </p>
        </div>
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? "保存中..." : "保存配置"}
        </Button>
      </div>

      <textarea
        className="w-full h-[500px] font-mono text-sm p-4 rounded-md border bg-muted/30 focus:outline-none focus:ring-2 focus:ring-primary"
        value={configStr}
        onChange={(e) => setConfigStr(e.target.value)}
      />
    </div>
  );
}
