
// Redmana extension content script
console.log("Redmana: content.js loaded. Injecting initializer script.");

const HEADER_ROW_SELECTOR = "table.list.issues-board > thead > tr";
const ISSUE_PATH_REGEX = /^\/issues\/\d+$/;
const DRAWER_INIT_FLAG = "__redmanaDrawerInitialized";
const ASSIGNEE_INIT_FLAG = "__redmanaAssigneeInitialized";
const LATEST_ASSIGNEES_KEY = `redmanaLatestAssignees:${window.location.host}`;
const MAX_LATEST_ASSIGNEES = 10;
const LATEST_OPTGROUP_LABEL = 'Latest';
const ASSIGNEE_SELECT_SELECTOR = 'select[name="issue[assigned_to_id]"]';
const SELECTED_CLASS = 'redmana-issue-selected';
const BODY_DRAWER_CLASS = 'redmana-drawer-open';
const CURRENT_HOST_CANONICAL = normalizeHostname(window.location.hostname || '');
let lastKnownUrl = window.location.href;

function normalizeHostname(rawHost) {
    return (rawHost || '')
        .toString()
        .trim()
        .replace(/:\d+$/, '')
        .replace(/^www\./, '')
        .toLowerCase();
}

function clearStaleDrawerState() {
    try {
        const state = history.state;
        if (!state || state.redmanaDrawer !== true) {
            return;
        }
        const nextState = { ...state };
        delete nextState.redmanaDrawer;
        const sanitized = Object.keys(nextState).length ? nextState : null;
        history.replaceState(sanitized, '', window.location.href);
    } catch (error) {
        console.warn('Redmana: Failed to clear stale drawer history state.', error);
    }
    lastKnownUrl = window.location.href;
}
function injectScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('board-enhancer.js');
    document.head.appendChild(script);
    script.remove();
    console.log("Redmana: Initializer script injected.");
}

// --- Main Execution ---
function waitForBoardAndInject() {
    let attempts = 0;
    const maxAttempts = 50; // Try for 10 seconds
    const interval = setInterval(() => {
        const board = document.querySelector(HEADER_ROW_SELECTOR);
        if (board) {
            clearInterval(interval);
            injectScript();
        } else if (++attempts > maxAttempts) {
            clearInterval(interval);
            console.warn("Redmana: Agile board not found after 10 seconds.");
        }
    }, 200);
}

function isLikelyRedmine() {
    const body = document.body;
    if (!body) return false;

    if (document.querySelector('meta[name="description"][content*="Redmine"]')) return true;
    if (document.querySelector('meta[name="application-name"][content*="Redmine"]')) return true;
    if (document.querySelector('meta[name="generator"][content*="Redmine"]')) return true;

    const bodyClasses = Array.from(body.classList || []);
    if (bodyClasses.some(cls => cls.startsWith('controller-')) &&
        bodyClasses.some(cls => cls.startsWith('action-'))) {
        return true;
    }

    if (document.querySelector('#top-menu') && document.querySelector('#header')) return true;
    if (document.querySelector('meta[name="csrf-token"]') && document.querySelector('meta[name="csrf-param"]')) {
        if (document.querySelector('#project-jump') || document.querySelector('#quick-search')) {
            return true;
        }
    }

    return false;
}


function navigateToIssuePage(issueUrl, reason) {
    try {
        console.warn('Redmana: falling back to standard issue view.', reason);
    } catch (error) {
        // no-op
    }
    forceCloseDrawer();
    const resolved = resolveIssueUrl(issueUrl);
    window.location.assign(resolved);
}
function forceCloseDrawer() {
    if (drawerState.isOpen) {
        closeDrawerInternal();
    }
}

const isRedmine = isLikelyRedmine();

if (isRedmine && document.body) {
    document.body.classList.add('redmana-loaded');
}

if (isRedmine) {
    clearStaleDrawerState();
}

if (isRedmine && window.location.pathname.includes('/agile/board')) {
    if (document.readyState === 'complete') {
        waitForBoardAndInject();
    } else {
        window.addEventListener('load', waitForBoardAndInject);
    }
}

// --- Feature: Image Lightbox ---

