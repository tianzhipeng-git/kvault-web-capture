import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  KNOWN_CAPTURE_TOOLS,
  type CaptureConfigFormState,
  type CaptureProfileFormState,
  type CaptureValidationRuleForm,
  type ValidationCapability,
  type ValidationConfigForm,
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
  const showRegex = capability !== "screenshot";

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
          {showRegex && (
            <>
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
            </>
          )}
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
  onChange,
}: {
  profile: CaptureProfileFormState;
  onChange: (next: CaptureProfileFormState) => void;
}) {
  return (
    <div className="rounded-md border p-4 space-y-3">
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
                checked={value.captureProfileEnabled}
                onChange={(event) => onChange({ ...value, captureProfileEnabled: event.target.checked })}
              />
              启用
            </label>
          </div>
        </CardHeader>
        {value.captureProfileEnabled && (
          <CardContent className="space-y-4">
            <ProfileEditor
              profile={value.captureProfile}
              onChange={(captureProfile) => onChange({ ...value, captureProfile })}
            />
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>完整截图规格</CardTitle>
              <CardDescription>
                complete 模式会为每个 variant 创建独立任务；配置会在保存时由服务端完整校验。
              </CardDescription>
            </div>
            <label className="flex items-center gap-2 text-sm shrink-0">
              <input
                type="checkbox"
                checked={value.screenshotEnabled}
                onChange={(event) => onChange({ ...value, screenshotEnabled: event.target.checked })}
              />
              启用
            </label>
          </div>
        </CardHeader>
        {value.screenshotEnabled && (
          <CardContent className="space-y-2">
            <Label>ScreenshotConfig (JSON)</Label>
            <textarea
              className="min-h-72 w-full rounded-md border bg-background p-3 font-mono text-xs"
              value={value.screenshotJson}
              onChange={(event) => onChange({ ...value, screenshotJson: event.target.value })}
              spellCheck={false}
            />
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>结果校验</CardTitle>
              <CardDescription>
                定义抓取结果是否可接受；所有工具统一使用此处配置。
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
              <Label>CDP 进程池大小</Label>
              <Input
                type="number"
                min={1}
                max={4}
                value={value.browser.cdpPoolSize}
                onChange={(event) => onChange({
                  ...value,
                  browser: { ...value.browser, cdpPoolSize: Number(event.target.value) },
                })}
              />
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
