function getEmailsFromText(text) {
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,7}/g;
  return (text || "").match(emailPattern) || [];
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function dedupeEmails(list) {
  return [...new Set((list || []).map(normalizeEmail).filter(Boolean))];
}

function scrapeCurrentPageEmails() {
  const emailSet = new Set();

  const mailLinks = document.querySelectorAll('a[href^="mailto:"]');
  mailLinks.forEach((link) => {
    const href = link.getAttribute("href");
    if (!href) return;
    const email = href.replace(/^mailto:/i, "").split("?")[0].trim();
    if (email) emailSet.add(normalizeEmail(email));
  });

  const textContent = document.body ? document.body.innerText || "" : "";
  const htmlContent = document.body ? document.body.innerHTML || "" : "";
  const matches = [...getEmailsFromText(textContent), ...getEmailsFromText(htmlContent)];

  matches.forEach((email) => emailSet.add(normalizeEmail(email)));
  return [...emailSet];
}

function getScrollState() {
  const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
  const maxScroll = Math.max(0, (document.documentElement.scrollHeight || document.body.scrollHeight) - window.innerHeight);
  return {
    running: !!(window.__linkedinAutoScrollState && window.__linkedinAutoScrollState.running),
    paused: !!(window.__linkedinAutoScrollState && window.__linkedinAutoScrollState.paused),
    position: scrollY,
    maxScroll,
    elapsed: window.__linkedinAutoScrollState && window.__linkedinAutoScrollState.startedAt
      ? Date.now() - window.__linkedinAutoScrollState.startedAt - (window.__linkedinAutoScrollState.totalPausedMs || 0)
      : 0,
    durationMs: window.__linkedinAutoScrollState ? window.__linkedinAutoScrollState.durationMs || 60000 : 60000,
  };
}

function startAutoScroll(durationMs = 60000) {
  const controller = window.__linkedinAutoScrollState || {};
  if (controller.timer) clearInterval(controller.timer);

  controller.running = true;
  controller.paused = false;
  controller.durationMs = Number(durationMs) || 60000;
  controller.startedAt = Date.now();
  controller.endAt = controller.startedAt + controller.durationMs;
  controller.totalPausedMs = 0;
  controller.pausedAt = 0;

  const step = Math.max(50, Math.min(window.innerHeight * 0.12, 250));
  controller.timer = setInterval(() => {
    if (!controller.running || controller.paused) return;

    const currentPosition = window.scrollY || document.documentElement.scrollTop || 0;
    const maxScroll = Math.max(0, (document.documentElement.scrollHeight || document.body.scrollHeight) - window.innerHeight);
    const nextPosition = Math.min(currentPosition + step, maxScroll);

    window.scrollTo({ top: nextPosition, left: 0, behavior: "auto" });

    if (nextPosition >= maxScroll || Date.now() >= controller.endAt) {
      if (controller.timer) clearInterval(controller.timer);
      controller.timer = null;
      controller.running = false;
      controller.paused = false;
    }
  }, 1000);

  window.__linkedinAutoScrollState = controller;
  return getScrollState();
}

function pauseAutoScroll() {
  const controller = window.__linkedinAutoScrollState || {};
  if (!controller.running) return getScrollState();
  controller.paused = true;
  controller.pausedAt = Date.now();
  window.__linkedinAutoScrollState = controller;
  return getScrollState();
}

function resumeAutoScroll() {
  const controller = window.__linkedinAutoScrollState || {};
  if (!controller.running || !controller.paused) return getScrollState();
  controller.totalPausedMs = (controller.totalPausedMs || 0) + (Date.now() - (controller.pausedAt || Date.now()));
  controller.paused = false;
  controller.pausedAt = 0;
  window.__linkedinAutoScrollState = controller;
  return getScrollState();
}

function stopAutoScroll() {
  const controller = window.__linkedinAutoScrollState || {};
  if (controller.timer) clearInterval(controller.timer);
  controller.timer = null;
  controller.running = false;
  controller.paused = false;
  controller.startedAt = 0;
  controller.endAt = 0;
  controller.totalPausedMs = 0;
  controller.pausedAt = 0;
  window.__linkedinAutoScrollState = controller;
  return getScrollState();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return;

  if (message.action === "scrapeEmails") {
    sendResponse({ emails: scrapeCurrentPageEmails() });
    return;
  }

  if (message.action === "startAutoScroll") {
    sendResponse(startAutoScroll(message.durationMs));
    return;
  }

  if (message.action === "pauseAutoScroll") {
    sendResponse(pauseAutoScroll());
    return;
  }

  if (message.action === "resumeAutoScroll") {
    sendResponse(resumeAutoScroll());
    return;
  }

  if (message.action === "stopAutoScroll") {
    sendResponse(stopAutoScroll());
    return;
  }

  if (message.action === "getAutoScrollStatus") {
    sendResponse(getScrollState());
    return;
  }
});