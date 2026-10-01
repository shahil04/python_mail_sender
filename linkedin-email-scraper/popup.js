const resultsEl = document.getElementById("results");
const statusEl = document.getElementById("status");
const emailCountEl = document.getElementById("emailCount");
const scrollDurationEl = document.getElementById("scrollDuration");
const customDurationEl = document.getElementById("customDuration");
const scrollStatusEl = document.getElementById("scrollStatus");

const state = {
    scrapedEmails: [],
    recipients: [],
    autoScroll: {
        timerId: null,
        statusTimerId: null,
        startedAt: 0,
        elapsed: 0,
        durationMs: 60000,
        paused: false,
        running: false,
        pauseStartedAt: 0,
        totalPausedMs: 0,
        currentPosition: 0,
    },
};

function setStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.style.color = isError ? "#b3261e" : "#1f1f1f";
}

function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
}

function dedupeEmails(list) {
    return [...new Set(list.map(normalizeEmail).filter(Boolean))];
}

function getEmailsFromText(text) {
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,7}/g;
    return (text || "").match(emailPattern) || [];
}

function updateEmailCount() {
    const total = state.recipients.length || state.scrapedEmails.length;
    emailCountEl.textContent = `${total} email${total === 1 ? "" : "s"} found`;
}

function setScrapedEmails(emails) {
    state.scrapedEmails = dedupeEmails(emails);
    state.recipients = [...state.scrapedEmails];
    resultsEl.value = state.scrapedEmails.join("\n");
    updateEmailCount();
}

function scrapeEmails() {
    const emailSet = new Set();

    document.querySelectorAll('a[href^="mailto:"]').forEach((link) => {
        const mailto = link.getAttribute("href");
        if (mailto && mailto.startsWith("mailto:")) {
            const email = mailto.replace(/^mailto:/i, "").split("?")[0].trim();
            if (email) emailSet.add(normalizeEmail(email));
        }
    });

    const textContent = document.body ? document.body.innerText || "" : "";
    const htmlContent = document.body ? document.body.innerHTML || "" : "";
    const matches = [...getEmailsFromText(textContent), ...getEmailsFromText(htmlContent)];
    matches.forEach((email) => emailSet.add(normalizeEmail(email)));
    return [...emailSet];
}

function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
}

function updateAutoScrollStatus() {
    const elapsedMs = state.autoScroll.elapsed;
    const currentPosition = state.autoScroll.currentPosition || 0;
    scrollStatusEl.textContent = `Elapsed: ${formatDuration(elapsedMs)} | Position: ${Math.round(currentPosition)}px`;
}

function getActiveTabId(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs && tabs[0] ? tabs[0].id : null;
        callback(tabId);
    });
}

function executeOnActiveTab(func, args = [], callback) {
    getActiveTabId((tabId) => {
        if (typeof tabId !== "number") {
            setStatus("Open a LinkedIn tab before using this feature.", true);
            if (callback) callback(null);
            return;
        }

        chrome.scripting.executeScript(
            {
                target: { tabId },
                args,
                func,
            },
            (results) => {
                if (chrome.runtime.lastError) {
                    setStatus(chrome.runtime.lastError.message, true);
                    if (callback) callback(null);
                    return;
                }

                if (callback) callback(results && results[0] ? results[0].result : null);
            }
        );
    });
}

function syncActiveTabScrollStatus() {
    if (!state.autoScroll.running) return;

    executeOnActiveTab(() => {
        const controller = window.__linkedinAutoScrollState || {};
        return {
            running: !!controller.running,
            paused: !!controller.paused,
            position: controller.scrollElement
                ? controller.scrollElement.scrollTop
                : window.scrollY || document.documentElement.scrollTop || 0,
            elapsed: controller.running && controller.startedAt
                ? Date.now() - controller.startedAt - (controller.totalPausedMs || 0)
                : 0,
            durationMs: controller.durationMs || 60000,
        };
    }, [], (response) => {
        if (!response) return;

        state.autoScroll.currentPosition = response.position || 0;
        state.autoScroll.elapsed = response.elapsed || 0;
        state.autoScroll.running = !!response.running;
        state.autoScroll.paused = !!response.paused;
        updateAutoScrollStatus();

        if (!response.running) {
            stopAutoScroll();
            setStatus("Auto-scroll finished");
        }
    });
}

function startAutoScrollStatusMonitor() {
    if (state.autoScroll.statusTimerId) {
        clearInterval(state.autoScroll.statusTimerId);
    }

    state.autoScroll.statusTimerId = setInterval(() => {
        if (!state.autoScroll.running) return;
        syncActiveTabScrollStatus();
    }, 1000);
}

