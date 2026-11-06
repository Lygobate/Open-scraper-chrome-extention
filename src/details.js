(() => {
    "use strict";

    const chromeInstance = chrome;

    // CSS class put on <body> while the page details panel is shown
    const DETAILS_MODE_CLASS = "mode-details";

    // Elements of the list panel, kept in the layout but made inert while hidden
    const LIST_PANEL_IDS = ["wait", "content"];

    // Longest wait for the test page to load, and for the page to answer a command
    const TEST_PAGE_TIMEOUT_MS = 30000;
    const ANSWER_TIMEOUT_MS = 10000;
    // Interval between two checks of a page being loaded
    const READY_POLL_MS = 100;
    // After opening a URL, the page is not asked anything before its load begins or this delay
    // has passed (a change of the #fragment only begins no load)
    const LOAD_START_WAIT_MS = 300;
    // Once a page has loaded (and Min has passed), longest extra wait for the fields not shown
    // yet (content drawn late by scripts); never beyond the Max limit. Pages that already show
    // every field are read at once.
    const LATE_FIELDS_WAIT_MS = 5000;
    // Longest wait for the page shown to tell which document it is, before a run opens the next URL
    const OLD_DOCUMENT_PING_MS = 500;
    // A field found empty after the full wait on this many pages in a row, and never drawn late
    // during the run, stops holding the next pages up (it is still read when a page shows it at
    // once or before Min ends). It is waited for again on one page after every
    // ABSENT_FIELD_RECHECK_PAGES pages, and for good once seen drawn late.
    const ABSENT_FIELD_PAGES = 3;
    const ABSENT_FIELD_RECHECK_PAGES = 10;
    // Space kept under the results grid (paddings of the panel and of the step), and the delay
    // before the grid follows a change of the window size
    const GRID_BOTTOM_SPACE = 36;
    const GRID_FIT_DELAY_MS = 100;
    // Height of the grid's column headers: completion line, then the column name
    const GRID_HEADER_HEIGHT = 38;
    // Delay after the target tab finished loading a page before step 2 previews it again
    const PAGE_WATCH_DELAY_MS = 300;
    // How long "show in page" highlights a field
    const SHOW_FIELD_MS = 1000;

    // Port kept open with the page while this window uses it: the page cleans up when it closes
    const DETAILS_PORT_NAME = "openscraper-details-session";

    // Extensions of image files: such URLs are not pages to visit
    const IMAGE_URL_PATTERN = /\.(jpe?g|gif|png|bmp|webp|svg|avif|ico)$/i;

    const KIND_LABELS = { text: "Text", link: "Link", image: "Image" };

    // Values of the URL column listed in step 1 (the count of the others is shown)
    const URL_LIST_LIMIT = 1000;

    // chrome.storage.local keys: templates, and the field sets saved by earlier builds
    const TEMPLATES_KEY = "pageDetailsTemplates";
    const LEGACY_FIELD_SETS_KEY = "pageDetailsFieldSets";
    const TEMPLATE_FORMAT = "open-scraper-page-details-template";
    const TEMPLATE_VERSION = 1;
    const DEFAULT_WAIT = { min: 2, max: 30 };
    const MAX_TEMPLATE_FIELDS = 200;
    // Value of the "+ New template…" entry of the template drop-down
    const NEW_TEMPLATE_VALUE = "__new__";

    // Labels that make a three-part registrable domain under a country code (example.co.uk)
    const SECOND_LEVEL_LABELS = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "ne", "or", "go", "gob", "nic", "ltd", "plc", "sch", "mil", "nom", "gouv", "asso"]);

    // Target tab, as given by background.js in the window URL
    const targetTabId = parseInt(new URLSearchParams(window.location.search).get("tabid"), 10);

    // In-memory state of the panel; only templates are persisted
    const state = {
        step: 1,
        source: "",
        sourceChosen: false,
        sourceTables: { list: null, csv: null, paste: null },
        csvFileName: "",
        columnIndex: -1,
        urls: [],
        validUrls: [],
        urlColumnName: "URL",
        testIndex: 0,
        testChosen: false,
        templates: [],
        templateId: "",
        previewToken: 0,
        picking: false,
        pickToken: 0,
        picks: [],
        pickTemplateId: "",
        // Values read in the test page by field id, and the template they were read for
        previewValues: null,
        previewTemplateId: "",
        // Field being dragged in the fields list of step 2
        dragFieldId: "",
        renaming: false,
        previewUrl: "",
        filledCounts: null,
        gridSize: null,
        gridFitTimer: 0,
        results: [],
        nextIndex: 0,
        extracted: 0,
        failed: 0,
        running: false,
        runId: 0,
        resolveStop: null,
        elapsedMs: 0,
        runStartedAt: 0,
        ticker: 0,
        grid: null,
        gridData: [],
        gridKey: "",
        port: null,
        portDoc: "",
        previewDoc: "",
        pageWatchTimer: 0,
        previewLoading: false,
        // A preview read is under way (the reload button is off)
        previewReading: false,
        // The last preview read the page shown in the tab rather than the test page
        previewShownPage: false,
        promptAction: null,
        columnPromptAction: null,
        waitSaveTimer: 0
    };

    const $id = id => document.getElementById(id);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const plural = (count, word) => count + " " + word + (count === 1 ? "" : "s");

    // --- Messages ---

    /**
     * Shows or hides a message line of the panel.
     * @param {string} id - Element id.
     * @param {string} text - Message ("" hides it).
     * @param {"info"|"warning"|"error"} [level="info"] - Message level.
     */
    function showMessage(id, text, level) {
        const el = $id(id);
        el.textContent = text || "";
        el.hidden = !text;
        el.classList.toggle("osd-message-warning", level === "warning");
        el.classList.toggle("osd-message-error", level === "error");
        // A message above the results grid moves it down
        if (state.grid) scheduleGridFit();
    }

    // --- Tabs and steps ---

    /**
     * Shows one of the two extraction modes. The list panel is never hidden with display:none,
     * so its own visibility logic and grid sizing keep working exactly as before.
     * @param {"list"|"details"} mode - Mode to show.
     */
    function setMode(mode) {
        const showDetails = mode === "details";
        document.body.classList.toggle(DETAILS_MODE_CLASS, showDetails);

        const tabList = $id("tabList");
        const tabDetails = $id("tabDetails");
        tabList.classList.toggle("is-active", !showDetails);
        tabDetails.classList.toggle("is-active", showDetails);
        tabList.setAttribute("aria-selected", String(!showDetails));
        tabDetails.setAttribute("aria-selected", String(showDetails));

        LIST_PANEL_IDS.forEach(id => {
            const el = $id(id);
            if (el) el.inert = showDetails;
        });

        if (showDetails) onDetailsShown();
    }

    /**
     * Tells whether the list tab is crawling (its Stop button is shown).
     * @returns {boolean} True while the list crawl runs.
     */
    function isListCrawlRunning() {
        const stopButton = $id("stopScraping");
        return !!stopButton && getComputedStyle(stopButton).display !== "none";
    }

    /**
     * Refreshes what depends on the list tab each time the details panel is shown.
     */
    function onDetailsShown() {
        if (!isBusy()) refreshListSource();
        showStep(state.step);
    }

    /**
     * Tells whether a step can be opened now.
     * @param {number} step - Step number.
     * @returns {boolean} True when allowed.
     */
    function canOpenStep(step) {
        if (isBusy()) return step === state.step;
        if (step === 1) return true;
        if (step === 2) return state.validUrls.length > 0;
        const template = getSelectedTemplate();
        return state.validUrls.length > 0 && !!template && template.fields.length > 0;
    }

    /**
     * Shows one step of the wizard and hides the others.
     * @param {number} step - Step number (1 Pages, 2 Fields, 3 Extract).
     */
    function showStep(step) {
        if (isBusy()) step = state.step;
        while (step > 1 && !canOpenStep(step)) step--;
        const leaving = state.step;
        state.step = step;
        [1, 2, 3].forEach(n => { $id("detailsStep" + n).hidden = n !== step; });
        if (leaving === 2 && step !== 2) {
            state.previewToken++;
            closeTemplateMenu();
            sendToTab({ action: "detailsClearHighlights" });
        }
        updateStepper();
        if (step === 2) onFieldsStepShown();
        if (step === 3) onExtractStepShown();
    }

    /**
     * Updates the step indicator: active, done and reachable steps.
     */
    function updateStepper() {
        [1, 2, 3].forEach(n => {
            const item = $id("detailsStepNav" + n);
            item.classList.toggle("is-active", n === state.step);
            item.classList.toggle("is-done", n < state.step);
            item.disabled = n !== state.step && !canOpenStep(n);
            if (n === state.step) item.setAttribute("aria-current", "step");
            else item.removeAttribute("aria-current");
        });
    }

    // --- Step 1: URL sources ---

    /**
     * Tells whether a value is a page address worth visiting: starts with http(s) and is not an
     * image (query and fragment excluded from the check).
     * @param {*} value - Cell value.
     * @returns {boolean} True for a usable URL.
     */
    function isUsableUrl(value) {
        if (typeof value !== "string") return false;
        const url = value.trim();
        if (!/^https?:\/\/[^\s]/i.test(url)) return false;
        return !IMAGE_URL_PATTERN.test(url.split(/[?#]/)[0]);
    }

    /**
     * Makes column names unique and non-empty ("Column 3", "price (2)").
     * @param {string[]} names - Raw column names.
     * @returns {string[]} Unique names.
     */
    function uniqueColumnNames(names) {
        const seen = {};
        return names.map((raw, index) => {
            const base = String(raw == null ? "" : raw).trim() || "Column " + (index + 1);
            let name = base;
            for (let n = 2; seen[name]; n++) name = base + " (" + n + ")";
            seen[name] = true;
            return name;
        });
    }

    /**
     * Returns the indexes of the columns where more than half of the non-empty values are usable URLs.
     * @param {{fields: string[], rows: Array<Array<*>>}} table - Source table.
     * @returns {number[]} Column indexes, in table order.
     */
    function getUrlColumns(table) {
        const columns = [];
        table.fields.forEach((_, col) => {
            let filled = 0;
            let usable = 0;
            table.rows.forEach(row => {
                const value = row[col];
                if (value == null || String(value).trim() === "") return;
                filled++;
                if (isUsableUrl(String(value))) usable++;
            });
            if (filled && usable / filled > 0.5) columns.push(col);
        });
        return columns;
    }

    /**
     * Reads the list tab results, or null when there are none.
     * @returns {{fields: string[], rows: Array<Array<*>>}|null} Table.
     */
    function readListTable() {
        let listTable = null;
        try {
            listTable = window.OpenScraper && window.OpenScraper.getListResults();
        } catch (error) {
            console.error("Unable to read the list results:", error);
        }
        return listTable && listTable.fields.length ? {
            fields: uniqueColumnNames(listTable.fields),
            rows: listTable.data.map(row => row.map(cell => (Array.isArray(cell) ? cell.join(", ") : cell)))
        } : null;
    }

    /**
     * Reads the list results again: the "List results" source is only offered when they have
     * a URL column.
     */
    function refreshListSource() {
        const table = readListTable();
        state.sourceTables.list = table && getUrlColumns(table).length ? table : null;
        $id("detailsSourceList").hidden = !state.sourceTables.list;
        if (!state.sourceChosen || (state.source === "list" && !state.sourceTables.list)) {
            setSource(state.sourceTables.list ? "list" : "csv");
        } else if (state.source === "list") {
            applySource();
        }
    }

    /**
     * Shows the "Extract each URL" button of the list tab when the list results have a URL column.
     */
    function updateExtractEachUrlButton() {
        const table = readListTable();
        $id("extractEachUrl").hidden = !(table && getUrlColumns(table).length);
    }

    /**
     * Uses the list results as the pages to visit and opens step 1 of the details tab.
     */
    function extractEachListUrl() {
        if (isBusy()) return;
        state.sourceChosen = true;
        state.step = 1;
        refreshListSource();
        setSource("list");
        setMode("details");
    }

    /**
     * Decodes a CSV file: UTF-16 with a byte order mark, else strict UTF-8, else Windows-1252.
     * @param {ArrayBuffer} buffer - File content.
     * @returns {string} Decoded text.
     */
    function decodeCsvBuffer(buffer) {
        const bytes = new Uint8Array(buffer);
        if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
        if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (error) {
            return new TextDecoder("windows-1252").decode(bytes);
        }
    }

    /**
     * Reads a CSV file chosen by the user (locally) as a URL source. The first row holds the names.
     * @param {File} file - Chosen file.
     */
    async function loadCsvSource(file) {
        if (!file) return;
        state.csvFileName = file.name;
        $id("detailsCsvName").textContent = file.name;
        try {
            const text = decodeCsvBuffer(await file.arrayBuffer()).replace(/^﻿/, "");
            const parsed = Papa.parse(text, { skipEmptyLines: true });
            const rows = parsed.data.filter(row => row.some(cell => String(cell).trim() !== ""));
            if (!rows.length) {
                state.sourceTables.csv = null;
                applySource("The file is empty.");
                return;
            }
            state.sourceTables.csv = { fields: uniqueColumnNames(rows[0]), rows: rows.slice(1) };
            state.columnIndex = -1;
            applySource();
        } catch (error) {
            state.sourceTables.csv = null;
            applySource("Unable to read this file: " + (error && error.message || error));
        }
    }

    /**
     * Reads the pasted text (one URL per line) as a URL source.
     */
    function loadPasteSource() {
        const lines = $id("detailsPasteUrls").value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        state.sourceTables.paste = lines.length ? { fields: ["URL"], rows: lines.map(line => [line]) } : null;
        applySource();
    }

    /**
     * Selects the source type (CSV file, list results or pasted URLs).
     * @param {"csv"|"list"|"paste"} source - Source type.
     */
    function setSource(source) {
        if (source === "list" && !state.sourceTables.list) source = "csv";
        state.source = source;
        state.columnIndex = -1;
        document.querySelectorAll(".osd-seg[data-source]").forEach(button => {
            const active = button.dataset.source === source;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", String(active));
        });
        $id("detailsSourceCsvPane").hidden = source !== "csv";
        $id("detailsSourceListPane").hidden = source !== "list";
        $id("detailsSourcePastePane").hidden = source !== "paste";
        applySource();
    }

    /**
     * Fills the column drop-down with the URL columns of the current source and selects the
     * first one (or keeps the current choice).
     * @param {string} [problem] - Error to show instead of the usual hints.
     */
    function applySource(problem) {
        const table = state.sourceTables[state.source];
        const select = $id("detailsUrlColumn");
        select.innerHTML = "";
        const columns = table ? getUrlColumns(table) : [];

        if (!table || !columns.length) {
            $id("detailsColumnRow").hidden = true;
            let message = problem || "";
            if (!message && table) message = "No column of this source contains URLs (addresses starting with http:// or https://).";
            showMessage("detailsUrlMessage", message, "error");
            setUrls([], "URL");
            return;
        }

        columns.forEach(index => {
            const option = document.createElement("option");
            option.value = String(index);
            option.textContent = table.fields[index];
            select.appendChild(option);
        });
        $id("detailsColumnRow").hidden = false;
        select.value = String(columns.indexOf(state.columnIndex) !== -1 ? state.columnIndex : columns[0]);
        applyColumn();
    }

    /**
     * Uses the column chosen in the drop-down as the list of URLs to visit.
     */
    function applyColumn() {
        const table = state.sourceTables[state.source];
        if (!table) return;
        const index = parseInt($id("detailsUrlColumn").value, 10);
        state.columnIndex = index;
        const name = table.fields[index] || "URL";
        showMessage("detailsUrlMessage", isUsableUrl(name) ?
            "The column name looks like a URL: the first row of the file may not be a header row (it is not visited)." : "", "warning");
        setUrls(table.rows.map(row => (row[index] == null ? "" : String(row[index]))), name);
    }

    /**
     * Sets the URLs to visit. Results are cleared when the list actually changes.
     * @param {string[]} urls - Values of the URL column, empty ones included.
     * @param {string} columnName - Name of the URL column, reused as the first result column.
     */
    function setUrls(urls, columnName) {
        const changed = JSON.stringify(urls) !== JSON.stringify(state.urls);
        state.urls = urls;
        state.urlColumnName = columnName || "URL";
        state.validUrls = urls.map(url => url.trim()).filter(isUsableUrl);
        if (changed) {
            state.testIndex = 0;
            state.testChosen = false;
            resetResults();
        }
        const usable = state.validUrls.length;
        const skipped = urls.length - usable;
        $id("detailsUrlCount").textContent = plural(usable, "URL") + (skipped ? " (" + skipped + " skipped)" : "");
        renderUrlList();
        $id("detailsToStep2").disabled = !usable;
        updateStepper();
    }

    /**
     * Lists the values of the URL column, numbered; values that are not visited are struck out.
     */
    function renderUrlList() {
        const list = $id("detailsUrlList");
        list.textContent = "";
        list.hidden = !state.urls.length;
        const fragment = document.createDocumentFragment();
        state.urls.slice(0, URL_LIST_LIMIT).forEach((value, index) => {
            const item = document.createElement("li");
            item.classList.toggle("is-skipped", !isUsableUrl(value.trim()));
            // The number is drawn by CSS (::before) so that copying the list gives only the values
            item.dataset.num = String(index + 1);
            const text = document.createElement("span");
            text.className = "osd-url-value";
            text.textContent = value.trim() || "(empty)";
            text.title = item.classList.contains("is-skipped") ? "Not a page URL: skipped" : value.trim();
            item.append(text);
            fragment.appendChild(item);
        });
        if (state.urls.length > URL_LIST_LIMIT) {
            const more = document.createElement("li");
            more.className = "osd-url-more";
            more.textContent = "… and " + (state.urls.length - URL_LIST_LIMIT) + " more";
            fragment.appendChild(more);
        }
        list.appendChild(fragment);
    }

    // --- Target tab ---

    /**
     * Reads the target tab, or null when it is gone.
     * @returns {Promise<Object|null>} Tab.
     */
    async function getTargetTab() {
        try {
            return await chromeInstance.tabs.get(targetTabId);
        } catch (error) {
            return null;
        }
    }

    /**
     * Normalizes a URL for comparisons ("http://a.b" and "http://a.b/" are the same page).
     * @param {string} url - URL.
     * @returns {string} Normalized URL, or the input when it does not parse.
     */
    function normalizeUrl(url) {
        try {
            return new URL(String(url || "").trim()).href;
        } catch (error) {
            return String(url || "").trim();
        }
    }

    /**
     * Opens a port with the page so that it removes what this window drew there when the
     * window closes. A port already open with the same document is kept: closing it right
     * after opening another one could reach the page first, and the page would then remove
     * the highlights it just drew. The previous port is closed after the new one is open.
     * @param {string} [doc] - Token of the page's document, when known.
     */
    function connectSessionPort(doc) {
        if (doc && state.port && state.portDoc === doc) return;
        const previous = state.port;
        state.portDoc = doc || "";
        try {
            const port = chromeInstance.tabs.connect(targetTabId, { name: DETAILS_PORT_NAME });
            port.onDisconnect.addListener(() => {
                void chromeInstance.runtime.lastError;
                if (state.port === port) state.port = null;
            });
            state.port = port;
        } catch (error) {
            state.port = null;
        }
        if (previous && previous !== state.port) {
            try {
                previous.disconnect();
            } catch (error) {
                // Already closed with its page
            }
        }
    }

    /**
     * Sends a message to the content script of the target tab.
     * @param {Object} message - Message with an action.
     * @returns {Promise<Object|undefined>} Response, or undefined when nothing answered.
     */
    async function sendToTab(message) {
        try {
            return await chromeInstance.tabs.sendMessage(targetTabId, message);
        } catch (error) {
            return undefined;
        }
    }

    /**
     * Sends a message until the content script answers or the time runs out.
     * @param {Object} message - Message with an action.
     * @param {number} timeoutMs - Longest wait.
     * @param {Function} [isCancelled] - Returns true to give up early.
     * @returns {Promise<Object|undefined>} Response, or undefined.
     */
    async function sendToTabWithRetry(message, timeoutMs, isCancelled) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const response = await sendToTab(message);
            if (response !== undefined) return response;
            if (Date.now() + READY_POLL_MS > deadline || (isCancelled && isCancelled())) return undefined;
            await sleep(READY_POLL_MS);
        }
    }

    /**
     * Opens a URL in the target tab and waits until the page has loaded and its content script
     * answers, with a time limit. The new page counts as loaded once the tab reported "loading"
     * then "complete" (the tab status alone can still describe the previous page for a moment,
     * whose content script would answer). When the tab already shows that exact URL, the page
     * is only asked whether it is ready; a change of the #fragment only is detected by the
     * address the page reports, so it never waits for a load that does not happen. A page that
     * cannot be reached (network error, refused connection, download) fails at once instead of
     * waiting for the time limit.
     * With the early option (runs), the page counts as ready as soon as it is parsed and its
     * content script answers, without waiting for its images, frames or ads: the document that
     * answers must then be another one than the page shown before (asked first), or be at the
     * address opened; else the load must have completed as above.
     * @param {string} url - Address to open.
     * @param {number} limitMs - Longest wait.
     * @param {{isCancelled: Function, busy: boolean, early: boolean}} [options] - Give up early;
     *     show the "Extracting..." overlay in the page as soon as it answers; ready once parsed.
     * @returns {Promise<boolean>} True when the page is ready.
     */
    async function loadPage(url, limitMs, options) {
        const isCancelled = options && options.isCancelled || (() => false);
        const early = !!(options && options.early);
        const pingMessage = { action: "detailsPing" };
        if (options && options.busy) pingMessage.busy = true;
        const deadline = Date.now() + Math.max(READY_POLL_MS, limitMs);
        const target = normalizeUrl(url);
        const tab = await getTargetTab();
        if (!tab) return false;

        let loadingSeen = false;
        let loaded = false;
        // Only the requests of this navigation count: the one it replaces is aborted meanwhile
        let unreachable = false;
        const requestIds = new Set();
        const requestFilter = { urls: ["<all_urls>"], tabId: targetTabId, types: ["main_frame"] };
        const onRequest = details => { requestIds.add(details.requestId); };
        const onError = details => {
            if (requestIds.has(details.requestId)) unreachable = true;
        };
        const onUpdated = (tabId, changeInfo) => {
            if (tabId !== targetTabId) return;
            if (changeInfo.status === "loading") {
                loadingSeen = true;
                loaded = false;
            } else if (changeInfo.status === "complete" && loadingSeen) {
                loaded = true;
            }
        };
        let alreadyThere = normalizeUrl(tab.url) === target && !tab.pendingUrl;
        // While the new page loads, the page shown keeps answering: its document is noted first
        // (undefined: it has no content script, so any answer comes from the new page; null: unknown)
        let oldDoc = null;
        if (early && !alreadyThere) {
            const before = await Promise.race([sendToTab({ action: "detailsPing" }), sleep(OLD_DOCUMENT_PING_MS).then(() => null)]);
            oldDoc = before === null ? null : (before && before.doc) || undefined;
            if (isCancelled()) return false;
        }
        if (!alreadyThere) {
            chromeInstance.tabs.onUpdated.addListener(onUpdated);
            try {
                chromeInstance.webRequest.onBeforeRequest.addListener(onRequest, requestFilter);
                chromeInstance.webRequest.onErrorOccurred.addListener(onError, requestFilter);
            } catch (error) {
                // Without it, an unreachable page waits for the time limit
            }
            try {
                await chromeInstance.tabs.update(targetTabId, { url: url });
            } catch (error) {
                chromeInstance.tabs.onUpdated.removeListener(onUpdated);
                chromeInstance.webRequest.onBeforeRequest.removeListener(onRequest);
                chromeInstance.webRequest.onErrorOccurred.removeListener(onError);
                return false;
            }
        }
        // Right after the URL is set, the tab can still report "complete" while its page is
        // already going away: asking it then fails, and Firefox logs that failure as an error
        const askFrom = alreadyThere ? 0 : Date.now() + LOAD_START_WAIT_MS;
        // A page already shown but without a content script (opened before the extension) is reloaded once
        let reloadAt = alreadyThere ? Date.now() + 1000 : 0;
        try {
            while (Date.now() < deadline && !isCancelled() && !unreachable) {
                const current = await getTargetTab();
                if (!current) return false;
                if ((early || current.status === "complete") && (loadingSeen || Date.now() >= askFrom)) {
                    const response = await sendToTab(pingMessage);
                    if (response && isCancelled() && pingMessage.busy) sendToTab({ action: "detailsBusy", on: false });
                    const sameDocument = response && normalizeUrl(response.url) === target;
                    const newDocument = response && early && oldDoc !== null && response.doc !== oldDoc &&
                        response.readyState !== "loading";
                    if (response && response.ready && (alreadyThere || loaded || sameDocument || newDocument)) {
                        connectSessionPort(response.doc);
                        return true;
                    }
                    if (!response && reloadAt && Date.now() > reloadAt) {
                        reloadAt = 0;
                        alreadyThere = false;
                        chromeInstance.tabs.onUpdated.addListener(onUpdated);
                        chromeInstance.tabs.reload(targetTabId).catch(() => {});
                    }
                }
                await sleep(READY_POLL_MS);
            }
            return false;
        } finally {
            chromeInstance.tabs.onUpdated.removeListener(onUpdated);
            chromeInstance.webRequest.onBeforeRequest.removeListener(onRequest);
            chromeInstance.webRequest.onErrorOccurred.removeListener(onError);
        }
    }

    /**
     * Brings the target tab and its window to the front. A minimized window is restored
     * first: focusing it alone leaves it in the Dock on macOS.
     * @returns {Promise<{ok: boolean, error: string}>} Result, with the reason when it failed.
     */
    async function focusTargetTab() {
        const tab = await getTargetTab();
        if (!tab) return { ok: false, error: "closed" };
        try {
            await chromeInstance.tabs.update(targetTabId, { active: true });
            const win = await chromeInstance.windows.get(tab.windowId);
            const change = { focused: true };
            if (win.state === "minimized") change.state = "normal";
            await chromeInstance.windows.update(tab.windowId, change);
            return { ok: true, error: "" };
        } catch (error) {
            console.warn("Unable to focus the target tab:", error);
            return { ok: false, error: String(error && error.message || error) };
        }
    }

    // --- Templates ---

    /**
     * Returns the registrable domain of a URL, without the PSL: the last two labels, or three
     * under a country code with a generic second level (shop.example.co.uk -> example.co.uk).
     * IP addresses and single-label hosts are kept whole.
     * @param {string} url - URL.
     * @returns {string} Domain, or "".
     */
    function getRegistrableDomain(url) {
        let host = "";
        try {
            host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
        } catch (error) {
            return "";
        }
        if (!host || /^[\d.]+$/.test(host) || host.indexOf(":") !== -1 || host.indexOf("[") !== -1) return host;
        host = host.replace(/^www\d*\./, "");
        const parts = host.split(".");
        if (parts.length <= 2) return host;
        const last = parts[parts.length - 1];
        const second = parts[parts.length - 2];
        if (last.length === 2 && SECOND_LEVEL_LABELS.has(second)) return parts.slice(-3).join(".");
        return parts.slice(-2).join(".");
    }

    /**
     * Returns the URL of the test page.
     * @returns {string} URL, or "".
     */
    function getTestUrl() {
        return state.validUrls[state.testIndex] || "";
    }

    /**
     * Returns the domain of the test page.
     * @returns {string} Domain, or "".
     */
    function getTestDomain() {
        return getRegistrableDomain(getTestUrl());
    }

    /**
     * Returns the selected template, or null.
     * @returns {Object|null} Template.
     */
    function getSelectedTemplate() {
        return state.templates.find(template => template.id === state.templateId) || null;
    }

    /**
     * Returns the templates of a domain, the most recently updated first.
     * @param {string} domain - Domain.
     * @returns {Object[]} Templates.
     */
    function getDomainTemplates(domain) {
        return state.templates.filter(template => template.domain === domain)
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }

    /**
     * Returns a template name not used yet on the domain ("x", "x (2)"...).
     * @param {string} base - Wanted name.
     * @param {string} domain - Domain.
     * @param {string} [exceptId] - Template whose own name does not count.
     * @returns {string} Unique name.
     */
    function uniqueTemplateName(base, domain, exceptId) {
        const used = new Set(state.templates.filter(t => t.domain === domain && t.id !== exceptId).map(t => t.name));
        let name = base;
        for (let n = 2; used.has(name); n++) name = base + " (" + n + ")";
        return name;
    }

    /**
     * Creates an id for a template or a field.
     * @param {string} prefix - Prefix.
     * @returns {string} Id.
     */
    function createId(prefix) {
        return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    /**
     * Brings two wait bounds in range: integers >= 0 with min <= max.
     * @param {*} wait - Raw {min, max}.
     * @returns {{min: number, max: number}} Bounds in seconds.
     */
    function normalizeWait(wait) {
        const read = (value, fallback) => {
            const number = parseInt(value, 10);
            return Number.isFinite(number) && number >= 0 ? Math.min(number, 3600) : fallback;
        };
        const min = read(wait && wait.min, DEFAULT_WAIT.min);
        return { min: min, max: Math.max(min, read(wait && wait.max, DEFAULT_WAIT.max)) };
    }

    /**
     * Checks and cleans a template read from storage or from a file.
     * @param {*} raw - Candidate template.
     * @returns {Object|null} Clean template, or null when it is not usable.
     */
    function sanitizeTemplate(raw) {
        if (!raw || typeof raw !== "object" || !Array.isArray(raw.fields)) return null;
        const usedIds = new Set();
        const fields = [];
        raw.fields.slice(0, MAX_TEMPLATE_FIELDS).forEach((field, index) => {
            if (!field || typeof field !== "object" || !KIND_LABELS[field.kind] || !Array.isArray(field.selectors)) return;
            const selectors = field.selectors.filter(selector => typeof selector === "string" && selector.trim() &&
                selector.length <= 2000).slice(0, 3);
            if (!selectors.length) return;
            let id = typeof field.id === "string" && field.id && field.id.length <= 64 ? field.id : "f" + (index + 1);
            while (usedIds.has(id)) id += "_";
            usedIds.add(id);
            const name = typeof field.name === "string" && field.name.trim() ? field.name.trim().slice(0, 120) : KIND_LABELS[field.kind];
            fields.push({ id: id, name: name, kind: field.kind, selectors: selectors });
        });
        // A template may have no field yet (just created), but not lose all of them on reading
        if (!fields.length && raw.fields.length) return null;
        const renames = {};
        if (raw.renames && typeof raw.renames === "object") {
            Object.keys(raw.renames).forEach(key => {
                const value = raw.renames[key];
                if ((key === "url" || usedIds.has(key)) && typeof value === "string" && value.trim()) {
                    renames[key] = value.trim().slice(0, 120);
                }
            });
        }
        const now = new Date().toISOString();
        return {
            id: typeof raw.id === "string" && raw.id ? raw.id : createId("t"),
            version: TEMPLATE_VERSION,
            domain: typeof raw.domain === "string" ? raw.domain.trim().toLowerCase() : "",
            name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 120) : "Template",
            fields: fields,
            wait: normalizeWait(raw.wait),
            // "Load full page": off for templates saved before it existed
            fullPage: raw.fullPage === true,
            renames: renames,
            createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
            updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now
        };
    }

    /**
     * Turns the field sets saved per host by earlier builds into templates (once).
     * @param {Object} legacy - Field sets by hostname.
     * @param {Object[]} templates - Current templates (completed in place).
     */
    function migrateLegacyFieldSets(legacy, templates) {
        Object.keys(legacy || {}).forEach(host => {
            const set = legacy[host];
            const domain = getRegistrableDomain("http://" + host + "/");
            const template = sanitizeTemplate({
                domain: domain,
                fields: set && Array.isArray(set.fields) ? set.fields.map((field, i) => Object.assign({}, field, { id: "f" + (i + 1) })) : [],
                createdAt: set && set.savedAt,
                updatedAt: set && set.savedAt
            });
            if (!template || !template.fields.length) return;
            let name = domain + " details";
            for (let n = 2; templates.some(t => t.domain === domain && t.name === name); n++) name = domain + " details (" + n + ")";
            template.name = name;
            templates.push(template);
        });
    }

    /**
     * Reads the templates from storage (migrating older saved field sets).
     * @returns {Promise<Object[]>} Templates.
     */
    async function readTemplates() {
        try {
            const stored = await chromeInstance.storage.local.get([TEMPLATES_KEY, LEGACY_FIELD_SETS_KEY]);
            const templates = (Array.isArray(stored[TEMPLATES_KEY]) ? stored[TEMPLATES_KEY] : [])
                .map(sanitizeTemplate).filter(Boolean);
            if (stored[LEGACY_FIELD_SETS_KEY]) {
                migrateLegacyFieldSets(stored[LEGACY_FIELD_SETS_KEY], templates);
                await chromeInstance.storage.local.set({ [TEMPLATES_KEY]: templates });
                await chromeInstance.storage.local.remove(LEGACY_FIELD_SETS_KEY);
            }
            return templates;
        } catch (error) {
            console.error("Unable to read the templates:", error);
            return [];
        }
    }

    /**
     * Changes the stored templates: reads the latest list (other windows may have changed it),
     * applies the change and writes the list back.
     * @param {function(Object[]): void} change - Changes the list in place.
     * @returns {Promise<boolean>} True when saved.
     */
    async function updateTemplates(change) {
        try {
            const templates = await readTemplates();
            change(templates);
            await chromeInstance.storage.local.set({ [TEMPLATES_KEY]: templates });
            state.templates = templates;
            return true;
        } catch (error) {
            console.error("Unable to save the templates:", error);
            showMessage("detailsPickMessage", "Unable to save the template: " + (error && error.message || error), "error");
            return false;
        }
    }

    /**
     * Saves a change to one template and refreshes what shows it.
     * @param {string} templateId - Template id.
     * @param {function(Object): void} change - Changes the template in place.
     * @returns {Promise<boolean>} True when saved.
     */
    async function updateTemplate(templateId, change) {
        let found = false;
        const saved = await updateTemplates(templates => {
            const template = templates.find(t => t.id === templateId);
            if (!template) return;
            change(template);
            template.updatedAt = new Date().toISOString();
            found = true;
        });
        onTemplatesChanged();
        return saved && found;
    }

    /**
     * Fills the template drop-down with the templates of the test page's domain.
     */
    function renderTemplateSelect() {
        const select = $id("detailsTemplate");
        const domain = getTestDomain();
        const templates = getDomainTemplates(domain);
        select.innerHTML = "";
        if (!templates.length) {
            const option = document.createElement("option");
            option.value = "";
            option.textContent = domain ? "No template for " + domain + " yet" : "No template yet";
            select.appendChild(option);
        } else {
            if (!getSelectedTemplate()) {
                const option = document.createElement("option");
                option.value = "";
                option.textContent = "Choose a template";
                select.appendChild(option);
            }
            templates.forEach(template => {
                const option = document.createElement("option");
                option.value = template.id;
                option.textContent = template.name + " (" + plural(template.fields.length, "field") + ")";
                select.appendChild(option);
            });
        }
        if (domain) {
            const option = document.createElement("option");
            option.value = NEW_TEMPLATE_VALUE;
            option.textContent = "+ New template…";
            select.appendChild(option);
        }
        select.value = getSelectedTemplate() ? state.templateId : "";
        select.disabled = isBusy() || !domain;
        updateTemplateMenu();
    }

    /**
     * Enables the template menu items that apply.
     */
    function updateTemplateMenu() {
        const hasTemplate = !!getSelectedTemplate();
        $id("detailsTemplateMenuButton").disabled = isBusy();
        $id("detailsTemplateNew").disabled = !getTestDomain();
        $id("detailsTemplateDuplicate").disabled = !hasTemplate;
        $id("detailsTemplateRename").disabled = !hasTemplate;
        $id("detailsTemplateExport").disabled = !hasTemplate;
        $id("detailsTemplateDelete").disabled = !hasTemplate;
        $id("detailsTemplateImport").disabled = !getTestDomain();
    }

    /**
     * Selects a template. Results are cleared when the template changes.
     * @param {string} templateId - Template id ("" for none).
     */
    function selectTemplate(templateId) {
        const changed = templateId !== state.templateId;
        state.templateId = templateId;
        if (changed) resetResults();
        const template = getSelectedTemplate();
        if (template) applyOptionsToInputs(template);
        renderTemplateSelect();
        updateFieldsStepUi();
        refreshPreview();
    }

    /**
     * Reacts to a change of the stored templates (here or in another window).
     */
    function onTemplatesChanged() {
        if (state.templateId && !getSelectedTemplate()) {
            stopRun();
            state.templateId = "";
            resetResults();
            // Another template of the site, if any, takes the place of the deleted one
            if (state.step === 3) showStep(2);
            else if (state.step === 2 && !chooseTemplateForDomain()) refreshPreview();
        } else if (state.step === 3 && !canOpenStep(3)) {
            // The template has no field left
            showStep(2);
        }
        renderTemplateSelect();
        updateFieldsStepUi();
        const template = getSelectedTemplate();
        // Names or order may have changed (here, in the grid or in another window)
        if (state.step === 2 && template) redrawPreview();
        if (state.step === 3) renderRunHeader();
        rebuildGridIfNeeded();
    }

    /**
     * Picks a template for the test page's domain when none (or one of another site) is selected.
     * @returns {boolean} True when the selection changed (the preview is then refreshed).
     */
    function chooseTemplateForDomain() {
        const template = getSelectedTemplate();
        const domain = getTestDomain();
        if (template && template.domain === domain) return false;
        const latest = getDomainTemplates(domain)[0];
        if (!latest && !state.templateId) return false;
        selectTemplate(latest ? latest.id : "");
        return true;
    }

    /**
     * Creates a new template from the fields picked in the page, and selects it.
     * @param {Array<{name: string, kind: string, selectors: string[], sample: string}>} picks - Picked fields.
     */
    async function createTemplateFromPicks(picks) {
        const domain = getTestDomain();
        const fields = picksToFields(picks, [], [state.urlColumnName || "URL"]).slice(0, MAX_TEMPLATE_FIELDS);
        if (!fields.length) {
            showMessage("detailsPickMessage", "Nothing was selected.", "warning");
            return;
        }
        const template = await addTemplate({ domain: domain, name: domain + " details", fields: fields });
        if (template) showMessage("detailsPickMessage", "Template \"" + template.name + "\" created with " + plural(fields.length, "field") + ".");
    }

    /**
     * Saves a new template and selects it. Its name is made unique on its domain.
     * @param {{domain: string, name: string, fields: Object[], wait: Object, fullPage: boolean, renames: Object}} props -
     *     Content of the template (wait, fullPage and renames are optional).
     * @returns {Promise<Object|null>} Saved template, or null when it could not be saved.
     */
    async function addTemplate(props) {
        const now = new Date().toISOString();
        const template = {
            id: createId("t"),
            version: TEMPLATE_VERSION,
            domain: props.domain,
            name: "",
            fields: props.fields,
            wait: normalizeWait(props.wait || DEFAULT_WAIT),
            fullPage: props.fullPage === true,
            renames: props.renames || {},
            createdAt: now,
            updatedAt: now
        };
        const saved = await updateTemplates(templates => {
            // The name must be unique among the latest stored templates
            state.templates = templates;
            template.name = uniqueTemplateName(String(props.name).slice(0, 120), template.domain);
            templates.push(template);
        });
        if (!saved) return null;
        selectTemplate(template.id);
        return template;
    }

    /**
     * Asks for a name and creates an empty template for the test page's domain; its fields are
     * then selected in the page.
     */
    function promptNewTemplate() {
        const domain = getTestDomain();
        if (!domain || isBusy()) return;
        const base = domain + " details";
        openPrompt("detailsTemplatePrompt", "New template", uniqueTemplateName(base, domain), "Create", async name => {
            const template = await addTemplate({ domain: domain, name: name || base, fields: [] });
            if (template) showMessage("detailsPickMessage", "Template \"" + template.name + "\" created. Click \"Select data to extract\" to add its fields.");
        });
    }

    /**
     * Copies a template (fields, options and column names) into a new one named "<name> (copy)".
     * @param {Object} template - Template to copy.
     */
    async function duplicateTemplate(template) {
        const copy = JSON.parse(JSON.stringify(template));
        const created = await addTemplate({ domain: copy.domain, name: copy.name + " (copy)", fields: copy.fields, wait: copy.wait,
            fullPage: copy.fullPage, renames: copy.renames });
        if (created) showMessage("detailsPickMessage", "Template \"" + template.name + "\" duplicated as \"" + created.name + "\".");
    }

    /**
     * Turns picks into template fields: kinds checked, at most 3 selectors, column names made
     * unique (among themselves and the given names), ids not used yet.
     * @param {Array<Object>} picks - Picked fields.
     * @param {Object[]} [existing=[]] - Fields already in the template.
     * @param {string[]} [usedNames=[]] - Column names already taken.
     * @returns {Object[]} New fields.
     */
    function picksToFields(picks, existing, usedNames) {
        const seen = {};
        (usedNames || []).forEach(name => { seen[name] = true; });
        const usedIds = new Set((existing || []).map(field => field.id));
        const known = new Set((existing || []).map(field => field.kind + "\n" + field.selectors[0]));
        let next = 1;
        return picks.filter(pick => pick && KIND_LABELS[pick.kind] && Array.isArray(pick.selectors) && pick.selectors.length)
            .filter(pick => {
                const key = pick.kind + "\n" + pick.selectors[0];
                if (known.has(key)) return false;
                known.add(key);
                return true;
            })
            .map(pick => {
                const base = String(pick.name || "").trim() || KIND_LABELS[pick.kind];
                let name = base;
                for (let n = 2; seen[name]; n++) name = base + " (" + n + ")";
                seen[name] = true;
                while (usedIds.has("f" + next)) next++;
                const id = "f" + next;
                usedIds.add(id);
                return { id: id, name: name, kind: pick.kind, selectors: pick.selectors.slice(0, 3).map(String) };
            });
    }

    /**
     * Adds picked fields to an existing template (same id and name); fields it already has
     * are not added twice.
     * @param {string} templateId - Template id.
     * @param {Array<Object>} picks - Picked fields.
     */
    async function addFieldsToTemplate(templateId, picks) {
        let added = 0;
        let name = "";
        const saved = await updateTemplate(templateId, template => {
            const fields = picksToFields(picks, template.fields, getResultColumns(template))
                .slice(0, Math.max(0, MAX_TEMPLATE_FIELDS - template.fields.length));
            template.fields = template.fields.concat(fields);
            added = fields.length;
            name = template.name;
        });
        if (!saved) {
            showMessage("detailsPickMessage", "The template was deleted meanwhile: nothing was added.", "warning");
        } else {
            showMessage("detailsPickMessage", added ? plural(added, "field") + " added to \"" + name + "\"." :
                "No new field: what you selected is already in the template.", added ? "info" : "warning");
        }
    }

    /**
     * Returns a file name without characters that systems refuse.
     * @param {string} name - Wanted name.
     * @returns {string} Safe file name base.
     */
    function toFileName(name) {
        return String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "page-details";
    }

    /**
     * Downloads the selected template as a JSON file.
     */
    function exportTemplate() {
        const template = getSelectedTemplate();
        if (!template) return;
        const file = {
            format: TEMPLATE_FORMAT,
            version: TEMPLATE_VERSION,
            template: {
                name: template.name,
                domain: template.domain,
                fields: template.fields,
                wait: template.wait,
                fullPage: template.fullPage,
                renames: template.renames,
                createdAt: template.createdAt,
                updatedAt: template.updatedAt
            }
        };
        saveAs(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }), toFileName(template.name) + ".json");
    }

    /**
     * Imports a template from a JSON file, for the test page's domain, and selects it.
     * @param {File} file - Chosen file.
     */
    async function importTemplate(file) {
        if (!file) return;
        const domain = getTestDomain();
        let template = null;
        try {
            const data = JSON.parse(await file.text());
            const raw = data && data.format === TEMPLATE_FORMAT ? data.template : data;
            template = sanitizeTemplate(raw && typeof raw === "object" ? Object.assign({}, raw, { id: "" }) : null);
        } catch (error) {
            template = null;
        }
        if (!template || !domain) {
            showMessage("detailsPickMessage", "This file is not a page details template.", "error");
            return;
        }
        const madeFor = template.domain;
        template.id = createId("t");
        template.domain = domain;
        template.name = uniqueTemplateName(template.name, domain);
        template.createdAt = template.updatedAt = new Date().toISOString();
        if (!(await updateTemplates(templates => { templates.push(template); }))) return;
        showMessage("detailsPickMessage", "Template \"" + template.name + "\" imported" +
            (madeFor && madeFor !== domain ? " (made for " + madeFor + ", now used on " + domain + ")." : "."));
        selectTemplate(template.id);
    }

    /**
     * Shows an inline prompt (text input, or a confirmation when no value is given).
     * @param {string} formId - Prompt form id.
     * @param {string} label - Question.
     * @param {string|null} value - Initial text, or null for a plain confirmation.
     * @param {string} okText - Text of the confirm button.
     * @param {function(string): void} onOk - Called with the entered text.
     */
    function openPrompt(formId, label, value, okText, onOk) {
        const form = $id(formId);
        const input = form.querySelector("input");
        const ok = form.querySelector("button[type=submit]");
        form.querySelector(".osd-prompt-label").textContent = label;
        input.hidden = value === null;
        input.value = value || "";
        ok.textContent = okText;
        ok.classList.toggle("osd-btn-danger", value === null);
        form.hidden = false;
        form.onsubmit = event => {
            event.preventDefault();
            form.hidden = true;
            onOk(input.value.trim());
        };
        (value === null ? ok : input).focus();
        if (value !== null) input.select();
    }

    /**
     * Closes an inline prompt.
     * @param {string} formId - Prompt form id.
     */
    function closePrompt(formId) {
        $id(formId).hidden = true;
    }

    /**
     * Shows or hides the template menu.
     * @param {boolean} open - Open the menu.
     */
    function toggleTemplateMenu(open) {
        $id("detailsTemplateMenu").hidden = !open;
        $id("detailsTemplateMenuButton").setAttribute("aria-expanded", String(open));
        if (open) updateTemplateMenu();
    }

    /**
     * Closes the template menu.
     */
    function closeTemplateMenu() {
        toggleTemplateMenu(false);
    }

    /**
     * Runs a template menu action.
     * @param {"new"|"duplicate"|"rename"|"export"|"import"|"delete"} action - Action.
     */
    function onTemplateMenuAction(action) {
        closeTemplateMenu();
        const template = getSelectedTemplate();
        if (action === "new") {
            promptNewTemplate();
            return;
        }
        if (action === "import") {
            $id("detailsTemplateFile").value = "";
            $id("detailsTemplateFile").click();
            return;
        }
        if (!template) return;
        if (action === "export") {
            exportTemplate();
        } else if (action === "duplicate") {
            duplicateTemplate(template);
        } else if (action === "rename") {
            openPrompt("detailsTemplatePrompt", "Name", template.name, "Save", name => {
                if (!name) return;
                updateTemplate(template.id, t => { t.name = uniqueTemplateName(name.slice(0, 120), t.domain, t.id); });
            });
        } else if (action === "delete") {
            openPrompt("detailsTemplatePrompt", "Delete \"" + template.name + "\"?", null, "Delete", () => {
                updateTemplates(templates => {
                    const index = templates.findIndex(t => t.id === template.id);
                    if (index !== -1) templates.splice(index, 1);
                }).then(saved => {
                    onTemplatesChanged();
                    if (saved) showMessage("detailsPickMessage", "Template \"" + template.name + "\" deleted.");
                });
            });
        }
    }

    // --- Step 2: test page, picking and preview ---

    /**
     * Prepares the fields step: test page, templates of its domain, preview.
     */
    async function onFieldsStepShown() {
        if (!state.testChosen) {
            state.testChosen = true;
            const tab = await getTargetTab();
            const index = tab ? state.validUrls.map(normalizeUrl).indexOf(normalizeUrl(tab.url)) : -1;
            state.testIndex = index >= 0 ? index : 0;
        }
        updateTestUrlUi();
        const changed = chooseTemplateForDomain();
        renderTemplateSelect();
        updateFieldsStepUi();
        if (!changed && getSelectedTemplate()) refreshPreview();
    }

    /**
     * Shows the test URL and the state of its arrows.
     */
    function updateTestUrlUi() {
        const count = state.validUrls.length;
        $id("detailsTestUrl").value = getTestUrl();
        $id("detailsTestUrl").title = getTestUrl();
        $id("detailsTestPrev").disabled = count < 2 || isBusy();
        $id("detailsTestNext").disabled = count < 2 || isBusy();
    }

    /**
     * Updates the buttons of the fields step.
     */
    function updateFieldsStepUi() {
        const busy = isBusy();
        const template = getSelectedTemplate();
        const hasFields = !!template && template.fields.length > 0;
        $id("detailsPickStart").hidden = state.picking;
        $id("detailsPickStart").disabled = busy || !getTestUrl();
        $id("detailsPickStart").classList.toggle("osd-btn-primary", !hasFields);
        $id("detailsEditFields").hidden = !hasFields;
        $id("detailsEditFields").disabled = busy || !getTestUrl();
        $id("detailsPickStop").hidden = !state.picking;
        $id("detailsBackTo1").disabled = busy;
        $id("detailsToStep3").disabled = busy || !hasFields;
        $id("detailsTemplate").disabled = busy || !getTestDomain();
        updatePreviewReloadUi();
        updateTestUrlUi();
        updateTemplateMenu();
        updateStepper();
    }

    /**
     * Turns the preview's reload button off while picking, running or reading.
     */
    function updatePreviewReloadUi() {
        const template = getSelectedTemplate();
        $id("detailsPreviewReload").disabled = isBusy() || state.previewReading || !template || !template.fields.length;
    }

    /**
     * Reads the test page again after scrolling through it, whatever "Load full page" says
     * (content that only loads once scrolled to).
     */
    function reloadPreview() {
        if (isBusy() || state.previewReading) return;
        refreshPreview({ shownPage: state.previewShownPage, fullPage: true });
    }

    /**
     * Moves to the previous or next test URL (looping), opens it in the target tab and brings
     * the tab to the front.
     * @param {number} step - -1 or +1.
     */
    async function moveTestUrl(step) {
        const count = state.validUrls.length;
        if (!count || isBusy()) return;
        state.testIndex = (state.testIndex + step + count) % count;
        updateTestUrlUi();
        const changed = chooseTemplateForDomain();
        renderTemplateSelect();
        focusTargetTab();
        if (changed) return;
        if (getSelectedTemplate()) {
            refreshPreview();
        } else {
            const token = ++state.previewToken;
            await loadPage(getTestUrl(), TEST_PAGE_TIMEOUT_MS, { isCancelled: () => token !== state.previewToken });
        }
    }

    /**
     * Opens the test page in the target tab unless it already shows it.
     * @param {Function} isCancelled - Returns true to give up.
     * @returns {Promise<boolean>} True when the page is ready.
     */
    function ensureTestPage(isCancelled) {
        return loadPage(getTestUrl(), TEST_PAGE_TIMEOUT_MS, { isCancelled: isCancelled });
    }

    /**
     * Returns the column name of a field (renamed or as picked).
     * @param {Object} template - Template.
     * @param {Object} field - Field.
     * @returns {string} Column name.
     */
    function getFieldColumnName(template, field) {
        return template.renames[field.id] || field.name;
    }

    /**
     * Loads the test page if needed, reads one row (at once, then again once late fields show)
     * and highlights in the page the elements found. The reload button is off meanwhile.
     * @param {{shownPage: boolean, fullPage: boolean}} [options] - shownPage: read the page
     *     shown in the tab as it is (the user opened another page of the site there) instead of
     *     the test page; fullPage: scroll through the page first even when the template's "Load
     *     full page" is off (reload button).
     */
    async function refreshPreview(options) {
        const token = ++state.previewToken;
        state.previewReading = true;
        state.previewShownPage = !!(options && options.shownPage);
        updatePreviewReloadUi();
        try {
            await readPreview(token, options);
        } finally {
            if (token === state.previewToken) {
                state.previewReading = false;
                updatePreviewReloadUi();
            }
        }
    }

    /**
     * Reads the preview for refreshPreview.
     * @param {number} token - Preview token: a newer preview cancels this one.
     * @param {{shownPage: boolean, fullPage: boolean}} [options] - See refreshPreview.
     */
    async function readPreview(token, options) {
        const template = getSelectedTemplate();
        const box = $id("detailsPreview");
        if (!template || state.step !== 2) {
            box.hidden = true;
            return;
        }
        box.hidden = false;
        state.previewUrl = "";
        if (!template.fields.length) {
            renderPreviewRows(template, {});
            $id("detailsPreviewStatus").textContent = "No field yet";
            return;
        }
        renderPreviewRows(template, null);
        $id("detailsPreviewStatus").textContent = "Loading the test page…";
        const isCancelled = () => token !== state.previewToken;
        state.previewLoading = true;
        let ready;
        try {
            ready = options && options.shownPage ? true : await ensureTestPage(isCancelled);
        } finally {
            if (!isCancelled()) state.previewLoading = false;
        }
        if (isCancelled()) return;
        if (!ready) {
            $id("detailsPreviewStatus").textContent = "The test page does not answer";
            return;
        }
        $id("detailsPreviewStatus").textContent = "Reading…";
        const fields = template.fields.map(field => ({ kind: field.kind, selectors: field.selectors }));
        // With "Load full page" (or the reload button), the first read scrolls through the page
        // first, like a run
        const scrollFirst = template.fullPage || !!(options && options.fullPage);
        // Read at once, then, if fields are missing, again once they show (or the wait ends)
        for (const waitMs of [0, LATE_FIELDS_WAIT_MS]) {
            const fullPage = scrollFirst && !waitMs;
            const response = await sendToTab({ action: "detailsPreview", fields: fields, waitMs: waitMs,
                fullPage: fullPage, limitMs: fullPage ? Math.max(1, template.wait.max) * 1000 : 0 });
            if (isCancelled()) return;
            if (!response || !Array.isArray(response.values)) {
                $id("detailsPreviewStatus").textContent = "The test page does not answer";
                return;
            }
            connectSessionPort(response.doc);
            state.previewDoc = response.doc || "";
            state.previewUrl = response.url || "";
            const found = response.values.filter(value => value).length;
            const complete = found === template.fields.length;
            $id("detailsPreviewStatus").textContent = found + " / " + template.fields.length + " found" +
                (complete || waitMs ? "" : " · waiting for the others…");
            // Kept by field id: the fields may be moved meanwhile
            const values = {};
            template.fields.forEach((field, i) => { values[field.id] = response.values[i] || ""; });
            state.previewValues = values;
            state.previewTemplateId = template.id;
            redrawPreview();
            if (complete) return;
        }
    }

    /**
     * Previews again a page that the target tab loaded on its own while the fields step is
     * shown (reload, link followed, address typed): one of the URLs to visit becomes the test
     * page; another page of the template's site is read as it is.
     */
    async function onTargetPageLoaded() {
        state.pageWatchTimer = 0;
        const template = getSelectedTemplate();
        if (state.step !== 2 || isBusy() || !template || state.previewLoading || !document.body.classList.contains(DETAILS_MODE_CLASS)) return;
        const response = await sendToTabWithRetry({ action: "detailsPing" }, ANSWER_TIMEOUT_MS);
        if (!response || !response.doc || response.doc === state.previewDoc || state.step !== 2 || isBusy() || state.previewLoading) return;
        const index = state.validUrls.map(normalizeUrl).indexOf(normalizeUrl(response.url));
        if (index >= 0) {
            if (index !== state.testIndex) {
                state.testIndex = index;
                updateTestUrlUi();
                const changed = chooseTemplateForDomain();
                renderTemplateSelect();
                if (changed) return;
            }
            refreshPreview();
        } else if (getRegistrableDomain(response.url) === template.domain) {
            refreshPreview({ shownPage: true });
        }
    }

    /**
     * Draws the preview again with the values already read, when they cover every field of the
     * selected template (else it waits for the next read).
     */
    function redrawPreview() {
        const template = getSelectedTemplate();
        if (!template || $id("detailsPreview").hidden) return;
        const values = state.previewValues;
        const usable = !!values && state.previewTemplateId === template.id && template.fields.every(field => field.id in values);
        if (usable || !values) renderPreviewRows(template, usable ? values : null);
    }

    /**
     * Draws the preview table: the URL column, then one row per field with a drag handle, its
     * kind, column name (renamable), value read in the test page, and a button to remove it.
     * Not redrawn while a name is being edited or a field dragged (it is drawn again when that
     * ends).
     * @param {Object} template - Template.
     * @param {Object<string, string>|null} values - Values by field id, or null while loading.
     */
    function renderPreviewRows(template, values) {
        state.previewValues = values;
        state.previewTemplateId = template.id;
        if (state.renaming || state.dragFieldId) return;
        const busy = isBusy();
        const count = template.fields.length;
        const body = $id("detailsPreviewBody");
        body.textContent = "";
        $id("detailsPreviewHint").hidden = count < 2 || busy;
        const columns = getResultColumns(template);
        const addRow = (kindKey, kindLabel, key, name, value, missing, field) => {
            const row = document.createElement("tr");
            const handleCell = document.createElement("td");
            handleCell.className = "osd-preview-handle";
            if (field) {
                row.dataset.fieldId = field.id;
                if (count > 1 && !busy) {
                    const handle = document.createElement("span");
                    handle.className = "osd-drag-handle";
                    handle.textContent = "⠿";
                    handle.draggable = true;
                    handle.title = "Drag to change the column order";
                    handleCell.appendChild(handle);
                }
            } else {
                handleCell.title = "The URL column stays first";
            }

            const kindCell = document.createElement("td");
            kindCell.className = "osd-preview-kind";
            const kind = document.createElement("span");
            kind.className = "osd-kind osd-kind-" + kindKey;
            kind.textContent = kindLabel;
            kindCell.appendChild(kind);

            const nameCell = document.createElement("td");
            nameCell.className = "osd-preview-name";
            const nameText = document.createElement("span");
            nameText.className = "osd-preview-name-text";
            nameText.textContent = name;
            nameText.title = field ? name + "\n" + field.selectors.join("\n") : name;
            const rename = document.createElement("button");
            rename.type = "button";
            rename.className = "osd-btn osd-btn-icon osd-rename";
            rename.textContent = "✎";
            rename.title = "Rename this column";
            rename.setAttribute("aria-label", "Rename column " + name);
            rename.disabled = busy;
            rename.addEventListener("click", () => startRename(nameCell, template.id, key, name));
            nameCell.append(nameText, rename);

            const valueCell = document.createElement("td");
            valueCell.className = "osd-preview-value" + (missing ? " is-missing" : "");
            valueCell.textContent = values === null ? "…" : (missing ? "Not found" : value);
            valueCell.title = value;

            const actionsCell = document.createElement("td");
            actionsCell.className = "osd-preview-actions";
            if (field) {
                const remove = document.createElement("button");
                remove.type = "button";
                remove.className = "osd-btn osd-btn-icon osd-remove";
                remove.textContent = "×";
                remove.title = "Remove this field from the template";
                remove.setAttribute("aria-label", "Remove field " + name);
                remove.disabled = busy;
                remove.addEventListener("click", () => removeTemplateField(template.id, field.id));
                actionsCell.appendChild(remove);
            }
            row.append(handleCell, kindCell, nameCell, valueCell, actionsCell);
            body.appendChild(row);
        };
        addRow("url", "URL", "url", columns[0], state.previewUrl || getTestUrl(), false, null);
        template.fields.forEach((field, index) => {
            const value = values ? values[field.id] || "" : "";
            addRow(field.kind, KIND_LABELS[field.kind], field.id, columns[index + 1], value, !!values && !value, field);
        });
    }

    /**
     * Returns the fields in a new order, or null when the move changes nothing.
     * @param {Object[]} fields - Fields of a template.
     * @param {string} fieldId - Field to move.
     * @param {{nextTo: string, after: boolean}} target - Field to put it before or after.
     * @returns {Object[]|null} Fields in their new order.
     */
    function reorderFields(fields, fieldId, target) {
        const from = fields.findIndex(field => field.id === fieldId);
        if (from === -1) return null;
        const rest = fields.filter(field => field.id !== fieldId);
        const index = rest.findIndex(field => field.id === target.nextTo);
        if (index === -1) return null;
        const to = index + (target.after ? 1 : 0);
        if (to === from) return null;
        rest.splice(to, 0, fields[from]);
        return rest;
    }

    /**
     * Moves a field of a template. The order of the fields is the order of the result columns
     * (the URL column stays first): the preview, the grid and the exports follow it, and the
     * results already extracted keep their values (they are stored by field id).
     * @param {string} templateId - Template id.
     * @param {string} fieldId - Field to move.
     * @param {{nextTo: string, after: boolean}} target - See reorderFields.
     * @returns {Promise<boolean>} True when the new order was saved.
     */
    async function moveTemplateField(templateId, fieldId, target) {
        const template = state.templates.find(t => t.id === templateId);
        if (!template || isBusy() || !reorderFields(template.fields, fieldId, target)) return false;
        return updateTemplate(templateId, t => {
            const fields = reorderFields(t.fields, fieldId, target);
            if (fields) t.fields = fields;
        });
    }

    /**
     * Returns where a dragged field would be dropped: before or after the row under the pointer
     * (on the URL row: before the first field).
     * @param {DragEvent} event - Drag event in the fields list.
     * @returns {{row: HTMLElement, nextTo: string, after: boolean, line: string}|null} Target and
     *     the side of the row to mark.
     */
    function getDropTarget(event) {
        const template = getSelectedTemplate();
        const row = event.target instanceof Element ? event.target.closest("#detailsPreviewBody tr") : null;
        if (!row || !template || !template.fields.length) return null;
        if (!row.dataset.fieldId) return { row: row, nextTo: template.fields[0].id, after: false, line: "after" };
        const box = row.getBoundingClientRect();
        const after = event.clientY > box.top + box.height / 2;
        return { row: row, nextTo: row.dataset.fieldId, after: after, line: after ? "after" : "before" };
    }

    /**
     * Removes the drop line from the fields list.
     */
    function clearDropLine() {
        $id("detailsPreviewBody").querySelectorAll(".is-drop-before, .is-drop-after").forEach(row => {
            row.classList.remove("is-drop-before", "is-drop-after");
        });
    }

    /**
     * Ends dragging a field and draws the list again (it is not redrawn during the drag).
     */
    function endFieldDrag() {
        if (!state.dragFieldId) return;
        state.dragFieldId = "";
        clearDropLine();
        $id("detailsPreviewBody").querySelectorAll(".is-dragging").forEach(row => row.classList.remove("is-dragging"));
        redrawPreview();
    }

    /**
     * Saves a column name in the template (the one name used by the preview, the grid and the
     * exports). Empty names are refused; a name used by another column gets " (2)"...
     * @param {string} templateId - Template id.
     * @param {string} key - Field id, or "url" for the URL column.
     * @param {string} name - Wanted name.
     * @returns {Promise<boolean>} True when saved.
     */
    async function renameColumn(templateId, key, name) {
        const wanted = String(name || "").trim().slice(0, 120);
        if (!wanted) return false;
        return updateTemplate(templateId, template => {
            const keys = ["url"].concat(template.fields.map(field => field.id));
            const others = new Set(getResultColumns(template).filter((_, col) => keys[col] !== key));
            let unique = wanted;
            for (let n = 2; others.has(unique); n++) unique = wanted + " (" + n + ")";
            template.renames[key] = unique;
        });
    }

    /**
     * Turns a column name of the preview into a text box: Enter or leaving it saves, Escape
     * cancels, an empty name is refused.
     * @param {HTMLElement} cell - Name cell.
     * @param {string} templateId - Template id.
     * @param {string} key - Field id, or "url".
     * @param {string} current - Current name.
     */
    function startRename(cell, templateId, key, current) {
        if (state.renaming || isBusy()) return;
        state.renaming = true;
        cell.textContent = "";
        const input = document.createElement("input");
        input.type = "text";
        input.className = "osd-input osd-rename-input";
        input.maxLength = 120;
        input.value = current;
        input.setAttribute("aria-label", "Column name");
        cell.appendChild(input);
        let done = false;
        const finish = async save => {
            if (done) return;
            done = true;
            const name = input.value.trim();
            if (save && !name) showMessage("detailsPickMessage", "A column name cannot be empty: the name was kept.", "warning");
            if (save && name && name !== current) {
                await renameColumn(templateId, key, name);
                showMessage("detailsPickMessage", "");
            }
            state.renaming = false;
            redrawPreview();
        };
        input.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                event.preventDefault();
                finish(true);
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                finish(false);
            }
        });
        input.addEventListener("blur", () => finish(true));
        input.focus();
        input.select();
    }

    /**
     * Removes a field from a template.
     * @param {string} templateId - Template id.
     * @param {string} fieldId - Field id.
     */
    async function removeTemplateField(templateId, fieldId) {
        await updateTemplate(templateId, template => {
            template.fields = template.fields.filter(field => field.id !== fieldId);
            delete template.renames[fieldId];
        });
        refreshPreview();
    }

    /**
     * Tells whether picking or a run is in progress.
     * @returns {boolean} True when busy.
     */
    function isBusy() {
        return state.picking || state.running;
    }

    /**
     * Opens the test page if needed, brings it to the front and turns on the picker there.
     * @param {"new"|"edit"} [mode="new"] - "new" makes a new template of the picks; "edit"
     *     shows the selected template's fields as selected and adds the picks to it.
     */
    async function startPicking(mode) {
        if (isBusy()) return;
        const editing = mode === "edit" ? getSelectedTemplate() : null;
        if (mode === "edit" && !editing) return;
        if (isListCrawlRunning()) {
            showMessage("detailsPickMessage", 'Stop the crawl of the "Extract list" tab first.', "warning");
            return;
        }
        const token = ++state.pickToken;
        state.previewToken++;
        state.picking = true;
        state.picks = [];
        state.pickTemplateId = editing ? editing.id : "";
        closeTemplateMenu();
        closePrompt("detailsTemplatePrompt");
        updateBusyUi();
        showMessage("detailsPickMessage", "Opening the test page…");

        const ready = await ensureTestPage(() => token !== state.pickToken);
        if (token !== state.pickToken) return;
        if (!ready) {
            endPicking(token, "The test page does not answer. Check that it opens, or use another test page.", "error");
            return;
        }
        await focusTargetTab();
        const startMessage = { action: "detailsPickerStart" };
        if (editing) startMessage.existing = editing.fields.map(field => ({ kind: field.kind, selectors: field.selectors }));
        const started = await sendToTabWithRetry(startMessage, ANSWER_TIMEOUT_MS);
        if (token !== state.pickToken) return;
        if (!started || !started.ok) {
            endPicking(token, "The page does not answer. Reload it, or open a regular web page, then try again.", "error");
            return;
        }
        connectSessionPort(started.doc);
        showMessage("detailsPickMessage", editing && editing.fields.length ? "Fields of \"" + editing.name + "\" found in the page are green. Click more data to add, then click Finish." :
            "Click the data to extract in the page, then click Finish.");
        pollPicks(token);
    }

    /**
     * Waits for new picks from the page until picking ends.
     * @param {number} token - Picking session.
     */
    async function pollPicks(token) {
        let known = 0;
        while (token === state.pickToken) {
            const response = await sendToTab({ action: "detailsPickerPoll", known: known });
            if (token !== state.pickToken) return;
            if (!response || !Array.isArray(response.picks)) {
                endPicking(token, "Selecting ended because the page changed or was closed.", "warning");
                return;
            }
            state.picks = response.picks;
            known = response.picks.length;
            if (response.active) {
                showMessage("detailsPickMessage", plural(known, "field") + " selected. Click Finish in the page when done.");
            } else {
                endPicking(token, "");
                return;
            }
        }
    }

    /**
     * Asks the page to end picking (the poll then receives the final picks).
     */
    async function finishPicking() {
        const token = state.pickToken;
        const response = await sendToTab({ action: "detailsPickerStop" });
        if (!response) {
            endPicking(token, "");
        } else if (Array.isArray(response.picks) && token === state.pickToken) {
            state.picks = response.picks;
        }
    }

    /**
     * Leaves picking mode; the picks, if any, become a new template.
     * @param {number} token - Picking session that ends.
     * @param {string} message - Message to show ("" for none).
     * @param {"info"|"warning"|"error"} [level] - Message level.
     */
    function endPicking(token, message, level) {
        if (token !== state.pickToken) return;
        state.pickToken++;
        state.picking = false;
        const picks = state.picks;
        const editedId = state.pickTemplateId;
        state.picks = [];
        state.pickTemplateId = "";
        showMessage("detailsPickMessage", message, level);
        updateBusyUi();
        if (editedId) {
            if (picks.length) {
                addFieldsToTemplate(editedId, picks).then(() => refreshPreview());
            } else {
                if (!message) showMessage("detailsPickMessage", "No field added.");
                refreshPreview();
            }
        } else if (picks.length) {
            createTemplateFromPicks(picks);
        } else if (!message) {
            showMessage("detailsPickMessage", "Nothing was selected.", "warning");
        }
    }

    // --- Step 3: run ---

    /**
     * Shows the options of a template (wait bounds, "Load full page") in the inputs.
     * @param {{wait: Object, fullPage: boolean}} template - Template.
     */
    function applyOptionsToInputs(template) {
        const bounds = normalizeWait(template.wait);
        $id("detailsMinWait").value = String(bounds.min);
        $id("detailsMaxWait").value = String(bounds.max);
        $id("detailsFullPage").checked = template.fullPage === true;
        updateOptionsSummary();
    }

    /**
     * Writes the options in the header of the closed options panel ("Wait 2–30 s · Load full page: off").
     */
    function updateOptionsSummary() {
        const wait = getWait();
        $id("detailsOptionsSummary").textContent = "Wait " + (wait.min === wait.max ? wait.min : wait.min + "–" + wait.max) +
            " s · Load full page: " + ($id("detailsFullPage").checked ? "on" : "off");
    }

    /**
     * Saves the "Load full page" switch in the template.
     */
    function onFullPageChanged() {
        const on = $id("detailsFullPage").checked;
        updateOptionsSummary();
        const template = getSelectedTemplate();
        if (template) updateTemplate(template.id, t => { t.fullPage = on; });
    }

    /**
     * Reads the wait bounds, in seconds.
     * @returns {{min: number, max: number}} Bounds.
     */
    function getWait() {
        return normalizeWait({ min: $id("detailsMinWait").value, max: $id("detailsMaxWait").value });
    }

    /**
     * Keeps min <= max (raising Min raises Max, lowering Max lowers Min) and saves both in the template.
     * @param {"min"|"max"} changed - Input the user changed.
     */
    function onWaitChanged(changed) {
        const minInput = $id("detailsMinWait");
        const maxInput = $id("detailsMaxWait");
        const read = input => Math.max(0, parseInt(input.value, 10) || 0);
        let min = read(minInput);
        let max = read(maxInput);
        if (min > max) {
            if (changed === "min") max = min;
            else min = max;
        }
        minInput.value = String(min);
        maxInput.value = String(max);
        updateOptionsSummary();
        const template = getSelectedTemplate();
        if (!template) return;
        clearTimeout(state.waitSaveTimer);
        state.waitSaveTimer = setTimeout(() => {
            updateTemplate(template.id, t => { t.wait = normalizeWait({ min: min, max: max }); });
        }, 300);
    }

    /**
     * Clears the results and goes back to the first URL.
     */
    function resetResults() {
        state.results = [];
        state.nextIndex = 0;
        state.extracted = 0;
        state.failed = 0;
        state.elapsedMs = 0;
        showMessage("detailsRunMessage", "");
        rebuildGridIfNeeded(true);
        updateRunUi();
    }

    /**
     * Prepares the extract step.
     */
    function onExtractStepShown() {
        const template = getSelectedTemplate();
        if (template) applyOptionsToInputs(template);
        renderRunHeader();
        updateRunUi();
        rebuildGridIfNeeded(true);
    }

    /**
     * Shows the template name and domain.
     */
    function renderRunHeader() {
        const template = getSelectedTemplate();
        $id("detailsRunName").textContent = template ? template.name : "";
        $id("detailsRunDomain").textContent = template ? template.domain + " · " + plural(template.fields.length, "field") : "";
    }

    /**
     * Formats a duration as mm:ss, or hh:mm:ss from one hour.
     * @param {number} ms - Duration.
     * @returns {string} Formatted duration.
     */
    function formatDuration(ms) {
        const total = Math.floor(ms / 1000);
        const pad = n => String(n).padStart(2, "0");
        const hours = Math.floor(total / 3600);
        const rest = pad(Math.floor(total / 60) % 60) + ":" + pad(total % 60);
        return hours ? pad(hours) + ":" + rest : rest;
    }

    /**
     * Returns the time spent running, stops excluded.
     * @returns {number} Milliseconds.
     */
    function getElapsedMs() {
        return state.elapsedMs + (state.running ? Date.now() - state.runStartedAt : 0);
    }

    /**
     * Counts the valid URLs not visited yet.
     * @returns {number} Remaining pages.
     */
    function getRemaining() {
        return state.urls.slice(state.nextIndex).filter(url => isUsableUrl(url.trim())).length;
    }

    /**
     * Updates the counters, the Start / Stop button and the export buttons.
     */
    function updateRunUi() {
        $id("detailsExtracted").textContent = String(state.extracted);
        $id("detailsRemaining").textContent = String(getRemaining());
        $id("detailsDuration").textContent = formatDuration(getElapsedMs());
        const toggle = $id("detailsRunToggle");
        const finished = state.nextIndex >= state.urls.length && state.results.length > 0;
        toggle.textContent = state.running ? "Stop" : (finished ? "Restart" : "Start");
        toggle.classList.toggle("osd-btn-danger", state.running);
        toggle.disabled = !state.running && (state.picking || !canOpenStep(3));
        $id("detailsReset").disabled = isBusy() || !hasRunProgress();
        if ($id("detailsReset").disabled) closePrompt("detailsResetPrompt");
        const count = state.results.length;
        $id("detailsResultCount").textContent = count ? plural(count, "row") : "One row per page, URL first.";
        ["detailsCsv", "detailsJson", "detailsXlsx", "detailsCopy"].forEach(id => { $id(id).disabled = !count; });
        if (!count) showMessage("detailsExportMessage", "");
    }

    /**
     * Tells whether the run has anything to reset: rows, time spent, or pages visited.
     * @returns {boolean} True when Reset has something to clear.
     */
    function hasRunProgress() {
        return state.results.length > 0 || state.nextIndex > 0 || state.elapsedMs > 0;
    }

    /**
     * Asks before deleting the rows of the run; on Reset, the next Start begins with the first
     * URL. The template, the URLs, the options and the column order stay as they are.
     */
    function askResetRun() {
        if (isBusy() || !hasRunProgress()) return;
        const count = state.results.length;
        openPrompt("detailsResetPrompt", count ? "Delete the " + plural(count, "extracted row") + " and start again from the first URL?" :
            "Start again from the first URL?", null, "Reset", () => {
            if (isBusy()) return;
            resetResults();
            showMessage("detailsRunMessage", "Results deleted. Start begins with the first URL.", "info");
        });
    }

    /**
     * Enables or disables the controls while picking or running.
     */
    function updateBusyUi() {
        const busy = isBusy();
        $id("tabList").disabled = state.running;
        $id("tabDetails").disabled = state.running;
        document.querySelectorAll(".osd-seg[data-source]").forEach(button => { button.disabled = busy; });
        ["detailsCsvFile", "detailsPasteUrls", "detailsUrlColumn", "detailsMinWait", "detailsMaxWait", "detailsFullPage", "detailsToStep2"].forEach(id => {
            $id(id).disabled = busy || (id === "detailsToStep2" && !state.validUrls.length);
        });
        renderTemplateSelect();
        updateFieldsStepUi();
        updateRunUi();
    }

    /**
     * Starts the run or resumes it at the next page to visit.
     */
    async function startRun() {
        if (isBusy()) return;
        closePrompt("detailsResetPrompt");
        if (isListCrawlRunning()) {
            showMessage("detailsRunMessage", 'Stop the crawl of the "Extract list" tab first.', "warning");
            return;
        }
        const template = getSelectedTemplate();
        if (!template || !template.fields.length || !state.validUrls.length) return;
        if (!(await getTargetTab())) {
            showMessage("detailsRunMessage", "The target tab was closed. Close this window and click the extension icon again.", "error");
            return;
        }
        if (state.nextIndex >= state.urls.length) resetResults();

        sendToTab({ action: "detailsClearHighlights" });
        const runId = ++state.runId;
        const stopped = new Promise(resolve => { state.resolveStop = resolve; });
        const isStopped = () => runId !== state.runId;
        const fields = template.fields.map(field => ({ id: field.id, kind: field.kind, selectors: field.selectors }));
        // What the run learns of each field (see ABSENT_FIELD_PAGES)
        const learned = fields.map(() => ({ absentPages: 0, skippedPages: 0, late: false }));
        state.running = true;
        state.runStartedAt = Date.now();
        state.ticker = setInterval(updateRunUi, 1000);
        showMessage("detailsRunMessage", "");
        updateBusyUi();

        while (state.nextIndex < state.urls.length) {
            const index = state.nextIndex;
            const url = state.urls[index].trim();
            const row = { url: state.urls[index], values: {}, failed: false };
            if (isUsableUrl(url)) {
                // The page takes at least Min seconds and at most about Max seconds. It is read
                // once parsed: the content script waits for Min and for the fields drawn late,
                // after scrolling through the page with "Load full page".
                const wait = getWait();
                const fullPage = $id("detailsFullPage").checked;
                const pageStart = Date.now();
                const limitMs = Math.max(1, wait.max) * 1000;
                const minEnd = pageStart + wait.min * 1000;
                const ready = await Promise.race([
                    loadPage(url, limitMs, { isCancelled: isStopped, busy: true, early: true }),
                    stopped.then(() => false)
                ]);
                if (isStopped()) return;
                let response;
                if (ready) {
                    const awaited = learned.map(field => field.late || field.absentPages < ABSENT_FIELD_PAGES ||
                        field.skippedPages >= ABSENT_FIELD_RECHECK_PAGES);
                    response = await Promise.race([
                        sendToTabWithRetry({ action: "detailsExtract", fields: fields, busy: true, awaited: awaited, fullPage: fullPage,
                            notBeforeMs: Math.max(0, minEnd - Date.now()), lateMs: LATE_FIELDS_WAIT_MS,
                            limitMs: Math.max(0, pageStart + limitMs - Date.now()) }, 2000, isStopped),
                        stopped.then(() => undefined)
                    ]);
                    if (isStopped()) return;
                    if (response && response.ok && Array.isArray(response.values)) learnFields(learned, awaited, response);
                }
                if (Date.now() < minEnd) {
                    // Error page or no answer: the page still takes Min seconds
                    await Promise.race([sleep(minEnd - Date.now()), stopped]);
                    if (isStopped()) return;
                }
                if (response && response.ok && Array.isArray(response.values)) {
                    fields.forEach((field, i) => { row.values[field.id] = response.values[i] == null ? "" : String(response.values[i]); });
                    state.extracted++;
                } else {
                    row.failed = true;
                    state.failed++;
                }
            }
            state.results.push(row);
            state.nextIndex = index + 1;
            appendGridRow(row);
            updateRunUi();
        }
        finishRun(runId, state.failed ? plural(state.failed, "page") +
            " could not be read (error page, time limit or no answer): only the URL is in the row." : "Done.", state.failed ? "warning" : "info");
    }

    /**
     * Notes, after a page of a run, which fields showed late and which stayed absent after the
     * full wait (see ABSENT_FIELD_PAGES).
     * @param {Array<{absentPages: number, skippedPages: number, late: boolean}>} learned - Per
     *     field, updated in place.
     * @param {boolean[]} awaited - Per field, whether the page waited for it.
     * @param {{values: Array, complete: boolean, late: boolean[]}} response - Page answer.
     */
    function learnFields(learned, awaited, response) {
        learned.forEach((field, i) => {
            if (response.late && response.late[i]) {
                field.late = true;
                field.absentPages = 0;
            } else if (awaited[i]) {
                if (response.values[i]) field.absentPages = 0;
                else if (!response.complete) field.absentPages++;
                field.skippedPages = 0;
            } else {
                field.skippedPages++;
            }
        });
    }

    /**
     * Stops the run at once. The page being visited is not counted and is visited again on Start.
     */
    function stopRun() {
        if (!state.running) return;
        const resolveStop = state.resolveStop;
        state.runId++;
        finishRun(state.runId, "Stopped. Start continues with page " + (state.nextIndex + 1) + ".", "info");
        if (resolveStop) resolveStop();
    }

    /**
     * Leaves the running state and removes the overlay from the page.
     * @param {number} runId - Run that ends.
     * @param {string} message - Message to show.
     * @param {"info"|"warning"|"error"} [level] - Message level.
     */
    function finishRun(runId, message, level) {
        if (runId !== state.runId) return;
        state.elapsedMs += Date.now() - state.runStartedAt;
        state.running = false;
        state.resolveStop = null;
        clearInterval(state.ticker);
        sendToTab({ action: "detailsBusy", on: false });
        showMessage("detailsRunMessage", message, level);
        updateBusyUi();
    }

    // --- Results grid ---

    /**
     * Counts, per column of the selected template, the rows where it has a value.
     * @returns {{rows: number, filled: Object<string, number>}} Rows so far, filled count by
     *     field id ("url" for the URL column).
     */
    function getFilledCounts() {
        const template = getSelectedTemplate();
        const key = template ? template.id + "|" + template.fields.map(field => field.id).join(",") + "|" + state.results.length : "";
        if (state.filledCounts && state.filledCounts.key === key && state.filledCounts.results === state.results) return state.filledCounts;
        const counts = { key: key, results: state.results, rows: state.results.length, filled: { url: 0 } };
        state.filledCounts = counts;
        if (!template) return counts;
        template.fields.forEach(field => { counts.filled[field.id] = 0; });
        state.results.forEach(result => {
            if (String(result.url || "").trim()) counts.filled.url++;
            template.fields.forEach(field => {
                if (result.values[field.id]) counts.filled[field.id]++;
            });
        });
        return counts;
    }

    /**
     * Returns the result column names: the URL column, then one column per field (renamed),
     * made unique.
     * @param {Object} template - Template.
     * @returns {string[]} Column names.
     */
    function getResultColumns(template) {
        return uniqueColumnNames([template.renames.url || state.urlColumnName || "URL"]
            .concat(template.fields.map(field => getFieldColumnName(template, field))));
    }

    /**
     * Turns a result into a grid row.
     * @param {Object} template - Template.
     * @param {{url: string, values: Object}} result - Result.
     * @returns {string[]} Row.
     */
    function toGridRow(template, result) {
        return [result.url].concat(template.fields.map(field => (field.id in result.values ? result.values[field.id] : "")));
    }

    /**
     * Builds the results table for the exports.
     * @returns {{fields: string[], data: string[][]}} Table.
     */
    function buildResultsTable() {
        const template = getSelectedTemplate();
        if (!template) return { fields: [], data: [] };
        return { fields: getResultColumns(template), data: state.results.map(result => toGridRow(template, result)) };
    }

    /**
     * Escapes text for HTML.
     * @param {string} text - Raw text.
     * @returns {string} Escaped text.
     */
    function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
    }

    /**
     * Returns the size available for the grid: the full width of its box and the height left
     * down to the bottom of the window.
     * @returns {{width: number, height: number}} Size in pixels.
     */
    function getGridSize() {
        const wrap = $id("detailsHotWrap");
        const top = wrap.getBoundingClientRect().top;
        return { width: Math.max(200, wrap.clientWidth), height: Math.max(160, Math.floor(window.innerHeight - top - GRID_BOTTOM_SPACE)) };
    }

    /**
     * Fits the grid to the space available, keeping its data, selection and scroll position.
     */
    function fitGrid() {
        state.gridFitTimer = 0;
        if (!state.grid || state.step !== 3 || !document.body.classList.contains(DETAILS_MODE_CLASS)) return;
        const size = getGridSize();
        if (state.gridSize && state.gridSize.width === size.width && state.gridSize.height === size.height) return;
        const holder = $id("detailsHot").querySelector(".ht_master .wtHolder");
        const left = holder ? holder.scrollLeft : 0;
        const top = holder ? holder.scrollTop : 0;
        state.gridSize = size;
        state.grid.updateSettings({ width: size.width, height: size.height });
        if (holder) setGridScroll(holder, left, top);
    }

    /**
     * Scrolls the grid's cells and makes its row and column headers follow: the headers only
     * move on a scroll event, which a position set to its current value does not fire.
     * @param {HTMLElement} holder - Scrolling box of the grid's cells.
     * @param {number} left - Horizontal position.
     * @param {number} top - Vertical position.
     */
    function setGridScroll(holder, left, top) {
        holder.scrollLeft = left;
        holder.scrollTop = top;
        holder.dispatchEvent(new Event("scroll"));
    }

    /**
     * Fits the grid on the next frames, once (window resized, a message shown above it...).
     */
    function scheduleGridFit() {
        if (state.gridFitTimer) return;
        state.gridFitTimer = setTimeout(fitGrid, GRID_FIT_DELAY_MS);
    }

    /**
     * Creates the grid again when the columns changed (or when asked), otherwise keeps it.
     * @param {boolean} [force=false] - Recreate even if the columns are the same.
     */
    function rebuildGridIfNeeded(force) {
        const template = getSelectedTemplate();
        const container = $id("detailsHot");
        const key = template ? JSON.stringify([template.id, getResultColumns(template), template.fields.map(f => f.id)]) : "";
        if (!force && key === state.gridKey && state.grid) return;
        if (state.grid) {
            state.grid.destroy();
            state.grid = null;
        }
        container.innerHTML = "";
        state.gridKey = key;
        if (!template || state.step !== 3 || !document.body.classList.contains(DETAILS_MODE_CLASS)) {
            state.gridKey = "";
            return;
        }
        const columns = getResultColumns(template);
        const size = getGridSize();
        state.gridSize = size;
        state.gridData = state.results.map(result => toGridRow(template, result));
        state.grid = new Handsontable(container, {
            data: state.gridData,
            colHeaders: col => {
                const name = escapeHtml(columns[col] || "");
                const field = col > 0 ? template.fields[col - 1] : null;
                // Completion line above the name: rows with a value / rows so far (not data)
                const counts = getFilledCounts();
                const filled = counts.filled[field ? field.id : "url"] || 0;
                const stat = counts.rows ? filled + "/" + counts.rows : "&nbsp;";
                const statTip = counts.rows ? ' title="' + filled + " of " + counts.rows + ' rows have a value"' : "";
                const show = col > 0 ? '<button type="button" class="osd-col-action" data-col-action="show" data-col="' + col +
                    '" title="Show in page">&#9673;</button>' : "";
                return '<span class="osd-col-stat' + (counts.rows && filled < counts.rows ? " is-partial" : "") + '"' + statTip + ">" + stat + "</span>" +
                    '<span class="osd-col-head"><span class="osd-col-name" title="' + name + '">' + name + "</span>" +
                    '<button type="button" class="osd-col-action" data-col-action="rename" data-col="' + col +
                    '" title="Rename column">&#9998;</button>' + show + "</span>";
            },
            columns: columns.map(() => ({ readOnly: true })),
            rowHeaders: true,
            columnHeaderHeight: GRID_HEADER_HEIGHT,
            readOnly: true,
            wordWrap: false,
            manualColumnResize: true,
            width: size.width,
            height: size.height,
            stretchH: "all",
            colWidths: columns.map((_, col) => (col === 0 ? 220 : 160))
        });
    }

    /**
     * Adds one row to the grid without rebuilding it. The horizontal scroll never moves; the
     * view follows the new row only when it was already showing the last rows.
     * @param {Object} result - New result.
     */
    function appendGridRow(result) {
        const template = getSelectedTemplate();
        if (!state.grid || !template) {
            rebuildGridIfNeeded();
            return;
        }
        const holder = $id("detailsHot").querySelector(".ht_master .wtHolder");
        const atBottom = !holder || holder.scrollTop + holder.clientHeight >= holder.scrollHeight - 30;
        const left = holder ? holder.scrollLeft : 0;
        state.gridData.push(toGridRow(template, result));
        state.grid.render();
        if (holder) setGridScroll(holder, left, atBottom ? holder.scrollHeight : holder.scrollTop);
    }

    /**
     * Handles the rename and "show in page" buttons of the column headers.
     * @param {MouseEvent} event - Mouse event in the grid.
     */
    function onGridHeaderAction(event) {
        const button = event.target instanceof Element ? event.target.closest("[data-col-action]") : null;
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.type !== "click") return;
        const template = getSelectedTemplate();
        if (!template) return;
        const col = parseInt(button.dataset.col, 10);
        const field = col > 0 ? template.fields[col - 1] : null;
        if (button.dataset.colAction === "rename") {
            const current = getResultColumns(template)[col];
            openPrompt("detailsColumnPrompt", "Column name", current, "Save", name => {
                if (name) renameColumn(template.id, field ? field.id : "url", name);
            });
        } else if (field) {
            showFieldInPage(field);
        }
    }

    /**
     * Highlights the element of a field in the target tab for a moment.
     * @param {Object} field - Field.
     */
    async function showFieldInPage(field) {
        await focusTargetTab();
        const response = await sendToTab({ action: "detailsShowField", field: { kind: field.kind, selectors: field.selectors }, durationMs: SHOW_FIELD_MS });
        if (response) connectSessionPort(response.doc);
        if (!response || !response.found) {
            showMessage("detailsExportMessage", "Not found in the page shown in the tab.", "warning");
        } else {
            showMessage("detailsExportMessage", "");
        }
    }

    // --- Exports ---

    /**
     * Returns the export file name without extension: "<template name>-YYYY-MM-DD".
     * @returns {string} File name base.
     */
    function getExportFileBase() {
        const template = getSelectedTemplate();
        const now = new Date();
        const pad = n => String(n).padStart(2, "0");
        const date = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
        return toFileName(template ? template.name : "page-details") + "-" + date;
    }

    /**
     * Downloads the results as JSON: an indented array with one object per page, URL first.
     * @param {{fields: string[], data: string[][]}} table - Results table.
     * @param {string} fileName - Name of the downloaded file.
     */
    function exportJson(table, fileName) {
        const records = table.data.map(row => {
            const record = {};
            table.fields.forEach((name, col) => { record[name] = row[col] == null ? "" : row[col]; });
            return record;
        });
        saveAs(new Blob([JSON.stringify(records, null, 2)], { type: "application/json" }), fileName);
    }

    /**
     * Runs one of the shared export helpers of popup.js on the results.
     * @param {"csv"|"json"|"xlsx"|"copy"} format - Export format.
     */
    function exportResults(format) {
        const helpers = window.OpenScraper;
        if (!helpers || !state.results.length) return;
        const table = buildResultsTable();
        if (format === "csv") {
            helpers.exportCsv(table, getExportFileBase() + ".csv", { bom: true });
        } else if (format === "json") {
            exportJson(table, getExportFileBase() + ".json");
        } else if (format === "xlsx") {
            helpers.exportXlsx(table, getExportFileBase() + ".xlsx", "Page details");
        } else {
            helpers.copyTsv(table);
            showMessage("detailsExportMessage", "Copied " + plural(table.data.length, "row") + " to the clipboard.");
        }
    }

    // --- Wiring ---

    // The list grid is drawn again after every read of the list: check its columns then
    let listCheckTimer = 0;
    new MutationObserver(() => {
        clearTimeout(listCheckTimer);
        listCheckTimer = setTimeout(updateExtractEachUrlButton, 400);
    }).observe($id("hot"), { childList: true });
    $id("extractEachUrl").addEventListener("click", extractEachListUrl);

    $id("tabList").addEventListener("click", () => setMode("list"));
    $id("tabDetails").addEventListener("click", () => setMode("details"));
    document.querySelectorAll(".osd-stepper-item").forEach(item => {
        item.addEventListener("click", () => showStep(parseInt(item.dataset.step, 10)));
    });

    document.querySelectorAll(".osd-seg[data-source]").forEach(button => {
        button.addEventListener("click", () => {
            state.sourceChosen = true;
            setSource(button.dataset.source);
        });
    });
    $id("detailsCsvFile").addEventListener("change", event => loadCsvSource(event.target.files[0]));
    $id("detailsPasteUrls").addEventListener("input", loadPasteSource);
    $id("detailsUrlColumn").addEventListener("change", applyColumn);
    $id("detailsToStep2").addEventListener("click", () => showStep(2));

    $id("detailsTestPrev").addEventListener("click", () => moveTestUrl(-1));
    $id("detailsTestNext").addEventListener("click", () => moveTestUrl(1));
    $id("detailsTemplate").addEventListener("change", event => {
        if (event.target.value !== NEW_TEMPLATE_VALUE) {
            selectTemplate(event.target.value);
            return;
        }
        event.target.value = getSelectedTemplate() ? state.templateId : "";
        promptNewTemplate();
    });
    $id("detailsTemplateMenuButton").addEventListener("click", event => {
        event.stopPropagation();
        toggleTemplateMenu($id("detailsTemplateMenu").hidden);
    });
    [["detailsTemplateNew", "new"], ["detailsTemplateDuplicate", "duplicate"], ["detailsTemplateRename", "rename"],
        ["detailsTemplateExport", "export"], ["detailsTemplateImport", "import"], ["detailsTemplateDelete", "delete"]]
        .forEach(([id, action]) => $id(id).addEventListener("click", () => onTemplateMenuAction(action)));
    document.addEventListener("click", event => {
        if (!$id("detailsTemplateMenu").hidden && !event.target.closest(".osd-menu-wrap")) closeTemplateMenu();
    });
    document.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            closeTemplateMenu();
            closePrompt("detailsTemplatePrompt");
            closePrompt("detailsColumnPrompt");
            closePrompt("detailsResetPrompt");
        }
    });
    $id("detailsTemplateFile").addEventListener("change", event => importTemplate(event.target.files[0]));
    $id("detailsTemplatePromptCancel").addEventListener("click", () => closePrompt("detailsTemplatePrompt"));
    $id("detailsColumnPromptCancel").addEventListener("click", () => closePrompt("detailsColumnPrompt"));
    $id("detailsResetPromptCancel").addEventListener("click", () => closePrompt("detailsResetPrompt"));
    $id("detailsReset").addEventListener("click", askResetRun);
    // An empty template selected gets the picks; otherwise they make a new template
    $id("detailsPickStart").addEventListener("click", () => {
        const template = getSelectedTemplate();
        startPicking(template && !template.fields.length ? "edit" : "new");
    });
    $id("detailsEditFields").addEventListener("click", () => startPicking("edit"));
    $id("detailsPickStop").addEventListener("click", finishPicking);

    // Fields list: drag a field by its handle to change the column order
    const previewBody = $id("detailsPreviewBody");
    previewBody.addEventListener("dragstart", event => {
        const handle = event.target instanceof Element ? event.target.closest(".osd-drag-handle") : null;
        const row = handle && handle.closest("tr");
        if (!row || !row.dataset.fieldId || isBusy() || state.renaming) {
            event.preventDefault();
            return;
        }
        state.dragFieldId = row.dataset.fieldId;
        row.classList.add("is-dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", row.dataset.fieldId);
        event.dataTransfer.setDragImage(row, 12, row.offsetHeight / 2);
    });
    previewBody.addEventListener("dragover", event => {
        const target = state.dragFieldId ? getDropTarget(event) : null;
        if (!target) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        clearDropLine();
        target.row.classList.add("is-drop-" + target.line);
    });
    previewBody.addEventListener("dragleave", event => {
        if (!(event.relatedTarget instanceof Node && previewBody.contains(event.relatedTarget))) clearDropLine();
    });
    previewBody.addEventListener("drop", event => {
        const fieldId = state.dragFieldId;
        const target = fieldId ? getDropTarget(event) : null;
        if (!fieldId) return;
        event.preventDefault();
        const template = getSelectedTemplate();
        endFieldDrag();
        if (target && template) moveTemplateField(template.id, fieldId, target);
    });
    previewBody.addEventListener("dragend", endFieldDrag);
    $id("detailsBackTo1").addEventListener("click", () => showStep(1));
    $id("detailsPreviewReload").addEventListener("click", reloadPreview);
    $id("detailsToStep3").addEventListener("click", () => showStep(3));

    $id("detailsMinWait").addEventListener("change", () => onWaitChanged("min"));
    $id("detailsMaxWait").addEventListener("change", () => onWaitChanged("max"));
    $id("detailsFullPage").addEventListener("change", onFullPageChanged);
    $id("detailsRunToggle").addEventListener("click", () => (state.running ? stopRun() : startRun()));
    ["mousedown", "click"].forEach(type => $id("detailsHot").addEventListener(type, onGridHeaderAction, true));

    $id("detailsCsv").addEventListener("click", () => exportResults("csv"));
    $id("detailsJson").addEventListener("click", () => exportResults("json"));
    $id("detailsXlsx").addEventListener("click", () => exportResults("xlsx"));
    $id("detailsCopy").addEventListener("click", () => exportResults("copy"));

    chromeInstance.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes[TEMPLATES_KEY]) return;
        const list = Array.isArray(changes[TEMPLATES_KEY].newValue) ? changes[TEMPLATES_KEY].newValue : [];
        state.templates = list.map(sanitizeTemplate).filter(Boolean);
        onTemplatesChanged();
    });

    window.addEventListener("resize", scheduleGridFit);
    chromeInstance.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (tabId !== targetTabId || changeInfo.status !== "complete" || state.step !== 2) return;
        clearTimeout(state.pageWatchTimer);
        state.pageWatchTimer = setTimeout(onTargetPageLoaded, PAGE_WATCH_DELAY_MS);
    });
    $id("detailsOptions").addEventListener("toggle", scheduleGridFit);

    // The window holds the results in memory only: confirm before closing it during a run
    window.addEventListener("beforeunload", event => {
        if (state.running) {
            event.preventDefault();
            event.returnValue = "";
        }
    });

    readTemplates().then(templates => {
        state.templates = templates;
        onTemplatesChanged();
    });
    setSource("csv");
    showStep(1);
    updateBusyUi();
})();
