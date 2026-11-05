
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

// Third-party Redmine lightbox plugins (e.g. redmine_lightbox3 / fancybox) bind their
// own handlers to attachment links. When such a plugin is installed we must stay out of
// the way, otherwise both overlays open stacked on top of each other.
const EXTERNAL_LIGHTBOX_SCRIPT_SELECTOR = [
    'script[src*="redmine_lightbox"]',
    'script[src*="fancybox"]',
    'script[src*="colorbox"]',
    'script[src*="magnific"]',
    'script[src*="photoswipe"]'
].join(', ');

// Overlay roots the known plugins inject when they open.
const EXTERNAL_LIGHTBOX_OVERLAY_SELECTOR = [
    '.fancybox-container',
    '.fancybox-overlay',
    '.lb-outerContainer',
    '#colorbox',
    '.mfp-wrap',
    '.pswp--open'
].join(', ');

let externalLightboxPresent = false;

function detectExternalLightbox() {
    return !!document.querySelector(EXTERNAL_LIGHTBOX_SCRIPT_SELECTOR);
}

// True when a third-party lightbox has already taken over this particular click.
// On a regular issue page the plugin binds directly to the anchor, so its handler runs
// (and calls preventDefault) before this delegated one on <body>. Links rendered later -
// e.g. inside the Redmana drawer - never get that binding, so our lightbox still applies.
function externalLightboxHandledClick(event) {
    if (!externalLightboxPresent) {
        return false;
    }

    if (event.defaultPrevented) {
        return true;
    }

    return !!document.querySelector(EXTERNAL_LIGHTBOX_OVERLAY_SELECTOR);
}