function startAutoScroll() {
    const customSeconds = Number(customDurationEl.value) * 1000;
    const duration = customDurationEl && !customDurationEl.classList.contains("hidden")
        ? (Number.isFinite(customSeconds) && customSeconds > 0 ? customSeconds : 60000)
        : Number(scrollDurationEl.value || 60000);

    state.autoScroll.durationMs = duration;
    state.autoScroll.startedAt = Date.now();
    state.autoScroll.elapsed = 0;
    state.autoScroll.paused = false;
    state.autoScroll.running = true;
    state.autoScroll.currentPosition = 0;

    executeOnActiveTab((durationMs) => {
        const controller = window.__linkedinAutoScrollState || {};
        if (controller.timer) clearInterval(controller.timer);

        controller.running = true;
        controller.paused = false;
        controller.durationMs = Number(durationMs) || 60000;
        controller.startedAt = Date.now();
        controller.endAt = controller.startedAt + controller.durationMs;
        controller.totalPausedMs = 0;
        controller.pausedAt = 0;

        const findScrollTarget = () => {
            const root = document.scrollingElement || document.documentElement;
            const rootOverflow = window.getComputedStyle(root).overflowY;
            if (root.scrollHeight > root.clientHeight + 1 && !/hidden|clip/.test(rootOverflow)) return root;

            const candidates = Array.from(document.querySelectorAll("body *"))
                .filter((element) => {
                    const style = window.getComputedStyle(element);
                    const rect = element.getBoundingClientRect();
                    return /auto|scroll|overlay/.test(style.overflowY)
                        && element.scrollHeight > element.clientHeight + 1
                        && rect.height > 100
                        && rect.bottom > 0
                        && rect.top < window.innerHeight;
                });

            return candidates.sort((a, b) =>
                (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
            )[0] || root;
        };

        const step = Math.max(100, Math.min(window.innerHeight * 0.15, 400));
        controller.timer = setInterval(() => {
            if (!controller.running || controller.paused) return;

            if (Date.now() >= controller.endAt) {
                if (controller.timer) clearInterval(controller.timer);
                controller.timer = null;
                controller.running = false;
                controller.paused = false;
                return;
            }

            const target = findScrollTarget();
            const currentPosition = target.scrollTop;
            const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
            controller.scrollElement = target === (document.scrollingElement || document.documentElement)
                ? null
                : target;

            if (currentPosition < maxScroll) {
                target.scrollTop = Math.min(currentPosition + step, maxScroll);
                if (!controller.scrollElement) {
                    window.scrollTo({ top: target.scrollTop, left: 0, behavior: "auto" });
                }
            }
        }, 600);

        window.__linkedinAutoScrollState = controller;
        return {
            running: true,
            paused: false,
            position: window.scrollY || document.documentElement.scrollTop || 0,
            elapsed: 0,
            durationMs: controller.durationMs,
        };
    }, [duration], (response) => {
        if (!response || !response.running) {
            state.autoScroll.running = false;
            setStatus("Could not start auto-scroll on the active tab.", true);
            return;
        }

        setStatus("Auto-scroll started on the active page");
        startAutoScrollStatusMonitor();
        updateAutoScrollStatus();
    });
}

function pauseAutoScroll() {
    if (!state.autoScroll.running) {
        setStatus("No active auto-scroll is running.", true);
        return;
    }

    state.autoScroll.paused = true;
    executeOnActiveTab(() => {
        const controller = window.__linkedinAutoScrollState || {};
        if (!controller.running) return { running: false, paused: false, position: 0, elapsed: 0 };
        controller.paused = true;
        controller.pausedAt = Date.now();
        window.__linkedinAutoScrollState = controller;
        return {
            running: true,
            paused: true,
            position: controller.scrollElement
                ? controller.scrollElement.scrollTop
                : window.scrollY || document.documentElement.scrollTop || 0,
            elapsed: Date.now() - (controller.startedAt || Date.now()) - (controller.totalPausedMs || 0),
            durationMs: controller.durationMs || 60000,
        };
    }, [], () => {
        setStatus("Auto-scroll paused");
        updateAutoScrollStatus();
    });
}

function resumeAutoScroll() {
    if (!state.autoScroll.running) {
        setStatus("Auto-scroll is not active.", true);
        return;
    }

    state.autoScroll.paused = false;
    executeOnActiveTab(() => {
        const controller = window.__linkedinAutoScrollState || {};
        if (!controller.running) return { running: false, paused: false, position: 0, elapsed: 0 };
        if (controller.paused) {
            controller.totalPausedMs = (controller.totalPausedMs || 0) + (Date.now() - (controller.pausedAt || Date.now()));
            controller.paused = false;
            controller.pausedAt = 0;
        }
        window.__linkedinAutoScrollState = controller;
        return {
            running: true,
            paused: false,
            position: controller.scrollElement
                ? controller.scrollElement.scrollTop
                : window.scrollY || document.documentElement.scrollTop || 0,
            elapsed: Date.now() - (controller.startedAt || Date.now()) - (controller.totalPausedMs || 0),
            durationMs: controller.durationMs || 60000,
        };
    }, [], () => {
        setStatus("Auto-scroll resumed");
        updateAutoScrollStatus();
    });
}

function stopAutoScroll() {
    state.autoScroll.running = false;
    state.autoScroll.paused = false;
    state.autoScroll.elapsed = 0;
    state.autoScroll.currentPosition = 0;

    if (state.autoScroll.statusTimerId) {
        clearInterval(state.autoScroll.statusTimerId);
        state.autoScroll.statusTimerId = null;
    }

    executeOnActiveTab(() => {
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
        return { stopped: true };
    }, [], () => {
        setStatus("Auto-scroll stopped");
        updateAutoScrollStatus();
    });
}

function addPastedEmails() {
    const list = document.getElementById("pasteEmails").value;
    const found = dedupeEmails(list.split(/[\s,;\n]+/).filter(Boolean));
    if (!found.length) {
        setStatus("No valid emails found in the pasted list.", true);
        return;
    }

    state.recipients = dedupeEmails([...state.recipients, ...found]);
    updateEmailCount();
    setStatus(`${found.length} pasted email(s) added`);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openHostedEmailSender() {
    const recipients = state.recipients.length ? state.recipients : state.scrapedEmails;
    if (!recipients.length) {
        setStatus("Add or scrape some emails before sending.", true);
        return;
    }

    downloadBlob(new Blob([recipients.join("\n")], { type: "text/plain" }), "linkedin-emails.txt");

    chrome.tabs.create({ url: "https://pmsender.streamlit.app/" }, () => {
        if (chrome.runtime.lastError) {
            setStatus(`Could not open hosted sender: ${chrome.runtime.lastError.message}`, true);
            return;
        }

        setStatus("Hosted sender opened and recipient list downloaded. Upload the list and your PDF, enter credentials, then send.");
    });
}

document.getElementById("scrapeBtn").addEventListener("click", () => {
    getActiveTabId((tabId) => {
        if (typeof tabId !== "number") {
            setStatus("Please open a LinkedIn page first.", true);
            resultsEl.value = "";
            return;
        }

        chrome.scripting.executeScript(
            {
                target: { tabId },
                func: () => {
                    const emailSet = new Set();
                    const mailLinks = document.querySelectorAll('a[href^="mailto:"]');
                    mailLinks.forEach((link) => {
                        const href = link.getAttribute("href");
                        if (!href) return;
                        const email = href.replace(/^mailto:/i, "").split("?")[0].trim();
                        if (email) emailSet.add(email.toLowerCase());
                    });

                    const text = (document.body ? document.body.innerText || "" : "") + " " + (document.body ? document.body.innerHTML || "" : "");
                    const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,7}/g) || [];
                    matches.forEach((email) => emailSet.add(email.toLowerCase()));
                    return [...emailSet];
                },
            },
            (results) => {
                if (chrome.runtime.lastError) {
                    setStatus(chrome.runtime.lastError.message, true);
                    return;
                }

                const emails = Array.isArray(results?.[0]?.result) ? results[0].result : [];
                if (!emails.length) {
                    resultsEl.value = "No emails found on this page.";
                    setStatus("No emails found");
                    return;
                }

                setScrapedEmails(emails);
                setStatus(`${emails.length} email(s) found`);
            }
        );
    });
});

