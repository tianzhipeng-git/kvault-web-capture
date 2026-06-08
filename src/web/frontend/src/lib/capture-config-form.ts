export const KNOWN_CAPTURE_TOOLS = [
  "http-base",
  "defuddle-markdown",
  "lightpanda-markdown",
  "jina-markdown",
  "playwright-screenshot",
  "crawl4ai-page",
  "scrapling-page",
  "kickstarter-comments",
] as const;

export type ValidationCapability = "base" | "markdown" | "screenshot" | "structured";

export interface CaptureValidationRuleForm {
  enabled: boolean;
  minLength: string;
  minBytes: string;
  rejectRegexText: string;
  requireRegexText: string;
}

export interface ValidationConfigForm {
  base: CaptureValidationRuleForm;
  markdown: CaptureValidationRuleForm;
  screenshot: CaptureValidationRuleForm;
  structured: CaptureValidationRuleForm;
}

export interface CaptureProfileFormItem {
  key: string;
  name: string;
  toolsText: string;
  validationEnabled: boolean;
  validation: ValidationConfigForm;
}

export interface BrowserFormState {
  engine: "chromium" | "cloakbrowser" | "lightpanda";
  profileMode: "ephemeral" | "persistent" | "storage_state";
  reuse: "run_browser" | "site_browser";
  contextReuse: "site_session_proxy" | "site_run";
  proxyBinding: "session" | "none";
}

export interface ProxyPolicyFormState {
  mode: "off" | "always" | "retry_on_failure";
  provider: "crawlee" | "apify" | "";
}

export interface CaptureConfigFormState {
  captureProfilesEnabled: boolean;
  profiles: CaptureProfileFormItem[];
  defaultCaptureProfile: string;
  validationEnabled: boolean;
  validation: ValidationConfigForm;
  browserEnabled: boolean;
  browser: BrowserFormState;
  proxyPolicyEnabled: boolean;
  proxyPolicy: ProxyPolicyFormState;
}

export interface CaptureValidationRuleApi {
  minLength?: number;
  minBytes?: number;
  rejectRegex?: string[];
  requireRegex?: string[];
}

export interface CaptureValidationConfigApi {
  base?: CaptureValidationRuleApi;
  markdown?: CaptureValidationRuleApi;
  screenshot?: CaptureValidationRuleApi;
  structured?: CaptureValidationRuleApi;
}

export interface CaptureProfileConfigApi {
  tools: string[];
  validation?: CaptureValidationConfigApi;
}

export interface SiteConfigM2Fields {
  captureProfiles?: Record<string, CaptureProfileConfigApi>;
  defaultCaptureProfile?: string;
  validation?: CaptureValidationConfigApi;
  browser?: BrowserFormState & { pageReuse: "none" };
  proxyPolicy?: {
    mode: ProxyPolicyFormState["mode"];
    provider?: "crawlee" | "apify";
  };
}