function initLightbox() {
    document.body.addEventListener('click', function(event) {
        const thumbnailLink = event.target.closest('div.thumbnails a');

        if (!thumbnailLink) {
            return; // Click was not on a thumbnail
        }

        const imgTag = thumbnailLink.querySelector('img');
        if (!imgTag) {
            // Not an image thumbnail (pdf, video, etc.) - allow default behaviour
            return;
        }

        const attachmentHref = thumbnailLink.getAttribute('href');
        if (!attachmentHref) {
            console.error('Redmana: Thumbnail link missing href.');
            return;
        }

        const titleName = imgTag.getAttribute('data-filename')
            || imgTag.getAttribute('title')
            || imgTag.getAttribute('alt')
            || '';
        const hrefFile = decodeURIComponent(attachmentHref).split('/').pop() || '';
        const candidateName = (titleName || hrefFile).trim();
        const imageExtensionPattern = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
        if (!candidateName || !imageExtensionPattern.test(candidateName)) {
            // Not an image attachment; allow default navigation (e.g. PDF, video)
            return;
        }

        const attachmentUrl = new URL(attachmentHref, window.location.origin);
        const idMatch = attachmentUrl.pathname.match(/\/attachments\/(?:download\/)?(\d+)/);
        const downloadFilename = candidateName.replace(/[/\\]/g, '_');
        const imageUrl = idMatch
            ? `${window.location.origin}/attachments/download/${idMatch[1]}/${encodeURIComponent(downloadFilename)}`
            : attachmentUrl.href;

        event.preventDefault();

        // Create lightbox elements
        const overlay = document.createElement('div');
        overlay.className = 'redmana-lightbox-overlay';

        const content = document.createElement('div');
        content.className = 'redmana-lightbox-content';

        const img = document.createElement('img');
        img.src = imageUrl;

        content.appendChild(img);
        overlay.appendChild(content);

        // Close lightbox when overlay is clicked
        overlay.addEventListener('click', () => {
            overlay.remove();
        });

        document.body.appendChild(overlay);
    });
    console.log("Redmana: Lightbox initialized.");
}

// Initialize the lightbox feature on all pages
if (isRedmine) {
    initLightbox();
}

// --- Feature: Issue Drawer ---

const drawerState = {
    isOpen: false,
    baseUrl: null,
    currentUrl: null,
    closePending: false,
    activeController: null,
    activeRequestToken: null,
    selectedElement: null
};

let drawerElements = null;
let assigneeObserver = null;

function resolveIssueUrl(rawHref) {
    try {
        const url = new URL(rawHref, window.location.origin);
        const urlHost = normalizeHostname(url.hostname);

        if (window.location.protocol === 'https:' &&
            url.protocol === 'http:' &&
            urlHost === CURRENT_HOST_CANONICAL) {
            url.protocol = 'https:';
            url.port = '';
        }
        return url.toString();
    } catch (error) {
        console.error("Redmana: Failed to resolve issue URL.", error);
        return rawHref;
    }
}

function shouldHandleIssueLink(anchor) {
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('javascript:')) return false;
    if (anchor.target === '_blank' || anchor.hasAttribute('download')) return false;
    if (anchor.dataset.redmanaBypass === 'true') return false;
    if (anchor.closest('.tabs')) return false;

    let url;
    try {
        url = new URL(href, window.location.origin);
    } catch (error) {
        return false;
    }

    const normalizedPath = url.pathname.replace(/\/$/, '');
    if (!ISSUE_PATH_REGEX.test(normalizedPath)) {
        return false;
    }

    // Allow modifier keys or non-primary button clicks to behave normally
    return url.origin === window.location.origin;
}