document.getElementById("copyBtn").addEventListener("click", () => {
    const text = resultsEl.value.trim();
    if (!text || text === "No emails found on this page.") {
        setStatus("There is nothing to copy.", true);
        return;
    }

    resultsEl.select();
    document.execCommand("copy");
    setStatus("Copied to clipboard");
});

document.getElementById("downloadBtn").addEventListener("click", () => {
    const text = resultsEl.value.trim();
    if (!text || text === "No emails found on this page.") {
        setStatus("There are no emails to download.", true);
        return;
    }

    const blob = new Blob([text], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mails.csv";
    a.click();
    URL.revokeObjectURL(url);
    setStatus("CSV downloaded");
});

document.getElementById("sendBtn").addEventListener("click", openHostedEmailSender);

document.getElementById("pasteEmailsBtn").addEventListener("click", addPastedEmails);

document.getElementById("startScrollBtn").addEventListener("click", startAutoScroll);
document.getElementById("pauseScrollBtn").addEventListener("click", pauseAutoScroll);
document.getElementById("resumeScrollBtn").addEventListener("click", resumeAutoScroll);
document.getElementById("stopScrollBtn").addEventListener("click", stopAutoScroll);

scrollDurationEl.addEventListener("change", () => {
    const isCustom = scrollDurationEl.value === "custom";
    customDurationEl.classList.toggle("hidden", !isCustom);
    if (!isCustom) {
        customDurationEl.value = "";
    }
});

updateEmailCount();
updateAutoScrollStatus();