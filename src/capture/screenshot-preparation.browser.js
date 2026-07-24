async function kvaultScreenshotPreparation(payload) {
  const stateKey = '__kvaultScreenshotPreparationState';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  if (payload.action === 'cleanup') {
    const state = globalThis[stateKey];
    if (!state) return;
    state.observer?.disconnect();
    for (const entry of state.styles.reverse()) {
      entry.element.setAttribute('style', entry.style);
      if (entry.style === null) entry.element.removeAttribute('style');
    }
    state.animationStyle?.remove();
    delete globalThis[stateKey];
    return;
  }

  const config = payload.config;
  const startedAt = performance.now();
  const deadline = startedAt + config.timeoutMs;
  const warnings = [];
  const state = { styles: [], mutationCount: 0 };
  globalThis[stateKey] = state;

  const animationStyle = document.createElement('style');
  animationStyle.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;scroll-behavior:auto!important}';
  document.documentElement.appendChild(animationStyle);
  state.animationStyle = animationStyle;
  state.observer = new MutationObserver(() => { state.mutationCount += 1; });
  state.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
  });

  const timedOut = () => performance.now() >= deadline;
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const documentHeight = () => Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight ?? 0,
  );
  const pendingImages = () => [...document.images].filter((image) =>
    !image.complete || image.naturalWidth === 0
  );
  const waitForImages = async () => {
    if (!config.waitForImages) return;
    const images = pendingImages();
    await Promise.all(images.map(async (image) => {
      try {
        await Promise.race([
          image.decode(),
          sleep(Math.min(config.settleMs * 2, Math.max(0, deadline - performance.now()))),
        ]);
      } catch {
        warnings.push(`image decode failed: ${image.currentSrc || image.src || '(unknown)'}`);
      }
    }));
  };
  const waitForSettle = async () => {
    await waitForImages();
    if (!timedOut() && config.settleMs > 0) {
      await sleep(Math.min(config.settleMs, Math.max(0, deadline - performance.now())));
    }
  };
  const containers = () => [...document.querySelectorAll('*')].filter((element) => {
    if (!(element instanceof HTMLElement) || element.matches('textarea,select')) return false;
    const style = getComputedStyle(element);
    return visible(element) &&
      element.clientHeight >= 40 &&
      element.scrollHeight > element.clientHeight + 2 &&
      ['auto', 'scroll', 'overlay'].includes(style.overflowY);
  }).sort((left, right) => {
    const depth = (element) => {
      let count = 0;
      for (let node = element; node; node = node.parentElement) count += 1;
      return count;
    };
    return depth(right) - depth(left);
  });

  let fontsReady = !config.waitForFonts || !document.fonts;
  if (config.waitForFonts && document.fonts) {
    try {
      await Promise.race([
        document.fonts.ready.then(() => { fontsReady = true; }),
        sleep(Math.max(0, deadline - performance.now())),
      ]);
    } catch {
      warnings.push('document fonts did not become ready');
    }
  }
  await waitForImages();

  const found = new Set();
  const completed = new Set();
  let rounds = 0;
  let limitReason = null;
  const enforceLimit = () => {
    if (timedOut()) limitReason = 'timeout';
    else if (rounds >= config.maxScrollRounds) limitReason = 'maxScrollRounds';
    else if (documentHeight() > config.maxCaptureHeight) limitReason = 'maxCaptureHeight';
    return limitReason !== null;
  };

  if (config.scrollContainers) {
    let rescansStable = 0;
    while (rescansStable < config.stableRounds && !enforceLimit()) {
      const beforeCount = found.size;
      for (const element of containers()) {
        found.add(element);
        while (element.scrollTop + element.clientHeight < element.scrollHeight - 2) {
          if (enforceLimit()) break;
          const before = element.scrollTop;
          element.scrollTop = Math.min(
            element.scrollHeight,
            before + Math.max(1, element.clientHeight * config.scrollStepRatio),
          );
          rounds += 1;
          await waitForSettle();
          if (element.scrollTop <= before) break;
        }
        if (element.scrollTop + element.clientHeight >= element.scrollHeight - 2) {
          completed.add(element);
        }
        if (limitReason) break;
      }
      rescansStable = found.size === beforeCount ? rescansStable + 1 : 0;
    }
  }

  let documentScrollCompleted = !config.scrollDocument;
  if (config.scrollDocument && !limitReason) {
    let stable = 0;
    let previousHeight = documentHeight();
    while (stable < config.stableRounds && !enforceLimit()) {
      const scrolling = document.scrollingElement || document.documentElement;
      const before = scrolling.scrollTop;
      scrolling.scrollTop = Math.min(
        previousHeight,
        before + Math.max(1, window.innerHeight * config.scrollStepRatio),
      );
      rounds += 1;
      const mutationsBefore = state.mutationCount;
      await waitForSettle();
      const nextHeight = documentHeight();
      const atBottom = scrolling.scrollTop + window.innerHeight >= nextHeight - 2;
      const unchanged = Math.abs(nextHeight - previousHeight) <= 2 &&
        state.mutationCount === mutationsBefore &&
        pendingImages().length === 0;
      stable = atBottom && unchanged ? stable + 1 : 0;
      previousHeight = nextHeight;
    }
    documentScrollCompleted = !limitReason && stable >= config.stableRounds;
  }

  let expanded = 0;
  if (config.expandScrollContainers && !limitReason) {
    for (const element of found) {
      if (!completed.has(element)) continue;
      state.styles.push({ element, style: element.getAttribute('style') });
      element.style.setProperty('height', 'auto', 'important');
      element.style.setProperty('max-height', 'none', 'important');
      element.style.setProperty('overflow-y', 'visible', 'important');
      element.scrollTop = 0;
      expanded += 1;
    }
    await waitForSettle();
    if (documentHeight() > config.maxCaptureHeight) limitReason = 'maxCaptureHeight';
  }

  const images = [...document.images];
  const imagesPending = pendingImages().length;
  if (!fontsReady && !limitReason) limitReason = 'fontsTimeout';
  if (imagesPending > 0 && !limitReason) limitReason = 'imagesTimeout';
  if (!documentScrollCompleted && !limitReason) limitReason = 'documentUnstable';

  return {
    documentScrollCompleted,
    scrollContainersFound: found.size,
    scrollContainersCompleted: completed.size,
    scrollContainersExpanded: expanded,
    imagesFound: images.length,
    imagesPending,
    fontsReady,
    truncated: limitReason !== null,
    limitReason,
    preparationDurationMs: Math.round(performance.now() - startedAt),
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    documentHeight: documentHeight(),
    warnings,
  };
}