function ensureDrawerElements() {
    if (drawerElements) {
        return drawerElements;
    }

    const container = document.createElement('div');
    container.className = 'redmana-drawer-container';

    const drawer = document.createElement('aside');
    drawer.className = 'redmana-drawer';
    drawer.setAttribute('aria-hidden', 'true');

    const header = document.createElement('div');
    header.className = 'redmana-drawer-header';

    const title = document.createElement('h2');
    title.className = 'redmana-drawer-title';

    const titleLink = document.createElement('a');
    titleLink.className = 'redmana-drawer-title-link';
    titleLink.href = '#';
    titleLink.target = '_blank';
    titleLink.rel = 'noopener noreferrer';
    titleLink.textContent = 'Loading...';

    title.appendChild(titleLink);

    const actionGroup = document.createElement('div');
    actionGroup.className = 'redmana-drawer-actions';

    const closeButton = document.createElement('button');
    closeButton.className = 'redmana-drawer-close';
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close task drawer');
    closeButton.innerHTML = '&times;';

    actionGroup.appendChild(closeButton);

    const body = document.createElement('div');
    body.className = 'redmana-drawer-body';

    header.appendChild(title);
    header.appendChild(actionGroup);
    drawer.appendChild(header);
    drawer.appendChild(body);

    container.appendChild(drawer);

    document.body.appendChild(container);

    closeButton.addEventListener('click', requestDrawerClose);

    drawerElements = {
        container,
        drawer,
        header,
        title,
        titleLink,
        actions: actionGroup,
        closeButton,
        body
    };

    return drawerElements;
}

function setDrawerTitle(text, url) {
    const elements = ensureDrawerElements();
    const label = (text && text.trim()) || 'Task';
    const href = url || drawerState.currentUrl || '#';

    elements.titleLink.textContent = label;
    elements.titleLink.href = href || '#';
    elements.titleLink.title = 'Open full issue page';
}

function showDrawerLoading(message = 'Loading...') {
    const elements = ensureDrawerElements();
    elements.body.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'redmana-drawer-loading';
    loading.textContent = message;
    elements.body.appendChild(loading);
}

function showDrawerError(message) {
    const elements = ensureDrawerElements();
    elements.body.innerHTML = '';
    const alert = document.createElement('div');
    alert.className = 'redmana-drawer-alert';
    alert.textContent = message || 'Unable to load the task. Please try again.';
    elements.body.appendChild(alert);
}

function requestDrawerClose() {
    if (!drawerState.isOpen || drawerState.closePending) {
        return;
    }
    drawerState.closePending = true;
    history.back();
}

function closeDrawerInternal() {
    if (!drawerState.isOpen) return;
    const elements = ensureDrawerElements();
    elements.container.classList.remove('is-open');
    elements.drawer.setAttribute('aria-hidden', 'true');
    if (document.body) {
        document.body.classList.remove(BODY_DRAWER_CLASS);
    }
    drawerState.isOpen = false;
    drawerState.baseUrl = null;
    drawerState.currentUrl = null;
    drawerState.closePending = false;
    lastKnownUrl = window.location.href;

    clearHighlightedIssue();

    if (drawerState.activeController) {
        drawerState.activeController.abort();
        drawerState.activeController = null;
    }

    drawerState.activeRequestToken = null;

    setTimeout(() => {
        elements.body.scrollTop = 0;
        setDrawerTitle('Loading...', '#');
        showDrawerLoading();
    }, 200);
}

