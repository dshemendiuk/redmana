
// Redmana: user overview - a drawer (and a profile page block) answering "what is this
// person working on right now, and what did they do lately".
//
// Loaded right after content.js into the same isolated world, so it shares its globals:
// isRedmine, the drawer history helpers (claimDrawerHistory, requestDrawerLayerClose,
// forgetDrawerLayer, drawerLayerClosers) and bringDrawerToFront.

const USER_DRAWER_INIT_FLAG = '__redmanaUserDrawerInitialized';
const USER_LINK_EXCLUDE_SELECTOR = '#top-menu, #account, #loggedas, #header, .flyout-menu, .tabs, .redmana-drawer-header, [data-redmana-bypass="true"]';
const ACTIVITY_DAY_OPTIONS = [3, 7, 14];
const DEFAULT_ACTIVITY_DAYS = 7;
const ACTIVITY_DAYS_KEY = 'redmanaUserActivityDays';
// Time in the current status at which an issue starts to deserve a question at stand-up.
const STALE_WARN_DAYS = 3;
const STALE_ALERT_DAYS = 7;
const BACKLOG_COLLAPSE_THRESHOLD = 5;
const MAX_ASSIGNED_ISSUES = 300;
const MAX_TIME_ENTRIES = 300;
const MAX_ACTIVITY_PAGES = 4;
// Journal requests are cheap (~200ms) but there can be dozens of them per person, and
// they share the server with the issue pages the user is actually waiting for.
const JOURNAL_CONCURRENCY = 4;
const ISSUE_JOURNAL_TTL_MS = 60000;
const MAX_CACHED_JOURNALS = 400;
// A reopened overview renders from memory at once; past this age it also refreshes.
const OVERVIEW_REFRESH_AFTER_MS = 15000;
const NOTIFY_THROTTLE_MS = 250;
const PROFILE_REFRESH_AFTER_MS = 300000;
const DAY_MS = 86400000;
const NOTES_EXCERPT_LENGTH = 280;

const REDMINE_BASE_PATH = detectRedmineBasePath();
const PAGE_LANG = document.documentElement.lang || undefined;

const userDrawerState = {
    isOpen: false,
    userId: null
};

let userDrawerElements = null;

// userId -> overview state (see createOverviewState)
const overviewStates = new Map();
// Every place an overview is rendered into: the drawer and, on a profile page, the page itself.
const overviewViews = new Set();

// --- Redmine access ---

// Redmine may live under a sub-path (example.com/redmine/); the home link always points at its root.
function detectRedmineBasePath() {
    const home = document.querySelector('#top-menu a.home');
    if (home) {
        try {
            const pathname = new URL(home.getAttribute('href'), window.location.origin).pathname;
            return pathname.endsWith('/') ? pathname : `${pathname}/`;
        } catch (error) {
            // Fall through to the root.
        }
    }
    return '/';
}

function redmineUrl(path) {
    return new URL(REDMINE_BASE_PATH + path.replace(/^\/+/, ''), window.location.origin).toString();
}

class RedmineApiUnavailableError extends Error {}

// Redmine ignores the session cookie on .json requests, so the REST API needs the user's
// own key. It is read from /my/api_key with the session the user already has, and kept
// in memory only - never stored or shown.
let apiKeyPromise = null;

function getApiKey() {
    if (!apiKeyPromise) {
        apiKeyPromise = fetch(redmineUrl('my/api_key'), { credentials: 'include' })
            .then(response => (response.ok ? response.text() : ''))
            .then(html => {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const pre = doc.querySelector('#content pre');
                const key = pre ? pre.textContent.trim() : '';
                return /^[0-9a-f]{20,}$/i.test(key) ? key : null;
            })
            .catch(() => null)
            .then(key => {
                if (!key) {
                    apiKeyPromise = null; // Let the next attempt try again.
                }
                return key;
            });
    }
    return apiKeyPromise;
}

async function redmineApi(path) {
    const key = await getApiKey();
    if (!key) {
        throw new RedmineApiUnavailableError('REST API key unavailable');
    }
    const response = await fetch(redmineUrl(path), {
        credentials: 'same-origin',
        headers: { 'X-Redmine-API-Key': key, Accept: 'application/json' }
    });
    if (!response.ok) {
        throw new Error(`Redmine API responded ${response.status} for ${path.split('?')[0]}`);
    }
    return response.json();
}

