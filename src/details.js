(() => {
    "use strict";

    const chromeInstance = chrome;

    // CSS class put on <body> while the page details panel is shown
    const DETAILS_MODE_CLASS = "mode-details";

    // Elements of the list panel, kept in the layout but made inert while hidden
    const LIST_PANEL_IDS = ["wait", "content"];

    // Longest wait for a page to finish loading, then for the content script to answer
    const LOAD_TIMEOUT_MS = 30000;
    const ANSWER_TIMEOUT_MS = 10000;
    const RETRY_INTERVAL_MS = 500;

    // Extensions of image files: such URLs are not pages to visit
    const IMAGE_URL_PATTERN = /\.(jpe?g|gif|png|bmp|webp|svg|avif|ico)$/i;

    const KIND_LABELS = { text: "Text", link: "Link", image: "Image" };

    // Rows drawn in the results grid (exports always contain every row)
    const PREVIEW_LIMIT = 1000;

    // chrome.storage.local key of the saved field sets, by hostname
    const FIELD_SETS_KEY = "pageDetailsFieldSets";

    // Target tab, as given by background.js in the window URL
    const targetTabId = parseInt(new URLSearchParams(window.location.search).get("tabid"), 10);

    // In-memory state of the panel; nothing here is persisted except saved field sets
    const state = {
        source: "list",
        sourceTables: { list: null, csv: null, paste: null },
        columnIndex: -1,
        urls: [],
        sampleUrls: [],
        sampleIndex: 0,
        fields: [],
        nextFieldId: 1,
        picking: false,
        pickToken: 0,
        results: [],
        nextIndex: 0,
        running: false,
        runToken: 0,
        resolveStop: null,
        grid: null
    };

    const $id = id => document.getElementById(id);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    }

    // --- Tabs ---

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
        if (state.source === "list" && !state.running) loadListSource();
        renderResultsGrid();
    }

    // --- URL sources ---

    /**
     * Tells whether a value is a page address worth visiting: starts with http and is not an image.
     * @param {*} value - Cell value.
     * @returns {boolean} True for a usable URL.
     */
    function isUsableUrl(value) {
        if (typeof value !== "string") return false;
        const url = value.trim();
        if (!/^https?:\/\//i.test(url)) return false;
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
     * Returns, for each column, the share of non-empty values that are usable URLs.
     * @param {{fields: string[], rows: Array<Array<*>>}} table - Source table.
     * @returns {number[]} Ratios between 0 and 1.
     */
    function getUrlRatios(table) {
        return table.fields.map((_, col) => {
            let filled = 0;
            let usable = 0;
            table.rows.forEach(row => {
                const value = row[col];
                if (value == null || String(value).trim() === "") return;
                filled++;
                if (isUsableUrl(String(value))) usable++;
            });
            return filled ? usable / filled : 0;
        });
    }

    /**
     * Reads the list tab results as a URL source.
     */
    function loadListSource() {
        let listTable = null;
        try {
            listTable = window.OpenScraper && window.OpenScraper.getListResults();
        } catch (error) {
            console.error("Unable to read the list results:", error);
        }
        state.sourceTables.list = listTable && listTable.fields.length ? {
            fields: uniqueColumnNames(listTable.fields),
            rows: listTable.data.map(row => row.map(cell => (Array.isArray(cell) ? cell.join(", ") : cell)))
        } : null;
        applySource();
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
     * Selects the source type (list results, CSV file or pasted URLs).
     * @param {"list"|"csv"|"paste"} source - Source type.
     */
    function setSource(source) {
        state.source = source;
        state.columnIndex = -1;
        document.querySelectorAll(".osd-seg[data-source]").forEach(button => {
            const active = button.dataset.source === source;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", String(active));
        });
        $id("detailsSourceListPane").hidden = source !== "list";
        $id("detailsSourceCsvPane").hidden = source !== "csv";
        $id("detailsSourcePastePane").hidden = source !== "paste";
        if (source === "list") {
            loadListSource();
        } else {
            applySource();
        }
    }

    /**
     * Fills the column drop-down for the current source and preselects the best URL column.
     * @param {string} [problem] - Message to show instead of the usual hints.
     */
    function applySource(problem) {
        const table = state.sourceTables[state.source];
        const select = $id("detailsUrlColumn");
        select.innerHTML = "";

        if (!table) {
            $id("detailsColumnRow").hidden = true;
            const hint = {
                list: 'No list results yet: extract a list in the "Extract list" tab first, or use another source.',
                csv: "",
                paste: ""
            }[state.source];
            showMessage("detailsUrlMessage", problem || hint, problem ? "error" : "warning");
            setUrls([]);
            return;
        }

        const ratios = getUrlRatios(table);
        let best = -1;
        ratios.forEach((ratio, index) => {
            if (ratio > 0.5 && (best === -1 || ratio > ratios[best])) best = index;
        });

        table.fields.forEach((name, index) => {
            const option = document.createElement("option");
            option.value = String(index);
            option.textContent = ratios[index] > 0.5 ? name : name + " (no URLs)";
            select.appendChild(option);
        });
        $id("detailsColumnRow").hidden = false;

        const keep = state.columnIndex >= 0 && state.columnIndex < table.fields.length &&
            ratios[state.columnIndex] > 0.5 ? state.columnIndex : best;
        select.value = String(keep >= 0 ? keep : 0);
        applyColumn(best === -1 ? "No column of this source contains URLs." : "");
    }

    /**
     * Uses the column chosen in the drop-down as the list of URLs to visit.
     * @param {string} [problem] - Message to show.
     */
    function applyColumn(problem) {
        const table = state.sourceTables[state.source];
        if (!table) return;
        const index = parseInt($id("detailsUrlColumn").value, 10);
        state.columnIndex = index;
        const name = table.fields[index] || "";
        let warning = problem || "";
        if (!warning && isUsableUrl(name)) {
            warning = "The column name looks like a URL: the first row of the file may not be a header row.";
        }
        showMessage("detailsUrlMessage", warning, problem ? "error" : "warning");
        setUrls(table.rows.map(row => (row[index] == null ? "" : String(row[index]))), name);
    }

    /**
     * Sets the URLs to visit. Results are cleared when the list actually changes.
     * @param {string[]} urls - Values of the URL column, empty ones included.
     * @param {string} [columnName] - Name of the URL column, reused as the first result column.
     */
    function setUrls(urls, columnName) {
        const changed = JSON.stringify(urls) !== JSON.stringify(state.urls);
        state.urls = urls;
        state.urlColumnName = columnName || "URL";
        state.sampleUrls = urls.map(url => url.trim()).filter(isUsableUrl);
        if (changed) {
            state.sampleIndex = 0;
            resetResults();
            chooseInitialSample();
        }
        const usable = state.sampleUrls.length;
        $id("detailsUrlCount").textContent = usable + (usable === 1 ? " URL" : " URLs") +
            (urls.length !== usable ? " (" + (urls.length - usable) + (urls.length - usable === 1 ? " other value)" : " other values)") : "");
        updateSampleUi();
        updateRunUi();
    }

    // --- Sample page ---

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
     * Starts on the URL currently shown in the target tab when it belongs to the list.
     */
    async function chooseInitialSample() {
        const tab = await getTargetTab();
        const index = tab ? state.sampleUrls.indexOf(tab.url) : -1;
        state.sampleIndex = index >= 0 ? index : 0;
        updateSampleUi();
    }

    /**
     * Shows the sample URL (the current page when no URL list is set).
     */
    async function updateSampleUi() {
        const hasList = state.sampleUrls.length > 0;
        $id("detailsSamplePrev").disabled = !hasList || state.sampleUrls.length < 2 || isBusy();
        $id("detailsSampleNext").disabled = !hasList || state.sampleUrls.length < 2 || isBusy();
        if (hasList) {
            $id("detailsSampleUrl").value = state.sampleUrls[state.sampleIndex] || "";
        } else {
            const tab = await getTargetTab();
            $id("detailsSampleUrl").value = tab ? tab.url : "";
        }
        refreshSavedBar();
    }

    /**
     * Moves to the previous or next sample URL (looping) and opens it in the target tab.
     * @param {number} step - -1 or +1.
     */
    function moveSample(step) {
        const count = state.sampleUrls.length;
        if (!count) return;
        state.sampleIndex = (state.sampleIndex + step + count) % count;
        updateSampleUi();
        navigateTab(state.sampleUrls[state.sampleIndex], LOAD_TIMEOUT_MS);
    }

    // --- Target tab ---

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
            if (Date.now() + RETRY_INTERVAL_MS > deadline || (isCancelled && isCancelled())) return undefined;
            await sleep(RETRY_INTERVAL_MS);
        }
    }

    /**
     * Opens a URL in the target tab and waits until it has finished loading.
     * @param {string} url - Address to open.
     * @param {number} timeoutMs - Longest wait.
     * @returns {Promise<boolean>} True when loaded, false on time-out or failure.
     */
    function navigateTab(url, timeoutMs) {
        return new Promise(resolve => {
            let sawLoading = false;
            let done = false;
            const finish = loaded => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                chromeInstance.tabs.onUpdated.removeListener(onUpdated);
                resolve(loaded);
            };
            const onUpdated = (tabId, changeInfo) => {
                if (tabId !== targetTabId) return;
                if (changeInfo.status === "loading") sawLoading = true;
                if (changeInfo.status === "complete" && sawLoading) finish(true);
            };
            const timer = setTimeout(() => finish(false), timeoutMs);
            chromeInstance.tabs.onUpdated.addListener(onUpdated);
            Promise.resolve(chromeInstance.tabs.update(targetTabId, { url: url })).catch(() => finish(false));
        });
    }

    /**
     * Brings the target tab and its window to the front.
     */
    async function focusTargetTab() {
        const tab = await getTargetTab();
        if (!tab) return;
        try {
            await chromeInstance.tabs.update(targetTabId, { active: true });
            await chromeInstance.windows.update(tab.windowId, { focused: true });
        } catch (error) {
            console.warn("Unable to focus the target tab:", error);
        }
    }

    // --- Fields ---

    /**
     * Returns a field name not used yet ("price", "price (2)"...).
     * @param {string} name - Wanted name.
     * @returns {string} Unique name.
     */
    function uniqueFieldName(name) {
        const base = (name || "").trim() || "field";
        const used = new Set(state.fields.map(field => field.name));
        let candidate = base;
        for (let n = 2; used.has(candidate); n++) candidate = base + " (" + n + ")";
        return candidate;
    }

    /**
     * Adds picked fields to the list.
     * @param {Array<{name: string, kind: string, selectors: string[], sample: string}>} picks - New fields.
     */
    function addFields(picks) {
        picks.forEach(pick => {
            if (!pick || !Array.isArray(pick.selectors) || !pick.selectors.length) return;
            state.fields.push({
                id: state.nextFieldId++,
                name: uniqueFieldName(pick.name),
                kind: KIND_LABELS[pick.kind] ? pick.kind : "text",
                selectors: pick.selectors.slice(0, 3).map(String),
                sample: String(pick.sample || "")
            });
        });
        renderFieldList();
        onFieldsChanged();
    }

    /**
     * Removes a field.
     * @param {number} fieldId - Field id.
     */
    function removeField(fieldId) {
        state.fields = state.fields.filter(field => field.id !== fieldId);
        renderFieldList();
        onFieldsChanged();
    }

    /**
     * Draws the field list: kind, editable name, sample value and remove button.
     */
    function renderFieldList() {
        const list = $id("detailsFieldList");
        list.innerHTML = "";
        state.fields.forEach(field => {
            const item = document.createElement("li");
            item.className = "osd-field";
            item.dataset.fieldId = String(field.id);

            const kind = document.createElement("span");
            kind.className = "osd-kind osd-kind-" + field.kind;
            kind.textContent = KIND_LABELS[field.kind];

            const name = document.createElement("input");
            name.type = "text";
            name.className = "osd-input osd-field-name";
            name.value = field.name;
            name.setAttribute("aria-label", "Column name");
            name.disabled = isBusy();
            name.addEventListener("input", () => {
                field.name = name.value;
                onFieldsChanged(true);
            });

            const sample = document.createElement("span");
            sample.className = "osd-field-sample";
            sample.textContent = field.sample || "(saved field)";
            sample.title = field.sample + "\n\n" + field.selectors.join("\n");

            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "osd-btn osd-btn-icon osd-field-remove";
            remove.setAttribute("aria-label", "Remove field " + field.name);
            remove.title = "Remove field";
            remove.textContent = "×";
            remove.disabled = isBusy();
            remove.addEventListener("click", () => removeField(field.id));

            item.append(kind, name, sample, remove);
            list.appendChild(item);
        });
        $id("detailsNoFields").hidden = state.fields.length > 0;
    }

    /**
     * Reacts to a change of the field list or of a field name.
     * @param {boolean} [nameOnly=false] - Only a name changed.
     */
    function onFieldsChanged(nameOnly) {
        if (!nameOnly) updateRunUi();
        $id("detailsSaveFields").disabled = isBusy() || !state.fields.length;
        onResultsChanged();
    }

    // --- Picking ---

    /**
     * Tells whether picking or a run is in progress.
     * @returns {boolean} True when busy.
     */
    function isBusy() {
        return state.picking || state.running;
    }

    /**
     * Opens the sample page if needed, then turns on the picker in the target tab.
     */
    async function startPicking() {
        if (isBusy()) return;
        if (isListCrawlRunning()) {
            showMessage("detailsPickMessage", 'Stop the crawl of the "Extract list" tab first.', "warning");
            return;
        }
        const token = ++state.pickToken;
        state.picking = true;
        updateBusyUi();
        showMessage("detailsPickMessage", "Opening the sample page...");

        const tab = await getTargetTab();
        if (!tab) {
            endPicking("The target tab was closed. Close this window and click the extension icon again.", "error");
            return;
        }
        const sampleUrl = state.sampleUrls[state.sampleIndex];
        if (sampleUrl && tab.url !== sampleUrl) {
            await navigateTab(sampleUrl, LOAD_TIMEOUT_MS);
        }
        if (token !== state.pickToken) return;

        const started = await sendToTabWithRetry({ action: "detailsPickerStart" }, ANSWER_TIMEOUT_MS);
        if (token !== state.pickToken) return;
        if (!started || !started.ok) {
            endPicking("The page does not answer. Reload it, or open a regular web page, then try again.", "error");
            return;
        }
        await focusTargetTab();
        showMessage("detailsPickMessage", 'Click the data to extract in the page, then click "Finish picking".');
        pollPicks(token, 0);
    }

    /**
     * Waits for new picks from the page and adds them, until picking ends.
     * @param {number} token - Picking session.
     * @param {number} known - Number of picks already received.
     */
    async function pollPicks(token, known) {
        while (token === state.pickToken && state.picking) {
            const response = await sendToTab({ action: "detailsPickerPoll", known: known });
            if (token !== state.pickToken) return;
            if (!response || !Array.isArray(response.picks)) {
                endPicking("Picking ended because the page changed or was closed.", "warning");
                return;
            }
            if (response.picks.length > known) {
                addFields(response.picks.slice(known));
                known = response.picks.length;
            }
            if (!response.active) {
                endPicking("");
                return;
            }
        }
    }

    /**
     * Asks the page to end picking.
     */
    async function finishPicking() {
        const response = await sendToTab({ action: "detailsPickerStop" });
        if (!response) endPicking("");
    }

    /**
     * Leaves picking mode in the panel.
     * @param {string} message - Message to show ("" for none).
     * @param {"info"|"warning"|"error"} [level] - Message level.
     */
    function endPicking(message, level) {
        state.pickToken++;
        state.picking = false;
        showMessage("detailsPickMessage", message, level);
        updateBusyUi();
    }

    // --- Run ---

    /**
     * Reads the wait bounds, in seconds.
     * @returns {{min: number, max: number}} Bounds.
     */
    function getDelays() {
        const min = Math.max(0, parseInt($id("detailsMinDelay").value, 10) || 0);
        const max = Math.max(min, parseInt($id("detailsMaxDelay").value, 10) || 0);
        return { min: min, max: max };
    }

    /**
     * Keeps min <= max: raising min raises max, lowering max lowers min.
     * @param {"min"|"max"} changed - Input the user changed.
     */
    function linkDelays(changed) {
        const minInput = $id("detailsMinDelay");
        const maxInput = $id("detailsMaxDelay");
        const min = Math.max(0, parseInt(minInput.value, 10) || 0);
        const max = Math.max(0, parseInt(maxInput.value, 10) || 0);
        if (min > max) {
            if (changed === "min") maxInput.value = String(min);
            else minInput.value = String(max);
        }
    }

    /**
     * Clears the results and goes back to the first URL.
     */
    function resetResults() {
        state.results = [];
        state.nextIndex = 0;
        onResultsChanged();
        updateProgress();
    }

    /**
     * Visits the URLs one at a time in the target tab, from the next URL to visit.
     */
    async function startRun() {
        if (isBusy()) return;
        if (isListCrawlRunning()) {
            showMessage("detailsRunMessage", 'Stop the crawl of the "Extract list" tab first.', "warning");
            return;
        }
        if (!state.sampleUrls.length || !state.fields.length) return;
        if (state.nextIndex >= state.urls.length) resetResults();

        const token = ++state.runToken;
        const stopped = new Promise(resolve => { state.resolveStop = resolve; });
        state.running = true;
        showMessage("detailsRunMessage", "");
        updateBusyUi();

        const fields = state.fields.map(field => ({ id: field.id, kind: field.kind, selectors: field.selectors }));
        const isCancelled = () => token !== state.runToken;

        while (state.nextIndex < state.urls.length && !isCancelled()) {
            const index = state.nextIndex;
            const url = state.urls[index].trim();
            updateProgress(index, url);

            const values = {};
            if (isUsableUrl(url)) {
                if (!(await getTargetTab())) {
                    finishRun(token, "The target tab was closed. Close this window and click the extension icon again.", "error");
                    return;
                }
                const delays = getDelays();
                const waitMs = 1000 * (delays.min + Math.random() * (delays.max - delays.min));
                const [loaded] = await Promise.race([
                    Promise.all([navigateTab(url, LOAD_TIMEOUT_MS), sleep(waitMs)]),
                    stopped.then(() => [false])
                ]);
                if (isCancelled()) return;
                if (loaded) {
                    const response = await sendToTabWithRetry(
                        { action: "detailsExtract", fields: fields },
                        ANSWER_TIMEOUT_MS,
                        isCancelled
                    );
                    if (isCancelled()) return;
                    if (response && response.ok && Array.isArray(response.values)) {
                        fields.forEach((field, i) => { values[field.id] = response.values[i] == null ? "" : String(response.values[i]); });
                    }
                }
            }

            state.results.push({ url: state.urls[index], values: values });
            state.nextIndex = index + 1;
            onResultsChanged();
            updateProgress();
        }
        finishRun(token, "");
    }

    /**
     * Stops the run at once. The page being visited is dropped and visited again on resume.
     */
    function stopRun() {
        if (!state.running) return;
        const resolveStop = state.resolveStop;
        state.runToken++;
        finishRun(state.runToken, "Stopped. Click Resume to continue from the next page.", "info");
        if (resolveStop) resolveStop();
    }

    /**
     * Leaves the running state.
     * @param {number} token - Run that ends.
     * @param {string} message - Message to show.
     * @param {"info"|"warning"|"error"} [level] - Message level.
     */
    function finishRun(token, message, level) {
        if (token !== state.runToken) return;
        state.running = false;
        state.resolveStop = null;
        showMessage("detailsRunMessage", message, level);
        updateBusyUi();
        updateProgress();
    }

    /**
     * Shows the progress: done / total and the page being visited.
     * @param {number} [currentIndex] - Index of the page being visited.
     * @param {string} [currentUrl] - Page being visited.
     */
    function updateProgress(currentIndex, currentUrl) {
        const total = state.urls.length;
        const done = state.nextIndex;
        $id("detailsProgress").hidden = !total || (!state.running && !done);
        $id("detailsProgressBar").style.width = total ? Math.round(100 * done / total) + "%" : "0";
        if (state.running && currentUrl !== undefined) {
            $id("detailsProgressText").textContent = "Page " + (currentIndex + 1) + " / " + total;
            $id("detailsProgressUrl").textContent = currentUrl;
        } else {
            $id("detailsProgressText").textContent = done + " / " + total + " pages done";
            $id("detailsProgressUrl").textContent = "";
        }
    }

    /**
     * Updates the Start / Resume / Restart button.
     */
    function updateRunUi() {
        const start = $id("detailsStart");
        const done = state.nextIndex;
        start.textContent = done === 0 ? "Start" : (done < state.urls.length ? "Resume" : "Restart");
        start.disabled = isBusy() || !state.sampleUrls.length || !state.fields.length;
        start.hidden = state.running;
        $id("detailsStop").hidden = !state.running;
    }

    /**
     * Enables or disables the controls while picking or running.
     */
    function updateBusyUi() {
        const busy = isBusy();
        $id("tabList").disabled = state.running;
        $id("tabDetails").disabled = state.running;
        document.querySelectorAll(".osd-seg[data-source]").forEach(button => { button.disabled = busy; });
        ["detailsCsvFile", "detailsPasteUrls", "detailsUrlColumn", "detailsMinDelay", "detailsMaxDelay"].forEach(id => {
            $id(id).disabled = state.running;
        });
        $id("detailsPickStart").hidden = state.picking;
        $id("detailsPickStart").disabled = busy;
        $id("detailsPickStop").hidden = !state.picking;
        document.querySelectorAll("#detailsFieldList input, #detailsFieldList button").forEach(el => { el.disabled = busy; });
        $id("detailsSaveFields").disabled = busy || !state.fields.length;
        $id("detailsUseSaved").disabled = busy;
        $id("detailsDeleteSaved").disabled = busy;
        updateSampleUi();
        updateRunUi();
    }

    // --- Results ---

    /**
     * Builds the results table: the URL first, then one column per field, in field order.
     * Fields added after some pages were visited are empty for those pages.
     * @returns {{fields: string[], data: string[][]}} Table ready for the grid and the exports.
     */
    function buildResultsTable() {
        return {
            fields: [state.urlColumnName || "URL"].concat(state.fields.map(field => field.name)),
            data: state.results.map(result => [result.url].concat(
                state.fields.map(field => (field.id in result.values ? result.values[field.id] : ""))
            ))
        };
    }

    /**
     * Reacts to new results or to a change of the fields shown.
     */
    function onResultsChanged() {
        updateRunUi();
        const count = state.results.length;
        $id("detailsResultCount").textContent = count ? count + (count === 1 ? " row" : " rows") : "";
        ["detailsCsv", "detailsXlsx", "detailsCopy"].forEach(id => { $id(id).disabled = !count; });
        if (!count) showMessage("detailsExportMessage", "");
        renderResultsGrid();
    }

    /**
     * Draws the read-only results grid (only while the panel is shown, so that it gets a real size).
     */
    function renderResultsGrid() {
        const container = $id("detailsHot");
        const hasRows = state.results.length > 0;
        $id("detailsNoResults").hidden = hasRows;
        container.hidden = !hasRows;

        if (state.grid && (!hasRows || document.body.classList.contains(DETAILS_MODE_CLASS))) {
            state.grid.destroy();
            state.grid = null;
            container.innerHTML = "";
        }
        if (!hasRows || !document.body.classList.contains(DETAILS_MODE_CLASS)) return;

        const table = buildResultsTable();
        const rows = table.data.slice(0, PREVIEW_LIMIT);
        const panelHeight = $id("detailsPanel").clientHeight;
        state.grid = new Handsontable(container, {
            data: rows,
            colHeaders: table.fields,
            rowHeaders: true,
            readOnly: true,
            wordWrap: false,
            manualColumnResize: true,
            width: container.clientWidth,
            height: Math.min(Math.max(180, panelHeight - 90), 34 + 25 * rows.length),
            modifyColWidth: function(width) {
                if (width > 240) return 240;
            }
        });
    }

    /**
     * Returns the export file name without extension: "<site>-details-<date>".
     * @returns {string} File name base.
     */
    function getExportFileBase() {
        let site = "page";
        try {
            const parts = new URL(state.sampleUrls[0] || $id("detailsSampleUrl").value).hostname.split(".");
            site = parts[0].indexOf("www") > -1 && parts[1] ? parts[1] : parts[0];
        } catch (error) {
            site = "page";
        }
        return site + "-details-" + new Date().toISOString().slice(0, 10);
    }

    /**
     * Runs one of the shared export helpers of popup.js on the results.
     * @param {"csv"|"xlsx"|"copy"} format - Export format.
     */
    function exportResults(format) {
        const helpers = window.OpenScraper;
        if (!helpers || !state.results.length) return;
        const table = buildResultsTable();
        if (format === "csv") {
            helpers.exportCsv(table, getExportFileBase() + ".csv");
        } else if (format === "xlsx") {
            helpers.exportXlsx(table, getExportFileBase() + ".xlsx", "Page details");
        } else {
            helpers.copyTsv(table);
            showMessage("detailsExportMessage", "Copied " + table.data.length + (table.data.length === 1 ? " row" : " rows") + " to the clipboard.");
        }
    }

    // --- Saved field sets ---

    /**
     * Returns the hostname (without www.) of the sample page.
     * @returns {string} Hostname, or "".
     */
    function getSampleHost() {
        try {
            return new URL($id("detailsSampleUrl").value).hostname.replace(/^www\./, "");
        } catch (error) {
            return "";
        }
    }

    /**
     * Reads the saved field sets.
     * @returns {Promise<Object>} Field sets by hostname.
     */
    async function readFieldSets() {
        try {
            const stored = await chromeInstance.storage.local.get(FIELD_SETS_KEY);
            const sets = stored && stored[FIELD_SETS_KEY];
            return sets && typeof sets === "object" ? sets : {};
        } catch (error) {
            return {};
        }
    }

    /**
     * Returns the valid fields of a saved set.
     * @param {Object} set - Saved set.
     * @returns {Array<{name: string, kind: string, selectors: string[]}>} Fields.
     */
    function getSavedFields(set) {
        if (!set || !Array.isArray(set.fields)) return [];
        return set.fields.filter(field => field && KIND_LABELS[field.kind] &&
            Array.isArray(field.selectors) && field.selectors.length &&
            field.selectors.every(selector => typeof selector === "string"));
    }

    /**
     * Shows the saved field set of the sample page's site, if any, with Use and Delete.
     */
    async function refreshSavedBar() {
        const host = getSampleHost();
        const fields = host ? getSavedFields((await readFieldSets())[host]) : [];
        $id("detailsSavedBar").hidden = !fields.length;
        if (fields.length) {
            $id("detailsSavedText").textContent = "Saved fields for " + host + ": " +
                fields.map(field => field.name).join(", ");
            $id("detailsSavedText").title = $id("detailsSavedText").textContent;
        }
    }

    /**
     * Saves the current fields for the sample page's site (replaces the previous set).
     */
    async function saveFieldSet() {
        const host = getSampleHost();
        if (!host || !state.fields.length) return;
        const sets = await readFieldSets();
        sets[host] = {
            fields: state.fields.map(field => ({ name: field.name, kind: field.kind, selectors: field.selectors.slice() })),
            savedAt: new Date().toISOString()
        };
        try {
            await chromeInstance.storage.local.set({ [FIELD_SETS_KEY]: sets });
            showMessage("detailsPickMessage", "Fields saved for " + host + ".");
        } catch (error) {
            showMessage("detailsPickMessage", "Unable to save the fields: " + (error && error.message || error), "error");
        }
        refreshSavedBar();
    }

    /**
     * Replaces the current fields with the saved set of the sample page's site.
     */
    async function useSavedFieldSet() {
        if (isBusy()) return;
        const host = getSampleHost();
        const fields = getSavedFields((await readFieldSets())[host]);
        if (!fields.length) return;
        state.fields = [];
        resetResults();
        addFields(fields.map(field => ({ name: field.name, kind: field.kind, selectors: field.selectors, sample: "" })));
        showMessage("detailsPickMessage", "Saved fields of " + host + " loaded.");
    }

    /**
     * Deletes the saved field set of the sample page's site.
     */
    async function deleteSavedFieldSet() {
        const host = getSampleHost();
        const sets = await readFieldSets();
        if (!host || !(host in sets)) return;
        delete sets[host];
        try {
            await chromeInstance.storage.local.set({ [FIELD_SETS_KEY]: sets });
        } catch (error) {
            console.error("Unable to delete the saved fields:", error);
        }
        refreshSavedBar();
    }

    // --- Wiring ---

    $id("tabList").addEventListener("click", () => setMode("list"));
    $id("tabDetails").addEventListener("click", () => setMode("details"));

    document.querySelectorAll(".osd-seg[data-source]").forEach(button => {
        button.addEventListener("click", () => setSource(button.dataset.source));
    });
    $id("detailsCsvFile").addEventListener("change", event => loadCsvSource(event.target.files[0]));
    $id("detailsPasteUrls").addEventListener("input", loadPasteSource);
    $id("detailsUrlColumn").addEventListener("change", () => applyColumn(""));

    $id("detailsSamplePrev").addEventListener("click", () => moveSample(-1));
    $id("detailsSampleNext").addEventListener("click", () => moveSample(1));
    $id("detailsPickStart").addEventListener("click", startPicking);
    $id("detailsPickStop").addEventListener("click", finishPicking);

    $id("detailsMinDelay").addEventListener("change", () => linkDelays("min"));
    $id("detailsMaxDelay").addEventListener("change", () => linkDelays("max"));
    $id("detailsStart").addEventListener("click", startRun);
    $id("detailsStop").addEventListener("click", stopRun);

    $id("detailsSaveFields").addEventListener("click", saveFieldSet);
    $id("detailsUseSaved").addEventListener("click", useSavedFieldSet);
    $id("detailsDeleteSaved").addEventListener("click", deleteSavedFieldSet);
    chromeInstance.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[FIELD_SETS_KEY]) refreshSavedBar();
    });

    $id("detailsCsv").addEventListener("click", () => exportResults("csv"));
    $id("detailsXlsx").addEventListener("click", () => exportResults("xlsx"));
    $id("detailsCopy").addEventListener("click", () => exportResults("copy"));

    // When no URL list is set, the sample page follows the target tab
    chromeInstance.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (tabId === targetTabId && changeInfo.url && !state.sampleUrls.length) updateSampleUi();
    });

    window.addEventListener("resize", () => {
        if (document.body.classList.contains(DETAILS_MODE_CLASS)) renderResultsGrid();
    });

    // The window holds the results in memory only: confirm before closing it during a run
    window.addEventListener("beforeunload", event => {
        if (state.running) {
            event.preventDefault();
            event.returnValue = "";
        }
    });

    renderFieldList();
    updateBusyUi();
    onResultsChanged();
    setSource("list");
})();