async function loadIssueIntoDrawer(issueUrl) {
    const elements = ensureDrawerElements();
    const urlObj = new URL(issueUrl, window.location.origin);
    const requestUrl = `${urlObj.origin}${urlObj.pathname}${urlObj.search}`;
    const anchor = urlObj.hash;

    if (drawerState.activeController) {
        drawerState.activeController.abort();
    }
    const controller = new AbortController();
    drawerState.activeController = controller;
    const requestToken = Symbol('drawerRequest');
    drawerState.activeRequestToken = requestToken;

    setDrawerTitle('Loading...', issueUrl);
    showDrawerLoading();

    let effectiveIssueUrl = issueUrl;

    try {
        const response = await fetch(requestUrl, {
            credentials: 'include',
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Response not OK (${response.status})`);
        }

        const html = await response.text();

        if (!html || !html.trim()) {
            navigateToIssuePage(issueUrl, 'Empty issue response.');
            return;
        }

        if (drawerState.activeRequestToken !== requestToken) {
            return;
        }

        const finalUrlBase = resolveIssueUrl(response.url || requestUrl);
        effectiveIssueUrl = anchor ? `${finalUrlBase}${anchor}` : finalUrlBase;
        drawerState.currentUrl = effectiveIssueUrl;

        if (drawerState.isOpen) {
            try {
                history.replaceState({ redmanaDrawer: true }, '', effectiveIssueUrl);
                lastKnownUrl = window.location.href;
            } catch (error) {
                console.warn('Redmana: Failed to sync history state.', error);
            }
        }

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const content = doc.querySelector('#content');

        if (!content) {
            navigateToIssuePage(issueUrl, 'Issue content container missing.');
            return;
        }

        const clonedContent = content.cloneNode(true);
        clonedContent.id = 'redmana-drawer-content';
        clonedContent.querySelectorAll('script, link[rel="stylesheet"]').forEach(el => el.remove());

        const heading = clonedContent.querySelector('h2');
        const titleText = heading ? heading.textContent.trim() : 'Task';
        setDrawerTitle(titleText, effectiveIssueUrl);

        elements.body.innerHTML = '';
        elements.body.appendChild(clonedContent);
        elements.body.scrollTop = 0;

        attachDrawerEnhancements(clonedContent, effectiveIssueUrl);
        highlightIssueContext(effectiveIssueUrl);

        if (anchor) {
            const target = clonedContent.querySelector(anchor);
            if (target) {
                target.scrollIntoView({ block: 'start' });
            }
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            return;
        }
        console.error('Redmana: Failed to load issue into drawer.', error);
        navigateToIssuePage(issueUrl, error && error.message ? error.message : error);
        return;
    } finally {
        if (drawerState.activeController === controller) {
            drawerState.activeController = null;
        }
        if (drawerState.activeRequestToken === requestToken) {
            drawerState.activeRequestToken = null;
        }
    }
}

function attachDrawerEnhancements(drawerContent, issueUrl) {
    enhanceIssueForms(drawerContent, issueUrl);
    normalizeLinks(drawerContent);
    revealIssueHistory(drawerContent);
}

function normalizeLinks(drawerContent) {
    drawerContent.querySelectorAll('a[href]').forEach(link => {
        const href = link.getAttribute('href');
        if (!href || href.startsWith('#')) return;

        link.href = resolveIssueUrl(href);
    });
}

function revealIssueHistory(drawerContent) {
    drawerContent.querySelectorAll('.tab-content').forEach(section => {
        section.classList.remove('hidden');
        section.style.removeProperty('display');
        if (window.getComputedStyle(section).display === 'none') {
            section.style.display = 'block';
        }
    });

    drawerContent.querySelectorAll('#history, .history, .journal, #issue-changesets, #issue-changesets + .tab-content')
        .forEach(element => {
            element.classList.remove('hidden');
            element.style.removeProperty('display');
        });

    drawerContent.querySelectorAll('.tabs').forEach(tabs => {
        tabs.classList.add('redmana-drawer-tabs');
        tabs.classList.remove('hidden');
        tabs.style.removeProperty('display');
    });
}

function enhanceIssueForms(drawerContent, issueUrl) {
    const issueForm = drawerContent.querySelector('form#issue-form');
    if (!issueForm) {
        return;
    }

    const statusMessage = document.createElement('div');
    statusMessage.className = 'redmana-drawer-alert redmana-drawer-alert--hidden';
    issueForm.prepend(statusMessage);

    issueForm.addEventListener('submit', async event => {
        event.preventDefault();
        statusMessage.classList.add('redmana-drawer-alert--hidden');
        await submitIssueForm(issueForm, issueUrl, statusMessage);
    });
}

async function submitIssueForm(form, issueUrl, statusMessage) {
    const submitButtons = Array.from(form.querySelectorAll('input[type="submit"], button[type="submit"]'));
    submitButtons.forEach(button => {
        button.dataset.originalText = button.innerText || button.value || '';
        if (button.tagName === 'INPUT') {
            button.value = 'Saving...';
        } else {
            button.innerText = 'Saving...';
        }
        button.disabled = true;
    });

    const formData = new FormData(form);
    const method = (form.getAttribute('method') || 'post').toUpperCase();
    const action = resolveIssueUrl(form.getAttribute('action') || issueUrl);

    try {
        const response = await fetch(action, {
            method,
            credentials: 'include',
            body: formData,
            redirect: 'manual'
        });

        const isOpaqueRedirect = response.type === 'opaqueredirect';
        const isRedirectStatus = response.status >= 300 && response.status < 400;

        if (!response.ok && !isRedirectStatus && !isOpaqueRedirect) {
            throw new Error(`Failed to submit form (${response.status})`);
        }

        const redirectLocation = response.headers ? response.headers.get('Location') : null;
        const nextUrl = redirectLocation ? resolveIssueUrl(redirectLocation) : issueUrl;

        await loadIssueIntoDrawer(nextUrl);
        showTemporaryMessage('Task updated.', 'success');
    } catch (error) {
        console.error('Redmana: Failed to submit issue form.', error);
        if (statusMessage) {
            statusMessage.textContent = 'Unable to save changes. Review the form and try again.';
            statusMessage.classList.remove('redmana-drawer-alert--hidden');
        }
    } finally {
        submitButtons.forEach(button => {
            const originalText = button.dataset.originalText || '';
            if (button.tagName === 'INPUT') {
                button.value = originalText;
            } else {
                button.innerText = originalText;
            }
            button.disabled = false;
        });
    }
}

function showTemporaryMessage(message, type = 'info') {
    const elements = ensureDrawerElements();
    const banner = document.createElement('div');
    banner.className = `redmana-drawer-toast redmana-drawer-toast--${type}`;
    banner.textContent = message;
    elements.container.appendChild(banner);

    requestAnimationFrame(() => {
        banner.classList.add('is-visible');
    });

    setTimeout(() => {
        banner.classList.remove('is-visible');
        setTimeout(() => banner.remove(), 300);
    }, 2500);
}

function extractIssueIdFromUrl(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url, window.location.origin);
        const match = parsed.pathname.match(/\/issues\/(\d+)/);
        return match ? match[1] : null;
    } catch (error) {
        return null;
    }
}

function clearHighlightedIssue() {
    if (drawerState.selectedElement) {
        drawerState.selectedElement.classList.remove(SELECTED_CLASS);
        drawerState.selectedElement = null;
    }
}

function highlightIssueContext(issueUrl, triggerElement = null) {
    const issueId = extractIssueIdFromUrl(issueUrl);
    const candidate = findIssueElement({ issueId, triggerElement });

    if (candidate) {
        if (drawerState.selectedElement && drawerState.selectedElement !== candidate) {
            drawerState.selectedElement.classList.remove(SELECTED_CLASS);
        }
        drawerState.selectedElement = candidate;
        candidate.classList.add(SELECTED_CLASS);
    } else {
        clearHighlightedIssue();
    }
}

function findIssueElement({ issueId, triggerElement }) {
    const fromTrigger = locateIssueElementFromAnchor(triggerElement);
    if (fromTrigger) {
        return fromTrigger;
    }

    if (!issueId) {
        return null;
    }

    const selectors = [
        `.issue-card[data-id="${issueId}"]`,
        `.issue-card[data-issue-id="${issueId}"]`,
        `.issue-card[data-card-id="${issueId}"]`,
        `tr.hascontextmenu[data-id="${issueId}"]`,
        `tr.hascontextmenu[data-issue-id="${issueId}"]`,
        `tr#issue-${issueId}`,
        `tr.issue[data-id="${issueId}"]`,
        `tr.issue-${issueId}`,
        `tr[data-id="${issueId}"]`
    ];

    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && !element.closest('.redmana-drawer')) {
            return element;
        }
    }

    return null;
}