async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length).fill(null);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const index = next;
            next += 1;
            try {
                results[index] = await fn(items[index]);
            } catch (error) {
                results[index] = null;
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// Statuses and priorities, in Redmine's configured order.
let referenceDataPromise = null;

function loadReferenceData() {
    if (!referenceDataPromise) {
        referenceDataPromise = Promise.all([
            redmineApi('issue_statuses.json'),
            redmineApi('enumerations/issue_priorities.json').catch(() => ({ issue_priorities: [] }))
        ]).then(([statusData, priorityData]) => {
            const statuses = statusData.issue_statuses || [];
            const priorities = priorityData.issue_priorities || [];
            const defaultPriorityIndex = Math.max(0, priorities.findIndex(priority => priority.is_default));
            // `status_id=open` can be very slow on large instances (10s+ for a busy person,
            // whatever the page size), while the same set spelled out as ids is instant.
            // Older Redmines don't report is_closed, so fall back to the keyword there.
            const knowsClosed = statuses.length && statuses.every(status => typeof status.is_closed === 'boolean');
            return {
                statuses,
                openStatusFilter: knowsClosed
                    ? statuses.filter(status => !status.is_closed).map(status => status.id).join('|') || 'open'
                    : 'open',
                statusOrder: new Map(statuses.map((status, index) => [status.id, index])),
                statusNames: new Map(statuses.map(status => [String(status.id), status.name])),
                // The first status is where new issues land; time spent there is backlog, not delay.
                backlogStatusId: statuses.length ? statuses[0].id : null,
                priorityNames: new Map(priorities.map(priority => [String(priority.id), priority.name])),
                elevatedPriorityIds: new Set(priorities.slice(defaultPriorityIndex + 1).map(priority => priority.id)),
                defaultPriorityId: priorities[defaultPriorityIndex] ? priorities[defaultPriorityIndex].id : null
            };
        }).catch(error => {
            referenceDataPromise = null;
            throw error;
        });
    }
    return referenceDataPromise;
}

// Journal details carry bare user ids. Names are collected from everything we fetch and
// from user links on the page; looking users up one by one is far too slow on big instances.
const knownUserNames = new Map();

function rememberUser(user) {
    if (user && user.id && user.name) {
        knownUserNames.set(String(user.id), user.name);
    }
}

// Also hands the issue to the issue drawer, which can draw it at once when it is opened.
function rememberIssuePeople(issue) {
    rememberIssueData(issue);
    rememberUser(issue.assigned_to);
    rememberUser(issue.author);
    (issue.journals || []).forEach(journal => rememberUser(journal.user));
}

function seedUserNamesFromPage() {
    document.querySelectorAll('a.user[href]').forEach(anchor => {
        if (anchor.closest(USER_LINK_EXCLUDE_SELECTOR)) return;
        const userId = userIdFromHref(anchor.getAttribute('href'));
        const name = anchor.textContent.trim();
        if (userId && name && !knownUserNames.has(userId)) {
            knownUserNames.set(userId, name);
        }
    });
}

function userName(userId) {
    if (userId === null || userId === undefined || userId === '') return 'nobody';
    return knownUserNames.get(String(userId)) || `user #${userId}`;
}

// issueId -> { promise, issue, fetchedAt }
const issueJournalCache = new Map();

function fetchIssueWithJournals(issueId, knownUpdatedOn) {
    const cached = issueJournalCache.get(issueId);
    if (cached) {
        if (!cached.issue) {
            return cached.promise;
        }
        const fresh = knownUpdatedOn
            ? cached.issue.updated_on === knownUpdatedOn
            : Date.now() - cached.fetchedAt < ISSUE_JOURNAL_TTL_MS;
        if (fresh) {
            return Promise.resolve(cached.issue);
        }
    }

    const entry = { issue: null, fetchedAt: 0 };
    entry.promise = whenIssuePagesIdle()
        .then(() => redmineApi(`issues/${issueId}.json?include=journals`))
        .then(data => {
            entry.issue = data.issue;
            entry.fetchedAt = Date.now();
            rememberIssuePeople(data.issue);
            return data.issue;
        })
        .catch(error => {
            issueJournalCache.delete(issueId);
            throw error;
        });

    issueJournalCache.delete(issueId);
    issueJournalCache.set(issueId, entry);
    while (issueJournalCache.size > MAX_CACHED_JOURNALS) {
        issueJournalCache.delete(issueJournalCache.keys().next().value);
    }
    return entry.promise;
}

// Reports what has arrived so far through `onProgress`, so a long list renders page by page.
async function fetchAssignedIssues(userId, reference, onProgress) {
    const path = offset => `issues.json?assigned_to_id=${userId}&status_id=${reference.openStatusFilter}&limit=100&offset=${offset}`;
    const pages = [];
    let totalCount = 0;
    const report = () => {
        const issues = pages.flat();
        issues.forEach(rememberIssuePeople);
        onProgress(issues, totalCount);
        return issues;
    };

    const first = await redmineApi(path(0));
    pages[0] = first.issues || [];
    totalCount = first.total_count || pages[0].length;
    report();

    const total = Math.min(totalCount, MAX_ASSIGNED_ISSUES);
    const rest = [];
    for (let offset = 100; offset < total; offset += 100) {
        rest.push(redmineApi(path(offset)).then(page => {
            pages[offset / 100] = page.issues || [];
            report();
        }));
    }
    await Promise.all(rest);
    return report();
}

async function fetchRecentlyUpdatedAssignedIssues(userId, reference, startKey) {
    const page = await redmineApi(`issues.json?assigned_to_id=${userId}&status_id=${reference.openStatusFilter}&updated_on=%3E%3D${startKey}&limit=100`);
    const issues = page.issues || [];
    issues.forEach(rememberIssueData);
    return issues;
}

async function fetchCreatedIssues(userId, startKey) {
    const page = await redmineApi(`issues.json?author_id=${userId}&created_on=%3E%3D${startKey}&status_id=*&limit=100`);
    const issues = page.issues || [];
    issues.forEach(rememberIssueData);
    return issues;
}

async function fetchClosedAssignedIssues(userId, startKey) {
    const page = await redmineApi(`issues.json?assigned_to_id=${userId}&status_id=c&closed_on=%3E%3D${startKey}&limit=100`);
    const issues = page.issues || [];
    issues.forEach(rememberIssueData);
    return issues;
}

async function fetchTimeEntries(userId, startKey, endKey) {
    const entries = [];
    for (let offset = 0; offset < MAX_TIME_ENTRIES; offset += 100) {
        const page = await redmineApi(`time_entries.json?user_id=${userId}&from=${startKey}&to=${endKey}&limit=100&offset=${offset}`);
        entries.push(...(page.time_entries || []));
        if (offset + 100 >= (page.total_count || 0)) break;
    }
    return entries;
}

// The activity page is only used to find which issues the person touched. It is fast and
// session-authenticated, unlike the "updated by" issue filter, which can take tens of
// seconds on a large instance. The details then come from the journals themselves,
// because the activity stream leaves out every change that has neither a note nor a
// status change (reassignments, priority, due dates...).
// The first page also comes back through `onFirstPage` as Redmine's own feed, which is
// shown as-is while the journals behind the richer version load.
async function fetchActivityIssueIds(userId, startKey, onFirstPage) {
    const ids = new Set();
    let from = localDateKey(Date.now());

    for (let page = 0; page < MAX_ACTIVITY_PAGES; page += 1) {
        const response = await fetch(redmineUrl(`activity?user_id=${userId}&show_issues=1&from=${from}`), { credentials: 'include' });
        if (!response.ok) {
            throw new Error(`Activity page responded ${response.status}`);
        }
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        if (page === 0 && onFirstPage) {
            onFirstPage(parseNativeActivity(doc));
        }
        doc.querySelectorAll('#activity dt a[href]').forEach(anchor => {
            const match = anchor.getAttribute('href').match(/\/issues\/(\d+)/);
            if (match) ids.add(Number(match[1]));
        });

        // Each page covers a fixed number of days; its "Previous" link says where the next one starts.
        const previous = findPreviousActivityDate(doc, from);
        if (!previous || previous < startKey) break;
        from = previous;
    }

    return ids;
}

// Day headings stay as Redmine wrote them ("Today", "11/04/2026"): their format follows
// the user's date settings and isn't worth parsing for a preview that lives a second.
function parseNativeActivity(doc) {
    const days = [];
    doc.querySelectorAll('#activity h3').forEach(heading => {
        const list = heading.nextElementSibling;
        if (!list || list.tagName !== 'DL') return;
        const entries = [];
        list.querySelectorAll(':scope > dt').forEach(term => {
            const link = term.querySelector('a[href]');
            if (!link) return;
            const definition = term.nextElementSibling;
            const description = definition && definition.tagName === 'DD' ? definition.querySelector('.description') : null;
            const time = term.querySelector('.time');
            entries.push({
                time: time ? time.textContent.trim() : '',
                href: link.getAttribute('href'),
                title: link.textContent.trim(),
                notes: description ? description.textContent : ''
            });
        });
        if (entries.length) days.push({ label: heading.textContent.trim(), entries });
    });
    return days;
}

function findPreviousActivityDate(doc, currentFrom) {
    let best = null;
    doc.querySelectorAll('#content a[href*="from="]').forEach(anchor => {
        const match = anchor.getAttribute('href').match(/[?&]from=(\d{4}-\d{2}-\d{2})/);
        if (match && match[1] < currentFrom && (!best || match[1] > best)) {
            best = match[1];
        }
    });
    return best;
}

// --- Analysis ---

function analyzeIssueHistory(issue, userId) {
    let statusSince = issue.created_on;
    let assignedSince = issue.created_on;
    let lastJournal = null;
    let lastByUser = null;

    (issue.journals || []).forEach(journal => {
        (journal.details || []).forEach(detail => {
            if (detail.property !== 'attr') return;
            if (detail.name === 'status_id') {
                statusSince = journal.created_on;
            } else if (detail.name === 'assigned_to_id' && String(detail.new_value) === String(userId)) {
                assignedSince = journal.created_on;
            }
        });
        lastJournal = journal;
        if (journal.user && journal.user.id === userId) {
            lastByUser = journal;
        }
    });

    // "How long has this been sitting on them in this status" - whichever started later.
    const since = Math.max(Date.parse(statusSince), Date.parse(assignedSince));
    return {
        statusSince: Date.parse(statusSince),
        assignedSince: Date.parse(assignedSince),
        since,
        lastJournal,
        lastByUser
    };
}

const FIELD_LABELS = {
    status_id: 'Status',
    assigned_to_id: 'Assignee',
    priority_id: 'Priority',
    done_ratio: '% Done',
    due_date: 'Due date',
    start_date: 'Start date',
    estimated_hours: 'Estimate',
    fixed_version_id: 'Version',
    tracker_id: 'Tracker',
    project_id: 'Project',
    parent_id: 'Parent',
    category_id: 'Category',
    subject: 'Subject',
    description: 'Description',
    is_private: 'Private',
    tag_list: 'Tags'
};

function fieldLabel(name) {
    if (FIELD_LABELS[name]) return FIELD_LABELS[name];
    const words = String(name).replace(/_id$/, '').replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

// Turns journal details into { changes: [{label, from, to}], edited: [labels], attachments: [names] }.
function describeJournalDetails(details, reference) {
    const changes = [];
    const edited = [];
    const attachments = [];
    let customFields = 0;

    (details || []).forEach(detail => {
        if (detail.property === 'attachment') {
            if (detail.new_value) attachments.push(detail.new_value);
            return;
        }
        if (detail.property === 'cf') {
            customFields += 1;
            return;
        }
        if (detail.property === 'relation') {
            const target = detail.new_value || detail.old_value;
            edited.push(`${detail.new_value ? 'Relation' : 'Removed relation'} #${target}`);
            return;
        }
        if (detail.property !== 'attr') return;

        switch (detail.name) {
            case 'status_id':
                changes.push({
                    label: 'Status',
                    from: reference.statusNames.get(String(detail.old_value)) || detail.old_value,
                    to: reference.statusNames.get(String(detail.new_value)) || detail.new_value,
                    kind: 'status'
                });
                break;
            case 'assigned_to_id':
                changes.push({ label: 'Assignee', from: userName(detail.old_value), to: userName(detail.new_value), kind: 'assignee' });
                break;
            case 'priority_id':
                changes.push({
                    label: 'Priority',
                    from: reference.priorityNames.get(String(detail.old_value)) || detail.old_value,
                    to: reference.priorityNames.get(String(detail.new_value)) || detail.new_value
                });
                break;
            case 'done_ratio':
                changes.push({ label: '% Done', from: `${detail.old_value || 0}%`, to: `${detail.new_value || 0}%` });
                break;
            case 'due_date':
                changes.push({ label: 'Due date', from: detail.old_value || 'none', to: detail.new_value || 'none' });
                break;
            default:
                edited.push(fieldLabel(detail.name));
        }
    });

    if (customFields) {
        edited.push(customFields === 1 ? 'a custom field' : `${customFields} custom fields`);
    }

    return { changes, edited, attachments };
}

function buildIssueEvents(issue, userId, startMs, reference) {
    const events = [];
    (issue.journals || []).forEach(journal => {
        const time = Date.parse(journal.created_on);
        if (time < startMs) return;

        const byUser = journal.user && journal.user.id === userId;
        const receivedAssignment = (journal.details || []).some(detail =>
            detail.property === 'attr' && detail.name === 'assigned_to_id' && String(detail.new_value) === String(userId));

        if (byUser) {
            events.push({
                time,
                issue,
                kind: 'update',
                notes: journal.notes || '',
                anchor: `change-${journal.id}`,
                ...describeJournalDetails(journal.details, reference)
            });
        } else if (receivedAssignment) {
            // Somebody else handed this person an issue - worth seeing next to their own work.
            const description = describeJournalDetails(journal.details, reference);
            events.push({
                time,
                issue,
                kind: 'received',
                actor: journal.user ? journal.user.name : '',
                notes: '',
                anchor: `change-${journal.id}`,
                changes: description.changes.filter(change => change.kind === 'status' || change.kind === 'assignee'),
                edited: [],
                attachments: []
            });
        }
    });
    return events;
}

// How many issues the person was involved in during the period. Expects unmerged events.
function computeInvolvement({ events, fullIssues, assignedIssues, closedAssignedIssues, userId, startMs }) {
    const touched = new Set();
    const commented = new Set();
    let statusChanges = 0;

    events.forEach(event => {
        if (event.kind === 'received') return;
        touched.add(event.issue.id);
        if (event.notes && event.notes.trim()) commented.add(event.issue.id);
        statusChanges += event.changes.filter(change => change.kind === 'status').length;
    });

    // Handed to them in the period: an assignment journal, or a new issue created on them.
    const received = new Set();
    fullIssues.forEach(issue => {
        if (!issue) return;
        const handedOver = (issue.journals || []).some(journal =>
            Date.parse(journal.created_on) >= startMs && (journal.details || []).some(detail =>
                detail.property === 'attr' && detail.name === 'assigned_to_id' && String(detail.new_value) === String(userId)));
        if (handedOver) received.add(issue.id);
    });
    assignedIssues.forEach(issue => {
        if (Date.parse(issue.created_on) >= startMs) received.add(issue.id);
    });

    // Everything they had a hand in: own work, new assignments, and issues closed on them.
    const involved = new Set([...touched, ...received, ...closedAssignedIssues.map(issue => issue.id)]);

    return {
        involved: involved.size,
        touched: touched.size,
        commented: commented.size,
        received: received.size,
        statusChanges
    };
}

// A status change and its comment often land as separate journals a few seconds apart;
// they read as one action, so they are shown as one. Expects events sorted newest first.
const EVENT_MERGE_WINDOW_MS = 5 * 60000;

function mergeAdjacentEvents(events) {
    const merged = [];
    events.forEach(event => {
        const previous = merged[merged.length - 1];
        if (previous && previous.kind === 'update' && event.kind === 'update' &&
            previous.issue.id === event.issue.id && previous.time - event.time <= EVENT_MERGE_WINDOW_MS) {
            // `previous` is the later journal; the earlier one's changes come first.
            previous.changes = [...event.changes, ...previous.changes];
            previous.edited = [...new Set([...event.edited, ...previous.edited])];
            previous.attachments = [...event.attachments, ...previous.attachments];
            previous.notes = [event.notes, previous.notes].filter(Boolean).join('\n\n');
            previous.anchor = event.anchor;
            return;
        }
        merged.push({ ...event });
    });
    return merged;
}

// --- Overview state ---

function createOverviewState(person) {
    return {
        userId: person.id,
        name: person.name || '',
        avatar: person.avatar || null,
        reference: null,
        workload: { status: 'idle', issues: [], totalCount: 0, history: new Map(), error: null, fetchedAt: 0, promise: null },
        notifyTimer: null,
        profile: { status: 'idle', node: null, fetchedAt: 0, promise: null },
        activity: new Map(), // days -> { status, events, hoursByDay, totalHours, error, fetchedAt, promise }
        collapsedGroups: null
    };
}

function getOverviewState(person) {
    let state = overviewStates.get(person.id);
    if (!state) {
        state = createOverviewState(person);
        overviewStates.set(person.id, state);
    } else {
        if (person.name && !state.name) state.name = person.name;
        if (person.avatar && !state.avatar) state.avatar = person.avatar;
    }
    return state;
}

function notifyOverview(state) {
    if (state.notifyTimer !== null) {
        clearTimeout(state.notifyTimer);
        state.notifyTimer = null;
    }
    overviewViews.forEach(view => {
        if (view.userId === state.userId) {
            view.render(state);
        }
    });
}

// Coalesces the stream of small updates while a long list fills in.
function scheduleNotify(state) {
    if (state.notifyTimer !== null) return;
    state.notifyTimer = setTimeout(() => {
        state.notifyTimer = null;
        notifyOverview(state);
    }, NOTIFY_THROTTLE_MS);
}

// Issues in flight first: the backlog is folded away and never flagged as stale anyway.
function journalFetchOrder(issues, reference) {
    const rank = issue => (issue.status.id === reference.backlogStatusId ? 1 : 0);
    return issues.slice().sort((a, b) => rank(a) - rank(b));
}

function backlogIsFolded(state, issues) {
    const backlogId = state.reference && state.reference.backlogStatusId;
    if (state.collapsedGroups) return state.collapsedGroups.has(backlogId);
    return issues.filter(issue => issue.status.id === backlogId).length > BACKLOG_COLLAPSE_THRESHOLD;
}

// Fills in the history of a group opened by hand - typically the deferred backlog.
// Issues already being fetched share their in-flight request through the journal cache.
function loadMissingHistory(state, issues) {
    const workload = state.workload;
    const missing = issues.filter(issue => !workload.history.has(issue.id));
    if (!missing.length) return Promise.resolve();

    return mapWithConcurrency(missing, JOURNAL_CONCURRENCY, async issue => {
        const full = await fetchIssueWithJournals(issue.id, issue.updated_on);
        workload.history.set(full.id, analyzeIssueHistory(full, state.userId));
        scheduleNotify(state);
    }).finally(() => notifyOverview(state));
}

function refreshWorkload(state, { force = false } = {}) {
    const workload = state.workload;
    if (workload.promise) return workload.promise;
    if (!force && workload.status === 'ready' && Date.now() - workload.fetchedAt < OVERVIEW_REFRESH_AFTER_MS) {
        return Promise.resolve();
    }

    // A refresh of data already on screen is swapped in once complete instead of streaming.
    const hadData = workload.status === 'ready';
    if (!hadData) {
        workload.status = 'loading';
    }

    workload.promise = loadReferenceData()
        .then(async reference => {
            state.reference = reference;
            const issues = await fetchAssignedIssues(state.userId, reference, (partial, totalCount) => {
                workload.totalCount = totalCount;
                if (hadData) return;
                workload.issues = partial;
                workload.status = 'partial';
                scheduleNotify(state);
            });

            workload.issues = issues;
            workload.error = null;
            if (!state.name && issues[0] && issues[0].assigned_to) {
                state.name = issues[0].assigned_to.name;
            }

            // A folded backlog can be hundreds of issues; their history waits until it is opened.
            const deferBacklog = backlogIsFolded(state, issues);
            const wanted = deferBacklog
                ? issues.filter(issue => issue.status.id !== reference.backlogStatusId)
                : journalFetchOrder(issues, reference);

            const history = hadData ? new Map() : workload.history;
            if (!hadData) history.clear();
            await mapWithConcurrency(wanted, JOURNAL_CONCURRENCY, async issue => {
                const full = await fetchIssueWithJournals(issue.id, issue.updated_on);
                history.set(full.id, analyzeIssueHistory(full, state.userId));
                if (!hadData) scheduleNotify(state);
            });
            workload.history = history;
            workload.status = 'ready';
            workload.fetchedAt = Date.now();
        })
        .catch(error => {
            console.warn('Redmana: Failed to load user workload.', error);
            workload.error = error;
            if (!hadData) workload.status = 'error';
        })
        .finally(() => {
            workload.promise = null;
            notifyOverview(state);
        });

    return workload.promise;
}

// The native profile column (login, last sign-in, issue counts, projects). Redmine renders
// that page slowly for busy people - seconds, not milliseconds - so it fills in last.
function refreshProfile(state) {
    const profile = state.profile;
    if (profile.promise) return profile.promise;
    if (profile.status === 'ready' && Date.now() - profile.fetchedAt < PROFILE_REFRESH_AFTER_MS) {
        return Promise.resolve();
    }
    if (profile.status !== 'ready') profile.status = 'loading';

    profile.promise = fetch(redmineUrl(`users/${state.userId}`), { credentials: 'include' })
        .then(response => {
            if (!response.ok) throw new Error(`Profile page responded ${response.status}`);
            return response.text();
        })
        .then(html => {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const column = doc.querySelector('#content .splitcontentleft');
            if (column) column.querySelectorAll('script').forEach(element => element.remove());
            Object.assign(profile, { status: column ? 'ready' : 'empty', node: column, fetchedAt: Date.now() });
        })
        .catch(error => {
            console.warn('Redmana: Failed to load the profile page.', error);
            if (profile.status !== 'ready') profile.status = 'error';
        })
        .finally(() => {
            profile.promise = null;
            notifyOverview(state);
        });
    return profile.promise;
}

function refreshActivity(state, days, { force = false } = {}) {
    let activity = state.activity.get(days);
    if (!activity) {
        activity = { status: 'idle', preview: null, events: [], hoursByDay: new Map(), totalHours: null, error: null, fetchedAt: 0, promise: null };
        state.activity.set(days, activity);
    }
    if (activity.promise) return activity.promise;
    if (!force && activity.status === 'ready' && Date.now() - activity.fetchedAt < OVERVIEW_REFRESH_AFTER_MS) {
        return Promise.resolve();
    }

    const hadData = activity.status === 'ready';
    if (!hadData) activity.status = 'loading';

    const userId = state.userId;
    const startMs = startOfLocalDay(Date.now() - (days - 1) * DAY_MS);
    const startKey = localDateKey(startMs);
    const endKey = localDateKey(Date.now());

    // Deliberately independent of the workload list, which can be long for a busy person.
    activity.promise = loadReferenceData()
        .then(reference => Promise.all([
            reference,
            fetchActivityIssueIds(userId, startKey, nativeDays => {
                if (hadData) return;
                activity.preview = nativeDays.slice(0, days);
                scheduleNotify(state);
            }),
            fetchCreatedIssues(userId, startKey).catch(() => []),
            fetchTimeEntries(userId, startKey, endKey).catch(() => null),
            // Open issues on them that moved in the period - where someone may have handed one over.
            fetchRecentlyUpdatedAssignedIssues(userId, reference, startKey).catch(() => []),
            fetchClosedAssignedIssues(userId, startKey).catch(() => [])
        ]))
        .then(async ([reference, touchedIds, createdIssues, timeEntries, assignedIssues, closedAssignedIssues]) => {
            const knownUpdatedOn = new Map();
            [...createdIssues, ...assignedIssues].forEach(issue => knownUpdatedOn.set(issue.id, issue.updated_on));

            const ids = new Set(touchedIds);
            createdIssues.forEach(issue => ids.add(issue.id));
            assignedIssues.forEach(issue => ids.add(issue.id));

            const issueIds = Array.from(ids);
            const fullIssues = await mapWithConcurrency(issueIds, JOURNAL_CONCURRENCY,
                issueId => fetchIssueWithJournals(issueId, knownUpdatedOn.get(issueId)));

            const events = [];
            fullIssues.forEach(issue => {
                if (issue) events.push(...buildIssueEvents(issue, userId, startMs, reference));
            });
            createdIssues.forEach(issue => {
                events.push({ time: Date.parse(issue.created_on), issue, kind: 'created', notes: '', changes: [], edited: [], attachments: [] });
            });
            events.sort((a, b) => b.time - a.time);
            const involvement = computeInvolvement({
                events,
                fullIssues,
                assignedIssues,
                closedAssignedIssues,
                userId,
                startMs
            });
            const mergedEvents = mergeAdjacentEvents(events);

            const hoursByDay = new Map();
            let totalHours = null;
            if (timeEntries) {
                totalHours = 0;
                timeEntries.forEach(entry => {
                    const hours = Number(entry.hours) || 0;
                    totalHours += hours;
                    hoursByDay.set(entry.spent_on, (hoursByDay.get(entry.spent_on) || 0) + hours);
                });
            }

            Object.assign(activity, { status: 'ready', events: mergedEvents, involvement, hoursByDay, totalHours, error: null, fetchedAt: Date.now() });
        })
        .catch(error => {
            console.warn('Redmana: Failed to load user activity.', error);
            activity.error = error;
            if (!hadData) activity.status = 'error';
        })
        .finally(() => {
            activity.promise = null;
            notifyOverview(state);
        });

    return activity.promise;
}

function loadActivityDaysPreference() {
    try {
        const stored = Number(localStorage.getItem(ACTIVITY_DAYS_KEY));
        return ACTIVITY_DAY_OPTIONS.includes(stored) ? stored : DEFAULT_ACTIVITY_DAYS;
    } catch (error) {
        return DEFAULT_ACTIVITY_DAYS;
    }
}

function saveActivityDaysPreference(days) {
    try {
        localStorage.setItem(ACTIVITY_DAYS_KEY, String(days));
    } catch (error) {
        // Not worth surfacing; the choice just won't be remembered.
    }
}

let activityDays = loadActivityDaysPreference();

// Order inside a status group, by time in the status. Newest first by default: issues that
// sat for a year are usually stale, while the fresh ones are what to ask about.
const ISSUE_SORT_KEY = 'redmanaUserIssueSort';
const ISSUE_SORT_OPTIONS = [
    { value: 'newest', label: 'Newest first' },
    { value: 'oldest', label: 'Oldest first' }
];

function loadIssueSortPreference() {
    try {
        return localStorage.getItem(ISSUE_SORT_KEY) === 'oldest' ? 'oldest' : 'newest';
    } catch (error) {
        return 'newest';
    }
}

function saveIssueSortPreference(value) {
    try {
        localStorage.setItem(ISSUE_SORT_KEY, value);
    } catch (error) {
        // Not worth surfacing; the choice just won't be remembered.
    }
}

let issueSortOrder = loadIssueSortPreference();

// --- Formatting ---

function pad2(value) {
    return String(value).padStart(2, '0');
}

function localDateKey(timeMs) {
    const date = new Date(timeMs);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function startOfLocalDay(timeMs) {
    const date = new Date(timeMs);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

function formatDuration(ms) {
    const minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

function formatRelative(timeMs) {
    const diff = Date.now() - timeMs;
    if (diff < 60000) return 'just now';
    return `${formatDuration(diff)} ago`;
}

function formatDateTime(timeMs) {
    return new Date(timeMs).toLocaleString(PAGE_LANG, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatTime(timeMs) {
    return new Date(timeMs).toLocaleTimeString(PAGE_LANG, { hour: '2-digit', minute: '2-digit' });
}

function formatShortDate(dateKey) {
    const [year, month, day] = dateKey.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(PAGE_LANG, { day: 'numeric', month: 'short' });
}

function formatDayLabel(dateKey) {
    const today = localDateKey(Date.now());
    if (dateKey === today) return 'Today';
    if (dateKey === localDateKey(startOfLocalDay(Date.now()) - DAY_MS / 2)) return 'Yesterday';
    const [year, month, day] = dateKey.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(PAGE_LANG, { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatHours(hours) {
    const rounded = Math.round(hours * 10) / 10;
    return `${rounded}h`;
}

function notesExcerpt(notes) {
    const text = String(notes || '')
        .replace(/```[\s\S]*?```/g, ' [code] ')
        .replace(/<pre>[\s\S]*?<\/pre>/gi, ' [code] ')
        .replace(/\|?\s*:?-{3,}:?\s*/g, ' ')
        .replace(/[*_`>#|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > NOTES_EXCERPT_LENGTH ? `${text.slice(0, NOTES_EXCERPT_LENGTH).trim()}…` : text;
}

// --- DOM helpers ---

function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
        Object.entries(props).forEach(([key, value]) => {
            if (value === null || value === undefined || value === false) return;
            if (key === 'class') {
                node.className = value;
            } else if (key === 'text') {
                node.textContent = value;
            } else if (key.startsWith('on') && typeof value === 'function') {
                node.addEventListener(key.slice(2), value);
            } else {
                node.setAttribute(key, value === true ? '' : value);
            }
        });
    }
    children.flat().forEach(child => {
        if (child === null || child === undefined || child === false) return;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
}

function issueUrl(issueId, anchor) {
    return redmineUrl(`issues/${issueId}${anchor ? `#${anchor}` : ''}`);
}

function issueLabel(issue) {
    return `${issue.tracker ? `${issue.tracker.name} ` : ''}#${issue.id}`;
}

function renderAvatar(person, className) {
    if (person.avatar && person.avatar.src) {
        return h('img', {
            class: `${className} gravatar avatar`,
            src: person.avatar.src,
            srcset: person.avatar.srcset || null,
            alt: ''
        });
    }
    const initials = (person.name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase();
    return h('span', { class: `${className} redmana-uo-initials`, 'aria-hidden': 'true', text: initials || '?' });
}

function renderAlert(message) {
    return h('div', { class: 'redmana-drawer-alert', text: message });
}

function renderMuted(message) {
    return h('div', { class: 'redmana-uo-muted', text: message });
}

function errorMessage(error, what) {
    if (error instanceof RedmineApiUnavailableError) {
        return 'Redmana needs the Redmine REST API to build this overview. Ask an administrator to enable it (Administration → Settings → API).';
    }
    return `Could not load ${what}. ${error && error.message ? error.message : ''}`.trim();
}

// --- Rendering: workload ---

function staleLevel(days, statusId, reference) {
    if (reference && statusId === reference.backlogStatusId) return null;
    if (days >= STALE_ALERT_DAYS) return 'alert';
    if (days >= STALE_WARN_DAYS) return 'warn';
    return null;
}

function computeWorkloadStats(state) {
    const { issues, history } = state.workload;
    const reference = state.reference;
    const today = localDateKey(Date.now());
    let stale = 0;
    let overdue = 0;
    let elevated = 0;

    issues.forEach(issue => {
        const info = history.get(issue.id);
        if (info && staleLevel((Date.now() - info.since) / DAY_MS, issue.status.id, reference) === 'alert') stale += 1;
        if (issue.due_date && issue.due_date < today) overdue += 1;
        if (reference && issue.priority && reference.elevatedPriorityIds.has(issue.priority.id)) elevated += 1;
    });

    return { total: Math.max(issues.length, state.workload.totalCount), stale, overdue, elevated };
}

function tile(value, label, { tone = null, title = null } = {}) {
    return h('div', {
        class: `redmana-uo-tile${tone ? ` is-${tone}` : ''}`,
        title
    }, h('strong', { text: value }), h('span', { text: label }));
}

function renderSummary(state) {
    const workload = state.workload;
    const activity = state.activity.get(activityDays);
    const ready = workload.status === 'ready';
    const stats = computeWorkloadStats(state);

    const listed = workload.status === 'ready' || workload.status === 'partial';
    const lastOwnEvent = activity && activity.status === 'ready'
        ? activity.events.find(event => event.kind !== 'received')
        : null;

    let lastActiveValue = '…';
    if (activity && activity.status === 'ready') {
        lastActiveValue = lastOwnEvent ? formatRelative(lastOwnEvent.time) : `>${activityDays}d`;
    } else if (activity && activity.status === 'error') {
        lastActiveValue = '—';
    }

    return h('div', { class: 'redmana-uo-summary' },
        tile(listed ? String(stats.total) : '…', 'open issues'),
        tile(ready ? String(stats.stale) : '…', `≥${STALE_ALERT_DAYS}d in status`, {
            tone: ready && stats.stale ? 'alert' : null,
            title: 'Open issues that have been in their current status, on this person, for a week or more (the initial status is not counted).'
        }),
        tile(listed ? String(stats.overdue) : '…', 'overdue', { tone: listed && stats.overdue ? 'alert' : null }),
        tile(listed ? String(stats.elevated) : '…', 'high priority', { tone: listed && stats.elevated ? 'warn' : null }),
        tile(lastActiveValue, 'last activity', {
            title: lastOwnEvent ? formatDateTime(lastOwnEvent.time) : null
        })
    );
}

function groupIssuesByStatus(state) {
    const reference = state.reference;
    const groups = new Map();
    state.workload.issues.forEach(issue => {
        const key = issue.status.id;
        if (!groups.has(key)) {
            groups.set(key, { status: issue.status, issues: [] });
        }
        groups.get(key).issues.push(issue);
    });

    const order = status => (reference && reference.statusOrder.has(status.id) ? reference.statusOrder.get(status.id) : 9999);
    const sorted = Array.from(groups.values()).sort((a, b) => order(a.status) - order(b.status));

    // Until its history arrives an issue sorts by its last update, the closest stand-in.
    const history = state.workload.history;
    const direction = issueSortOrder === 'oldest' ? 1 : -1;
    sorted.forEach(group => {
        group.issues.sort((a, b) => {
            const aSince = history.has(a.id) ? history.get(a.id).since : Date.parse(a.updated_on);
            const bSince = history.has(b.id) ? history.get(b.id).since : Date.parse(b.updated_on);
            return (aSince - bSince) * direction;
        });
    });
    return sorted;
}

function renderStatusStrip(groups, scrollRoot) {
    return h('div', { class: 'redmana-uo-status-strip' },
        groups.map(group => h('button', {
            type: 'button',
            class: 'redmana-uo-status-chip',
            onclick: () => {
                const target = scrollRoot.querySelector(`[data-redmana-status-group="${group.status.id}"]`);
                if (!target) return;
                target.open = true;
                target.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }
        }, h('span', { text: group.status.name }), h('b', { text: String(group.issues.length) })))
    );
}

function renderSortControl(state) {
    return h('div', { class: 'redmana-uo-segmented', role: 'group', 'aria-label': 'Sort issues by time in status' },
        ISSUE_SORT_OPTIONS.map(option => h('button', {
            type: 'button',
            class: option.value === issueSortOrder ? 'is-selected' : null,
            'aria-pressed': option.value === issueSortOrder ? 'true' : 'false',
            title: 'Order inside each status, by how long the issue has been in it',
            onclick: () => {
                issueSortOrder = option.value;
                saveIssueSortPreference(option.value);
                notifyOverview(state);
            }
        }, option.label)));
}

function renderIssueRow(issue, state) {
    const reference = state.reference;
    const info = state.workload.history.get(issue.id);
    const today = localDateKey(Date.now());

    let ageBadge;
    if (info) {
        const ageMs = Date.now() - info.since;
        const level = staleLevel(ageMs / DAY_MS, issue.status.id, reference);
        const title = [
            `In “${issue.status.name}” since ${formatDateTime(info.statusSince)}`,
            `assigned since ${formatDateTime(info.assignedSince)}`
        ].join(' · ');
        ageBadge = h('span', { class: `redmana-uo-age${level ? ` is-${level}` : ''}`, title }, formatDuration(ageMs));
    } else {
        ageBadge = h('span', { class: 'redmana-uo-age is-pending', title: 'Loading history…' }, '…');
    }

    const meta = [];
    if (issue.project) meta.push(h('span', { text: issue.project.name }));
    if (issue.priority && reference && issue.priority.id !== reference.defaultPriorityId) {
        const elevated = reference.elevatedPriorityIds.has(issue.priority.id);
        meta.push(h('span', { class: elevated ? 'redmana-uo-priority is-elevated' : 'redmana-uo-priority', text: issue.priority.name }));
    }
    if (issue.due_date) {
        const overdue = issue.due_date < today;
        meta.push(h('span', { class: overdue ? 'redmana-uo-due is-overdue' : 'redmana-uo-due', text: `due ${formatShortDate(issue.due_date)}` }));
    }
    if (issue.done_ratio) meta.push(h('span', { text: `${issue.done_ratio}%` }));

    const updatedAt = Date.parse(issue.updated_on);
    const lastAuthor = info && info.lastJournal && info.lastJournal.user ? info.lastJournal.user.name : null;
    meta.push(h('span', { title: formatDateTime(updatedAt) },
        `updated ${formatRelative(updatedAt)}${lastAuthor ? ` by ${lastAuthor}` : ''}`));

    return h('li', { class: 'redmana-uo-issue' },
        h('div', { class: 'redmana-uo-issue-main' },
            h('a', { class: 'redmana-uo-issue-link', href: issueUrl(issue.id) },
                h('span', { class: 'redmana-uo-issue-ref', text: issueLabel(issue) }),
                ' ',
                h('span', { text: issue.subject })),
            h('div', { class: 'redmana-uo-meta' }, meta)),
        ageBadge
    );
}

function renderWorkload(state, scrollRoot) {
    const workload = state.workload;

    if (workload.status === 'idle' || workload.status === 'loading') {
        return renderSkeleton(5);
    }
    if (workload.status === 'error') {
        return renderAlert(errorMessage(workload.error, 'assigned issues'));
    }
    if (!workload.issues.length) {
        return renderMuted('No open issues assigned.');
    }

    const groups = groupIssuesByStatus(state);
    // Start with a big backlog folded away; everything in flight stays visible. The choice
    // is only settled once the whole list is in, so the first page alone can't decide it.
    const collapsed = state.collapsedGroups || new Set(groups
        .filter(group => state.reference && group.status.id === state.reference.backlogStatusId &&
            group.issues.length > BACKLOG_COLLAPSE_THRESHOLD)
        .map(group => group.status.id));
    if (!state.collapsedGroups && workload.status === 'ready') {
        state.collapsedGroups = collapsed;
    }

    return h('div', { class: 'redmana-uo-workload' },
        h('div', { class: 'redmana-uo-toolbar' },
            renderStatusStrip(groups, scrollRoot),
            renderSortControl(state)),
        groups.map(group => {
            const details = h('details', {
                class: 'redmana-uo-group',
                'data-redmana-status-group': String(group.status.id),
                open: !collapsed.has(group.status.id)
            },
            h('summary', null, h('span', { text: group.status.name }), h('span', { class: 'redmana-uo-count', text: String(group.issues.length) })),
            h('ul', { class: 'redmana-uo-issues' }, group.issues.map(issue => renderIssueRow(issue, state))));

            // Also fires for the initial `open` of every render, so only act on a real change.
            details.addEventListener('toggle', () => {
                if (!state.collapsedGroups) state.collapsedGroups = collapsed;
                const wasCollapsed = state.collapsedGroups.has(group.status.id);
                if (details.open && wasCollapsed) {
                    state.collapsedGroups.delete(group.status.id);
                    loadMissingHistory(state, group.issues);
                } else if (!details.open && !wasCollapsed) {
                    state.collapsedGroups.add(group.status.id);
                }
            });
            return details;
        })
    );
}

// --- Rendering: activity ---

function renderChange(change) {
    return h('span', { class: 'redmana-uo-change' },
        h('span', { class: 'redmana-uo-change-label', text: `${change.label}: ` }),
        change.from !== undefined && change.from !== null && change.from !== ''
            ? h('span', { class: 'redmana-uo-change-from', text: String(change.from) })
            : null,
        change.from !== undefined && change.from !== null && change.from !== '' ? ' → ' : null,
        h('span', { class: 'redmana-uo-change-to', text: String(change.to) }));
}

function renderActivityEvent(event) {
    const issue = event.issue;
    const lines = [];

    if (event.kind === 'created') {
        lines.push(h('div', { class: 'redmana-uo-event-line' }, h('span', { class: 'redmana-uo-change-label', text: 'Created issue' })));
    }
    if (event.kind === 'received' && event.actor) {
        lines.push(h('div', { class: 'redmana-uo-event-line' }, h('span', { class: 'redmana-uo-change-label', text: `Handed over by ${event.actor}` })));
    }
    if (event.changes.length) {
        lines.push(h('div', { class: 'redmana-uo-event-line' }, event.changes.map(renderChange)));
    }
    const extras = [];
    if (event.edited.length) extras.push(`Edited ${event.edited.join(', ')}`);
    if (event.attachments.length) extras.push(`Attached ${event.attachments.join(', ')}`);
    if (extras.length) {
        lines.push(h('div', { class: 'redmana-uo-event-line redmana-uo-muted', text: extras.join(' · ') }));
    }
    const excerpt = notesExcerpt(event.notes);
    if (excerpt) {
        lines.push(h('div', { class: 'redmana-uo-notes', text: excerpt }));
    }

    return h('li', { class: `redmana-uo-event is-${event.kind}` },
        h('time', { class: 'redmana-uo-event-time', datetime: new Date(event.time).toISOString(), title: formatDateTime(event.time), text: formatTime(event.time) }),
        h('div', { class: 'redmana-uo-event-body' },
            h('a', { class: 'redmana-uo-issue-link', href: issueUrl(issue.id, event.anchor) },
                h('span', { class: 'redmana-uo-issue-ref', text: issueLabel(issue) }),
                ' ',
                h('span', { text: issue.subject })),
            issue.status ? h('span', { class: 'redmana-uo-status-badge', text: issue.status.name }) : null,
            lines));
}

function renderActivity(state, onDaysChange) {
    const activity = state.activity.get(activityDays);

    const header = h('div', { class: 'redmana-uo-section-header' },
        h('h3', { text: 'Activity' }),
        h('div', { class: 'redmana-uo-segmented', role: 'group', 'aria-label': 'Activity period' },
            ACTIVITY_DAY_OPTIONS.map(days => h('button', {
                type: 'button',
                class: days === activityDays ? 'is-selected' : null,
                'aria-pressed': days === activityDays ? 'true' : 'false',
                onclick: () => onDaysChange(days)
            }, `${days}d`))),
        h('a', {
            class: 'redmana-uo-more',
            href: redmineUrl(`activity?user_id=${state.userId}`),
            target: '_blank',
            rel: 'noopener noreferrer',
            'data-redmana-bypass': 'true'
        }, 'Redmine activity ↗'));

    let body;
    if (!activity || activity.status === 'idle' || activity.status === 'loading') {
        body = [
            renderInvolvement(null),
            activity && activity.preview ? renderNativeActivity(activity.preview) : renderSkeleton(4)
        ];
    } else if (activity.status === 'error') {
        body = renderAlert(errorMessage(activity.error, 'activity'));
    } else {
        body = [renderInvolvement(activity), renderActivityDays(activity)];
    }

    return h('div', { class: 'redmana-uo-activity' }, header, body);
}

// Period stats: they follow the 3d / 7d / 14d switch above them. Without data yet the
// tiles are still drawn, so nothing shifts when the numbers arrive.
function renderInvolvement(activity) {
    const involvement = activity ? activity.involvement : null;
    const value = key => (involvement ? String(involvement[key]) : '…');
    let logged = '…';
    if (activity) logged = activity.totalHours === null ? '—' : formatHours(activity.totalHours);

    return h('div', { class: 'redmana-uo-summary redmana-uo-involvement' },
        tile(value('involved'), 'involved in', {
            title: 'Issues this person worked on, was handed, or had closed on them in the period.'
        }),
        tile(value('touched'), 'worked on', {
            title: 'Issues this person updated, commented on or created in the period.'
        }),
        tile(value('commented'), 'commented in', {
            title: 'Issues this person left at least one comment in.'
        }),
        tile(value('received'), 'handed to them', {
            title: 'Issues that became assigned to this person during the period: reassigned to them or created on them.'
        }),
        tile(value('statusChanges'), 'status changes', {
            title: 'Status changes this person made.'
        }),
        tile(logged, 'logged', {
            title: activity && activity.totalHours === null ? 'Time entries are not available.' : 'Time logged in the period.'
        }));
}

// Redmine's own feed, in the same layout as ours, until the journal-based version is ready.
function renderNativeActivity(days) {
    if (!days.length) {
        return renderSkeleton(2);
    }
    return h('div', { class: 'redmana-uo-days is-preview', title: 'Loading details…' }, days.map(day =>
        h('section', { class: 'redmana-uo-day' },
            h('h4', null, h('span', { text: day.label })),
            h('ul', { class: 'redmana-uo-events' }, day.entries.map(entry => {
                const excerpt = notesExcerpt(entry.notes);
                return h('li', { class: 'redmana-uo-event' },
                    h('span', { class: 'redmana-uo-event-time', text: entry.time }),
                    h('div', { class: 'redmana-uo-event-body' },
                        h('a', { class: 'redmana-uo-issue-link', href: entry.href, text: entry.title }),
                        excerpt ? h('div', { class: 'redmana-uo-notes', text: excerpt }) : null));
            })))));
}

function renderSkeleton(rows) {
    return h('div', { class: 'redmana-uo-skeleton', 'aria-label': 'Loading', role: 'status' },
        Array.from({ length: rows }, () => h('div', { class: 'redmana-uo-skeleton-row' },
            h('span', { class: 'redmana-uo-skeleton-bar' }),
            h('span', { class: 'redmana-uo-skeleton-bar is-short' }))));
}

function renderActivityDays(activity) {
    const byDay = new Map();
    activity.events.forEach(event => {
        const key = localDateKey(event.time);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(event);
    });
    activity.hoursByDay.forEach((hours, key) => {
        if (!byDay.has(key)) byDay.set(key, []);
    });

    if (!byDay.size) {
        return renderMuted(`No activity in the last ${activityDays} days.`);
    }

    const keys = Array.from(byDay.keys()).sort().reverse();
    return h('div', { class: 'redmana-uo-days' }, keys.map(key => {
        const events = byDay.get(key);
        const hours = activity.hoursByDay.get(key);
        const ownCount = events.filter(event => event.kind !== 'received').length;
        const facts = [];
        if (ownCount) facts.push(`${ownCount} ${ownCount === 1 ? 'update' : 'updates'}`);
        if (hours) facts.push(`${formatHours(hours)} logged`);

        return h('section', { class: 'redmana-uo-day' },
            h('h4', null, h('span', { text: formatDayLabel(key) }), facts.length ? h('span', { class: 'redmana-uo-muted', text: facts.join(' · ') }) : null),
            events.length
                ? h('ul', { class: 'redmana-uo-events' }, events.map(renderActivityEvent))
                : renderMuted('Only time logged.'));
    }));
}

// --- Rendering: native profile ---

function renderProfile(state) {
    const profile = state.profile;
    if (profile.status === 'empty' || profile.status === 'error') {
        return [];
    }

    const header = h('div', { class: 'redmana-uo-section-header' },
        h('h3', { text: 'Profile' }),
        h('a', {
            class: 'redmana-uo-more',
            href: redmineUrl(`users/${state.userId}`),
            target: '_blank',
            rel: 'noopener noreferrer',
            'data-redmana-bypass': 'true'
        }, 'Profile page ↗'));

    const body = profile.status === 'ready'
        ? h('div', { class: 'redmana-uo-native-profile' }, Array.from(profile.node.cloneNode(true).childNodes))
        : renderSkeleton(3);

    return [header, body];
}

// --- Views ---

// A view owns a set of containers and redraws them whenever its user's state changes.
function createOverviewView({ summary, workload, activity, profile = null, scrollRoot, onRender = null }) {
    const view = {
        userId: null,
        wantsProfile: !!profile,
        render(state) {
            if (onRender) onRender(state);
            const scrollTop = scrollRoot ? scrollRoot.scrollTop : 0;
            if (summary) summary.replaceChildren(renderSummary(state));
            if (workload) workload.replaceChildren(renderWorkload(state, scrollRoot || document));
            if (activity) {
                activity.replaceChildren(renderActivity(state, days => {
                    activityDays = days;
                    saveActivityDaysPreference(days);
                    refreshActivity(state, days);
                    notifyOverview(state);
                }));
            }
            if (profile) profile.replaceChildren(...renderProfile(state));
            if (scrollRoot) scrollRoot.scrollTop = scrollTop;
        }
    };
    overviewViews.add(view);
    return view;
}

function showOverview(view, person) {
    seedUserNamesFromPage();
    const state = getOverviewState(person);
    view.userId = state.userId;
    view.render(state);
    refreshWorkload(state);
    refreshActivity(state, activityDays);
    if (view.wantsProfile) refreshProfile(state);
    return state;
}

// --- Drawer ---

function ensureUserDrawerElements() {
    if (userDrawerElements) {
        return userDrawerElements;
    }

    const container = h('div', { class: 'redmana-drawer-container redmana-user-drawer-container' });
    const drawer = h('aside', { class: 'redmana-drawer redmana-user-drawer', 'aria-hidden': 'true', 'aria-label': 'User overview' });

    const avatarSlot = h('span', { class: 'redmana-uo-header-avatar' });
    const titleLink = h('a', {
        class: 'redmana-drawer-title-link',
        href: '#',
        target: '_blank',
        rel: 'noopener noreferrer',
        title: 'Open profile page'
    }, 'Loading...');
    const title = h('h2', { class: 'redmana-drawer-title' }, titleLink);
    const issuesLink = h('a', {
        class: 'redmana-uo-header-link',
        href: '#',
        target: '_blank',
        rel: 'noopener noreferrer',
        title: 'Open issues assigned to this person'
    }, 'Issues ↗');
    const closeButton = h('button', {
        class: 'redmana-drawer-close',
        type: 'button',
        'aria-label': 'Close user overview',
        onclick: () => requestDrawerLayerClose('user')
    });
    closeButton.innerHTML = '&times;';

    const header = h('div', { class: 'redmana-drawer-header' },
        avatarSlot,
        title,
        h('div', { class: 'redmana-drawer-actions' }, issuesLink, closeButton));

    const summary = h('div', { class: 'redmana-uo-block' });
    const workload = h('div', { class: 'redmana-uo-block' });
    const activity = h('div', { class: 'redmana-uo-block' });
    const profile = h('div', { class: 'redmana-uo-block' });
    const body = h('div', { class: 'redmana-drawer-body redmana-uo' }, summary, workload, activity, profile);

    drawer.append(header, body);
    container.appendChild(drawer);
    document.body.appendChild(container);

    userDrawerElements = {
        container,
        drawer,
        body,
        avatarSlot,
        titleLink,
        issuesLink,
        view: createOverviewView({ summary, workload, activity, profile, scrollRoot: body, onRender: renderUserDrawerHeader })
    };
    return userDrawerElements;
}

// The name may only become known once the issues arrive (e.g. the link was a bare avatar).
function renderUserDrawerHeader(state) {
    const elements = userDrawerElements;
    elements.avatarSlot.replaceChildren(renderAvatar(state, 'redmana-uo-avatar'));
    elements.titleLink.textContent = state.name || `User #${state.userId}`;
    elements.titleLink.href = redmineUrl(`users/${state.userId}`);
    elements.issuesLink.href = redmineUrl(`issues?set_filter=1&assigned_to_id=${state.userId}&status_id=o`);
}

function openUserDrawer(person) {
    const elements = ensureUserDrawerElements();

    // The address bar shows the profile URL while the drawer is open, so a reload or a
    // copied link lands on the (enhanced) profile page.
    claimDrawerHistory('user', redmineUrl(`users/${person.id}`), () => {
        const switching = userDrawerState.userId !== person.id;
        userDrawerState.isOpen = true;
        userDrawerState.userId = person.id;

        showOverview(elements.view, person);
        if (switching) {
            elements.body.scrollTop = 0;
        }

        bringDrawerToFront(elements.container);
        elements.container.classList.add('is-open');
        elements.drawer.setAttribute('aria-hidden', 'false');
    });
}

// Closes the UI only; history is handled by the drawer layer stack in content.js.
function closeUserDrawerInternal() {
    if (!userDrawerState.isOpen) return;
    forgetDrawerLayer('user');
    const elements = ensureUserDrawerElements();
    elements.container.classList.remove('is-open');
    elements.drawer.setAttribute('aria-hidden', 'true');
    userDrawerState.isOpen = false;
}

// --- Link handling ---

function userIdFromHref(href) {
    if (!href || href.startsWith('javascript:')) return null;
    let url;
    try {
        url = new URL(href, window.location.origin);
    } catch (error) {
        return null;
    }
    if (url.origin !== window.location.origin) return null;
    if (!url.pathname.startsWith(REDMINE_BASE_PATH)) return null;
    const match = url.pathname.slice(REDMINE_BASE_PATH.length).match(/^users\/(\d+)\/?$/);
    return match ? match[1] : null;
}

function findLinkAvatar(anchor) {
    const candidates = [
        anchor.querySelector('img.gravatar, img.avatar'),
        anchor.previousElementSibling && anchor.previousElementSibling.matches('img.gravatar, img.avatar') ? anchor.previousElementSibling : null,
        anchor.parentElement ? anchor.parentElement.querySelector(':scope > img.gravatar, :scope > img.avatar') : null
    ];
    const img = candidates.find(Boolean);
    if (!img || !img.getAttribute('src')) return null;
    return { src: img.currentSrc || img.src, srcset: img.getAttribute('srcset') };
}

function personFromUserLink(anchor) {
    if (anchor.target === '_blank' || anchor.hasAttribute('download')) return null;
    if (anchor.closest(USER_LINK_EXCLUDE_SELECTOR)) return null;

    const userId = userIdFromHref(anchor.getAttribute('href'));
    if (!userId) return null;

    const img = anchor.querySelector('img');
    const name = anchor.textContent.trim() || (img && img.getAttribute('title')) || '';
    return { id: Number(userId), name, avatar: findLinkAvatar(anchor) };
}

function handleUserLinkClick(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = event.target.closest && event.target.closest('a[href]');
    if (!anchor) return;
    const person = personFromUserLink(anchor);
    if (!person) return;

    event.preventDefault();
    event.stopPropagation();
    openUserDrawer(person);
}

// --- Profile page ---

function enhanceUserProfilePage() {
    const body = document.body;
    if (!body.classList.contains('controller-users') || !body.classList.contains('action-show')) return;

    const userId = userIdFromHref(window.location.href);
    const content = document.querySelector('#content');
    const heading = content && content.querySelector(':scope > h2');
    if (!userId || !heading) return;

    const headingImg = heading.querySelector('img');
    const person = {
        id: Number(userId),
        name: heading.textContent.trim(),
        avatar: headingImg ? { src: headingImg.currentSrc || headingImg.src, srcset: headingImg.getAttribute('srcset') } : null
    };

    const summary = h('div', { class: 'redmana-uo-block' });
    const workload = h('div', { class: 'redmana-uo-block' });
    const overview = h('div', { class: 'redmana-uo redmana-uo-profile' }, summary, workload);
    heading.insertAdjacentElement('afterend', overview);

    // Redmine's own profile feed is capped at the last 10 events and skips every change
    // without a note or status change; ours replaces it, the full page stays one click away.
    const activity = h('div', { class: 'redmana-uo redmana-uo-block' });
    const rightColumn = content.querySelector('.splitcontentright');
    const nativeActivity = rightColumn && rightColumn.querySelector('#activity');
    if (rightColumn && nativeActivity) {
        rightColumn.querySelectorAll(':scope > h3, :scope > #activity, :scope > .other-formats').forEach(element => {
            element.classList.add('redmana-uo-replaced');
        });
        rightColumn.prepend(activity);
    } else if (rightColumn) {
        rightColumn.prepend(activity);
    } else {
        overview.appendChild(activity);
    }

    showOverview(createOverviewView({ summary, workload, activity, scrollRoot: null }), person);
}

function initUserOverview() {
    if (window[USER_DRAWER_INIT_FLAG]) return;
    window[USER_DRAWER_INIT_FLAG] = true;

    drawerLayerClosers.user = closeUserDrawerInternal;
    document.addEventListener('click', handleUserLinkClick, true);
    enhanceUserProfilePage();
}

if (isRedmine) {
    initUserOverview();
}