function linesToArray(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function arrayToLines(value: string[] | undefined): string {
  return (value ?? []).join("\n");
}

function emptyValidationRule(): CaptureValidationRuleForm {
  return {
    enabled: false,
    minLength: "",
    minBytes: "",
    rejectRegexText: "",
    requireRegexText: "",
  };
}

export function emptyValidationConfigForm(): ValidationConfigForm {
  return {
    base: emptyValidationRule(),
    markdown: emptyValidationRule(),
    screenshot: emptyValidationRule(),
    structured: emptyValidationRule(),
  };
}

export function defaultBrowserFormState(): BrowserFormState {
  return {
    engine: "chromium",
    profileMode: "ephemeral",
    reuse: "run_browser",
    contextReuse: "site_session_proxy",
    proxyBinding: "session",
  };
}

function validationRuleToForm(rule?: CaptureValidationRuleApi): CaptureValidationRuleForm {
  if (!rule) return emptyValidationRule();
  return {
    enabled: true,
    minLength: rule.minLength === undefined ? "" : String(rule.minLength),
    minBytes: rule.minBytes === undefined ? "" : String(rule.minBytes),
    rejectRegexText: arrayToLines(rule.rejectRegex),
    requireRegexText: arrayToLines(rule.requireRegex),
  };
}

function validationRuleFromForm(form: CaptureValidationRuleForm): CaptureValidationRuleApi | undefined {
  if (!form.enabled) return undefined;

  const rule: CaptureValidationRuleApi = {};
  if (form.minLength.trim()) {
    rule.minLength = Number(form.minLength);
  }
  if (form.minBytes.trim()) {
    rule.minBytes = Number(form.minBytes);
  }
  const rejectRegex = linesToArray(form.rejectRegexText);
  const requireRegex = linesToArray(form.requireRegexText);
  if (rejectRegex.length > 0) rule.rejectRegex = rejectRegex;
  if (requireRegex.length > 0) rule.requireRegex = requireRegex;

  const hasValue = rule.minLength !== undefined
    || rule.minBytes !== undefined
    || rule.rejectRegex !== undefined
    || rule.requireRegex !== undefined;
  return hasValue ? rule : undefined;
}

function validationConfigToForm(config?: CaptureValidationConfigApi): ValidationConfigForm {
  const empty = emptyValidationConfigForm();
  if (!config) return empty;
  return {
    base: config.base ? validationRuleToForm(config.base) : empty.base,
    markdown: config.markdown ? validationRuleToForm(config.markdown) : empty.markdown,
    screenshot: config.screenshot ? validationRuleToForm(config.screenshot) : empty.screenshot,
    structured: config.structured ? validationRuleToForm(config.structured) : empty.structured,
  };
}

function validationConfigHasEnabledRule(form: ValidationConfigForm): boolean {
  return (["base", "markdown", "screenshot", "structured"] as ValidationCapability[])
    .some((key) => form[key].enabled);
}

function validationConfigFromForm(form: ValidationConfigForm): CaptureValidationConfigApi | undefined {
  const config: CaptureValidationConfigApi = {};
  for (const key of ["base", "markdown", "screenshot", "structured"] as ValidationCapability[]) {
    const rule = validationRuleFromForm(form[key]);
    if (rule) config[key] = rule;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function createProfileFormItem(name: string, profile?: CaptureProfileConfigApi): CaptureProfileFormItem {
  const validation = validationConfigToForm(profile?.validation);
  return {
    key: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    toolsText: arrayToLines(profile?.tools),
    validationEnabled: validationConfigHasEnabledRule(validation),
    validation,
  };
}

export function captureConfigFromApi(config: SiteConfigM2Fields): CaptureConfigFormState {
  const profiles = Object.entries(config.captureProfiles ?? {}).map(([name, profile]) =>
    createProfileFormItem(name, profile),
  );
  const validation = validationConfigToForm(config.validation);
  const browser = config.browser
    ? {
      engine: config.browser.engine,
      profileMode: config.browser.profileMode,
      reuse: config.browser.reuse ?? "run_browser",
      contextReuse: config.browser.contextReuse ?? "site_session_proxy",
      proxyBinding: config.browser.proxyBinding ?? "session",
    }
    : defaultBrowserFormState();

  return {
    captureProfilesEnabled: profiles.length > 0,
    profiles,
    defaultCaptureProfile: config.defaultCaptureProfile ?? (profiles[0]?.name ?? ""),
    validationEnabled: validationConfigHasEnabledRule(validation),
    validation,
    browserEnabled: config.browser !== undefined,
    browser,
    proxyPolicyEnabled: config.proxyPolicy !== undefined,
    proxyPolicy: {
      mode: config.proxyPolicy?.mode ?? "off",
      provider: config.proxyPolicy?.provider ?? "",
    },
  };
}

export function captureConfigToApi(state: CaptureConfigFormState): SiteConfigM2Fields {
  const result: SiteConfigM2Fields = {};

  if (state.captureProfilesEnabled && state.profiles.length > 0) {
    const captureProfiles: Record<string, CaptureProfileConfigApi> = {};
    for (const profile of state.profiles) {
      const name = profile.name.trim();
      if (!name) continue;
      const entry: CaptureProfileConfigApi = {
        tools: linesToArray(profile.toolsText),
      };
      if (profile.validationEnabled) {
        const validation = validationConfigFromForm(profile.validation);
        if (validation) entry.validation = validation;
      }
      captureProfiles[name] = entry;
    }
    if (Object.keys(captureProfiles).length > 0) {
      result.captureProfiles = captureProfiles;
      const defaultName = state.defaultCaptureProfile.trim();
      if (defaultName && captureProfiles[defaultName]) {
        result.defaultCaptureProfile = defaultName;
      }
    }
  }

  if (state.validationEnabled) {
    const validation = validationConfigFromForm(state.validation);
    if (validation) result.validation = validation;
  }

  if (state.browserEnabled) {
    result.browser = {
      ...state.browser,
      pageReuse: "none",
    };
  }

  if (state.proxyPolicyEnabled) {
    result.proxyPolicy = {
      mode: state.proxyPolicy.mode,
      ...(state.proxyPolicy.mode !== "off" && state.proxyPolicy.provider
        ? { provider: state.proxyPolicy.provider }
        : {}),
    };
  }

  return result;
}

export function createEmptyProfileFormItem(): CaptureProfileFormItem {
  return createProfileFormItem("default");
}

export function validationCapabilityLabel(capability: ValidationCapability): string {
  switch (capability) {
    case "base":
      return "Base";
    case "markdown":
      return "Markdown";
    case "screenshot":
      return "截图";
    case "structured":
      return "结构化";
  }
}