function locateIssueElementFromAnchor(anchor) {
    if (!anchor) return null;
    if (anchor.closest('.redmana-drawer')) {
        return null;
    }
    const element = anchor.closest('.issue-card');
    if (element && !element.closest('.redmana-drawer')) {
        return element;
    }
    const row = anchor.closest('tr.hascontextmenu');
    if (row && !row.closest('.redmana-drawer')) {
        return row;
    }
    const fallbackRow = anchor.closest('tr.issue');
    if (fallbackRow && !fallbackRow.closest('.redmana-drawer')) {
        return fallbackRow;
    }
    return null;
}

function openIssueDrawer(issueUrl, options = {}) {
    const elements = ensureDrawerElements();

    const absoluteUrl = resolveIssueUrl(issueUrl);
    highlightIssueContext(absoluteUrl, options.triggerElement || null);

    if (!drawerState.isOpen) {
        drawerState.baseUrl = window.location.href;
        try {
            history.pushState({ redmanaDrawer: true }, '', absoluteUrl);
            lastKnownUrl = window.location.href;
        } catch (error) {
            console.warn('Redmana: Failed to push history state.', error);
        }
    } else {
        try {
            history.replaceState({ redmanaDrawer: true }, '', absoluteUrl);
            lastKnownUrl = window.location.href;
        } catch (error) {
            console.warn('Redmana: Failed to replace history state.', error);
        }
    }

    drawerState.isOpen = true;
    drawerState.currentUrl = absoluteUrl;
    drawerState.closePending = false;

    elements.container.classList.add('is-open');
    elements.drawer.setAttribute('aria-hidden', 'false');
    if (document.body) {
        document.body.classList.add(BODY_DRAWER_CLASS);
    }

    loadIssueIntoDrawer(absoluteUrl);
}

