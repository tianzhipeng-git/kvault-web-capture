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

export interface CaptureProfileFormState {
  toolsText: string;
}

export interface BrowserFormState {
  engine: "chromium" | "cloakbrowser" | "lightpanda";
  profileMode: "ephemeral" | "persistent" | "storage_state";
  cdpPoolSize: number;
  reuse: "run_browser" | "site_browser";
  contextReuse: "site_session_proxy" | "site_run";
  proxyBinding: "session" | "none";
}

export interface ProxyPolicyFormState {
  mode: "off" | "always" | "retry_on_failure";
  provider: "crawlee" | "apify" | "";
}

export interface CaptureConfigFormState {
  captureProfileEnabled: boolean;
  captureProfile: CaptureProfileFormState;
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
}

export interface SiteConfigM2Fields {
  captureProfile?: CaptureProfileConfigApi;
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
    cdpPoolSize: 1,
    reuse: "run_browser",
    contextReuse: "site_session_proxy",
    proxyBinding: "session",
  };
}

function validationRuleToForm(
  rule: CaptureValidationRuleApi | undefined,
  capability: ValidationCapability,
): CaptureValidationRuleForm {
  if (!rule) return emptyValidationRule();
  const supportsRegex = capability !== "screenshot";
  return {
    enabled: true,
    minLength: rule.minLength === undefined ? "" : String(rule.minLength),
    minBytes: rule.minBytes === undefined ? "" : String(rule.minBytes),
    rejectRegexText: supportsRegex ? arrayToLines(rule.rejectRegex) : "",
    requireRegexText: supportsRegex ? arrayToLines(rule.requireRegex) : "",
  };
}

function validationRuleFromForm(
  form: CaptureValidationRuleForm,
  capability: ValidationCapability,
): CaptureValidationRuleApi | undefined {
  if (!form.enabled) return undefined;

  const rule: CaptureValidationRuleApi = {};
  if (form.minLength.trim()) {
    rule.minLength = Number(form.minLength);
  }
  if (form.minBytes.trim()) {
    rule.minBytes = Number(form.minBytes);
  }
  if (capability !== "screenshot") {
    const rejectRegex = linesToArray(form.rejectRegexText);
    const requireRegex = linesToArray(form.requireRegexText);
    if (rejectRegex.length > 0) rule.rejectRegex = rejectRegex;
    if (requireRegex.length > 0) rule.requireRegex = requireRegex;
  }

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
    base: config.base ? validationRuleToForm(config.base, "base") : empty.base,
    markdown: config.markdown ? validationRuleToForm(config.markdown, "markdown") : empty.markdown,
    screenshot: config.screenshot ? validationRuleToForm(config.screenshot, "screenshot") : empty.screenshot,
    structured: config.structured ? validationRuleToForm(config.structured, "structured") : empty.structured,
  };
}

function validationConfigHasEnabledRule(form: ValidationConfigForm): boolean {
  return (["base", "markdown", "screenshot", "structured"] as ValidationCapability[])
    .some((key) => form[key].enabled);
}

function validationConfigFromForm(form: ValidationConfigForm): CaptureValidationConfigApi | undefined {
  const config: CaptureValidationConfigApi = {};
  for (const key of ["base", "markdown", "screenshot", "structured"] as ValidationCapability[]) {
    const rule = validationRuleFromForm(form[key], key);
    if (rule) config[key] = rule;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function captureProfileToForm(profile?: CaptureProfileConfigApi): CaptureProfileFormState {
  return {
    toolsText: arrayToLines(profile?.tools),
  };
}

export function captureConfigFromApi(config: SiteConfigM2Fields): CaptureConfigFormState {
  const validation = validationConfigToForm(config.validation);
  const browser = config.browser
    ? {
      engine: config.browser.engine,
      profileMode: config.browser.profileMode,
      cdpPoolSize: config.browser.cdpPoolSize ?? 1,
      reuse: config.browser.reuse ?? "run_browser",
      contextReuse: config.browser.contextReuse ?? "site_session_proxy",
      proxyBinding: config.browser.proxyBinding ?? "session",
    }
    : defaultBrowserFormState();

  return {
    captureProfileEnabled: config.captureProfile !== undefined,
    captureProfile: captureProfileToForm(config.captureProfile),
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

  if (state.captureProfileEnabled) {
    const captureProfile: CaptureProfileConfigApi = {
      tools: linesToArray(state.captureProfile.toolsText),
    };
    result.captureProfile = captureProfile;
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
