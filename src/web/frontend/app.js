const state = {
  authenticated: false,
  loading: false,
  message: '',
  error: '',
  projects: [],
  sites: [],
  selectedProjectId: null,
  selectedSiteId: null,
  siteOverview: null,
  siteConfig: null,
  siteRuns: [],
  pages: null,
  pendingReview: [],
  sampleCaptures: [],
  runDetail: null,
  pageFilter: {
    status: '',
    query: '',
  },
};

const app = document.querySelector('#app');

function setState(patch) {
  Object.assign(state, patch);
  render();
}

function setMessage(message) {
  state.message = message;
  state.error = '';
  render();
}

function setError(error) {
  state.error = error;
  state.message = '';
  render();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  if (response.status === 401) {
    setState({ authenticated: false });
    throw new Error('登录已过期，请重新输入管理密码。');
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || '请求失败。');
  }

  return data;
}

function splitLines(value) {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

async function bootstrap() {
  try {
    const session = await api('/api/auth/session', {
      headers: {},
    });
    setState({ authenticated: session.authenticated });

    if (session.authenticated) {
      await loadProjects();
    }
  } catch (error) {
    setError(error.message);
  }
}

async function loadProjects() {
  const data = await api('/api/projects');
  state.projects = data.items;

  if (!state.selectedProjectId && data.items[0]) {
    state.selectedProjectId = data.items[0].projectId;
  }

  if (state.selectedProjectId) {
    await loadSites(state.selectedProjectId);
  } else {
    render();
  }
}

async function loadSites(projectId) {
  const data = await api(`/api/projects/${projectId}/sites`);
  state.sites = data.items;
  state.selectedProjectId = projectId;

  if (!state.selectedSiteId || !data.items.some((item) => item.siteId === state.selectedSiteId)) {
    state.selectedSiteId = data.items[0]?.siteId ?? null;
  }

  if (state.selectedSiteId) {
    await loadSiteWorkspace(state.selectedSiteId);
  } else {
    render();
  }
}

async function loadSiteWorkspace(siteId) {
  const [overview, config, runs, pages, pendingReview, sampleCaptures] = await Promise.all([
    api(`/api/sites/${siteId}/overview`),
    api(`/api/sites/${siteId}/config`),
    api(`/api/sites/${siteId}/runs`),
    api(`/api/sites/${siteId}/pages?page=1&pageSize=20&status=${encodeURIComponent(state.pageFilter.status)}&query=${encodeURIComponent(state.pageFilter.query)}`),
    api(`/api/sites/${siteId}/pending-review`),
    api(`/api/sites/${siteId}/sample-captures?limit=5`),
  ]);

  setState({
    selectedSiteId: siteId,
    siteOverview: overview,
    siteConfig: config,
    siteRuns: runs.items,
    pages,
    pendingReview: pendingReview.items,
    sampleCaptures: sampleCaptures.items,
  });
}

async function refreshCurrentSite() {
  if (!state.selectedSiteId) {
    return;
  }

  await loadSiteWorkspace(state.selectedSiteId);
}

async function submitLogin(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        password: String(form.get('password') || ''),
      }),
    });
    setState({ authenticated: true });
    await loadProjects();
    setMessage('已登录到管理台。');
  } catch (error) {
    setError(error.message);
  }
}

async function submitProject(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  try {
    await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: String(form.get('name') || ''),
      }),
    });
    event.currentTarget.reset();
    await loadProjects();
    setMessage('项目已创建。');
  } catch (error) {
    setError(error.message);
  }
}

async function submitSite(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  try {
    await api('/api/sites', {
      method: 'POST',
      body: JSON.stringify({
        projectId: state.selectedProjectId,
        name: String(form.get('name') || ''),
        baseUrl: String(form.get('baseUrl') || ''),
        storageRoot: String(form.get('storageRoot') || ''),
      }),
    });
    event.currentTarget.reset();
    await loadSites(state.selectedProjectId);
    setMessage('站点已创建，可以开始准备配置。');
  } catch (error) {
    setError(error.message);
  }
}

