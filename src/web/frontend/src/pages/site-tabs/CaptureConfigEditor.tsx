import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2 } from "lucide-react";
import {
  KNOWN_CAPTURE_TOOLS,
  type CaptureConfigFormState,
  type CaptureProfileFormItem,
  type CaptureValidationRuleForm,
  type ValidationCapability,
  type ValidationConfigForm,
  createEmptyProfileFormItem,
  validationCapabilityLabel,
} from "@/lib/capture-config-form";

function ValidationRuleFields({
  capability,
  form,
  onChange,
}: {
  capability: ValidationCapability;
  form: CaptureValidationRuleForm;
  onChange: (next: CaptureValidationRuleForm) => void;
}) {
  const showMinLength = capability === "base" || capability === "markdown" || capability === "structured";
  const showMinBytes = capability === "screenshot";

  return (
    <div className="rounded-md border p-3 space-y-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => onChange({ ...form, enabled: event.target.checked })}
        />
        启用 {validationCapabilityLabel(capability)} 校验
      </label>
      {form.enabled && (
        <div className="grid gap-3 md:grid-cols-2">
          {showMinLength && (
            <div className="space-y-1">
              <Label>最小长度 (minLength)</Label>
              <Input
                type="number"
                min="0"
                value={form.minLength}
                onChange={(event) => onChange({ ...form, minLength: event.target.value })}
              />
            </div>
          )}
          {showMinBytes && (
            <div className="space-y-1">
              <Label>最小字节数 (minBytes)</Label>
              <Input
                type="number"
                min="0"
                value={form.minBytes}
                onChange={(event) => onChange({ ...form, minBytes: event.target.value })}
              />
            </div>
          )}
          <div className="space-y-1 md:col-span-2">
            <Label>拒绝正则 (rejectRegex，每行一条)</Label>
            <textarea
              className="h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={form.rejectRegexText}
              onChange={(event) => onChange({ ...form, rejectRegexText: event.target.value })}
              placeholder="Access Denied"
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>必须匹配正则 (requireRegex，每行一条)</Label>
            <textarea
              className="h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={form.requireRegexText}
              onChange={(event) => onChange({ ...form, requireRegexText: event.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ValidationConfigEditor({
  value,
  onChange,
}: {
  value: ValidationConfigForm;
  onChange: (next: ValidationConfigForm) => void;
}) {
  const capabilities: ValidationCapability[] = ["base", "markdown", "screenshot", "structured"];

  return (
    <div className="space-y-3">
      {capabilities.map((capability) => (
        <ValidationRuleFields
          key={capability}
          capability={capability}
          form={value[capability]}
          onChange={(next) => onChange({ ...value, [capability]: next })}
        />
      ))}
    </div>
  );
}

function ProfileEditor({
  profile,
  defaultSelected,
  onChange,
  onRemove,
  onSelectDefault,
}: {
  profile: CaptureProfileFormItem;
  defaultSelected: boolean;
  onChange: (next: CaptureProfileFormItem) => void;
  onRemove: () => void;
  onSelectDefault: () => void;
}) {
  return (
    <div className="rounded-md border p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" checked={defaultSelected} onChange={onSelectDefault} />
          默认 Profile
        </label>
        <div className="flex-1 min-w-[12rem] space-y-1">
          <Label>Profile 名称</Label>
          <Input
            value={profile.name}
            onChange={(event) => onChange({ ...profile, name: event.target.value })}
          />
        </div>
        <Button type="button" variant="outline" size="sm" className="gap-1" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
          删除
        </Button>
      </div>
      <div className="space-y-1">
        <Label>工具链 (tools，每行一个，按 fallback 顺序排列)</Label>
        <textarea
          className="h-28 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
          value={profile.toolsText}
          onChange={(event) => onChange({ ...profile, toolsText: event.target.value })}
          placeholder={KNOWN_CAPTURE_TOOLS.join("\n")}
        />
        <p className="text-xs text-muted-foreground">
          可用工具：{KNOWN_CAPTURE_TOOLS.join("、")}
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={profile.validationEnabled}
          onChange={(event) => onChange({ ...profile, validationEnabled: event.target.checked })}
        />
        为此 Profile 配置专属校验规则（覆盖站点级校验）
      </label>
      {profile.validationEnabled && (
        <ValidationConfigEditor
          value={profile.validation}
          onChange={(validation) => onChange({ ...profile, validation })}
        />
      )}
    </div>
  );
}

export function CaptureConfigEditor({
  value,
  onChange,
}: {
  value: CaptureConfigFormState;
  onChange: (next: CaptureConfigFormState) => void;
}) {
  const updateProfiles = (profiles: CaptureProfileFormItem[]) => {
    const defaultCaptureProfile = profiles.some((item) => item.name === value.defaultCaptureProfile)
      ? value.defaultCaptureProfile
      : (profiles[0]?.name ?? "");
    onChange({ ...value, profiles, defaultCaptureProfile });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>抓取 Profile</CardTitle>
              <CardDescription>
                配置工具链与 fallback 顺序；Executor 会按 needs 自动选择能覆盖能力的工具。
              </CardDescription>
            </div>
            <label className="flex items-center gap-2 text-sm shrink-0">
              <input
                type="checkbox"
                checked={value.captureProfilesEnabled}
                onChange={(event) => onChange({ ...value, captureProfilesEnabled: event.target.checked })}
              />
              启用
            </label>
          </div>
        </CardHeader>
        {value.captureProfilesEnabled && (
          <CardContent className="space-y-4">
            {value.profiles.map((profile) => (
              <ProfileEditor
                key={profile.key}
                profile={profile}
                defaultSelected={value.defaultCaptureProfile === profile.name}
                onChange={(next) => updateProfiles(value.profiles.map((item) => item.key === profile.key ? next : item))}
                onRemove={() => updateProfiles(value.profiles.filter((item) => item.key !== profile.key))}
                onSelectDefault={() => onChange({ ...value, defaultCaptureProfile: profile.name })}
              />
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={() => updateProfiles([...value.profiles, createEmptyProfileFormItem()])}
            >
              <Plus className="h-4 w-4" />
              添加 Profile
            </Button>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>站点级结果校验</CardTitle>
              <CardDescription>
                定义抓取结果是否可接受；Profile 级校验可覆盖此处配置。
              </CardDescription>
            </div>
            <label className="flex items-center gap-2 text-sm shrink-0">
              <input
                type="checkbox"
                checked={value.validationEnabled}
                onChange={(event) => onChange({ ...value, validationEnabled: event.target.checked })}
              />
              启用
            </label>
          </div>
        </CardHeader>
        {value.validationEnabled && (
          <CardContent>
            <ValidationConfigEditor
              value={value.validation}
              onChange={(validation) => onChange({ ...value, validation })}
            />
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>浏览器</CardTitle>
              <CardDescription>
                控制 BrowserManager 使用的 engine、profile 与复用策略。
              </CardDescription>
            </div>
            <label className="flex items-center gap-2 text-sm shrink-0">
              <input
                type="checkbox"
                checked={value.browserEnabled}
                onChange={(event) => onChange({ ...value, browserEnabled: event.target.checked })}
              />
              启用自定义配置
            </label>
          </div>
        </CardHeader>
        {value.browserEnabled && (
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Engine</Label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={value.browser.engine}
                onChange={(event) => onChange({
                  ...value,
                  browser: { ...value.browser, engine: event.target.value as typeof value.browser.engine },
                })}
              >
                <option value="chromium">Chromium (Playwright)</option>
                <option value="cloakbrowser">CloakBrowser</option>
                <option value="lightpanda">Lightpanda</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>Profile 模式</Label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={value.browser.profileMode}
                onChange={(event) => onChange({
                  ...value,
                  browser: { ...value.browser, profileMode: event.target.value as typeof value.browser.profileMode },
                })}
              >
                <option value="ephemeral">Ephemeral（临时）</option>
                <option value="persistent">Persistent（持久 userDataDir）</option>
                <option value="storage_state">Storage State（轻量登录态）</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>Browser 复用</Label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={value.browser.reuse}
                onChange={(event) => onChange({
                  ...value,
                  browser: { ...value.browser, reuse: event.target.value as typeof value.browser.reuse },
                })}
              >
                <option value="run_browser">Run 内复用进程</option>
                <option value="site_browser">站点级复用进程</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>Context 复用</Label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={value.browser.contextReuse}
                onChange={(event) => onChange({
                  ...value,
                  browser: { ...value.browser, contextReuse: event.target.value as typeof value.browser.contextReuse },
                })}
              >
                <option value="site_session_proxy">按 site + session + proxy</option>
                <option value="site_run">按 site + run</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>Proxy 绑定</Label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={value.browser.proxyBinding}
                onChange={(event) => onChange({
                  ...value,
                  browser: { ...value.browser, proxyBinding: event.target.value as typeof value.browser.proxyBinding },
                })}
              >
                <option value="session">跟随 Crawlee session</option>
                <option value="none">不绑定代理</option>
              </select>
            </div>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>代理策略</CardTitle>
              <CardDescription>
                控制 HTTP 与浏览器是否使用代理，以及失败后的重试策略。
              </CardDescription>
            </div>
            <label className="flex items-center gap-2 text-sm shrink-0">
              <input
                type="checkbox"
                checked={value.proxyPolicyEnabled}
                onChange={(event) => onChange({ ...value, proxyPolicyEnabled: event.target.checked })}
              />
              启用
            </label>
          </div>
        </CardHeader>
        {value.proxyPolicyEnabled && (
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <Label>模式</Label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={value.proxyPolicy.mode}
                onChange={(event) => onChange({
                  ...value,
                  proxyPolicy: { ...value.proxyPolicy, mode: event.target.value as typeof value.proxyPolicy.mode },
                })}
              >
                <option value="off">关闭</option>
                <option value="always">始终使用代理</option>
                <option value="retry_on_failure">失败后重试时使用代理</option>
              </select>
            </div>
            {value.proxyPolicy.mode !== "off" && (
              <div className="space-y-1">
                <Label>Provider</Label>
                <select
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={value.proxyPolicy.provider}
                  onChange={(event) => onChange({
                    ...value,
                    proxyPolicy: {
                      ...value.proxyPolicy,
                      provider: event.target.value as typeof value.proxyPolicy.provider,
                    },
                  })}
                >
                  <option value="">默认 (crawlee)</option>
                  <option value="crawlee">Crawlee</option>
                  <option value="apify">Apify</option>
                </select>
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