function handleDocumentClick(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = event.target.closest('a[href]');
    if (!anchor) return;
    if (!shouldHandleIssueLink(anchor)) return;

    const issueUrl = resolveIssueUrl(anchor.getAttribute('href'));
    event.preventDefault();
    event.stopPropagation();

    openIssueDrawer(issueUrl, { triggerElement: anchor });
}

function handlePopState(event) {
    const currentUrl = window.location.href;

    if (drawerState.isOpen) {
        closeDrawerInternal();
        lastKnownUrl = window.location.href;
        return;
    }

    const state = event && event.state;
    const hasDrawerFlag = !!(state && state.redmanaDrawer === true);
    const urlChanged = currentUrl !== lastKnownUrl;

    if (!hasDrawerFlag && urlChanged) {
        window.location.assign(currentUrl);
        lastKnownUrl = currentUrl;
        return;
    }

    lastKnownUrl = currentUrl;
}

function handleKeyDown(event) {
    if (event.key === 'Escape' && drawerState.isOpen) {
        requestDrawerClose();
    }
}

function initAssigneeEnhancement() {
    if (window[ASSIGNEE_INIT_FLAG]) return;
    window[ASSIGNEE_INIT_FLAG] = true;

    enhanceAllAssigneeSelects();
    observeAssigneeSelects();
}

function enhanceAllAssigneeSelects() {
    document.querySelectorAll(ASSIGNEE_SELECT_SELECTOR).forEach(enhanceAssigneeSelect);
}

function enhanceAssigneeSelect(select) {
    if (!(select instanceof HTMLSelectElement)) return;
    if (select.name !== 'issue[assigned_to_id]') return;

    rebuildLatestOptgroup(select);

    if (!select.dataset.redmanaAssigneeListener) {
        select.addEventListener('change', handleAssigneeChange);
        select.dataset.redmanaAssigneeListener = 'true';
    }
}

function handleAssigneeChange(event) {
    const select = event.currentTarget;
    if (!(select instanceof HTMLSelectElement)) return;

    const value = select.value;
    if (!value) return;

    const selectedOption = select.selectedOptions[0];
    const label = selectedOption ? selectedOption.textContent.trim() : '';
    if (!label) return;

    updateLatestAssignees({ id: value.toString(), name: label });
    document.querySelectorAll(ASSIGNEE_SELECT_SELECTOR).forEach(rebuildLatestOptgroup);
}