function initLightbox() {
    externalLightboxPresent = detectExternalLightbox();

    document.body.addEventListener('click', function(event) {
        const thumbnailLink = event.target.closest('div.thumbnails a');

        if (!thumbnailLink) {
            return; // Click was not on a thumbnail
        }

        if (externalLightboxHandledClick(event)) {
            return; // A third-party lightbox plugin is showing this image already
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
    console.log(externalLightboxPresent
        ? "Redmana: Lightbox initialized (external lightbox plugin detected, deferring on pages it handles)."
        : "Redmana: Lightbox initialized.");
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
    activeRequestToken: null,
    renderedSignature: null,
    selectedElement: null
};

let drawerElements = null;
let assigneeObserver = null;

// The issue drawer and the user overview drawer (user-drawer.js) can be open at the same
// time - an issue opened from someone's overview, or a person opened from an issue. The
// one opened last sits on top.
const DRAWER_BASE_Z_INDEX = 2147483000;

function bringDrawerToFront(container) {
    document.querySelectorAll('.redmana-drawer-container').forEach(element => {
        element.style.zIndex = String(element === container ? DRAWER_BASE_Z_INDEX + 1 : DRAWER_BASE_Z_INDEX);
    });
}

// --- Drawer history ---
// Every open drawer owns one history entry showing its real URL, so the address bar
// matches what is on screen and Back closes drawers top-down. Layer names, bottom to top.
const drawerLayers = [];
// name -> closes that drawer's UI without touching history. user-drawer.js adds 'user'.
const drawerLayerClosers = {};
let drawerHistoryPending = false;
let pendingDrawerClaim = null;

function topDrawerLayer() {
    return drawerLayers.length ? drawerLayers[drawerLayers.length - 1] : null;
}

// Points the address bar at `url` for drawer `name` and then runs `onReady`: a new entry
// when the drawer is not open yet, a replaced one when it is already on top. When it is
// open but covered, the drawer above is closed first - through history, so Back keeps
// matching what is on screen.
function claimDrawerHistory(name, url, onReady) {
    const top = topDrawerLayer();
    try {
        if (top === name) {
            history.replaceState({ redmanaDrawer: true }, '', url);
        } else if (drawerLayers.includes(name)) {
            pendingDrawerClaim = () => claimDrawerHistory(name, url, onReady);
            if (!drawerHistoryPending) {
                drawerHistoryPending = true;
                history.back();
            }
            return;
        } else {
            history.pushState({ redmanaDrawer: true }, '', url);
            drawerLayers.push(name);
        }
    } catch (error) {
        console.warn('Redmana: Failed to update history for the drawer.', error);
    }
    lastKnownUrl = window.location.href;
    onReady();
}

function replaceDrawerUrl(name, url) {
    if (topDrawerLayer() !== name) return;
    try {
        history.replaceState({ redmanaDrawer: true }, '', url);
        lastKnownUrl = window.location.href;
    } catch (error) {
        console.warn('Redmana: Failed to sync history state.', error);
    }
}

function requestDrawerLayerClose(name) {
    if (topDrawerLayer() === name) {
        if (!drawerHistoryPending) {
            drawerHistoryPending = true;
            history.back();
        }
        return;
    }
    // Not reachable through the UI (a covered drawer has no usable controls), but stay
    // consistent if it happens: close it in place and leave its history entry behind.
    const index = drawerLayers.lastIndexOf(name);
    if (index !== -1) {
        drawerLayers.splice(index, 1);
        drawerLayerClosers[name]();
    }
}

// Called with the layer already removed when history drove the close; removes it otherwise.
function forgetDrawerLayer(name) {
    const index = drawerLayers.lastIndexOf(name);
    if (index !== -1) drawerLayers.splice(index, 1);
}

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

    closeButton.addEventListener('click', () => requestDrawerLayerClose('issue'));

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

function closeDrawerInternal() {
    if (!drawerState.isOpen) return;
    forgetDrawerLayer('issue');
    const elements = ensureDrawerElements();
    elements.container.classList.remove('is-open');
    elements.drawer.setAttribute('aria-hidden', 'true');
    if (document.body) {
        document.body.classList.remove(BODY_DRAWER_CLASS);
    }
    drawerState.isOpen = false;
    drawerState.baseUrl = null;
    drawerState.currentUrl = null;
    drawerState.renderedSignature = null;
    lastKnownUrl = window.location.href;

    clearHighlightedIssue();

    // Any in-flight request is left to finish and populate the cache; dropping the
    // token is what stops it from rendering into a drawer the user already closed.
    drawerState.activeRequestToken = null;

    setTimeout(() => {
        elements.body.scrollTop = 0;
        setDrawerTitle('Loading...', '#');
        showDrawerLoading();
    }, 200);
}

// --- Drawer prefetching ---
// Rendering an issue page server-side takes anywhere from ~0.5s to several seconds,
// and that TTFB is the whole cost of opening the drawer - parsing and injecting the
// HTML is single-digit milliseconds. So the only real lever is to start the request
// before the click lands, and to not repeat it when the same issue is reopened.

// With background revalidation in place the cache can hold entries far longer than a
// plain TTL would allow: a stale copy is only ever shown for the moment it takes the
// refresh to come back.
const ISSUE_HTML_CACHE_TTL_MS = 300000;
// Below this age a copy is treated as current - it spares a pointless second render
// when a hover-prefetch is consumed by the click a moment later.
const REVALIDATE_AFTER_MS = 5000;
const PREFETCH_HOVER_DELAY_MS = 150;
const MAX_CACHED_ISSUES = 12;
// Rendering an issue costs the server real time, and a board is wall-to-wall issue
// links. Speculative requests stay capped so sweeping the mouse over a board cannot
// turn into a burst of expensive renders.
const MAX_INFLIGHT_PREFETCHES = 2;

// requestUrl -> { promise, html, fetchedAt }
const issueHtmlCache = new Map();
let prefetchHoverTimer = null;
let prefetchHoverUrl = null;
let inflightPrefetches = 0;

function issueRequestUrl(issueUrl) {
    const url = new URL(issueUrl, window.location.origin);
    return `${url.origin}${url.pathname}${url.search}`;
}

function pruneIssueHtmlCache() {
    const now = Date.now();
    issueHtmlCache.forEach((entry, key) => {
        if (entry.html !== undefined && now - entry.fetchedAt > ISSUE_HTML_CACHE_TTL_MS) {
            issueHtmlCache.delete(key);
        }
    });

    // Keep the map bounded; Map iterates in insertion order, so the oldest go first.
    while (issueHtmlCache.size > MAX_CACHED_ISSUES) {
        const oldestKey = issueHtmlCache.keys().next().value;
        issueHtmlCache.delete(oldestKey);
    }
}

// Single-flight fetch: a hover-triggered prefetch and the click that follows it share
// one request instead of racing two identical ones against a slow server.
function fetchIssueHtml(requestUrl, { force = false } = {}) {
    pruneIssueHtmlCache();

    if (force) {
        issueHtmlCache.delete(requestUrl);
    } else {
        const cached = issueHtmlCache.get(requestUrl);
        if (cached) {
            return cached.promise;
        }
    }

    const entry = { fetchedAt: Date.now(), html: undefined, finalUrl: requestUrl };
    entry.promise = fetch(requestUrl, { credentials: 'include' })
        .then(response => {
            if (!response.ok) {
                throw new Error(`Response not OK (${response.status})`);
            }
            entry.finalUrl = response.url || requestUrl;
            return response.text();
        })
        .then(html => {
            entry.html = html;
            entry.fetchedAt = Date.now();
            return { html, finalUrl: entry.finalUrl };
        })
        .catch(error => {
            // Never cache a failure - the next attempt should hit the server again.
            issueHtmlCache.delete(requestUrl);
            throw error;
        });

    issueHtmlCache.set(requestUrl, entry);
    return entry.promise;
}

function invalidateIssueHtml(issueUrl) {
    try {
        issueHtmlCache.delete(issueRequestUrl(issueUrl));
    } catch (error) {
        // Ignore unparsable URLs - nothing to invalidate.
    }
}

function prefetchIssue(issueUrl) {
    let requestUrl;
    try {
        requestUrl = issueRequestUrl(issueUrl);
    } catch (error) {
        return;
    }

    if (issueHtmlCache.has(requestUrl) || inflightPrefetches >= MAX_INFLIGHT_PREFETCHES) {
        return;
    }

    inflightPrefetches += 1;
    fetchIssueHtml(requestUrl)
        .catch(() => {
            // A failed prefetch is not worth reporting; the click will retry and surface it.
        })
        .finally(() => {
            inflightPrefetches -= 1;
        });
}

function cancelPrefetchHover() {
    if (prefetchHoverTimer !== null) {
        clearTimeout(prefetchHoverTimer);
        prefetchHoverTimer = null;
    }
    prefetchHoverUrl = null;
}

// Warm the cache once the pointer has settled on a link, so the server has a head start
// by the time the click arrives. The dwell delay keeps a cursor sweeping across an issue
// list from firing a request per row.
function handleIssuePrefetchHover(event) {
    const anchor = event.target.closest && event.target.closest('a[href]');
    if (!anchor || !shouldHandleIssueLink(anchor)) {
        cancelPrefetchHover();
        return;
    }

    const issueUrl = resolveIssueUrl(anchor.getAttribute('href'));
    if (issueUrl === prefetchHoverUrl) {
        return;
    }

    cancelPrefetchHover();
    prefetchHoverUrl = issueUrl;
    prefetchHoverTimer = setTimeout(() => {
        prefetchHoverTimer = null;
        prefetchIssue(issueUrl);
    }, PREFETCH_HOVER_DELAY_MS);
}

// Fallback for pointers that never hover (touch, keyboard-driven clicks): mousedown
// still beats the click event by a few dozen milliseconds.
function handleIssuePrefetchIntent(event) {
    if (event.button !== undefined && event.button !== 0) return;
    // A modified click opens a real tab and never reaches the drawer, so prefetching
    // for it would just burn a server render.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest && event.target.closest('a[href]');
    if (!anchor || !shouldHandleIssueLink(anchor)) return;

    cancelPrefetchHover();
    prefetchIssue(resolveIssueUrl(anchor.getAttribute('href')));
}

async function loadIssueIntoDrawer(issueUrl, { force = false } = {}) {
    ensureDrawerElements();
    const urlObj = new URL(issueUrl, window.location.origin);
    const requestUrl = `${urlObj.origin}${urlObj.pathname}${urlObj.search}`;
    const anchor = urlObj.hash;

    const requestToken = Symbol('drawerRequest');
    drawerState.activeRequestToken = requestToken;

    const cached = !force && issueHtmlCache.get(requestUrl);
    const isWarm = !!(cached && cached.html !== undefined);
    const shouldRevalidate = isWarm && (Date.now() - cached.fetchedAt) > REVALIDATE_AFTER_MS;

    // A warm cache hit renders synchronously enough that a loading state would just flash.
    if (!isWarm) {
        setDrawerTitle('Loading...', issueUrl);
        showDrawerLoading();
    }

    let effectiveIssueUrl = issueUrl;

    try {
        const { html, finalUrl } = await fetchIssueHtml(requestUrl, { force });

        // The drawer moved on (another issue clicked, or it was closed) while we waited.
        if (drawerState.activeRequestToken !== requestToken) {
            return;
        }

        if (!html || !html.trim()) {
            navigateToIssuePage(issueUrl, 'Empty issue response.');
            return;
        }

        const finalUrlBase = resolveIssueUrl(finalUrl || requestUrl);
        effectiveIssueUrl = anchor ? `${finalUrlBase}${anchor}` : finalUrlBase;
        drawerState.currentUrl = effectiveIssueUrl;

        if (drawerState.isOpen) {
            replaceDrawerUrl('issue', effectiveIssueUrl);
        }

        const content = parseIssueContent(html);

        if (!content) {
            navigateToIssuePage(issueUrl, 'Issue content container missing.');
            return;
        }

        renderIssueContent(content, effectiveIssueUrl, anchor);

        if (shouldRevalidate) {
            // The cached copy is on screen instantly; now check whether the issue moved
            // on behind our back (a new comment, an edited description) and quietly
            // catch up if it did.
            revalidateDrawerIssue(requestUrl, requestToken, effectiveIssueUrl, anchor);
        }
    } catch (error) {
        if (drawerState.activeRequestToken !== requestToken) {
            return;
        }
        console.error('Redmana: Failed to load issue into drawer.', error);
        navigateToIssuePage(issueUrl, error && error.message ? error.message : error);
        return;
    } finally {
        if (drawerState.activeRequestToken === requestToken) {
            drawerState.activeRequestToken = null;
        }
    }
}

function parseIssueContent(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.querySelector('#content');
}

function renderIssueContent(content, effectiveIssueUrl, anchor, { preserveScroll = false } = {}) {
    const elements = ensureDrawerElements();
    const previousScroll = preserveScroll ? elements.body.scrollTop : 0;

    const clonedContent = content.cloneNode(true);
    clonedContent.id = 'redmana-drawer-content';
    clonedContent.querySelectorAll('script, link[rel="stylesheet"]').forEach(el => el.remove());

    const heading = clonedContent.querySelector('h2');
    const titleText = heading ? heading.textContent.trim() : 'Task';
    setDrawerTitle(titleText, effectiveIssueUrl);

    elements.body.innerHTML = '';
    elements.body.appendChild(clonedContent);
    elements.body.scrollTop = previousScroll;

    drawerState.renderedSignature = issueContentSignature(content);

    attachDrawerEnhancements(clonedContent, effectiveIssueUrl);
    highlightIssueContext(effectiveIssueUrl);

    if (anchor && !preserveScroll) {
        const target = clonedContent.querySelector(anchor);
        if (target) {
            scrollDrawerToElement(target);
        }
    }
}

// Rails re-randomises the CSRF token and form names on every request, so raw markup
// never compares equal. Stripping just those makes an unchanged issue compare identical.
function issueContentSignature(content) {
    const copy = content.cloneNode(true);
    copy.querySelectorAll('input[name="authenticity_token"]').forEach(el => el.setAttribute('value', ''));
    copy.querySelectorAll('form[name]').forEach(el => el.removeAttribute('name'));
    copy.querySelectorAll('[id^="form-"]').forEach(el => el.removeAttribute('id'));
    return copy.innerHTML;
}

// Anything the user typed, ticked or picked since the drawer rendered. A background
// refresh must never throw this away - a half-written comment is worth more than
// being a few seconds fresher.
function drawerHasUnsavedInput() {
    const elements = ensureDrawerElements();
    const root = elements.body;

    if (root.contains(document.activeElement) && document.activeElement !== root) {
        const active = document.activeElement;
        if (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
            return true;
        }
    }

    const fields = root.querySelectorAll('input, textarea, select');
    for (const field of fields) {
        if (field.type === 'hidden' || field.disabled) continue;

        if (field.tagName === 'SELECT') {
            // Compare by value, not per-option flags: the "Latest" optgroup we inject
            // duplicates an existing option, so the selection legitimately sits on a
            // clone whose defaultSelected is false.
            const selected = Array.from(field.selectedOptions).map(option => option.value).sort();
            const original = Array.from(field.options).filter(option => option.defaultSelected).map(option => option.value).sort();

            if (!original.length && !field.multiple) {
                // No server-side selection means the browser picked the first option.
                const fallback = field.options[0] ? field.options[0].value : '';
                if (field.value !== fallback) return true;
                continue;
            }

            if (selected.join('\u0000') !== original.join('\u0000')) return true;
            continue;
        }

        if (field.type === 'checkbox' || field.type === 'radio') {
            if (field.checked !== field.defaultChecked) return true;
            continue;
        }

        if (field.type === 'file') {
            if (field.files && field.files.length) return true;
            continue;
        }

        if (field.value !== field.defaultValue) return true;
    }

    return !!root.querySelector('[contenteditable="true"]:not(:empty)');
}

// Fired only after a cache hit: re-request in the background and swap in the result
// if - and only if - the issue actually changed and the user has nothing in progress.
async function revalidateDrawerIssue(requestUrl, requestToken, effectiveIssueUrl, anchor) {
    let fresh;
    try {
        fresh = await fetchIssueHtml(requestUrl, { force: true });
    } catch (error) {
        console.warn('Redmana: Background refresh failed; keeping the cached view.', error);
        return;
    }

    // The drawer moved on to another issue, or was closed, while we were refreshing.
    if (drawerState.activeRequestToken !== null && drawerState.activeRequestToken !== requestToken) {
        return;
    }
    if (!drawerState.isOpen || drawerState.currentUrl !== effectiveIssueUrl) {
        return;
    }

    const content = parseIssueContent(fresh.html);
    if (!content) return;

    if (issueContentSignature(content) === drawerState.renderedSignature) {
        return; // Nothing changed - leave the DOM alone.
    }

    if (drawerHasUnsavedInput()) {
        console.log('Redmana: Issue changed upstream, but the drawer has unsaved input - not refreshing.');
        return;
    }

    renderIssueContent(content, effectiveIssueUrl, anchor, { preserveScroll: true });
}

function attachDrawerEnhancements(drawerContent, issueUrl) {
    enhanceIssueForms(drawerContent, issueUrl);
    normalizeLinks(drawerContent);
    revealIssueHistory(drawerContent);
    enableDrawerAnchorNavigation(drawerContent, issueUrl);
}

function normalizeLinks(drawerContent) {
    drawerContent.querySelectorAll('a[href]').forEach(link => {
        const href = link.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

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

function scrollDrawerToElement(targetElement, options = {}) {
    if (!targetElement) return;
    const { smooth = false } = options;
    const drawerBody = targetElement.closest('.redmana-drawer-body');
    const behavior = smooth ? 'smooth' : 'auto';

    if (drawerBody) {
        const drawerRect = drawerBody.getBoundingClientRect();
        const targetRect = targetElement.getBoundingClientRect();
        const nextScrollTop = drawerBody.scrollTop + (targetRect.top - drawerRect.top);
        drawerBody.scrollTo({ top: nextScrollTop, behavior });
    } else {
        targetElement.scrollIntoView({ block: 'start', behavior });
    }
}

function enableDrawerAnchorNavigation(drawerContent, issueUrl) {
    if (!drawerContent) return;

    let baseUrl;
    try {
        baseUrl = new URL(issueUrl, window.location.origin);
    } catch (error) {
        console.warn('Redmana: Failed to parse issue URL for anchor handling.', error);
        return;
    }

    const normalizePathname = pathname => (pathname || '').replace(/\/+$/, '');

    drawerContent.addEventListener('click', event => {
        if (event.defaultPrevented || event.button !== 0) return;
        const anchor = event.target.closest('a[href]');
        if (!anchor) return;

        const rawHref = anchor.getAttribute('href');
        if (!rawHref) return;

        let targetHash = null;

        if (rawHref.startsWith('#')) {
            targetHash = rawHref;
        } else {
            let resolvedUrl;
            try {
                resolvedUrl = new URL(resolveIssueUrl(rawHref));
            } catch (error) {
                return;
            }

            if (normalizePathname(resolvedUrl.pathname) !== normalizePathname(baseUrl.pathname)) {
                return; // Different issue; let the global handler deal with it.
            }

            targetHash = resolvedUrl.hash || '';
        }

        if (!targetHash || targetHash === '#') return;

        const selector = targetHash.startsWith('#') ? targetHash : `#${targetHash}`;
        const targetElement = drawerContent.querySelector(selector);
        if (!targetElement) return;

        event.preventDefault();
        event.stopPropagation();

        const updatedUrl = `${baseUrl.origin}${baseUrl.pathname}${baseUrl.search}${selector}`;
        replaceDrawerUrl('issue', updatedUrl);
        drawerState.currentUrl = updatedUrl;

        scrollDrawerToElement(targetElement, { smooth: true });
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

        invalidateIssueHtml(nextUrl);
        await loadIssueIntoDrawer(nextUrl, { force: true });
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
    if (!drawerState.isOpen) {
        drawerState.baseUrl = window.location.href;
    }

    claimDrawerHistory('issue', absoluteUrl, () => {
        highlightIssueContext(absoluteUrl, options.triggerElement || null);

        drawerState.isOpen = true;
        drawerState.currentUrl = absoluteUrl;

        bringDrawerToFront(elements.container);
        elements.container.classList.add('is-open');
        elements.drawer.setAttribute('aria-hidden', 'false');
        if (document.body) {
            document.body.classList.add(BODY_DRAWER_CLASS);
        }

        loadIssueIntoDrawer(absoluteUrl);
    });
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
    drawerHistoryPending = false;

    // Back (or a drawer's own close) leaves the top drawer's history entry: close that drawer.
    const layer = drawerLayers.pop();
    if (layer) {
        drawerLayerClosers[layer]();
        lastKnownUrl = window.location.href;

        const claim = pendingDrawerClaim;
        pendingDrawerClaim = null;
        if (claim) claim();
        return;
    }
    pendingDrawerClaim = null;

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
    const top = topDrawerLayer();
    if (event.key === 'Escape' && top) {
        requestDrawerLayerClose(top);
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

    drawerLayerClosers.issue = closeDrawerInternal;
    document.addEventListener('click', handleDocumentClick, true);
    document.addEventListener('mouseover', handleIssuePrefetchHover, true);
    document.addEventListener('mouseout', cancelPrefetchHover, true);
    document.addEventListener('mousedown', handleIssuePrefetchIntent, true);
    window.addEventListener('popstate', handlePopState);
    document.addEventListener('keydown', handleKeyDown);
}

if (isRedmine) {
    initIssueDrawer();
    initAssigneeEnhancement();
}