async function saveConfig(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  try {
    const config = {
      seedUrls: splitLines(String(form.get('seedUrls') || '')),
      sitemaps: splitLines(String(form.get('sitemaps') || '')),
      rulesBeforeBaseEq: JSON.parse(String(form.get('rulesBeforeBaseEq') || '[]')),
      rulesBeforeStage2Eq: JSON.parse(String(form.get('rulesBeforeStage2Eq') || '[]')),
      runOptions: {
        seedMaxDepth: Number(form.get('seedMaxDepth') || 1),
        crawlMaxDepth: Number(form.get('crawlMaxDepth') || 2),
      },
    };

    await api(`/api/sites/${state.selectedSiteId}/config`, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
    await refreshCurrentSite();
    setMessage('配置已保存。现在可以先做初步摸底。');
  } catch (error) {
    setError(error.message);
  }
}

async function startSeedRun() {
  try {
    const result = await api(`/api/sites/${state.selectedSiteId}/runs/seed`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setMessage(`已开始初步摸底，运行编号 ${result.runId}。`);
    await refreshCurrentSite();
  } catch (error) {
    setError(error.message);
  }
}

async function startCrawlRun() {
  try {
    const result = await api(`/api/sites/${state.selectedSiteId}/runs/crawl`, {
      method: 'POST',
      body: JSON.stringify({
        updatePolicy: 'force_recrawl_all',
      }),
    });
    setMessage(`已启动正式采集，运行编号 ${result.runId}。`);
    await refreshCurrentSite();
  } catch (error) {
    setError(error.message);
  }
}

async function logout() {
  await api('/api/auth/logout', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  setState({
    authenticated: false,
    projects: [],
    sites: [],
    selectedProjectId: null,
    selectedSiteId: null,
    siteOverview: null,
    siteConfig: null,
    siteRuns: [],
    pages: null,
    pendingReview: [],
    sampleCaptures: [],
    runDetail: null,
  });
}

async function openRun(runId) {
  try {
    const detail = await api(`/api/runs/${runId}`);
    setState({ runDetail: detail });
  } catch (error) {
    setError(error.message);
  }
}

function closeRun() {
  setState({ runDetail: null });
}

async function applyPageFilter(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  state.pageFilter.status = String(form.get('status') || '');
  state.pageFilter.query = String(form.get('query') || '');
  await refreshCurrentSite();
}

function renderLogin() {
  app.innerHTML = `
    <div class="login-wrap">
      <form class="login-card stack" id="login-form">
        <div>
          <div class="pill">KVault 采集管理台</div>
          <h1>先登录，再安排站点采集</h1>
          <p class="muted">第一版使用简单密码保护，适合本机或受控环境中的业务工作台。</p>
        </div>
        ${state.error ? `<div class="notice">${state.error}</div>` : ''}
        <label class="field">
          <span>管理密码</span>
          <input type="password" name="password" placeholder="请输入启动服务时配置的管理密码" />
        </label>
        <button type="submit">进入管理台</button>
      </form>
    </div>
  `;
  document.querySelector('#login-form').addEventListener('submit', submitLogin);
}

function renderProjectPanel() {
  return `
    <div class="panel stack">
      <div>
        <h2>项目</h2>
        <p class="muted">先按业务项目来组织站点，方便不同站点复用配置。</p>
      </div>
      <div class="site-list">
        ${
          state.projects.length === 0
            ? '<div class="empty">还没有项目，先创建一个。</div>'
            : state.projects
                .map(
                  (project) => `
                    <button class="secondary ${state.selectedProjectId === project.projectId ? 'active' : ''}" data-project-id="${project.projectId}">
                      <strong>${project.projectName}</strong><br />
                      <span class="muted">${project.siteCount} 个站点</span>
                    </button>
                  `,
                )
                .join('')
        }
      </div>
      <form class="stack" id="project-form">
        <div class="field">
          <span>新项目名称</span>
          <input name="name" placeholder="例如：Apple 文档采集" />
        </div>
        <button type="submit">创建项目</button>
      </form>
      <form class="stack" id="site-form">
        <div>
          <h3>快速创建站点</h3>
          <p class="muted">填写基础网址和存储目录后，后面再通过步骤页补齐采集配置。</p>
        </div>
        <div class="field">
          <span>站点名称</span>
          <input name="name" placeholder="例如：Apple 文档站" />
        </div>
        <div class="field">
          <span>基础网址</span>
          <input name="baseUrl" placeholder="https://example.com" />
        </div>
        <div class="field">
          <span>本地存储目录</span>
          <input name="storageRoot" placeholder=".local/apple-storage" />
        </div>
        <button type="submit" ${state.selectedProjectId ? '' : 'disabled'}>创建站点</button>
      </form>
    </div>
  `;
}

function renderSiteSidebar() {
  return `
    <div class="panel stack">
      <div>
        <h2>站点</h2>
        <p class="muted">项目下的业务站点，展示当前阶段和主要进展。</p>
      </div>
      <div class="site-list">
        ${
          state.sites.length === 0
            ? '<div class="empty">当前项目还没有站点。</div>'
            : state.sites
                .map(
                  (site) => `
                    <div class="site-row ${site.siteId === state.selectedSiteId ? 'active' : ''}" data-site-id="${site.siteId}">
                      <strong>${site.siteName}</strong>
                      <div class="muted">${site.baseUrl}</div>
                      <div class="pill-row">
                        <span class="pill">${site.siteStatusLabel}</span>
                        <span class="pill warn">待确认 ${site.pagesNeedReview}</span>
                      </div>
                    </div>
                  `,
                )
                .join('')
        }
      </div>
    </div>
  `;
}

function renderOverview() {
  if (!state.siteOverview) {
    return '<div class="panel"><div class="empty">请选择一个站点。</div></div>';
  }

  return `
    <div class="stack">
      <div class="panel">
        <div class="hero">
          <div>
            <div class="pill">${state.siteOverview.projectName}</div>
            <h1>${state.siteOverview.siteName}</h1>
            <p>${state.siteOverview.baseUrl}</p>
          </div>
          <div class="actions">
            <button class="secondary" id="refresh-site">刷新数据</button>
            <button id="start-seed">开始初步摸底</button>
            <button id="start-crawl">启动正式采集</button>
          </div>
        </div>
        <div class="pill-row">
          <span class="pill">${state.siteOverview.siteStatusLabel}</span>
          <span class="pill">可采集页面 ${state.siteOverview.pagesReadyForCapture}</span>
          <span class="pill warn">待确认 ${state.siteOverview.pagesNeedReview}</span>
        </div>
        <div class="stats">
          <div class="stat"><span>全部页面</span><strong>${state.siteOverview.totalPages}</strong></div>
          <div class="stat"><span>已完成采集</span><strong>${state.siteOverview.pagesCaptured}</strong></div>
          <div class="stat"><span>不采集</span><strong>${state.siteOverview.pagesExcluded}</strong></div>
          <div class="stat"><span>最近成功采集</span><strong>${state.siteOverview.latestSuccessfulCaptureAt ? new Date(state.siteOverview.latestSuccessfulCaptureAt).toLocaleString() : '尚无'}</strong></div>
        </div>
      </div>

      <div class="step-grid">
        ${state.siteOverview.workflowSteps
          .map(
            (step) => `
              <div class="step-card">
                <div class="status">${step.status === 'done' ? '已完成' : step.status === 'active' ? '进行中' : '待开始'}</div>
                <h3>${step.title}</h3>
                <p class="muted">${step.description}</p>
              </div>
            `,
          )
          .join('')}
      </div>

      <div class="two-col">
        <div class="panel">
          <h3>当前配置摘要</h3>
          <div class="stats">
            <div class="stat"><span>起始页面</span><strong>${state.siteOverview.configSummary.seedUrlCount}</strong></div>
            <div class="stat"><span>站点地图</span><strong>${state.siteOverview.configSummary.sitemapCount}</strong></div>
            <div class="stat"><span>范围规则</span><strong>${state.siteOverview.configSummary.preFilterRuleCount}</strong></div>
            <div class="stat"><span>采集规则</span><strong>${state.siteOverview.configSummary.captureRuleCount}</strong></div>
          </div>
        </div>
        <div class="panel">
          <h3>规则提醒</h3>
          ${
            state.siteOverview.ruleReviewHints.length === 0
              ? '<div class="empty">当前没有明显阻塞，可以继续推进正式采集。</div>'
              : `<ul class="hint-list">${state.siteOverview.ruleReviewHints.map((item) => `<li>${item}</li>`).join('')}</ul>`
          }
        </div>
      </div>
    </div>
  `;
}

function renderConfigEditor() {
  if (!state.siteConfig) {
    return '';
  }

  return `
    <div class="panel stack">
      <div>
        <h2>配置向导</h2>
        <p class="muted">按业务步骤整理配置。每个字段都尽量用业务语言说明影响范围。</p>
      </div>
      <form class="stack" id="config-form">
        <div class="three-col">
          <div class="field">
            <span>1. 起始页面</span>
            <small>放最重要的入口页面，一行一个网址。</small>
            <textarea name="seedUrls">${state.siteConfig.seedUrls.join('\n')}</textarea>
          </div>
          <div class="field">
            <span>2. 站点地图</span>
            <small>如果站点有 sitemap，这里填进去能更快完成初步摸底。</small>
            <textarea name="sitemaps">${state.siteConfig.sitemaps.join('\n')}</textarea>
          </div>
          <div class="field">
            <span>3. 页面范围规则</span>
            <small>先定义哪些 URL 明确不采集或必须纳入范围。</small>
            <textarea name="rulesBeforeBaseEq">${jsonText(state.siteConfig.rulesBeforeBaseEq)}</textarea>
          </div>
        </div>
        <div class="two-col">
          <div class="field">
            <span>4. 页面分类与采集方式</span>
            <small>根据标签或 URL 决定是否继续深入采集，以及需要什么采集结果。</small>
            <textarea name="rulesBeforeStage2Eq">${jsonText(state.siteConfig.rulesBeforeStage2Eq)}</textarea>
          </div>
          <div class="stack">
            <div class="field">
              <span>5. 初步摸底深度</span>
              <small>数字越大，初步摸底时会沿链接继续扩展更多页面。</small>
              <input type="number" min="0" name="seedMaxDepth" value="${state.siteConfig.runOptions.seedMaxDepth}" />
            </div>
            <div class="field">
              <span>6. 正式采集深度</span>
              <small>数字越大，正式采集时会继续深入发现的页面。</small>
              <input type="number" min="0" name="crawlMaxDepth" value="${state.siteConfig.runOptions.crawlMaxDepth}" />
            </div>
            <div class="notice">
              这里的规则区先用 JSON 编辑，便于直接复用当前 M1 配置结构；后续可以再升级成更友好的图形化规则编辑器。
            </div>
          </div>
        </div>
        <div class="actions">
          <button type="submit">保存配置</button>
        </div>
      </form>
    </div>
  `;
}

function renderPages() {
  if (!state.pages) {
    return '';
  }

  return `
    <div class="table-card stack">
      <div>
        <h3>页面清单</h3>
        <p class="muted">业务审核页，重点看当前页面是否需要继续采集，而不是底层任务明细。</p>
      </div>
      <form class="tabs" id="page-filter-form">
        <select name="status">
          <option value="">全部页面</option>
          <option value="stage2_pending" ${state.pageFilter.status === 'stage2_pending' ? 'selected' : ''}>待确认</option>
          <option value="url_rule_denied" ${state.pageFilter.status === 'url_rule_denied' ? 'selected' : ''}>不采集</option>
          <option value="stage2_captured" ${state.pageFilter.status === 'stage2_captured' ? 'selected' : ''}>已完成采集</option>
        </select>
        <input name="query" value="${state.pageFilter.query}" placeholder="按标题或网址搜索" />
        <button type="submit">筛选</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>页面</th>
            <th>状态</th>
            <th>标签</th>
            <th>最近结果</th>
            <th>采集结果</th>
          </tr>
        </thead>
        <tbody>
          ${
            state.pages.rows.length === 0
              ? '<tr><td colspan="5"><div class="empty">当前筛选条件下没有页面。</div></td></tr>'
              : state.pages.rows
                  .map(
                    (row) => `
                      <tr>
                        <td><strong>${row.title}</strong><br /><span class="muted">${row.url}</span></td>
                        <td>${row.businessStatus}${row.pendingReasonLabel ? `<br /><span class="muted">${row.pendingReasonLabel}</span>` : ''}</td>
                        <td>${row.tags.join('<br />') || '<span class="muted">暂无</span>'}</td>
                        <td>${row.latestOutcome}<br /><span class="muted">${row.latestHandledAt ? new Date(row.latestHandledAt).toLocaleString() : '尚无'}</span></td>
                        <td>${row.captureSummary}</td>
                      </tr>
                    `,
                  )
                  .join('')
          }
        </tbody>
      </table>
    </div>
  `;
}

function renderPendingReview() {
  return `
    <div class="panel stack">
      <div>
        <h3>待确认页面</h3>
        <p class="muted">这里只展示业务人员需要处理的卡点，而不是单独展示底层 Page Runs。</p>
      </div>
      <div class="group-list">
        ${
          state.pendingReview.length === 0
            ? '<div class="empty">当前没有待确认页面。</div>'
            : state.pendingReview
                .map(
                  (group) => `
                    <div class="group-card">
                      <div class="pill-row">
                        <span class="pill warn">${group.reasonLabel}</span>
                        <span class="pill">数量 ${group.count}</span>
                      </div>
                      <p>${group.nextAction}</p>
                      ${group.pages
                        .map(
                          (page) => `
                            <div class="site-row">
                              <strong>${page.title}</strong>
                              <div class="muted">${page.url}</div>
                              <div class="muted">${page.preview || '暂无预览'}</div>
                            </div>
                          `,
                        )
                        .join('')}
                    </div>
                  `,
                )
                .join('')
        }
      </div>
    </div>
  `;
}

function renderRuns() {
  return `
    <div class="panel stack">
      <div>
        <h3>运行记录</h3>
        <p class="muted">把“初步摸底”和“正式采集”统一展示成业务记录，避免暴露底层技术任务名词。</p>
      </div>
      <div class="run-list">
        ${
          state.siteRuns.length === 0
            ? '<div class="empty">还没有运行记录。</div>'
            : state.siteRuns
                .map(
                  (run) => `
                    <div class="run-row">
                      <strong>${run.runTypeLabel}</strong>
                      <div class="muted">${run.statusLabel} · ${new Date(run.startedAt).toLocaleString()}</div>
                      <div class="pill-row">
                        <span class="pill">成功 ${run.successfulPages}</span>
                        <span class="pill warn">待确认 ${run.pendingPages}</span>
                        <span class="pill">不采集 ${run.deniedPages}</span>
                      </div>
                      <div class="actions">
                        <button class="secondary" data-open-run="${run.runId}">查看本轮结果</button>
                      </div>
                    </div>
                  `,
                )
                .join('')
        }
      </div>
    </div>
  `;
}

function renderCaptures() {
  return `
    <div class="panel stack">
      <div>
        <h3>采集结果样本</h3>
        <p class="muted">这里用样本帮助业务确认抓取结果是否符合预期。</p>
      </div>
      <div class="group-list">
        ${
          state.sampleCaptures.length === 0
            ? '<div class="empty">还没有样本。</div>'
            : state.sampleCaptures
                .map(
                  (capture) => `
                    <div class="group-card">
                      <strong>${capture.title}</strong>
                      <div class="muted">${capture.normalizedUrl}</div>
                      <div>${capture.metaDescription}</div>
                      <div class="muted">${capture.bodyText.slice(0, 160)}</div>
                    </div>
                  `,
                )
                .join('')
        }
      </div>
    </div>
  `;
}

function renderDrawer() {
  if (!state.runDetail) {
    return '';
  }

  return `
    <aside class="drawer">
      <div class="actions" style="justify-content:space-between;">
        <div>
          <div class="pill">${state.runDetail.runTypeLabel}</div>
          <h2>本轮结果</h2>
        </div>
        <button class="secondary" id="close-drawer">关闭</button>
      </div>
      <div class="stats">
        <div class="stat"><span>状态</span><strong>${state.runDetail.statusLabel}</strong></div>
        <div class="stat"><span>成功页面</span><strong>${state.runDetail.successfulPages}</strong></div>
        <div class="stat"><span>待确认</span><strong>${state.runDetail.pendingPages}</strong></div>
        <div class="stat"><span>不采集</span><strong>${state.runDetail.deniedPages}</strong></div>
      </div>
      <div class="panel" style="margin-top:16px;">
        <h3>配置摘要</h3>
        <p class="muted">起始页面 ${state.runDetail.configSummary.seedUrlCount} 个，站点地图 ${state.runDetail.configSummary.sitemapCount} 个。</p>
        <p class="muted">摸底深度 ${state.runDetail.configSummary.seedDepth}，正式采集深度 ${state.runDetail.configSummary.crawlDepth}。</p>
      </div>
      <div class="panel" style="margin-top:16px;">
        <h3>重点问题</h3>
        ${
          state.runDetail.issues.length === 0
            ? '<div class="empty">本轮没有明显阻塞。</div>'
            : `<ul class="hint-list">${state.runDetail.issues.map((item) => `<li>${item}</li>`).join('')}</ul>`
        }
      </div>
    </aside>
  `;
}

function renderShell() {
  app.innerHTML = `
    <div class="shell">
      <div class="topbar">
        <div>
          <div class="pill">面向业务人员的流程化采集台</div>
          <div class="muted">先准备站点，再摸底、确认规则、启动正式采集。</div>
        </div>
        <div class="actions">
          ${state.message ? `<span class="pill">${state.message}</span>` : ''}
          ${state.error ? `<span class="pill warn">${state.error}</span>` : ''}
          <button class="secondary" id="logout-button">退出</button>
        </div>
      </div>
      <div class="grid">
        <div class="stack">
          ${renderProjectPanel()}
          ${renderSiteSidebar()}
        </div>
        <div class="stack">
          ${renderOverview()}
          ${renderConfigEditor()}
          ${renderPages()}
          <div class="two-col">
            ${renderPendingReview()}
            ${renderCaptures()}
          </div>
          ${renderRuns()}
        </div>
      </div>
      ${renderDrawer()}
    </div>
  `;

  document.querySelector('#logout-button')?.addEventListener('click', logout);
  document.querySelector('#project-form')?.addEventListener('submit', submitProject);
  document.querySelector('#site-form')?.addEventListener('submit', submitSite);
  document.querySelector('#config-form')?.addEventListener('submit', saveConfig);
  document.querySelector('#start-seed')?.addEventListener('click', startSeedRun);
  document.querySelector('#start-crawl')?.addEventListener('click', startCrawlRun);
  document.querySelector('#refresh-site')?.addEventListener('click', refreshCurrentSite);
  document.querySelector('#page-filter-form')?.addEventListener('submit', applyPageFilter);
  document.querySelector('#close-drawer')?.addEventListener('click', closeRun);

  document.querySelectorAll('[data-project-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      await loadSites(Number(button.getAttribute('data-project-id')));
    });
  });

  document.querySelectorAll('[data-site-id]').forEach((element) => {
    element.addEventListener('click', async () => {
      await loadSiteWorkspace(Number(element.getAttribute('data-site-id')));
    });
  });

  document.querySelectorAll('[data-open-run]').forEach((button) => {
    button.addEventListener('click', async () => {
      await openRun(Number(button.getAttribute('data-open-run')));
    });
  });
}

function render() {
  if (!state.authenticated) {
    renderLogin();
    return;
  }

  renderShell();
}

bootstrap();