function rebuildLatestOptgroup(select) {
    if (!(select instanceof HTMLSelectElement)) return;
    if (select.dataset.redmanaRebuilding === 'true') {
        return;
    }
    select.dataset.redmanaRebuilding = 'true';

    try {
        const currentValue = select.value;
        const latestGroup = ensureLatestGroup(select);

        const stored = loadLatestAssignees();
        const optionMap = new Map();

        Array.from(select.options).forEach(option => {
            const parentGroup = option.parentElement;
            if (!option.value) return;
            if (parentGroup && parentGroup.getAttribute('data-redmana-latest-group') === 'true') return;
            optionMap.set(option.value, option.textContent.trim());
        });

        const filtered = stored.filter(item => optionMap.has(item.id));
        if (filtered.length !== stored.length) {
            saveLatestAssignees(filtered);
        }

        if (!filtered.length) {
            if (latestGroup) {
                latestGroup.remove();
            }
            return;
        }

        if (latestGroup) {
            latestGroup.innerHTML = '';
        }

        const fragment = document.createDocumentFragment();
        filtered.forEach(item => {
            const clone = document.createElement('option');
            clone.value = item.id;
            clone.textContent = optionMap.get(item.id) || item.name;
            clone.setAttribute('data-redmana-latest-option', 'true');
            fragment.appendChild(clone);
        });

        if (latestGroup) {
            latestGroup.appendChild(fragment);
        }

        if (currentValue && select.value !== currentValue) {
            select.value = currentValue;
        }
    } finally {
        setTimeout(() => {
            // Allow MutationObserver callbacks triggered by this rebuild to settle before clearing the flag.
            if (select.dataset.redmanaRebuilding === 'true') {
                delete select.dataset.redmanaRebuilding;
            }
        }, 0);
    }
}

function ensureLatestGroup(select) {
    let latestGroup = select.querySelector('optgroup[data-redmana-latest-group="true"]');
    if (!latestGroup) {
        latestGroup = document.createElement('optgroup');
        latestGroup.label = LATEST_OPTGROUP_LABEL;
        latestGroup.setAttribute('data-redmana-latest-group', 'true');
        const insertBefore = findLatestGroupInsertPosition(select);
        select.insertBefore(latestGroup, insertBefore);
    }
    return latestGroup;
}

function findLatestGroupInsertPosition(select) {
    const children = Array.from(select.childNodes);
    for (let i = 0; i < children.length; i += 1) {
        const node = children[i];
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() === '') {
            return;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node;
            if (element.tagName === 'OPTION' && element.value === '') {
                return element.nextSibling;
            }
            if (element.tagName === 'OPTGROUP' && element.getAttribute('data-redmana-latest-group') === 'true') {
                continue;
            }
            return element;
        }
        return node;
    }
    return null;
}

function loadLatestAssignees() {
    try {
        const raw = localStorage.getItem(LATEST_ASSIGNEES_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string');
    } catch (error) {
        console.warn('Redmana: Failed to load latest assignees from storage.', error);
        return [];
    }
}

function saveLatestAssignees(list) {
    try {
        localStorage.setItem(LATEST_ASSIGNEES_KEY, JSON.stringify(list.slice(0, MAX_LATEST_ASSIGNEES)));
    } catch (error) {
        console.warn('Redmana: Failed to save latest assignees.', error);
    }
}

function updateLatestAssignees(entry) {
    if (!entry || !entry.id) return;
    const cleanedName = (entry.name || '').trim();
    const normalizedEntry = {
        id: entry.id.toString(),
        name: cleanedName || entry.name || entry.id.toString()
    };

    const list = loadLatestAssignees().filter(item => item.id !== normalizedEntry.id);
    list.unshift(normalizedEntry);
    saveLatestAssignees(list);
}

function observeAssigneeSelects() {
    if (assigneeObserver) return;
    assigneeObserver = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            if (mutation.type !== 'childList') return;

            const target = mutation.target;
            if (target instanceof HTMLSelectElement && target.matches(ASSIGNEE_SELECT_SELECTOR)) {
                enhanceAssigneeSelect(target);
            }

            mutation.addedNodes.forEach(node => {
                if (!(node instanceof Element)) return;
                if (node.matches && node.matches(ASSIGNEE_SELECT_SELECTOR)) {
                    enhanceAssigneeSelect(node);
                } else if (node.querySelectorAll) {
                    node.querySelectorAll(ASSIGNEE_SELECT_SELECTOR).forEach(enhanceAssigneeSelect);
                }
            });
        });
    });

    assigneeObserver.observe(document.body, { childList: true, subtree: true });
}

function initIssueDrawer() {
    if (window[DRAWER_INIT_FLAG]) return;
    window[DRAWER_INIT_FLAG] = true;

    document.addEventListener('click', handleDocumentClick, true);
    window.addEventListener('popstate', handlePopState);
    document.addEventListener('keydown', handleKeyDown);
}

if (isRedmine) {
    initIssueDrawer();
    initAssigneeEnhancement();
}
