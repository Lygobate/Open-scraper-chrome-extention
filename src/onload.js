(() => {
    /**
     * Escapes special CSS selector characters in a string and prepends an optional separator.
     * Used to build safe CSS class selectors from raw text.
     *
     * @param {string} rawText - The raw text to escape.
     * @param {string} [separator="."] - Prefix separator (e.g. "." for class, "#" for ID).
     * @returns {string} The escaped and prefixed CSS selector fragment.
     */
    function escapeCssSelectorPart(rawText, separator) {
        return (separator || ".") + rawText.replace(/[!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~]/g, "\\$&").trim();
    }

    /**
     * Returns the list of non-empty CSS classes of a jQuery element.
     *
     * @param {jQuery} $element - The jQuery element.
     * @returns {string[]} Array of class names.
     */
    function getElementClasses($element) {
        return ($element.attr("class") || "").trim().split(/\s+/).filter(function(cls) {
            return cls.length > 0;
        });
    }

    /**
     * Analyzes the children of a DOM element to find those sharing a common set of CSS classes.
     * This is used to detect repeating row-like elements that form a table structure.
     *
     * @param {Element} containerElement - The parent DOM element to inspect.
     * @param {boolean} [ignoreOwnClasses=false] - Leave out the classes this extension adds
     *   (row highlights), so that rows read before and rows added since count as alike.
     * @returns {{ children: jQuery, goodClasses: string[] }}
     *   An object containing:
     *   - `children`: jQuery collection of the best-matching child elements.
     *   - `goodClasses`: Array of the dominant class combinations found.
     */
    function findRepeatingChildren(containerElement, ignoreOwnClasses) {
        var $children = $(containerElement).children();
        var classComboCounts = {};
        var individualClassCounts = {};

        $children.each(function() {
            if (!["script", "img", "meta", "style"].includes(this.nodeName.toLowerCase()) && $(this).text().trim().length) {
                var sortedClasses = getElementClasses($(this)).filter(function(cls) {
                    return !ignoreOwnClasses || !isOwnClass(cls);
                }).sort();
                var comboKey = sortedClasses.join(" ");
                comboKey in classComboCounts || (classComboCounts[comboKey] = 0);
                classComboCounts[comboKey]++;
                sortedClasses.forEach(function(cls) {
                    cls in individualClassCounts || (individualClassCounts[cls] = 0);
                    individualClassCounts[cls]++;
                });
            }
        });

        // Dominant class combinations: those present in at least half the children (with some tolerance)
        var dominantCombos = Object.keys(classComboCounts).filter(function(combo) {
            return classComboCounts[combo] >= $children.length / 2 - 2;
        });

        // Fallback: try individual classes if no combo qualifies
        if (!dominantCombos.length) {
            dominantCombos = Object.keys(individualClassCounts).filter(function(cls) {
                return individualClassCounts[cls] >= $children.length / 2 - 2;
            });
        }

        $($children.length);

        // If no dominant classes found, return all valid children (non-empty, non-script/img/etc.)
        if (!dominantCombos.length || (dominantCombos.length === 1 && dominantCombos[0] === "")) {
            return {
                children: $children.filter(function() {
                    return this.nodeName
                        ? !["script", "img", "meta", "style"].includes(this.nodeName.toLowerCase()) && !!$(this).text().trim().length
                        : (console.log("???", this), false);
                }),
                goodClasses: []
            };
        }

        // Filter children: keep only those matching at least one dominant class combo
        return {
            children: $children.filter(function() {
                var matches = false;
                var $this = $(this);
                dominantCombos.forEach(function(combo) {
                    matches |= hasAllClasses($this, combo, ignoreOwnClasses);
                });
                return matches;
            }),
            goodClasses: dominantCombos
        };
    }

    /**
     * Checks whether a jQuery element has all classes listed in a space-separated string.
     *
     * @param {jQuery} $el - The jQuery element to check.
     * @param {string} classCombo - Space-separated list of class names.
     * @param {boolean} [ignoreOwnClasses=false] - Leave out the classes this extension adds:
     *   an empty combo then matches elements without any class of the page.
     * @returns {boolean} True if the element has all the specified classes.
     */
    function hasAllClasses($el, classCombo, ignoreOwnClasses) {
        if (ignoreOwnClasses) {
            var pageClasses = getElementClasses($el).filter(function(cls) { return !isOwnClass(cls); });
            var wanted = classCombo.split(" ").filter(Boolean);
            return wanted.length
                ? wanted.every(function(cls) { return pageClasses.indexOf(cls) !== -1; })
                : !pageClasses.length;
        }
        var classes = classCombo.split(" ");
        for (var i = 0; i < classes.length; i++) {
            if (!$el.hasClass(classes[i])) return false;
        }
        return true;
    }

    // --- Global Scraping State ---

    /** @type {Array<Object>} List of candidate table elements detected on the page */
    var detectedTables = [];

    /** @type {number} Index of the currently selected table in detectedTables */
    var currentTableIndex = 0;

    /**
     * @type {Element|null} Last row element of the list read so far: rows added after it by
     * "Load more" are new, while a list drawn again by the page no longer holds it
     */
    var listLastRow = null;

    /**
     * Scans all elements on the page to detect candidates for data tables.
     * A candidate must have a significant area and contain at least 3 repeating child rows.
     * The top 5 candidates (by score) are kept.
     *
     * @param {*} _robots - Unused (reserved for future robots.txt support).
     */
    function findTables(_robots) {
        _robots && _robots.length;
        var bodyArea = $("body").width() * $("body").height();

        $("body *").each(function() {
            var elementArea = this.offsetWidth * this.offsetHeight;
            if (isNaN(elementArea) || elementArea < 0.02 * bodyArea) return;

            var rowInfo = findRepeatingChildren(this);
            var $rows = rowInfo.children;
            var rowCount = $rows.length;
            if (isNaN(rowCount) || rowCount < 3) return;

            var score = elementArea * rowCount * rowCount;
            detectedTables.push({
                table: this,
                goodClasses: rowInfo.goodClasses,
                area: elementArea,
                children: $rows,
                text: $rows.text(),
                score: score,
                selector: buildCssSelectorForElement(this),
                type: "selector"
            });
        });

        detectedTables = detectedTables.sort((a, b) => b.score - a.score).slice(0, 5);
        console.log("findTables:", detectedTables);
    }

    /**
     * Highlights the currently selected table and its rows, and removes the highlight
     * from the previously selected one.
     */
    function highlightSelectedTable() {
        var prevIndex = (currentTableIndex + detectedTables.length - 1) % detectedTables.length;
        $(detectedTables[prevIndex].table).removeClass("tablescraper-selected-table");
        $(detectedTables[prevIndex].children).removeClass("tablescraper-selected-row");
        $(detectedTables[currentTableIndex].table).addClass("tablescraper-selected-table");
        $(detectedTables[currentTableIndex].children).addClass("tablescraper-selected-row");
    }

    /**
     * Removes all scraper-related CSS highlighting classes from all page elements.
     */
    function clearAllHighlights() {
        $("*").removeClass("tablescraper-selected-table");
        $("*").removeClass("tablescraper-selected-row");
    }

    new Set;

    /**
     * Computes the SHA-256 hash of a string.
     *
     * @param {string} text - The input string.
     * @returns {string} The hexadecimal SHA-256 hash.
     */
    function hashText(text) {
        var hasher = sha256.create();
        hasher.update(text);
        return hasher.hex();
    }

    /**
     * Finds the first jQuery-matchable element from a CSS selector string,
     * progressively truncating leading path segments if no match is found.
     *
     * @param {string} selector - A CSS selector, potentially composed of ">" segments.
     * @returns {jQuery|null} The matched jQuery element, or null if none found.
     */
    function findElementBySelector(selector) {
        for (; selector.length;) {
            if ($(selector).length) return $(selector);
            selector = selector.split(">").slice(1).join(">");
        }
        return null;
    }

    /**
     * Checks whether the current table content (as text) has already been visited,
     * to avoid re-scraping the same page during multi-page crawling.
     * Uses localStorage to persist visit history across requests.
     *
     * @param {string} rowsText - The concatenated text content of the table rows.
     * @returns {boolean} True if the content was already seen.
     */
    function isTableAlreadyVisited(rowsText) {
        if (localStorage.getItem("visited") === null) return false;
        const hash = hashText(rowsText);
        const visitedHashes = JSON.parse(localStorage.getItem("visited"));
        return visitedHashes[visitedHashes.length - 1] === hash || visitedHashes[visitedHashes.length - 2] === hash;
    }

    /**
     * Saves the hash of the current table content to localStorage
     * to mark it as visited for duplicate detection.
     *
     * @param {string} rowsText - The concatenated text content of the table rows.
     */
    function markTableAsVisited(rowsText) {
        if (localStorage.getItem("visited") === null) {
            localStorage.setItem("visited", JSON.stringify([]));
        }
        const visited = JSON.parse(localStorage.getItem("visited"));
        visited.push(hashText(rowsText));
        localStorage.setItem("visited", JSON.stringify(visited));
    }

    // Marks this extension puts on a hovered or chosen button: kept out of the cell paths, so that
    // a row holding the button reads the same whether the button is marked or not
    var TRANSIENT_MARK_CLASSES = ["tablescraper-next-button", "tablescraper-hover"];

    /**
     * Reads the cells of rows: the text, href and src of each element, keyed by its path in the row.
     * Rows without any value are left out.
     *
     * @param {jQuery} $rows - Row elements to read.
     * @returns {Array<Object>} One object of cell values per row.
     */
    function extractRows($rows) {
        var extractedRows = [];

        $rows.each(function() {
            var cellData = {};
            var pathHistory = [];

            /**
             * Records a cell value under a given path key, handling duplicate path names
             * by appending a numeric suffix.
             *
             * @param {string} value - The cell value to record.
             * @param {string} pathKey - The base path key.
             * @param {string} [suffix] - Optional suffix (e.g. "href", "src").
             */
            function recordCellValue(value, pathKey, suffix) {
                if (value) {
                    var fullKey = pathKey + (suffix ? " " + suffix : "");
                    var displayKey = fullKey;
                    var occurrences = 0;
                    pathHistory.forEach(p => {
                        p == pathKey && occurrences++;
                    });
                    if (occurrences > 1) displayKey = fullKey + " " + occurrences;
                    cellData[displayKey] = value;
                }
            }

            /**
             * Recursively traverses a DOM node and its children,
             * extracting text, href, and src values into cellData.
             *
             * @param {jQuery} $node - Current jQuery element.
             * @param {string} parentPath - Accumulated path from the row root.
             * @param {Element} rawNode - The raw DOM node.
             */
            !function traverseAndExtractNode($node, parentPath, rawNode) {
                if (rawNode.nodeName) {
                    var nodePath = parentPath + "/" + rawNode.nodeName.toLowerCase() + getElementClasses($node)
                        .filter(cls => !TRANSIENT_MARK_CLASSES.includes(cls)).map(cls => "." + cls).join("");
                    pathHistory.push(nodePath);
                    recordCellValue(
                        fixWindows1252Controls($node.clone().children().remove().end().text().trim()),
                        nodePath
                    );
                    recordCellValue($node.prop("href"), nodePath, "href");
                    recordCellValue($node.prop("src"), nodePath, "src");
                    $node.children().each(function() {
                        traverseAndExtractNode($(this), nodePath, this);
                    });
                } else {
                    console.log("what???", rawNode);
                }
            }($(this), "", this);

            if (Object.keys(cellData).length) extractedRows.push(cellData);
        });
        return extractedRows;
    }

    /**
     * Extracts structured data from the currently selected table,
     * or from a specific table selector if provided.
     *
     * When a `targetSelector` is given, the function first checks if the table data
     * has already been collected (duplicate detection), then recursively calls itself
     * without the selector to extract the final data.
     *
     * @param {Function} sendResponse - Chrome message response callback.
     * @param {string} [targetSelector] - Optional CSS selector to target a specific table.
     */
    async function extractTableData(sendResponse, targetSelector) {
        var $rows;
        if (targetSelector) {
            var $target = findElementBySelector(targetSelector);
            if (console.log("getTableData:", targetSelector, $target), !$target) {
                return sendResponse({ error: "Table not found" }), void console.log("Table not found");
            }
            detectedTables.length || (detectedTables = [{}]);
            var rowInfo = findRepeatingChildren($target);
            $rows = rowInfo.children;

            if (isTableAlreadyVisited($rows.text())) {
                return (
                    sendResponse({
                        error: "Table not changed. If the last page was not reached, try to increase crawl delay.",
                        errorId: "finished"
                    }),
                    void console.log("Table not changed")
                );
            }

            detectedTables[currentTableIndex].table = $target;
            detectedTables[currentTableIndex].children = $rows;
            detectedTables[currentTableIndex].goodClasses = rowInfo.goodClasses;
            detectedTables[currentTableIndex].text = $rows.text();
            markTableAsVisited($rows.text());
            highlightSelectedTable();
            return void extractTableData(sendResponse);
        }

        // Extract structured cell data from each row
        $rows = detectedTables[currentTableIndex].children;
        var extractedRows = extractRows($rows);
        listLastRow = $rows.last()[0] || null;

        sendResponse({
            data: extractedRows,
            rowCount: $rows.length,
            tableId: currentTableIndex,
            tableSelector: detectedTables[currentTableIndex].selector,
            goodClasses: detectedTables[currentTableIndex].goodClasses
        });
    }

    /**
     * Builds a unique CSS selector string for a DOM element by traversing its ancestor chain.
     * Uses IDs (when numeric-free) or class names to identify each ancestor.
     * Triggers mouseleave and blur before inspecting, to avoid UI state pollution.
     *
     * @param {Element} element - The target DOM element.
     * @returns {string} A CSS selector string (e.g. "div#main>ul.list>li.item").
     */
    function buildCssSelectorForElement(element) {
        return $(element).trigger("mouseleave").trigger("blur")
            .parents().addBack().not("html").not("body").map(function() {
                var tag = this.tagName.toLowerCase();
                // Classes this extension adds (highlights) are left out: they come and go
                var pageClasses = typeof this.className === "string"
                    ? this.className.trim().split(/\s+/).filter(function(cls) { return cls && !isOwnClass(cls); }).join(" ")
                    : "";
                if (typeof this.id === "string" && this.id.trim() && !this.id.match(/\d+/g)) {
                    tag += escapeCssSelectorPart(this.id, "#");
                } else if (pageClasses) {
                    tag += escapeCssSelectorPart(pageClasses).replace(/\s+/g, ".");
                }
                return tag;
            }).get().join(">");
    }

    // Elements that act as buttons by nature
    var CLICKABLE_SELECTOR = "button, a[href], [role=button], [role=link], input[type=button], input[type=submit], summary";
    // Pointer events kept from the page while a button is being picked, so that picking clicks nothing
    var BUTTON_PICKER_EVENTS = ["click", "dblclick", "auxclick", "mousedown", "mouseup", "pointerdown", "pointerup"];

    // Button picker in progress: {kind: "next" | "loadMore", sendResponse}, or null
    var buttonPicker = null;

    /**
     * Returns the element that acts as a button for a clicked element: the closest button, link
     * or role=button element, else the outermost element of its pointer-cursor block.
     *
     * @param {Element} element - The clicked element.
     * @returns {Element} The clickable element, or the clicked element itself.
     */
    function getClickableElement(element) {
        var clickable = element.closest(CLICKABLE_SELECTOR);
        if (clickable) return clickable;
        if (getComputedStyle(element).cursor !== "pointer") return element;
        // Children inherit the cursor: the block starts at the highest ancestor that still shows it
        while (element.parentElement && element.parentElement !== document.body &&
            getComputedStyle(element.parentElement).cursor === "pointer") {
            element = element.parentElement;
        }
        return element;
    }

    /**
     * Returns the element a pick on `target` would choose for the active picker.
     *
     * @param {Element} target - Element under the pointer.
     * @returns {Element} The "Next" target as is, or the clickable element of a "Load more" pick.
     */
    function getPickedButton(target) {
        return buttonPicker && buttonPicker.kind === "loadMore" ? getClickableElement(target) : target;
    }

    /**
     * Highlights the element the selector of the hovered button would find.
     *
     * @param {MouseEvent} event - The mouseover event.
     */
    function onButtonPickerHover(event) {
        if (!buttonPicker || !(event.target instanceof Element)) return;
        $(".tablescraper-hover").removeClass("tablescraper-hover");
        $(buildCssSelectorForElement(getPickedButton(event.target))).last().addClass("tablescraper-hover");
    }

    /**
     * Keeps pointer events from the page while picking, and picks the clicked button.
     *
     * @param {MouseEvent} event - A pointer event from the user.
     */
    function onButtonPickerEvent(event) {
        if (!buttonPicker || !event.isTrusted) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type !== "click" || !(event.target instanceof Element)) return;
        var element = getPickedButton(event.target);
        var sendResponse = buttonPicker.sendResponse;
        buttonPicker.sendResponse = null;
        stopButtonPicker();
        $(".tablescraper-next-button").removeClass("tablescraper-next-button");
        var selector = buildCssSelectorForElement(element);
        $(element).addClass("tablescraper-next-button");
        console.log("Button selector:", selector);
        sendResponse({ selector: selector });
    }

    /**
     * Activates interactive button picking mode: highlights elements on hover and captures
     * the user's next click to record the selector of the chosen button. A picker already
     * active is cancelled first. The page gets none of the picking clicks.
     *
     * @param {string} kind - "next" for a "Next page" button, "loadMore" for a "Load more" button.
     * @param {Function} sendResponse - Chrome message callback to return the chosen selector.
     */
    function activateNextButtonPickingMode(kind, sendResponse) {
        stopButtonPicker();
        window.focus();
        buttonPicker = { kind: kind, sendResponse: sendResponse };
        window.addEventListener("mouseover", onButtonPickerHover, true);
        BUTTON_PICKER_EVENTS.forEach(function(type) {
            window.addEventListener(type, onButtonPickerEvent, true);
        });
    }

    /**
     * Ends button picking mode, if active. A pick still awaited is answered as cancelled.
     */
    function stopButtonPicker() {
        if (!buttonPicker) return;
        var sendResponse = buttonPicker.sendResponse;
        buttonPicker = null;
        window.removeEventListener("mouseover", onButtonPickerHover, true);
        BUTTON_PICKER_EVENTS.forEach(function(type) {
            window.removeEventListener(type, onButtonPickerEvent, true);
        });
        $(".tablescraper-hover").removeClass("tablescraper-hover");
        if (sendResponse) sendResponse({ cancelled: true });
    }

    /**
     * Clicks the "Next page" button identified by a CSS selector,
     * simulating a full sequence of mousedown, click, and mouseup events.
     *
     * @param {string} selector - CSS selector for the "Next" button element.
     * @param {Function} sendResponse - Chrome message callback.
     * @param {boolean} [markOnly=false] - If true, only marks the button visually without clicking.
     */
    function clickNextButton(selector, sendResponse, markOnly) {
        var $button = findElementBySelector(selector);
        if (!$button) {
            return sendResponse(
                markOnly
                    ? { error: "Next button not found", errorId: "error" }
                    : { error: "No more next buttons: Finished crawling. Download CSV or Excel file", errorId: "finished" }
            );
        }

        $button.last().addClass("tablescraper-next-button");

        if (markOnly) {
            return sendResponse({});
        }

        stopButtonPicker();

        setTimeout(function() {
            sendResponse({});
            (function simulateClick(targetElement) {
                var mousedown = document.createEvent("MouseEvents");
                mousedown.initMouseEvent("mousedown", true, true, window, 1, targetElement.x, targetElement.y, targetElement.x, targetElement.y, false, false, false, false, 0, null);
                var click = document.createEvent("MouseEvents");
                click.initMouseEvent("click", true, true, window, 1, targetElement.x, targetElement.y, targetElement.x, targetElement.y, false, false, false, false, 0, null);
                var mouseup = document.createEvent("MouseEvents");
                mouseup.initMouseEvent("mouseup", true, true, window, 1, targetElement.x, targetElement.y, targetElement.x, targetElement.y, false, false, false, false, 0, null);
                targetElement.dispatchEvent(mousedown);
                targetElement.dispatchEvent(click);
                targetElement.dispatchEvent(mouseup);
            })($button.last()[0]);
        }, 100);
    }

    // --- "Load more" button: click it and read the rows it adds to the list ---

    // Interval between two looks for the rows a "Load more" click adds
    var LOAD_MORE_POLL_MS = 500;
    // Longest wait for a "Load more" button the page draws again late after a load
    var LOAD_MORE_BUTTON_WAIT_MS = 2000;
    // Interval between two looks for that button
    var LOAD_MORE_BUTTON_POLL_MS = 250;

    /**
     * Waits for a while.
     *
     * @param {number} ms - Time to wait in milliseconds.
     * @returns {Promise<void>} Resolved after the wait.
     */
    function wait(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    /**
     * Tells whether an element is in the page and shown: not detached, not of zero size,
     * not hidden by display or visibility.
     *
     * @param {Element} element - The element.
     * @returns {boolean} True when the element is shown.
     */
    function isElementShown(element) {
        if (!element.isConnected) return false;
        var rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        var style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
    }

    /**
     * Tells whether a button is disabled, natively or through aria-disabled.
     *
     * @param {Element} element - The button.
     * @returns {boolean} True when disabled.
     */
    function isElementDisabled(element) {
        return element.disabled === true || element.getAttribute("aria-disabled") === "true";
    }

    /**
     * Finds the "Load more" button by its selector. Like findElementBySelector, the leading
     * parts of the selector are dropped while nothing matches, but only while what is left
     * still names a class or an id: a bare "button" would find any other button.
     * Among several matches, the last shown one is chosen.
     *
     * @param {string} selector - CSS selector of the button.
     * @returns {Element|null} The button, or null when the page no longer has it.
     */
    function findLoadMoreButton(selector) {
        for (; selector && /[.#]/.test(selector); selector = selector.split(">").slice(1).join(">")) {
            var $matches = $(selector);
            if ($matches.length) {
                var $shown = $matches.filter(function() { return isElementShown(this); });
                return ($shown.length ? $shown : $matches).last()[0];
            }
        }
        return null;
    }

    /**
     * Looks for the "Load more" button until it is shown and enabled, or the time is up.
     *
     * @param {string} selector - CSS selector of the button.
     * @param {number} timeoutMs - Longest wait in milliseconds.
     * @returns {Promise<{button: (Element|null), state: string}>} The button and its state:
     *     "ready", "disabled" or "missing" (not found or hidden).
     */
    async function waitForLoadMoreButton(selector, timeoutMs) {
        var deadline = Date.now() + timeoutMs;
        for (;;) {
            var button = findLoadMoreButton(selector);
            var state = !button || !isElementShown(button) ? "missing" : isElementDisabled(button) ? "disabled" : "ready";
            if (state === "ready" || Date.now() >= deadline) return { button: button, state: state };
            await wait(LOAD_MORE_BUTTON_POLL_MS);
        }
    }

    /**
     * Clicks an element the way a script would. Elements that are not HTML elements (SVG)
     * have no click(): they get a bubbling click event.
     *
     * @param {Element} element - The element to click.
     */
    function clickElement(element) {
        if (element instanceof HTMLElement) {
            element.click();
        } else {
            element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }
    }

    /**
     * Finds the list and its rows as they are now in the page.
     *
     * @param {string} tableSelector - CSS selector of the list.
     * @returns {{$table: jQuery, rowInfo: {children: jQuery, goodClasses: string[]}}|null}
     *     The list and its rows, or null when the list is gone.
     */
    function readListRows(tableSelector) {
        var $table = findElementBySelector(tableSelector);
        return $table ? { $table: $table, rowInfo: findRepeatingChildren($table, true) } : null;
    }

    /**
     * One round of "Load more": when the list has no rows unread yet, clicks the button
     * and waits for Min delay and, at the same time, for new rows (at most Max delay).
     * Then reads the new rows. The page keeps the rows already read, so only the rows after
     * them are read; when the page has drawn the list again, all rows are sent, flagged so
     * that the window drops those it already has.
     *
     * Answers {status: "rows", data, rowCount, appended}, or {status} with "missing" (button
     * not found or hidden), "disabled" (button disabled: all loaded) or "noRows" (the click
     * added no rows in time), or {error}.
     *
     * @param {Object} message - {selector, tableSelector, rowCount, minWait, maxWait}: button and
     *     list selectors, number of list rows read so far, delays in milliseconds.
     * @param {Function} sendResponse - Chrome message callback.
     */
    async function loadMoreRows(message, sendResponse) {
        var getRows = function() {
            var read = readListRows(message.tableSelector);
            return read ? read.rowInfo.children : $();
        };
        var hasNewRows = function($rows) {
            return $rows.length !== message.rowCount || $rows.last()[0] !== listLastRow;
        };

        if (!hasNewRows(getRows())) {
            var found = await waitForLoadMoreButton(message.selector, Math.min(message.maxWait, LOAD_MORE_BUTTON_WAIT_MS));
            if (found.state !== "ready") {
                return void sendResponse({ status: found.state });
            }
            $(".tablescraper-next-button").removeClass("tablescraper-next-button");
            $(found.button).addClass("tablescraper-next-button");
            found.button.scrollIntoView({ block: "center", behavior: "instant" });
            clickElement(found.button);

            // New rows count once their number holds for one look (pages may add them in steps)
            var waitForNewRows = async function() {
                var deadline = Date.now() + message.maxWait;
                var previousCount = -1;
                while (Date.now() < deadline) {
                    await wait(LOAD_MORE_POLL_MS);
                    var $rows = getRows();
                    if (!hasNewRows($rows)) {
                        previousCount = -1;
                    } else if ($rows.length === previousCount) {
                        return;
                    } else {
                        previousCount = $rows.length;
                    }
                }
            };
            await Promise.all([wait(message.minWait), waitForNewRows()]);
        }

        var read = readListRows(message.tableSelector);
        if (!read) {
            return void sendResponse({ error: "Table not found" });
        }
        var $rows = read.rowInfo.children;
        if (!hasNewRows($rows)) {
            return void sendResponse({ status: "noRows" });
        }
        var appended = !!listLastRow && $rows.index(listLastRow) === message.rowCount - 1;
        var $newRows = appended ? $rows.slice(message.rowCount) : $rows;

        // Highlight the rows like the other reads do: the highlight class is part of the cell paths
        detectedTables.length || (detectedTables = [{}]);
        detectedTables[currentTableIndex].table = read.$table;
        detectedTables[currentTableIndex].children = $rows;
        detectedTables[currentTableIndex].goodClasses = read.rowInfo.goodClasses;
        highlightSelectedTable();
        listLastRow = $rows.last()[0] || null;

        sendResponse({
            status: "rows",
            data: extractRows($newRows),
            rowCount: $rows.length,
            appended: appended
        });
    }

    /**
     * Marks the chosen "Next" or "Load more" button in the page, after removing any former mark.
     *
     * @param {string|null} selector - CSS selector of the button; none only removes the mark.
     * @param {string} kind - "next" or "loadMore".
     * @param {Function} sendResponse - Chrome message callback, given {error} when not found.
     */
    function markButton(selector, kind, sendResponse) {
        $(".tablescraper-next-button").removeClass("tablescraper-next-button");
        if (!selector) {
            return sendResponse({});
        }
        if (kind !== "loadMore") {
            return clickNextButton(selector, sendResponse, true);
        }
        var button = findLoadMoreButton(selector);
        if (!button) {
            return sendResponse({ error: "Load more button not found", errorId: "error" });
        }
        $(button).addClass("tablescraper-next-button");
        sendResponse({});
    }

    // --- Page details extraction: highlight layer, field picker and per-page extraction ---

    // Classes added to page elements by this extension; never used in generated selectors
    var OWN_CLASS_PREFIXES = ["tablescraper-", "openscraper-"];
    // Class names that describe a transient UI state rather than the element itself
    var STATE_CLASS_PATTERN = /^(is-|has-)|^(active|selected|hover|hovered|focus|focused|open|opened|closed|visible|hidden|current|disabled|checked|expanded|collapsed|show|showing|in)$/i;
    // Class names produced by CSS-in-JS tools, regenerated on every build
    var GENERATED_CLASS_PATTERN = /^(sc|css|jsx|emotion|svelte)-/i;
    // Attributes written for automated tests: the most stable anchors on a page
    var TEST_ATTRIBUTES = ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"];
    // Attributes that usually describe what an element is. Attributes that carry the page's
    // content (alt, title, aria-label: often the product name) are left out: on another page
    // they miss, or match another element that shows the sample's content (related items).
    var DESCRIPTIVE_ATTRIBUTES = ["itemprop", "role", "name", "placeholder", "type"];
    // A class made of a word and a small number ("note2", "col-6") names a role, not a build
    var NUMBERED_CLASS_PATTERN = /^[a-zA-Z][a-zA-Z_-]*[a-zA-Z][-_]?\d{1,2}$/;
    var MAX_FIELD_SELECTORS = 3;
    var MAX_ANCESTOR_DEPTH = 6;
    var MAX_SELECTOR_TRIES = 1000;
    var MEDIA_ELEMENTS = "img, video, audio";
    // Media inside a hovered element that are compared with its box (large containers hold many)
    var MAX_MEDIA_CANDIDATES = 24;
    // Port kept open by the scraping window while it uses the page: when the window goes away,
    // the picker, highlights and overlay it left are removed
    var DETAILS_PORT_NAME = "openscraper-details-session";
    // Identifies this document (a reload or a new page gets another one)
    var DOCUMENT_TOKEN = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    // Attribute of the element that hosts everything this extension draws in the page
    var LAYER_ATTRIBUTE = "data-openscraper-layer";
    // Space between a highlighted element and its info label, and between the label and the window edges
    var LABEL_GAP = 4;
    // Longest value kept in the info label (the label cuts it visually with an ellipsis anyway)
    var LABEL_VALUE_LENGTH = 200;
    // Boxes are placed again at this interval while shown, for pages that move on their own
    var BOX_REFRESH_MS = 500;
    // Interval between two looks for the template's fields not found yet in the page, while
    // the picker shows them to edit the template
    var EXISTING_FIELDS_CHECK_MS = 400;
    // Pixels scrolled per wheel "line" (wheels that report lines instead of pixels)
    var WHEEL_LINE_PX = 40;

    var LAYER_STYLE =
        ":host{all:initial}" +
        "*{box-sizing:border-box}" +
        ".boxes{position:absolute;left:0;top:0;width:0;height:0;z-index:2}" +
        ".box{position:absolute;pointer-events:none;border-radius:3px}" +
        ".box.hover{border:2px dashed #06b6d4;background:rgba(6,182,212,.14)}" +
        ".box.picked{border:2px solid #10b981;background:rgba(16,185,129,.24)}" +
        ".box.found{border:2px solid #f59e0b;background:rgba(245,158,11,.2)}" +
        ".dim{position:fixed;inset:0;z-index:1;background:rgba(15,23,42,.1);pointer-events:none}" +
        ".catcher{position:fixed;inset:0;z-index:3;cursor:crosshair;background:transparent;pointer-events:auto}" +
        ".label{position:fixed;left:0;top:0;z-index:4;display:grid;grid-template-columns:auto minmax(0,1fr);" +
        "gap:3px 8px;align-items:baseline;max-width:260px;padding:6px 8px;pointer-events:none;" +
        "font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;color:#f1f5f9;" +
        "background:#0f172a;border:1px solid rgba(6,182,212,.45);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.4)}" +
        ".label[hidden],.panel[hidden],.dim[hidden],.catcher[hidden],.busy[hidden]{display:none}" +
        ".tag{grid-column:1/-1;justify-self:start;max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" +
        "padding:1px 6px;font-weight:700;color:#06b6d4;background:rgba(6,182,212,.15);border-radius:4px}" +
        ".key{color:#94a3b8}" +
        ".val{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}" +
        ".panel{position:fixed;top:16px;right:16px;z-index:5;width:220px;pointer-events:auto;" +
        "font:13px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#f1f5f9;background:#0f172a;" +
        "border:1px solid rgba(6,182,212,.45);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5);overflow:hidden}" +
        ".head{display:flex;align-items:center;gap:8px;padding:8px 12px;font-weight:600;color:#06b6d4;" +
        "background:#1e293b;cursor:move;user-select:none;touch-action:none}" +
        ".grip{margin-left:auto;color:#64748b;letter-spacing:1px}" +
        ".hints{margin:0;padding:10px 12px 4px;list-style:none;color:#94a3b8;font-size:12px}" +
        ".hints li{margin:0 0 4px}" +
        "kbd{display:inline-block;min-width:18px;padding:0 4px;margin-right:4px;font:600 11px/16px system-ui,sans-serif;" +
        "text-align:center;color:#f1f5f9;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);border-radius:4px}" +
        ".finish{display:block;width:calc(100% - 24px);margin:8px 12px 12px;padding:8px 10px;font:600 13px/1.2 system-ui,sans-serif;" +
        "color:#0f172a;background:#06b6d4;border:0;border-radius:8px;cursor:pointer}" +
        ".finish:hover{background:#22d3ee}" +
        ".busy{position:fixed;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;" +
        "background:rgba(15,23,42,.35);cursor:progress;pointer-events:auto}" +
        ".busy-card{display:flex;align-items:center;gap:10px;padding:12px 18px;font:600 14px/1.3 system-ui,-apple-system,sans-serif;" +
        "color:#f1f5f9;background:#0f172a;border:1px solid rgba(6,182,212,.45);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5)}" +
        ".spin{width:14px;height:14px;border:2px solid rgba(6,182,212,.3);border-top-color:#06b6d4;border-radius:50%;" +
        "animation:spin .8s linear infinite}" +
        "@keyframes spin{to{transform:rotate(360deg)}}";

    // Everything drawn in the page lives in one shadow root, removed when nothing is shown
    var layer = null;
    // Highlight boxes shown, each {element, box, kind}
    var layerBoxes = [];
    var layerFrame = 0;
    var layerTimer = 0;
    // Active picker state (null when the picker is off), fields picked so far and pending poll callbacks
    var fieldPicker = null;
    var pickedFields = [];
    var pendingPickerPolls = [];
    // Pointer events aimed at the layer are stopped on the window in the capture phase, before the
    // page's own document and element listeners see them, then handed to the layer's handlers
    var LAYER_EVENT_TYPES = ["click", "dblclick", "auxclick", "contextmenu", "mousedown", "mouseup", "mousemove",
        "mouseover", "mouseout", "pointerdown", "pointerup", "pointermove", "pointerover", "pointerout", "pointercancel",
        "touchstart", "touchmove", "touchend"];
    var layerHandlers = new WeakMap();

    /**
     * Trims a text and collapses its inner whitespace to single spaces.
     * @param {string} text - Raw text.
     * @returns {string} Normalized text.
     */
    function normalizeWhitespace(text) {
        return (text || "").replace(/\s+/g, " ").trim();
    }

    // Named HTML entities decoded when a page shows them as text ("&amp;nbsp;" in the HTML,
    // or a string set as text by a script, displays as "&nbsp;")
    var TEXT_ENTITIES = {
        nbsp: "\u00a0", amp: "&", AMP: "&", quot: '"', QUOT: '"', apos: "'", lt: "<", LT: "<", gt: ">", GT: ">",
        ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", ndash: "\u2013", mdash: "\u2014", hellip: "\u2026",
        lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", laquo: "\u00ab", raquo: "\u00bb",
        euro: "\u20ac", copy: "\u00a9", reg: "\u00ae", trade: "\u2122"
    };
    // An entity name is read whole ("&copyright" is not "&copy"), the final semicolon is optional
    var TEXT_ENTITY_PATTERN = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));?/g;

    /**
     * Decodes the HTML entities left as text in a value (double-escaped pages), with a fixed
     * table: page text is never parsed as HTML. Repeated for "&amp;amp;nbsp;"-like chains.
     * @param {string} text - Raw text.
     * @returns {string} Decoded text.
     */
    function decodeTextEntities(text) {
        var decode = function(match, decimal, hex, name) {
            if (name) {
                if (Object.prototype.hasOwnProperty.call(TEXT_ENTITIES, name)) return TEXT_ENTITIES[name];
                // "&nbspVAT": like the HTML parser, a leading "nbsp" without semicolon still counts
                return name.indexOf("nbsp") === 0 && match.slice(-1) !== ";" ? "\u00a0" + name.slice(4) : match;
            }
            var code = decimal ? parseInt(decimal, 10) : parseInt(hex, 16);
            if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return match;
            return String.fromCodePoint(code);
        };
        var result = text || "";
        for (var pass = 0; pass < 3 && result.indexOf("&") !== -1; pass++) {
            var next = result.replace(TEXT_ENTITY_PATTERN, decode);
            if (next === result) break;
            result = next;
        }
        return result;
    }

    // Windows-1252 characters of the codes 0x80-0x9F, where Unicode has invisible control
    // characters (the HTML parser reads "&#146;" as "\u2019" with this table, not as U+0092)
    var WINDOWS_1252_C1 = {
        0x80: "\u20ac", 0x82: "\u201a", 0x83: "\u0192", 0x84: "\u201e", 0x85: "\u2026", 0x86: "\u2020",
        0x87: "\u2021", 0x88: "\u02c6", 0x89: "\u2030", 0x8a: "\u0160", 0x8b: "\u2039", 0x8c: "\u0152",
        0x8e: "\u017d", 0x91: "\u2018", 0x92: "\u2019", 0x93: "\u201c", 0x94: "\u201d", 0x95: "\u2022",
        0x96: "\u2013", 0x97: "\u2014", 0x98: "\u02dc", 0x99: "\u2122", 0x9a: "\u0161", 0x9b: "\u203a",
        0x9c: "\u0153", 0x9e: "\u017e", 0x9f: "\u0178"
    };

    /**
     * Replaces the invisible control characters U+0080-U+009F that stand for Windows-1252
     * characters (text converted with the wrong encoding, "&#146;" decoded) with those
     * characters: "J\u0092utilise" becomes "J\u2019utilise".
     * @param {string} text - Raw text.
     * @returns {string} Text without those control characters.
     */
    function fixWindows1252Controls(text) {
        return (text || "").replace(/[\u0080-\u009f]/g, function(ch) {
            return WINDOWS_1252_C1[ch.charCodeAt(0)] || ch;
        });
    }

    /**
     * Cleans a text value: entities shown as text are decoded, Windows-1252 control characters
     * fixed, non-breaking and other Unicode spaces become plain spaces, whitespace is collapsed
     * and trimmed.
     * @param {string} text - Raw text.
     * @returns {string} Clean text.
     */
    function cleanText(text) {
        return normalizeWhitespace(fixWindows1252Controls(decodeTextEntities(text)).replace(/[\u00a0\u202f\u2007\u2000-\u200a]/g, " "));
    }

    /**
     * Reads the visible text of an element: typed value for form fields, chosen label for a
     * drop-down list, rendered text otherwise. Non-HTML elements (SVG) have no text.
     * @param {Element} element - Element to read.
     * @returns {string} Clean text (see cleanText), or "".
     */
    function getElementText(element) {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            return cleanText(element.value);
        }
        if (element instanceof HTMLSelectElement) {
            var option = element.options[element.selectedIndex];
            return option ? cleanText(option.text) : "";
        }
        if (!(element instanceof HTMLElement)) return "";
        return cleanText(readRenderedText(element));
    }

    // Beyond this many text nodes, the text of an element is read with innerText (large blocks)
    var MAX_TEXT_NODES = 400;
    // Parents whose text is never shown
    var HIDDEN_TEXT_PARENTS = /^(script|style|noscript|template|title)$/;

    /**
     * Lists the rendered text pieces of an element, in document order, with their boxes.
     * @param {Element} element - Element to read.
     * @returns {Array<Object>|null} Pieces {text, first, last, size}, or null when the
     *     element has too many text nodes to be read this way.
     */
    function getTextPieces(element) {
        var styles = new Map();
        var styleOf = function(node) {
            if (!styles.has(node)) styles.set(node, getComputedStyle(node));
            return styles.get(node);
        };
        var pieces = [];
        var range = document.createRange();
        var walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        var count = 0;
        for (var node = walker.nextNode(); node; node = walker.nextNode()) {
            if (++count > MAX_TEXT_NODES) return null;
            var parent = node.parentElement;
            if (!parent || HIDDEN_TEXT_PARENTS.test(parent.localName) || !node.data) continue;
            var style = styleOf(parent);
            if (style.visibility !== "visible") continue;
            range.selectNodeContents(node);
            var rects = Array.prototype.filter.call(range.getClientRects(), function(rect) { return rect.width > 0 || rect.height > 0; });
            // Not rendered (inside display:none) or whitespace collapsed away
            if (!rects.length) continue;
            var text = node.data;
            if (style.textTransform === "uppercase") text = text.toUpperCase();
            else if (style.textTransform === "lowercase") text = text.toLowerCase();
            else if (style.textTransform === "capitalize") text = text.replace(/(^|\s)(\S)/g, function(m, space, ch) { return space + ch.toUpperCase(); });
            pieces.push({
                text: /\S/.test(text) ? text : " ",
                first: rects[0],
                last: rects[rects.length - 1],
                size: parseFloat(style.fontSize) || 16
            });
        }
        return pieces;
    }

    /**
     * Tells whether two consecutive text pieces are apart on screen: on different lines (unless
     * the second one starts right where the first ends, like a superscript), or on the same
     * line with a gap wider than a fraction of a space, or overlapping (a piece positioned
     * over the other is not part of the same word).
     * @param {Object} a - First piece.
     * @param {Object} b - Next piece.
     * @returns {boolean} True when a space separates them.
     */
    function arePiecesApart(a, b) {
        var left = a.last;
        var right = b.first;
        var tolerance = 0.2 * Math.min(a.size, b.size);
        var gap = Math.max(right.left - left.right, left.left - right.right);
        var sameLine = right.top < left.bottom && right.bottom > left.top;
        if (sameLine) return Math.abs(gap) > tolerance;
        return !(right.left >= left.right - 1 && right.left - left.right <= tolerance);
    }

    /**
     * Joins text pieces the way the page shows them: no space between pieces that touch
     * (a price split into "11", ",", "95", "€"), one space between pieces apart on screen.
     * @param {Array<Object>} pieces - Pieces (see getTextPieces).
     * @returns {string} Text.
     */
    function joinTextPieces(pieces) {
        var text = "";
        var previous = null;
        pieces.forEach(function(piece) {
            if (previous && !/\s$/.test(text) && !/^\s/.test(piece.text) && arePiecesApart(previous, piece)) text += " ";
            text += piece.text;
            previous = piece;
        });
        return text;
    }

    /**
     * Reads the text of an element as shown on screen. Inline pieces that touch are joined
     * without the line breaks innerText adds around floated, positioned or flex pieces (a
     * price split into "11", ",", "95", "€"). Large or unrendered elements are read with
     * innerText.
     * @param {HTMLElement} element - Element to read.
     * @returns {string} Raw text (not cleaned).
     */
    function readRenderedText(element) {
        var pieces = getTextPieces(element);
        if (!pieces || !pieces.some(function(piece) { return piece.text !== " "; })) return element.innerText;
        return joinTextPieces(pieces);
    }

    /**
     * Returns the link element that the element is, or is inside of.
     * @param {Element} element - Element.
     * @returns {Element|null} The a / area element with a usable href, or null.
     */
    function getLinkElement(element) {
        var anchor = element.closest("a[href], area[href]");
        if (!(anchor instanceof HTMLAnchorElement || anchor instanceof HTMLAreaElement)) return null;
        var href = (anchor.href || "").trim();
        return href && !/^javascript:/i.test(href) ? anchor : null;
    }

    /**
     * Returns the absolute address of the link the element is, or is inside of.
     * @param {Element} element - Element to read.
     * @returns {string} Absolute URL, or "" (no link, or a javascript: link).
     */
    function getElementLink(element) {
        var anchor = getLinkElement(element);
        return anchor ? anchor.href.trim() : "";
    }

    /**
     * Tells whether two boxes match (2 px tolerance).
     * @param {DOMRect} a - First box.
     * @param {DOMRect} b - Second box.
     * @returns {boolean} True if both boxes match.
     */
    function areSameRects(a, b) {
        return Math.abs(a.left - b.left) <= 2 && Math.abs(a.top - b.top) <= 2 &&
            Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;
    }

    /**
     * Returns the image, video or audio element that the element is, or that fills exactly
     * the element's box.
     * @param {Element} element - Element.
     * @returns {Element|null} Media element, or null.
     */
    function getMediaElement(element) {
        if (element.matches(MEDIA_ELEMENTS)) return element;
        var candidates = element.querySelectorAll(MEDIA_ELEMENTS);
        if (!candidates.length) return null;
        var box = element.getBoundingClientRect();
        for (var i = 0; i < candidates.length && i < MAX_MEDIA_CANDIDATES; i++) {
            if (areSameRects(candidates[i].getBoundingClientRect(), box)) return candidates[i];
        }
        return null;
    }

    /**
     * Returns the absolute source of the media element that the element is or that fills its box.
     * @param {Element} element - Element to read.
     * @returns {string} Absolute URL, or "" (no media, or an inline data: source).
     */
    function getElementImage(element) {
        var media = getMediaElement(element);
        if (!media) return "";
        var src = media.currentSrc || media.src || "";
        if (!src) {
            var source = media.querySelector("source[src]");
            src = source ? source.src : "";
        }
        src = src.trim();
        return /^data:/i.test(src) ? "" : src;
    }

    /**
     * Reads one kind of value from an element.
     * @param {Element} element - Element to read.
     * @param {"text"|"link"|"image"} kind - Kind of value.
     * @returns {string} The value, or "".
     */
    function readFieldValue(element, kind) {
        if (kind === "link") return getElementLink(element);
        if (kind === "image") return getElementImage(element);
        return getElementText(element);
    }

    /**
     * Escapes an identifier for use in a CSS selector.
     * @param {string} value - Raw identifier.
     * @returns {string} Escaped identifier.
     */
    function escapeCssIdentifier(value) {
        return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, "\\$&");
    }

    /**
     * Builds an attribute selector, exact or by prefix.
     * @param {string} name - Attribute name.
     * @param {string} value - Attribute value (or prefix).
     * @param {boolean} [isPrefix=false] - Match the beginning of the value only.
     * @returns {string} Attribute selector.
     */
    function buildAttributeSelector(name, value, isPrefix) {
        return "[" + name + (isPrefix ? "^=" : "=") + '"' + value.replace(/["\\]/g, "\\$&") + '"]';
    }

    /**
     * Tells whether a class was added by this extension.
     * @param {string} className - Class name.
     * @returns {boolean} True for extension classes.
     */
    function isOwnClass(className) {
        return OWN_CLASS_PREFIXES.some(function(prefix) { return className.indexOf(prefix) === 0; });
    }

    /**
     * Tells whether a class looks stable across pages: no digits (or a word and a small
     * number), not a state, not generated.
     * @param {string} className - Class name.
     * @returns {boolean} True for a stable class.
     */
    function isStableClass(className) {
        return className.length > 1 && className.length <= 40 && (!/\d/.test(className) || NUMBERED_CLASS_PATTERN.test(className)) &&
            /^[a-zA-Z_-][\w-]*$/.test(className) && !isOwnClass(className) &&
            !STATE_CLASS_PATTERN.test(className) && !GENERATED_CLASS_PATTERN.test(className);
    }

    /**
     * Tells whether an id looks like a word: no digits and few changes between lower case and
     * upper case inside its parts (generated ids switch often). "-" and "_" only separate parts,
     * so "corePrice_feature_div" is a word-like id.
     * @param {string} id - Element id.
     * @returns {boolean} True for a meaningful id.
     */
    function isWordLikeId(id) {
        if (!id || id.length > 40 || /\d/.test(id) || !/^[a-zA-Z_-]+$/.test(id)) return false;
        var changes = 0;
        var previous = null;
        for (var i = 0; i < id.length; i++) {
            var ch = id[i];
            if (ch === "-" || ch === "_") {
                previous = null;
                continue;
            }
            var type = ch >= "a" && ch <= "z" ? "lower" : "upper";
            if (previous && type !== previous) changes++;
            previous = type;
        }
        return changes <= 4;
    }

    /**
     * Lists the ways to designate one element at its own level, from the most meaningful
     * (rank 0) to the most fragile (rank 5).
     * @param {Element} element - Element to describe.
     * @returns {Array<{selector: string, rank: number}>} Candidate selector steps.
     */
    function getSelectorSteps(element) {
        var tag = escapeCssIdentifier(element.localName);
        var steps = [];
        var add = function(selector, rank) {
            if (!steps.some(function(step) { return step.selector === selector; })) {
                steps.push({ selector: selector, rank: rank });
            }
        };

        // Rank 0: test attributes; numeric parts are dropped by matching the prefix only
        TEST_ATTRIBUTES.forEach(function(name) {
            var value = element.getAttribute(name);
            if (!value) return;
            if (!/\d/.test(value)) {
                add(buildAttributeSelector(name, value), 0);
            } else if (value.split(/\d/)[0].length >= 3) {
                add(buildAttributeSelector(name, value.split(/\d/)[0], true), 0);
            }
        });

        // Rank 1: descriptive attributes, tab order and other data attributes without digits
        DESCRIPTIVE_ATTRIBUTES.forEach(function(name) {
            var value = element.getAttribute(name);
            if (!value || value.length > 60) return;
            if (!/\d/.test(value)) {
                add(tag + buildAttributeSelector(name, value), 1);
            } else if (value.split(/\d/)[0].trim().length >= 3) {
                add(tag + buildAttributeSelector(name, value.split(/\d/)[0], true), 1);
            }
        });
        var tabIndex = (element.getAttribute("tabindex") || "").trim();
        if (/^-?\d+$/.test(tabIndex)) add(tag + buildAttributeSelector("tabindex", tabIndex), 1);
        Array.prototype.forEach.call(element.attributes, function(attribute) {
            var name = attribute.name;
            if (name.indexOf("data-") !== 0 || TEST_ATTRIBUTES.indexOf(name) !== -1) return;
            // A value with spaces is content ("Alpha Lamp"), not a token ("price")
            if (/\d/.test(name) || !attribute.value || attribute.value.length > 40 || /[\d\s]/.test(attribute.value)) return;
            add(tag + buildAttributeSelector(name, attribute.value), 1);
        });

        // Rank 2: id that looks like a word
        if (typeof element.id === "string" && isWordLikeId(element.id)) {
            add("#" + escapeCssIdentifier(element.id), 2);
        }

        // Rank 3: stable classes, alone then by pairs; aria-hidden, which marks the visible
        // copy of a value whose full text is kept for screen readers (common, so weak alone)
        var classes = Array.prototype.filter.call(element.classList, isStableClass).slice(0, 4);
        classes.forEach(function(className) {
            add(tag + "." + escapeCssIdentifier(className), 3);
        });
        if (element.getAttribute("aria-hidden") === "true") add(tag + buildAttributeSelector("aria-hidden", "true"), 3);
        for (var i = 0; i < classes.length; i++) {
            for (var j = i + 1; j < classes.length; j++) {
                add(tag + "." + escapeCssIdentifier(classes[i]) + "." + escapeCssIdentifier(classes[j]), 3);
            }
        }

        // Rank 4: tag alone; rank 5: tag and position among siblings of the same tag
        add(tag, 4);
        add(tag + ":nth-of-type(" + getTypeIndex(element) + ")", 5);
        return steps;
    }

    /**
     * Returns the 1-based position of an element among its siblings with the same tag.
     * @param {Element} element - Element.
     * @returns {number} Position.
     */
    function getTypeIndex(element) {
        var index = 1;
        for (var sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
            if (sibling.localName === element.localName) index++;
        }
        return index;
    }

    /**
     * Tells whether a selector designates the element as its first match in the page.
     * @param {string} selector - CSS selector.
     * @param {Element} element - Expected element.
     * @returns {boolean} True if document.querySelector(selector) is the element.
     */
    function selectsFirst(selector, element) {
        try {
            return document.querySelector(selector) === element;
        } catch (e) {
            return false;
        }
    }

    /**
     * Returns the step that best identifies the element itself (a stable class first, else a
     * test attribute, a descriptive attribute or an id), prefixed by its tag; or null when the
     * element has nothing but its tag.
     * @param {Element} element - Element.
     * @returns {string|null} Step such as "p.price", or null.
     */
    function getOwnTokenStep(element) {
        var tag = escapeCssIdentifier(element.localName);
        var steps = getSelectorSteps(element).filter(function(step) { return step.rank <= 3; });
        if (!steps.length) return null;
        var best = steps.filter(function(step) { return step.rank === 3; })[0] || steps[0];
        return best.selector.indexOf(tag) === 0 ? best.selector : tag + best.selector;
    }

    /**
     * Builds the structural path of an element: tag and position at each level, from the
     * closest ancestor with a meaningful id (or from body). The last step keeps a class or
     * attribute of the element when it has one, so that the path does not land on another
     * element at the same place in a page where the expected one is missing.
     * @param {Element} element - Element.
     * @returns {string} CSS selector.
     */
    function buildStructuralSelector(element) {
        var parts = [];
        var node = element;
        while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
            if (node !== element && typeof node.id === "string" && isWordLikeId(node.id) &&
                document.querySelectorAll("#" + escapeCssIdentifier(node.id)).length === 1) {
                parts.unshift("#" + escapeCssIdentifier(node.id));
                return parts.join(" > ");
            }
            var head = node === element ? (getOwnTokenStep(node) || escapeCssIdentifier(node.localName)) :
                escapeCssIdentifier(node.localName);
            parts.unshift(head + ":nth-of-type(" + getTypeIndex(node) + ")");
            node = node.parentElement;
        }
        parts.unshift("body");
        return parts.join(" > ");
    }

    /**
     * Builds up to three selectors that each find the element first in the page, ordered from
     * the most meaningful to the most fragile. Alternatives avoid reusing the same step, so that
     * one page change does not break all of them; the last one is always the structural path.
     * Every selector keeps a class, attribute or id of the element when it has one; a bare tag
     * ("h1", "article p") is only used, inside a described ancestor, for an element that has
     * nothing else. Otherwise, on a page where the element is missing, a fallback would read
     * another element.
     * @param {Element} element - Element picked by the user.
     * @returns {string[]} Selectors.
     */
    function buildFieldSelectors(element) {
        var found = [];
        var tries = 0;
        var ownSteps = getSelectorSteps(element).filter(function(step) { return step.rank <= 3; });
        var hasOwnToken = ownSteps.length > 0;
        if (!hasOwnToken) {
            ownSteps = getSelectorSteps(element).filter(function(step) { return step.rank === 4; });
        }

        if (hasOwnToken) {
            ownSteps.forEach(function(step) {
                tries++;
                if (selectsFirst(step.selector, element)) {
                    found.push({ selector: step.selector, score: step.rank + 0.5, parts: [step.selector] });
                }
            });
        }

        var ancestor = element.parentElement;
        for (var depth = 1; ancestor && ancestor !== document.documentElement && depth <= MAX_ANCESTOR_DEPTH; depth++) {
            var ancestorSteps = getSelectorSteps(ancestor).filter(function(step) { return step.rank <= 3; });
            for (var a = 0; a < ancestorSteps.length && tries < MAX_SELECTOR_TRIES; a++) {
                for (var o = 0; o < ownSteps.length && tries < MAX_SELECTOR_TRIES; o++) {
                    tries++;
                    var selector = ancestorSteps[a].selector + " " + ownSteps[o].selector;
                    if (selectsFirst(selector, element)) {
                        found.push({
                            selector: selector,
                            score: Math.max(ancestorSteps[a].rank, ownSteps[o].rank) + depth / 10,
                            parts: [ancestorSteps[a].selector, ownSteps[o].selector]
                        });
                    }
                }
            }
            ancestor = ancestor.parentElement;
        }

        found.sort(function(x, y) { return x.score - y.score; });

        var chosen = [];
        var usedParts = {};
        found.forEach(function(candidate) {
            if (chosen.length >= MAX_FIELD_SELECTORS - 1) return;
            if (candidate.parts.some(function(part) { return usedParts[part]; })) return;
            chosen.push(candidate.selector);
            candidate.parts.forEach(function(part) { usedParts[part] = true; });
        });
        found.forEach(function(candidate) {
            if (chosen.length < MAX_FIELD_SELECTORS - 1 && chosen.indexOf(candidate.selector) === -1) {
                chosen.push(candidate.selector);
            }
        });

        var structural = buildStructuralSelector(element);
        if (chosen.indexOf(structural) === -1 && selectsFirst(structural, element)) chosen.push(structural);
        return chosen.slice(0, MAX_FIELD_SELECTORS);
    }

    /**
     * Suggests a column name: first class of the element or of its closest ancestor with one,
     * else the tag name.
     * @param {Element} element - Picked element.
     * @returns {string} Column name.
     */
    function suggestFieldName(element) {
        for (var node = element; node && node.nodeType === 1 && node !== document.body; node = node.parentElement) {
            var className = getFirstClass(node);
            if (className) return className.replace(/\./g, "_");
        }
        return element.localName;
    }

    // --- Highlight layer: one shadow root, never any change to the page's own elements ---

    /**
     * Creates an element of the layer.
     * @param {string} tag - Tag name.
     * @param {string} className - Class names.
     * @param {Element} [parent] - Parent to append to.
     * @returns {Element} New element.
     */
    function createLayerElement(tag, className, parent) {
        var element = document.createElement(tag);
        element.className = className;
        if (parent) parent.appendChild(element);
        return element;
    }

    /**
     * Returns the layer, creating it on first use: a host appended to the root element, with a
     * shadow root so that the page's styles cannot reach what is drawn, above everything else.
     * @returns {Object} Layer parts.
     */
    function getLayer() {
        if (layer && layer.host.isConnected) return layer;
        var host = document.createElement("div");
        host.setAttribute(LAYER_ATTRIBUTE, "");
        host.style.cssText = "all:initial !important;position:absolute !important;left:0 !important;top:0 !important;" +
            "width:0 !important;height:0 !important;overflow:visible !important;display:block !important;" +
            "z-index:2147483647 !important;pointer-events:none !important";
        var root = host.attachShadow({ mode: "open" });
        createLayerElement("style", "", root).textContent = LAYER_STYLE;
        layer = {
            host: host,
            root: root,
            dim: createLayerElement("div", "dim", root),
            boxes: createLayerElement("div", "boxes", root),
            catcher: createLayerElement("div", "catcher", root),
            label: createLayerElement("div", "label", root),
            panel: null,
            busy: null
        };
        layer.dim.hidden = true;
        layer.catcher.hidden = true;
        layer.label.hidden = true;
        document.documentElement.appendChild(host);
        LAYER_EVENT_TYPES.forEach(function(type) { window.addEventListener(type, routeLayerEvent, true); });
        document.addEventListener("scroll", scheduleLayerPlacement, true);
        window.addEventListener("resize", scheduleLayerPlacement);
        clearInterval(layerTimer);
        layerTimer = setInterval(scheduleLayerPlacement, BOX_REFRESH_MS);
        return layer;
    }

    /**
     * Adds or removes a handler for an event on an element of the layer. These events never
     * reach the page (see routeLayerEvent), so the layer's elements do not listen themselves.
     * @param {Element} node - Element of the layer.
     * @param {string} type - One of LAYER_EVENT_TYPES.
     * @param {Function} handler - Called with the event.
     * @param {boolean} [remove] - True to remove the handler.
     */
    function onLayerEvent(node, type, handler, remove) {
        var handlers = layerHandlers.get(node) || {};
        layerHandlers.set(node, handlers);
        handlers[type] = (handlers[type] || []).filter(function(other) { return other !== handler; });
        if (!remove) handlers[type].push(handler);
    }

    /**
     * Window capture listener: an event aimed at the layer is stopped there, so no page listener
     * added after it (on the window, the document or an element, capture or bubble) runs for
     * it, then the layer's own handlers run from the target up to the host.
     * @param {Event} event - Pointer, mouse or touch event.
     */
    function routeLayerEvent(event) {
        if (!layer) return;
        var path = event.composedPath();
        var hostIndex = path.indexOf(layer.host);
        if (hostIndex < 0) return;
        event.stopImmediatePropagation();
        for (var i = 0; i < hostIndex; i++) {
            var handlers = layerHandlers.get(path[i]);
            if (handlers && handlers[event.type]) {
                handlers[event.type].slice().forEach(function(handler) { handler(event); });
            }
        }
    }

    /**
     * Removes the layer when nothing is shown in it any more.
     */
    function releaseLayerIfIdle() {
        if (!layer || fieldPicker || layerBoxes.length || (layer.busy && !layer.busy.hidden)) return;
        LAYER_EVENT_TYPES.forEach(function(type) { window.removeEventListener(type, routeLayerEvent, true); });
        document.removeEventListener("scroll", scheduleLayerPlacement, true);
        window.removeEventListener("resize", scheduleLayerPlacement);
        clearInterval(layerTimer);
        cancelAnimationFrame(layerFrame);
        layerFrame = 0;
        layer.host.remove();
        layer = null;
    }

    /**
     * Places the boxes and the label again on the next frame (after a scroll, a resize...).
     */
    function scheduleLayerPlacement() {
        if (!layer || layerFrame) return;
        layerFrame = requestAnimationFrame(function() {
            layerFrame = 0;
            placeLayerBoxes();
            if (fieldPicker) {
                // The page moved under a still pointer: what is under it may have changed
                updatePickerHover(false);
                placeInfoLabel();
            }
        });
    }

    /**
     * Tells whether the body is a box of its own. The body's overflow applies to the window
     * unless the root element sets its own: then pages use the body as their scroller.
     * @returns {boolean} True when the body scrolls or clips on its own.
     */
    function isBodyOwnBox() {
        return getComputedStyle(document.documentElement).overflowY !== "visible";
    }

    /**
     * Returns the part of an element left visible by the boxes around it that clip their
     * content (inner scroll boxes, overflow: hidden). The window is left out: boxes are drawn
     * in page coordinates and follow it.
     * @param {Element} element - Element.
     * @param {DOMRect} rect - Its bounding box, in viewport coordinates.
     * @returns {{left: number, top: number, width: number, height: number}|null} Visible part,
     *     in viewport coordinates, or null when the element is clipped out.
     */
    function getVisiblePart(element, rect) {
        var left = rect.left;
        var top = rect.top;
        var right = rect.right;
        var bottom = rect.bottom;
        var bodyOwnBox = isBodyOwnBox();
        // An absolutely positioned element is only clipped by the boxes from its containing block up
        var escaping = false;
        var node = element;
        while (node && node !== document.documentElement) {
            var style = getComputedStyle(node);
            var skip = false;
            if (node !== element) {
                var containsPositioned = style.position !== "static" || style.transform !== "none";
                skip = escaping && !containsPositioned;
                if (!skip) escaping = false;
            }
            if (!skip && node !== element && (node !== document.body || bodyOwnBox) &&
                style.display !== "inline" && style.display !== "contents") {
                var box = node.getBoundingClientRect();
                if (style.overflowX !== "visible") {
                    left = Math.max(left, box.left + node.clientLeft);
                    right = Math.min(right, box.left + node.clientLeft + node.clientWidth);
                }
                if (style.overflowY !== "visible") {
                    top = Math.max(top, box.top + node.clientTop);
                    bottom = Math.min(bottom, box.top + node.clientTop + node.clientHeight);
                }
            }
            if (!skip && style.position === "fixed") break;
            if (!skip && style.position === "absolute") escaping = true;
            node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
        }
        var width = right - left;
        var height = bottom - top;
        if (width < 0 || height < 0 || (width === 0 && rect.width > 0) || (height === 0 && rect.height > 0)) return null;
        return { left: left, top: top, width: width, height: height };
    }

    /**
     * Places every box over the visible part of its element, in page coordinates (boxes follow
     * the page when it scrolls). Parts scrolled out of an inner box are not drawn: drawn below
     * the page, they would make the window scroll on pages where only that box scrolls.
     */
    function placeLayerBoxes() {
        if (!layer || !layerBoxes.length) return;
        // Pages that rebuild their document can drop the layer: put it back
        if (!layer.host.isConnected) document.documentElement.appendChild(layer.host);
        var origin = layer.host.getBoundingClientRect();
        layerBoxes.forEach(function(entry) {
            // A field's element replaced by the page (late rendering) is found again
            if (!entry.element.isConnected && entry.field) {
                var again = resolveField(entry.field).element;
                if (again) entry.element = again;
            }
            var rect = entry.element.getBoundingClientRect();
            var hidden = !entry.element.isConnected || (rect.width === 0 && rect.height === 0);
            var part = hidden ? null : getVisiblePart(entry.element, rect);
            entry.box.style.display = part ? "block" : "none";
            if (!part) return;
            entry.box.style.left = (part.left - origin.left) + "px";
            entry.box.style.top = (part.top - origin.top) + "px";
            entry.box.style.width = part.width + "px";
            entry.box.style.height = part.height + "px";
        });
    }

    /**
     * Draws a box over an element.
     * @param {Element} element - Element to highlight.
     * @param {"hover"|"picked"|"found"} kind - Box style.
     * @returns {Object} Box entry.
     */
    function addLayerBox(element, kind, field) {
        var entry = { element: element, kind: kind, field: field || null, box: createLayerElement("div", "box " + kind, getLayer().boxes) };
        layerBoxes.push(entry);
        placeLayerBoxes();
        return entry;
    }

    /**
     * Removes boxes.
     * @param {function(Object): boolean} test - Returns true for each box entry to remove.
     */
    function removeLayerBoxes(test) {
        layerBoxes = layerBoxes.filter(function(entry) {
            if (!test(entry)) return true;
            entry.box.remove();
            return false;
        });
        releaseLayerIfIdle();
    }

    /**
     * Removes the boxes of one kind.
     * @param {"hover"|"picked"|"found"} kind - Box style.
     */
    function clearLayerBoxes(kind) {
        removeLayerBoxes(function(entry) { return entry.kind === kind; });
    }

    /**
     * Tells whether part of an element is inside the window.
     * @param {Element} element - Element.
     * @returns {boolean} True if visible in the viewport.
     */
    function isInViewport(element) {
        var rect = element.getBoundingClientRect();
        var width = window.innerWidth || document.documentElement.clientWidth;
        var height = window.innerHeight || document.documentElement.clientHeight;
        return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
    }

    /**
     * Highlights found elements; when none of them is in the window, scrolls to the first one.
     * @param {Element[]} elements - Elements to show.
     */
    function showFoundElements(elements, fields) {
        clearLayerBoxes("found");
        elements.forEach(function(element, index) { addLayerBox(element, "found", fields && fields[index]); });
        if (elements.length && !elements.some(isInViewport)) {
            elements[0].scrollIntoView({ block: "center", inline: "center" });
            placeLayerBoxes();
        }
    }

    /**
     * Shows or hides the "Extracting..." overlay that keeps the user from using the page during a run.
     * @param {boolean} on - Show the overlay.
     */
    function setBusyOverlay(on) {
        if (!on) {
            if (layer && layer.busy) layer.busy.hidden = true;
            releaseLayerIfIdle();
            return;
        }
        var parts = getLayer();
        if (!parts.busy) {
            parts.busy = createLayerElement("div", "busy", parts.root);
            parts.busy.setAttribute("role", "status");
            var card = createLayerElement("div", "busy-card", parts.busy);
            createLayerElement("span", "spin", card);
            createLayerElement("span", "", card).textContent = "Extracting…";
        }
        parts.busy.hidden = false;
    }

    // --- Field picker ---

    /**
     * Returns what the popup needs to know about the picker.
     * @returns {{active: boolean, picks: Array<Object>}} Picker snapshot.
     */
    function getPickerSnapshot() {
        return { active: !!fieldPicker, picks: pickedFields.slice() };
    }

    /**
     * Answers every pending poll with the current picker snapshot.
     */
    function answerPickerPolls() {
        var polls = pendingPickerPolls;
        pendingPickerPolls = [];
        polls.forEach(function(sendResponse) { sendResponse(getPickerSnapshot()); });
    }

    /**
     * Returns the first class of an element that was not added by this extension.
     * @param {Element} element - Element.
     * @returns {string} Class name, or "".
     */
    function getFirstClass(element) {
        return Array.prototype.find.call(element.classList, function(cls) { return !isOwnClass(cls); }) || "";
    }

    /**
     * Tells quickly whether an element holds some text, without rendering all of it (large
     * containers are under the pointer too): stops at the first non-blank text node.
     * @param {Element} element - Element.
     * @returns {boolean} True when the element has text.
     */
    function hasSomeText(element) {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
            return !!getElementText(element);
        }
        if (!(element instanceof HTMLElement)) return false;
        var walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (var node = walker.nextNode(); node; node = walker.nextNode()) {
            var parent = node.parentElement;
            if (parent && /^(script|style|noscript|template)$/.test(parent.localName)) continue;
            if (/\S/.test(node.data)) return true;
        }
        return false;
    }

    /**
     * Describes what clicking an element would add: its text, the link it is or is inside of,
     * and the media that it is or that fills its box. The text is only read when needed.
     * @param {Element} element - Element under the pointer.
     * @returns {{element: Element, rect: DOMRect, hasText: boolean, text: (string|null), linkElement: Element|null,
     *     link: string, mediaElement: Element|null, image: string}} Description.
     */
    function describeElement(element) {
        var linkElement = getLinkElement(element);
        var mediaElement = getMediaElement(element);
        return {
            element: element,
            rect: element.getBoundingClientRect(),
            hasText: hasSomeText(element),
            text: null,
            linkElement: linkElement,
            link: linkElement ? getElementLink(linkElement) : "",
            mediaElement: mediaElement,
            image: mediaElement ? getElementImage(mediaElement) : ""
        };
    }

    /**
     * Returns the rendered text of a described element (read once, then kept).
     * @param {Object} info - Description (see describeElement).
     * @returns {string} Text, or "".
     */
    function getInfoText(info) {
        if (info.text === null) info.text = info.hasText ? getElementText(info.element) : "";
        return info.text;
    }

    /**
     * Lists the useful elements under a point, smallest first: elements with text, a link or a
     * media. Elements stacked with exactly the same box count as one (the innermost is kept).
     * @param {number} x - Viewport x.
     * @param {number} y - Viewport y.
     * @returns {Array<Object>} Descriptions (see describeElement).
     */
    function getElementStack(x, y) {
        var catcher = layer.catcher;
        var elements;
        catcher.style.pointerEvents = "none";
        try {
            elements = document.elementsFromPoint(x, y);
        } finally {
            catcher.style.pointerEvents = "";
        }
        var stack = [];
        elements.forEach(function(element) {
            if (element === layer.host || element === document.documentElement || element === document.body) return;
            var info = describeElement(element);
            if (!info.hasText && !info.link && !info.image) return;
            if (info.rect.width === 0 && info.rect.height === 0) return;
            var last = stack[stack.length - 1];
            if (last && areSameRects(last.rect, info.rect)) return;
            stack.push(info);
        });
        return stack;
    }

    /**
     * Returns the description of the element currently hovered (at the chosen level), or null.
     * @returns {Object|null} Description.
     */
    function getHoveredInfo() {
        return fieldPicker && !fieldPicker.cancelled ? fieldPicker.stack[fieldPicker.level] || null : null;
    }

    /**
     * Finds what is under the pointer and highlights it. The stack is only rebuilt when the
     * element under the pointer changes, so moving inside one element costs nothing.
     * @param {boolean} fromPointer - The pointer moved (a hover hidden with Escape comes back).
     */
    function updatePickerHover(fromPointer) {
        var pointer = fieldPicker.pointer;
        if (!pointer || (!fromPointer && fieldPicker.cancelled)) return;
        var catcher = layer.catcher;
        catcher.style.pointerEvents = "none";
        var top;
        try {
            top = document.elementFromPoint(pointer.x, pointer.y);
        } finally {
            catcher.style.pointerEvents = "";
        }
        if (top === fieldPicker.top && !fieldPicker.cancelled) return;
        var previous = getHoveredInfo();
        var sameTop = top === fieldPicker.top;
        fieldPicker.top = top;
        fieldPicker.cancelled = false;
        fieldPicker.stack = getElementStack(pointer.x, pointer.y);
        // Keep the chosen level while the pointer stays on the same element
        var index = previous && sameTop ? fieldPicker.stack.findIndex(function(info) { return info.element === previous.element; }) : -1;
        fieldPicker.level = index >= 0 ? index : 0;
        renderPickerHover();
    }

    /**
     * Draws the hover box and the info label of the hovered element.
     */
    function renderPickerHover() {
        var info = getHoveredInfo();
        if (fieldPicker.hoverBox && (!info || fieldPicker.hoverBox.element !== info.element)) {
            var oldBox = fieldPicker.hoverBox;
            fieldPicker.hoverBox = null;
            removeLayerBoxes(function(entry) { return entry === oldBox; });
        }
        if (info && !fieldPicker.hoverBox) fieldPicker.hoverBox = addLayerBox(info.element, "hover");
        renderInfoLabel(info);
    }

    /**
     * Fills the info label: the element's tag and first class, then one row per value a click
     * would add (Text, Link, Image).
     * @param {Object|null} info - Description of the hovered element.
     */
    function renderInfoLabel(info) {
        var label = layer.label;
        label.textContent = "";
        if (!info) {
            label.hidden = true;
            return;
        }
        var cls = getFirstClass(info.element);
        var tag = createLayerElement("span", "tag", label);
        tag.textContent = info.element.localName + (cls ? "." + cls : "");
        [["Text", getInfoText(info)], ["Link", info.link], ["Image", info.image]].forEach(function(row) {
            if (!row[1]) return;
            createLayerElement("span", "key", label).textContent = row[0];
            var value = createLayerElement("span", "val", label);
            value.textContent = row[1].slice(0, LABEL_VALUE_LENGTH);
        });
        label.hidden = false;
        placeInfoLabel();
    }

    /**
     * Places the info label under the hovered box, or above it when there is no room below,
     * always inside the window.
     */
    function placeInfoLabel() {
        var info = getHoveredInfo();
        var label = layer && layer.label;
        if (!label || label.hidden || !info) return;
        var rect = info.element.getBoundingClientRect();
        var viewWidth = document.documentElement.clientWidth || window.innerWidth;
        var viewHeight = document.documentElement.clientHeight || window.innerHeight;
        var width = label.offsetWidth;
        var height = label.offsetHeight;
        var top = rect.bottom + LABEL_GAP;
        if (top + height > viewHeight - LABEL_GAP) {
            var above = rect.top - LABEL_GAP - height;
            top = above >= LABEL_GAP ? above : viewHeight - LABEL_GAP - height;
        }
        top = Math.max(LABEL_GAP, Math.min(top, viewHeight - LABEL_GAP - height));
        var left = Math.max(LABEL_GAP, Math.min(rect.left, viewWidth - LABEL_GAP - width));
        label.style.transform = "translate(" + Math.round(left) + "px," + Math.round(top) + "px)";
    }

    /**
     * Adds the fields of the hovered element: its text, its link and its image, when present.
     * The link field targets the link element itself and the image field the media element
     * itself. The same kind of value of the same element is never added twice.
     */
    function pickHoveredElement() {
        var info = getHoveredInfo();
        if (!info) return;
        var name = suggestFieldName(info.element);
        var added = 0;
        [
            ["text", info.element, getInfoText(info), ""],
            ["link", info.linkElement, info.link, " link"],
            ["image", info.mediaElement, info.image, " image"]
        ].forEach(function(entry) {
            var kind = entry[0];
            var target = entry[1];
            if (!target || !entry[2]) return;
            var kinds = fieldPicker.pickedKinds.get(target) || [];
            if (kinds.indexOf(kind) !== -1) return;
            var selectors = buildFieldSelectors(target);
            if (!selectors.length) return;
            pickedFields.push({ name: name + entry[3], kind: kind, selectors: selectors, sample: entry[2].slice(0, 300) });
            kinds.push(kind);
            fieldPicker.pickedKinds.set(target, kinds);
            added++;
        });
        if (added && !layerBoxes.some(function(entry) { return entry.kind === "picked" && entry.element === info.element; })) {
            addLayerBox(info.element, "picked");
        }
        answerPickerPolls();
    }

    /**
     * Pointer moves over the page: finds the element under it on the next frame.
     * @param {MouseEvent} event - Mouse move event on the catcher.
     */
    function onPickerPointerMove(event) {
        fieldPicker.pointer = { x: event.clientX, y: event.clientY };
        if (fieldPicker.moveFrame) return;
        fieldPicker.moveFrame = requestAnimationFrame(function() {
            if (!fieldPicker) return;
            fieldPicker.moveFrame = 0;
            updatePickerHover(true);
        });
    }

    /**
     * Click on the page: selects the hovered element.
     * @param {MouseEvent} event - Click event on the catcher.
     */
    function onPickerClick(event) {
        event.preventDefault();
        if (event.button !== 0) return;
        fieldPicker.pointer = { x: event.clientX, y: event.clientY };
        if (!getHoveredInfo()) updatePickerHover(true);
        pickHoveredElement();
    }

    /**
     * Scrolls an element down (or up) at once. Pages that ask for smooth scrolling
     * (scroll-behavior: smooth) would otherwise only move it after an animation.
     * @param {Element} element - Element to scroll.
     * @param {number} amount - Pixels, negative upwards.
     */
    function scrollInstantly(element, amount) {
        element.scrollBy({ top: amount, behavior: "instant" });
    }

    /**
     * Tells whether a box lets its content scroll vertically (its own scroll bar).
     * @param {CSSStyleDeclaration} style - Computed style of the box.
     * @returns {boolean} True for overflow-y auto, scroll or overlay.
     */
    function scrollsOnItsOwn(style) {
        return /^(auto|scroll|overlay)$/.test(style.overflowY);
    }

    /**
     * Finds the element that should scroll for a move under a point: the closest ancestor of
     * the element there that can still scroll that way. The page's own scrolling element is
     * left to the browser (null), which scrolls it natively and smoothly.
     * @param {number} x - Viewport x.
     * @param {number} y - Viewport y.
     * @param {number} dx - Horizontal move (pixels, negative to the left).
     * @param {number} dy - Vertical move (pixels, negative upwards).
     * @returns {Element|null} Element to scroll, or null.
     */
    function findScrollTarget(x, y, dx, dy) {
        var catcher = layer.catcher;
        var element;
        catcher.style.pointerEvents = "none";
        try {
            element = document.elementFromPoint(x, y);
        } finally {
            catcher.style.pointerEvents = "";
        }
        var documentScroller = document.scrollingElement || document.documentElement;
        var bodyOwnBox = isBodyOwnBox();
        while (element && element !== documentScroller && element !== document.documentElement) {
            if ((element !== document.body || bodyOwnBox) && element !== layer.host) {
                var style = getComputedStyle(element);
                var canY = dy && scrollsOnItsOwn(style) && element.scrollHeight > element.clientHeight + 1 &&
                    (dy > 0 ? element.scrollTop + element.clientHeight < element.scrollHeight - 1 : element.scrollTop > 0);
                var canX = dx && /^(auto|scroll|overlay)$/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1 &&
                    (dx > 0 ? element.scrollLeft + element.clientWidth < element.scrollWidth - 1 : element.scrollLeft > 0);
                if (canY || canX) return element;
            }
            element = element.parentElement || (element.getRootNode && element.getRootNode().host) || null;
        }
        return null;
    }

    /**
     * Mouse wheel over the picker's overlay: the overlay covers the page, so the browser would
     * only scroll the document. Pages that scroll an inner box (web apps whose body does not
     * scroll) get that box scrolled instead.
     * @param {WheelEvent} event - Wheel event.
     */
    function onPickerWheel(event) {
        if (!fieldPicker || !layer || event.ctrlKey || event.composedPath().indexOf(layer.catcher) === -1) return;
        var scale = event.deltaMode === 1 ? WHEEL_LINE_PX : (event.deltaMode === 2 ? window.innerHeight : 1);
        var dx = event.deltaX * scale;
        var dy = event.deltaY * scale;
        var target = findScrollTarget(event.clientX, event.clientY, dx, dy);
        if (!target) return;
        event.preventDefault();
        target.scrollBy({ left: dx, top: dy, behavior: "instant" });
    }

    /**
     * Scrolls the inner box under the pointer with the page keys (Page Up / Page Down, Space,
     * Home, End). The document itself is left to the browser.
     * @param {KeyboardEvent} event - Key event.
     * @returns {boolean} True when the key scrolled a box.
     */
    function scrollWithKey(event) {
        var pointer = fieldPicker.pointer;
        if (!pointer || event.ctrlKey || event.metaKey || event.altKey) return false;
        var down = event.key === "PageDown" || event.key === "End" || (event.key === " " && !event.shiftKey);
        var up = event.key === "PageUp" || event.key === "Home" || (event.key === " " && event.shiftKey);
        if (!down && !up) return false;
        var target = findScrollTarget(pointer.x, pointer.y, 0, down ? 1 : -1);
        if (!target) return false;
        if (event.key === "Home") target.scrollTo({ top: 0, behavior: "instant" });
        else if (event.key === "End") target.scrollTo({ top: target.scrollHeight, behavior: "instant" });
        else target.scrollBy({ top: (down ? 1 : -1) * target.clientHeight * 0.875, behavior: "instant" });
        return true;
    }

    /**
     * The page scrolled while picking: the element under the pointer changed, hover it.
     */
    function onPickerScroll() {
        if (!fieldPicker || fieldPicker.scrollFrame) return;
        fieldPicker.scrollFrame = requestAnimationFrame(function() {
            if (!fieldPicker) return;
            fieldPicker.scrollFrame = 0;
            updatePickerHover(false);
        });
    }

    /**
     * Keyboard: Up / Down move through the elements under the pointer, Enter selects,
     * Escape hides the hover (and ends picking when nothing is hovered).
     * @param {KeyboardEvent} event - Key down event.
     */
    function onPickerKeyDown(event) {
        var handled = true;
        if (event.key === "Escape") {
            if (getHoveredInfo()) {
                fieldPicker.cancelled = true;
                renderPickerHover();
            } else {
                stopFieldPicker();
            }
        } else if (event.key === "ArrowUp" && getHoveredInfo()) {
            fieldPicker.level = Math.min(fieldPicker.level + 1, fieldPicker.stack.length - 1);
            renderPickerHover();
        } else if (event.key === "ArrowDown" && getHoveredInfo()) {
            fieldPicker.level = Math.max(fieldPicker.level - 1, 0);
            renderPickerHover();
        } else if (event.key === "Enter" && getHoveredInfo()) {
            pickHoveredElement();
        } else {
            handled = scrollWithKey(event);
        }
        if (handled) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
        }
    }

    /**
     * Creates the small picker panel: product name (drag handle), shortcut hints, Finish button.
     * @returns {Element} Panel.
     */
    function createPickerPanel() {
        var parts = getLayer();
        var panel = createLayerElement("div", "panel", parts.root);
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "Open Scraper picker");
        var head = createLayerElement("div", "head", panel);
        head.title = "Drag to move";
        createLayerElement("span", "", head).textContent = "Open Scraper";
        createLayerElement("span", "grip", head).textContent = "⋮⋮";
        var hints = createLayerElement("ul", "hints", panel);
        [["Click", "select"], ["↑ ↓", "change level"]].forEach(function(hint) {
            var item = createLayerElement("li", "", hints);
            hint[0].split(" ").forEach(function(key) { createLayerElement("kbd", "", item).textContent = key; });
            item.appendChild(document.createTextNode(hint[1]));
        });
        var finish = createLayerElement("button", "finish", panel);
        finish.type = "button";
        finish.textContent = "Finish";
        onLayerEvent(finish, "click", function() { stopFieldPicker(); });

        // Dragging by the header keeps the panel inside the window
        var drag = null;
        onLayerEvent(head, "pointerdown", function(event) {
            var rect = panel.getBoundingClientRect();
            drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
            head.setPointerCapture(event.pointerId);
            event.preventDefault();
        });
        onLayerEvent(head, "pointermove", function(event) {
            if (!drag) return;
            var maxLeft = document.documentElement.clientWidth - panel.offsetWidth;
            var maxTop = document.documentElement.clientHeight - panel.offsetHeight;
            panel.style.right = "auto";
            panel.style.left = Math.max(0, Math.min(maxLeft, event.clientX - drag.dx)) + "px";
            panel.style.top = Math.max(0, Math.min(maxTop, event.clientY - drag.dy)) + "px";
        });
        var endDrag = function() { drag = null; };
        onLayerEvent(head, "pointerup", endDrag);
        onLayerEvent(head, "pointercancel", endDrag);
        return panel;
    }

    /**
     * Shows the fields a template already has as selected (green) when they are found in the
     * page, and keeps them from being added again. Fields not found yet (pages that draw their
     * content late, or after a scroll) are looked for again while the picker is on.
     * @param {Array<{kind: string, selectors: string[]}>} [fields] - Fields of the template.
     */
    function markExistingFields(fields) {
        fieldPicker.pendingFields = (Array.isArray(fields) ? fields : []).slice();
        markPendingFields();
        if (fieldPicker.pendingFields.length) {
            fieldPicker.pendingTimer = setInterval(markPendingFields, EXISTING_FIELDS_CHECK_MS);
        }
    }

    /**
     * Marks the existing fields that are now found in the page (see markExistingFields).
     */
    function markPendingFields() {
        if (!fieldPicker) return;
        fieldPicker.pendingFields = fieldPicker.pendingFields.filter(function(field) {
            var element = resolveField(field).element;
            if (!element) return true;
            var kinds = fieldPicker.pickedKinds.get(element) || [];
            if (kinds.indexOf(field.kind) === -1) kinds.push(field.kind);
            fieldPicker.pickedKinds.set(element, kinds);
            if (!layerBoxes.some(function(entry) { return entry.kind === "picked" && entry.element === element; })) {
                addLayerBox(element, "picked", field);
            }
            return false;
        });
        if (!fieldPicker.pendingFields.length) clearInterval(fieldPicker.pendingTimer);
    }

    /**
     * Turns on the field picker: light dim, crosshair overlay catching the mouse (the page gets
     * no click or hover), hover box with its info label, and the picker panel.
     * @param {Array<Object>} [existing] - Fields of the template being edited (see markExistingFields).
     */
    function startFieldPicker(existing) {
        if (fieldPicker) return;
        clearLayerBoxes("found");
        clearLayerBoxes("picked");
        pickedFields = [];
        var parts = getLayer();
        parts.dim.hidden = false;
        parts.catcher.hidden = false;
        if (!parts.panel) parts.panel = createPickerPanel();
        parts.panel.hidden = false;
        fieldPicker = {
            pointer: null,
            top: null,
            stack: [],
            level: 0,
            cancelled: false,
            hoverBox: null,
            moveFrame: 0,
            scrollFrame: 0,
            pendingFields: [],
            pendingTimer: 0,
            pickedKinds: new Map(),
            port: null
        };
        markExistingFields(existing);
        onLayerEvent(parts.catcher, "mousemove", onPickerPointerMove);
        onLayerEvent(parts.catcher, "click", onPickerClick);
        window.addEventListener("keydown", onPickerKeyDown, true);
        window.addEventListener("wheel", onPickerWheel, { capture: true, passive: false });
        document.addEventListener("scroll", onPickerScroll, true);
        window.focus();
    }

    /**
     * Turns off the field picker and removes everything it drew.
     */
    function stopFieldPicker() {
        if (!fieldPicker) return;
        cancelAnimationFrame(fieldPicker.moveFrame);
        window.removeEventListener("keydown", onPickerKeyDown, true);
        window.removeEventListener("wheel", onPickerWheel, { capture: true, passive: false });
        document.removeEventListener("scroll", onPickerScroll, true);
        cancelAnimationFrame(fieldPicker.scrollFrame);
        clearInterval(fieldPicker.pendingTimer);
        if (layer) {
            onLayerEvent(layer.catcher, "mousemove", onPickerPointerMove, true);
            onLayerEvent(layer.catcher, "click", onPickerClick, true);
            layer.catcher.hidden = true;
            layer.dim.hidden = true;
            layer.label.hidden = true;
            if (layer.panel) layer.panel.hidden = true;
        }
        fieldPicker = null;
        clearLayerBoxes("hover");
        clearLayerBoxes("picked");
        releaseLayerIfIdle();
        answerPickerPolls();
    }

    // --- Extraction ---

    // Matches of one selector tried for a value when its first match is empty
    var MAX_FIELD_MATCHES = 20;
    // Interval between two checks of the fields while waiting for a page to show them
    var FIELD_CHECK_MS = 150;
    // While fields are missing, the wait ends early once the page has loaded and has not changed
    // for this long (a page still drawing keeps changing; a field that is simply not on the page
    // never comes)
    var FIELD_QUIET_MS = 1500;
    // A page still loading that already shows every field is read once their values have not
    // changed for this long (a script may still be filling them in)
    var FIELD_STABLE_MS = 500;

    /**
     * Finds the element and value of a field. The first match of each selector is tried in
     * order, then their other matches: the first one that gives a non-empty value wins (a
     * page can hold an empty or hidden copy first, or a primary selector can land on another
     * element). With no value, the first element found is returned with "".
     * @param {{kind: string, selectors: string[]}} field - Field.
     * @returns {{element: (Element|null), value: string}} Element and value.
     */
    function resolveField(field) {
        var selectors = field && Array.isArray(field.selectors) ? field.selectors : [];
        var kind = field && field.kind;
        var lists = selectors.map(function(selector) {
            try {
                return document.querySelectorAll(selector);
            } catch (e) {
                return [];
            }
        });
        var firstElement = null;
        for (var i = 0; i < lists.length; i++) {
            if (!lists[i].length) continue;
            var value = readFieldValue(lists[i][0], kind);
            if (value) return { element: lists[i][0], value: value };
            firstElement = firstElement || lists[i][0];
        }
        for (i = 0; i < lists.length; i++) {
            for (var j = 1; j < lists[i].length && j < MAX_FIELD_MATCHES; j++) {
                var other = readFieldValue(lists[i][j], kind);
                if (other) return { element: lists[i][j], value: other };
            }
        }
        return { element: firstElement, value: "" };
    }

    /**
     * Extracts one value per field from the current page (see resolveField); a field with
     * no value gives "".
     * @param {Array<{kind: string, selectors: string[]}>} fields - Fields to extract.
     * @returns {string[]} Values, in field order.
     */
    function extractPageDetails(fields) {
        return (fields || []).map(function(field) { return resolveField(field).value; });
    }

    /**
     * Calls a function when the page changes (what this extension draws does not count) and
     * at a regular interval (layout changes, like an image that loads, are not mutations), at
     * most once per FIELD_CHECK_MS however many changes the page makes.
     * @param {Function} onCheck - Called with the time of the last change of the page since the
     *     previous call, or 0.
     * @returns {Function} Stops watching.
     */
    function watchPage(onCheck) {
        var scheduled = 0;
        var changedAt = 0;
        var lastRun = 0;
        var run = function() {
            scheduled = 0;
            var at = changedAt;
            changedAt = 0;
            if (at) lastRun = Date.now();
            onCheck(at);
        };
        var observer = new MutationObserver(function(records) {
            var own = layer && records.every(function(record) {
                return record.target === layer.host || Array.prototype.indexOf.call(record.addedNodes, layer.host) !== -1 ||
                    Array.prototype.indexOf.call(record.removedNodes, layer.host) !== -1;
            });
            if (own) return;
            changedAt = Date.now();
            // The first change after a calm moment is checked at once, the next ones together
            // (the regular checks do not count)
            if (!scheduled) scheduled = setTimeout(run, Math.max(0, lastRun + FIELD_CHECK_MS - changedAt));
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        var poll = setInterval(function() { if (!scheduled) run(); }, FIELD_CHECK_MS * 2);
        return function() {
            observer.disconnect();
            clearInterval(poll);
            clearTimeout(scheduled);
        };
    }

    /**
     * Waits until every field has a value (the preview of a page that draws its content late),
     * or the time runs out. A page that already shows every field answers at once.
     * @param {Array<{kind: string, selectors: string[]}>} fields - Fields.
     * @param {number} timeoutMs - Longest wait.
     * @returns {Promise<boolean>} True when every field has a value.
     */
    function waitForFields(fields, timeoutMs) {
        var allFound = function() {
            return fields.every(function(field) { return !!resolveField(field).value; });
        };
        return new Promise(function(resolve) {
            if (!fields.length || allFound()) return resolve(true);
            if (!(timeoutMs > 0)) return resolve(false);
            var done = false;
            var finish = function(found) {
                if (done) return;
                done = true;
                stopWatching();
                clearTimeout(timer);
                resolve(found);
            };
            var stopWatching = watchPage(function() {
                if (!done && allFound()) finish(true);
            });
            var timer = setTimeout(function() { finish(false); }, timeoutMs);
        });
    }

    /**
     * Waits until a page visited by a run can be read, watching it from the moment it is
     * parsed (it may still be loading images, frames or ads):
     * - never before notBeforeMs (the Min wait of the run), unless limitMs comes first;
     * - every awaited field has a value: read at once when the page has loaded, else once the
     *   values have not changed for FIELD_STABLE_MS;
     * - a field still missing is waited for until the page has loaded, then until it has not
     *   changed for FIELD_QUIET_MS or lateMs have passed, both counted from the end of the Min
     *   wait or from the load, whichever comes last (so a page is never read earlier than when
     *   it had loaded and Min had passed);
     * - never beyond limitMs (the Max limit of the run).
     * @param {Array<{kind: string, selectors: string[]}>} fields - Fields.
     * @param {{notBeforeMs: number, lateMs: number, limitMs: number, awaited: boolean[]}} options -
     *     Times in milliseconds from now; awaited tells, per field, whether a missing value holds
     *     the page up (all of them when not given).
     * @returns {Promise<{values: string[], complete: boolean, late: boolean[]}>} Values; complete
     *     when every awaited field has one; late, per field, when its value only showed after the
     *     first check.
     */
    function waitForRunFields(fields, options) {
        var started = Date.now();
        var minEnd = started + Math.max(0, Number(options.notBeforeMs) || 0);
        var limitMs = Number(options.limitMs);
        var hardEnd = started + (limitMs >= 0 ? limitMs : 30000);
        var lateMs = Math.max(0, Number(options.lateMs) || 0);
        var awaited = fields.map(function(field, i) { return !Array.isArray(options.awaited) || options.awaited[i] !== false; });
        var readValues = function() { return extractPageDetails(fields); };
        var values = readValues();
        var missingAtStart = values.map(function(value) { return !value; });
        var valuesKey = JSON.stringify(values);
        var valuesChangedAt = started;
        var lastChange = started;
        var loadedAt = document.readyState === "complete" ? started : 0;
        return new Promise(function(resolve) {
            var done = false;
            var wake = 0;
            var stopWatching = null;
            var onLoad = function() {
                loadedAt = Date.now();
                check(0);
            };
            var finish = function(complete) {
                if (done) return;
                done = true;
                if (stopWatching) stopWatching();
                clearTimeout(wake);
                window.removeEventListener("load", onLoad);
                values = readValues();
                resolve({
                    values: values,
                    complete: complete,
                    late: values.map(function(value, i) { return !!value && missingAtStart[i]; })
                });
            };
            var check = function(changedAt) {
                if (done) return;
                var now = Date.now();
                if (changedAt) lastChange = Math.max(lastChange, changedAt);
                values = readValues();
                var key = JSON.stringify(values);
                if (key !== valuesKey) {
                    valuesKey = key;
                    valuesChangedAt = now;
                }
                var complete = values.every(function(value, i) { return !awaited[i] || !!value; });
                if (now >= hardEnd) return finish(complete);
                // Next moment a rule can end the wait without any change of the page
                var next = hardEnd;
                if (now < minEnd) {
                    next = minEnd;
                } else if (complete) {
                    if (loadedAt || now - valuesChangedAt >= FIELD_STABLE_MS) return finish(true);
                    next = valuesChangedAt + FIELD_STABLE_MS;
                } else if (loadedAt) {
                    var from = Math.max(minEnd, loadedAt);
                    var quietEnd = Math.max(lastChange, from) + FIELD_QUIET_MS;
                    var lateEnd = from + lateMs;
                    if (now >= quietEnd || now >= lateEnd) return finish(false);
                    next = Math.min(quietEnd, lateEnd);
                }
                clearTimeout(wake);
                wake = setTimeout(function() { check(0); }, Math.max(0, Math.min(next, hardEnd) - now));
            };
            if (!loadedAt) window.addEventListener("load", onLoad);
            stopWatching = watchPage(check);
            check(0);
        });
    }

    // --- Load full page (option of a template) ---

    // Pause after each jump down, so that the page's lazy loaders see the part shown and start
    var FULL_PAGE_STEP_PAUSE_MS = 120;
    // At the bottom, the page counts as fully loaded once its height has not grown for this long
    var FULL_PAGE_STABLE_MS = 500;
    // Longest wait for the page's load event before scrolling (its scripts set up the lazy loaders)
    var FULL_PAGE_LOAD_WAIT_MS = 5000;
    // Most jumps on one page: a page that keeps growing (endless feed) is read after that
    var FULL_PAGE_MAX_STEPS = 150;
    // Each new scroll, and every stop of the scraping window, ends the scroll under way
    var fullPageScrollToken = 0;

    /**
     * Ends the "Load full page" scroll under way, if any.
     */
    function stopFullPageScroll() {
        fullPageScrollToken++;
    }

    /**
     * Finds what scrolls the page: the document when it is taller than the window, else the
     * largest inner box that scrolls (web apps whose body does not scroll).
     * @returns {Element|null} Element to scroll, or null when nothing scrolls.
     */
    function findPageScroller() {
        var documentScroller = document.scrollingElement || document.documentElement;
        if (documentScroller.scrollHeight > documentScroller.clientHeight + 1) return documentScroller;
        var best = null;
        var bestArea = 0;
        var elements = document.body ? document.body.getElementsByTagName("*") : [];
        for (var i = 0; i < elements.length; i++) {
            var element = elements[i];
            if (element.scrollHeight <= element.clientHeight + 1 || !element.clientHeight) continue;
            if (layer && element === layer.host) continue;
            var area = element.clientHeight * element.clientWidth;
            if (area > bestArea && scrollsOnItsOwn(getComputedStyle(element))) {
                best = element;
                bestArea = area;
            }
        }
        return best;
    }

    /**
     * "Load full page": scrolls the page down to its very end, one window at a time, so that
     * the content shown only once scrolled to (lazy images, reviews, comments, related items)
     * is there, then scrolls back to where it was. Waits first for the page's load event (at
     * most FULL_PAGE_LOAD_WAIT_MS), as its scripts set up the lazy loaders. The end counts as
     * reached once the page has not grown for FULL_PAGE_STABLE_MS at the bottom.
     * @param {number} limitMs - Longest time, in milliseconds.
     * @returns {Promise<{bottom: boolean, steps: number, cancelled: boolean}>} Whether the end
     *     was reached, the jumps made, and whether the scroll was stopped (stopFullPageScroll).
     */
    function scrollThroughPage(limitMs) {
        var token = ++fullPageScrollToken;
        var end = Date.now() + Math.max(0, Number(limitMs) || 0);
        var loadEnd = Math.min(end, Date.now() + FULL_PAGE_LOAD_WAIT_MS);
        return new Promise(function(resolve) {
            var scroller = null;
            var startTop = 0;
            var steps = 0;
            var lastHeight = 0;
            var heightSince = 0;
            var bottomSince = 0;
            // A page can keep the scroll from moving: after a few jumps that did not move, it is the end
            var jumpedFrom = -1;
            var stuckJumps = 0;
            var finish = function(bottom) {
                var cancelled = token !== fullPageScrollToken;
                // Back to where the page was, unless a newer scroll took over
                if (scroller && !cancelled) scroller.scrollTo({ top: startTop, behavior: "instant" });
                resolve({ bottom: bottom, steps: steps, cancelled: cancelled });
            };
            var step = function() {
                if (token !== fullPageScrollToken) return finish(false);
                var now = Date.now();
                if (now >= end) return finish(false);
                var height = scroller.scrollHeight;
                if (height !== lastHeight) {
                    lastHeight = height;
                    heightSince = now;
                }
                var top = scroller.scrollTop;
                if (jumpedFrom >= 0) {
                    stuckJumps = top === jumpedFrom ? stuckJumps + 1 : 0;
                    jumpedFrom = -1;
                }
                if (top + scroller.clientHeight >= height - 2 || stuckJumps >= 3) {
                    if (!bottomSince) bottomSince = now;
                    if (now - Math.max(bottomSince, heightSince) >= FULL_PAGE_STABLE_MS) return finish(true);
                    return setTimeout(step, FULL_PAGE_STEP_PAUSE_MS);
                }
                bottomSince = 0;
                if (steps >= FULL_PAGE_MAX_STEPS) return finish(false);
                steps++;
                jumpedFrom = top;
                scrollInstantly(scroller, Math.max(100, Math.round(scroller.clientHeight * 0.85)));
                setTimeout(step, FULL_PAGE_STEP_PAUSE_MS);
            };
            var start = function() {
                window.removeEventListener("load", start);
                clearTimeout(loadTimer);
                if (token !== fullPageScrollToken) return finish(false);
                scroller = findPageScroller();
                if (!scroller) return finish(true);
                startTop = scroller.scrollTop;
                lastHeight = scroller.scrollHeight;
                heightSince = Date.now();
                step();
            };
            var loadTimer = 0;
            if (document.readyState === "complete") return start();
            window.addEventListener("load", start);
            loadTimer = setTimeout(start, Math.max(0, loadEnd - Date.now()));
        });
    }

    /**
     * Highlights the elements found for the fields (and scrolls to them when none is in view).
     * @param {Array<{selectors: string[]}>} fields - Fields.
     * @returns {boolean[]} Whether each field was found.
     */
    function highlightFields(fields) {
        var found = [];
        var foundFields = [];
        var flags = fields.map(function(field) {
            var element = resolveField(field).element;
            if (element && found.indexOf(element) === -1) {
                found.push(element);
                foundFields.push(field);
            }
            return !!element;
        });
        showFoundElements(found, foundFields);
        return flags;
    }

    /**
     * Returns the HTTP status of the page, when the browser exposes it.
     * @returns {number} Status code, or 0 when unknown.
     */
    function getPageHttpStatus() {
        try {
            var entry = performance.getEntriesByType("navigation")[0];
            return entry && typeof entry.responseStatus === "number" ? entry.responseStatus : 0;
        } catch (e) {
            return 0;
        }
    }

    /**
     * Removes everything this extension shows in the page.
     */
    function clearDetailsLayer() {
        stopFullPageScroll();
        stopFieldPicker();
        clearLayerBoxes("found");
        setBusyOverlay(false);
    }

    /**
     * Handles the page details messages sent by the scraping window.
     * @param {Object} message - Message with an action starting with "details".
     * @param {Function} sendResponse - Message callback.
     */
    function handleDetailsMessage(message, sendResponse) {
        switch (message.action) {
            case "detailsPing":
                if (typeof message.busy === "boolean") setBusyOverlay(message.busy);
                sendResponse({ ready: true, url: window.location.href, status: getPageHttpStatus(), doc: DOCUMENT_TOKEN,
                    readyState: document.readyState });
                break;
            case "detailsPickerStart":
                stopFullPageScroll();
                clearLayerBoxes("found");
                setBusyOverlay(false);
                startFieldPicker(message.existing);
                sendResponse({ ok: true, url: window.location.href, doc: DOCUMENT_TOKEN });
                break;
            case "detailsPickerPoll":
                // Long poll: answered at once if something changed, else on the next pick or stop
                if (!fieldPicker || message.known !== pickedFields.length) {
                    sendResponse(getPickerSnapshot());
                } else {
                    pendingPickerPolls.push(sendResponse);
                }
                break;
            case "detailsPickerStop":
                stopFieldPicker();
                sendResponse(getPickerSnapshot());
                break;
            case "detailsPreview":
                // Scrolls through the page first with "Load full page", waits for the page to
                // show a field, reads one row and highlights what was found
                (function(fields) {
                    var scrolled = message.fullPage ? scrollThroughPage(message.limitMs) : Promise.resolve(null);
                    scrolled.then(function(scroll) {
                        return waitForFields(fields, scroll && scroll.cancelled ? 0 : message.waitMs);
                    }).then(function() {
                        try {
                            // The picker may have been turned on meanwhile: its boxes stay alone
                            sendResponse({
                                ok: true,
                                url: window.location.href,
                                doc: DOCUMENT_TOKEN,
                                values: extractPageDetails(fields),
                                found: message.highlight === false || fieldPicker ? [] : highlightFields(fields)
                            });
                        } catch (e) {
                            sendResponse({ error: String(e && e.message || e) });
                        }
                    });
                })(Array.isArray(message.fields) ? message.fields : []);
                break;
            case "detailsShowField":
                // Highlights one field's element for a moment
                (function(field) {
                    var element = resolveField(field).element;
                    if (element) {
                        showFoundElements([element], [field]);
                        var entry = layerBoxes[layerBoxes.length - 1];
                        setTimeout(function() {
                            removeLayerBoxes(function(box) { return box === entry; });
                        }, Math.max(200, message.durationMs || 1000));
                    }
                    sendResponse({ ok: true, found: !!element, doc: DOCUMENT_TOKEN });
                })(message.field);
                break;
            case "detailsClearHighlights":
                stopFullPageScroll();
                clearLayerBoxes("found");
                sendResponse({ ok: true });
                break;
            case "detailsBusy":
                // Turned off when a run ends or stops
                if (!message.on) stopFullPageScroll();
                setBusyOverlay(!!message.on);
                sendResponse({ ok: true });
                break;
            case "detailsExtract":
                // Read as soon as the page allows it (see waitForRunFields)
                (function(fields) {
                    try {
                        if (typeof message.busy === "boolean") setBusyOverlay(message.busy);
                        var status = getPageHttpStatus();
                        if (status >= 400) {
                            // Error page: its text is not the data of the page that was asked for
                            sendResponse({ ok: false, status: status, url: window.location.href });
                            return;
                        }
                        var started = Date.now();
                        var limitMs = Number(message.limitMs);
                        var scroll = null;
                        // "Load full page": scroll through the page first, within the page's time limit
                        var scrolled = message.fullPage ? scrollThroughPage(limitMs >= 0 ? limitMs : 30000) : Promise.resolve(null);
                        scrolled.then(function(result) {
                            scroll = result;
                            // The time spent scrolling counts in the Min wait and in the time limit
                            var spent = Date.now() - started;
                            return waitForRunFields(fields, Object.assign({}, message, {
                                notBeforeMs: Math.max(0, (Number(message.notBeforeMs) || 0) - spent),
                                limitMs: scroll && scroll.cancelled ? 0 : (limitMs >= 0 ? Math.max(0, limitMs - spent) : limitMs)
                            }));
                        }).then(function(result) {
                            sendResponse({ ok: true, status: status, url: window.location.href, values: result.values,
                                complete: result.complete, late: result.late, waitedMs: Date.now() - started, scroll: scroll });
                        }).catch(function(e) {
                            sendResponse({ error: String(e && e.message || e) });
                        });
                    } catch (e) {
                        sendResponse({ error: String(e && e.message || e) });
                    }
                })(Array.isArray(message.fields) ? message.fields : []);
                break;
            default:
                sendResponse({});
        }
    }

    // The scraping window keeps a port open while it uses the page: when the window closes,
    // the picker, highlights and overlay it left are removed
    var detailsPorts = [];
    chrome.runtime.onConnect.addListener(function(port) {
        if (port.name !== DETAILS_PORT_NAME) return;
        detailsPorts.push(port);
        port.onDisconnect.addListener(function() {
            detailsPorts = detailsPorts.filter(function(other) { return other !== port; });
            if (!detailsPorts.length) clearDetailsLayer();
        });
    });

    // --- Chrome Runtime Message Listener ---

    chrome.runtime.onMessage.addListener(function(message, _sender, sendResponse) {

        if ("nextTable" === message.action || "findTables" === message.action) {
            // Detect tables on the page or advance to the next detected table
            if ("findTables" === message.action) {
                detectedTables = [];
                findTables(message.robots);
            } else {
                if (detectedTables.length <= 1 || !detectedTables.filter(t => !t.robot).length) {
                    detectedTables = [];
                    findTables(message.robots);
                }
                currentTableIndex = (currentTableIndex + 1) % detectedTables.length;
            }

            highlightSelectedTable();
            localStorage.removeItem("visited");

            sendResponse({
                tableId: currentTableIndex,
                tableSelector: detectedTables[currentTableIndex].selector,
                robot: detectedTables[currentTableIndex].robot,
                href: window.location.href,
                hostname: window.location.hostname
            });
            return true;
        }

        if ("getTableData" === message.action) {
            extractTableData(sendResponse, message.selector);
            return true;
        }

        if ("getNextButton" === message.action) {
            activateNextButtonPickingMode(message.kind || "next", sendResponse);
            return true;
        }

        if ("stopButtonPicker" === message.action) {
            stopButtonPicker();
            sendResponse({});
            return true;
        }

        if ("clickNext" === message.action) {
            clickNextButton(message.selector, sendResponse);
            return true;
        }

        if ("scrollDown" === message.action) {
            // Scroll down through the element containing the scraped table,
            // waiting until new rows appear or the scroll position stops changing.
            clearAllHighlights();
            (async function scrollDownUntilNewRows(tableSelector, sendResponse) {
                /**
                 * Attempts to scroll an element down by 50px and checks if it can scroll.
                 * @param {Element} el - The scrollable element.
                 * @returns {Promise<boolean>} True if the element has reached scroll threshold.
                 */
                let canScrollElement = el => new Promise((resolve) => {
                    if (el.scrollTop + 5 >= 50) {
                        resolve(true);
                    } else {
                        scrollInstantly(el, 50);
                        setTimeout(() => {
                            resolve(el.scrollTop + 5 >= 50);
                        }, 10);
                    }
                });

                /**
                 * Scrolls an element by a given amount and waits 1 second.
                 * @param {Element} el - The scrollable element.
                 * @param {number} amount - Amount to scroll in pixels.
                 * @returns {Promise<void>}
                 */
                let scrollByAmount = (el, amount) => new Promise((resolve) => {
                    scrollInstantly(el, amount);
                    setTimeout(() => { resolve(); }, 1000);
                });

                // Find the scrollable ancestor of the table element
                let scrollableEl = document.querySelector(tableSelector);
                for (; scrollableEl && !await canScrollElement(scrollableEl);) {
                    scrollableEl = scrollableEl.parentElement;
                }

                console.log("Element with scrollbar");
                console.log(scrollableEl);

                if (!scrollableEl) {
                    return void sendResponse({ error: "No element with a scrollbar found" });
                }

                // Lists that only keep the rows near the window (virtual lists) drop the rows
                // scrolled past: each step stays within one window height so no row is skipped,
                // and new rows are told by the last row changing, as the row count may not.
                let isDocumentScroller = scrollableEl === document.scrollingElement || scrollableEl === document.documentElement;
                let visibleHeight = isDocumentScroller ? window.innerHeight : scrollableEl.clientHeight;
                let stepHeight = Math.min(1000, Math.max(200, visibleHeight - 100));
                let lastRowText = () => $(tableSelector).children().last().text();

                let newRowsAppeared = false;
                let scrollPositionUnchanged = false;
                let initialRowCount = $(tableSelector).children().length;
                let initialLastRowText = lastRowText();
                let lastScrollTop = scrollableEl.scrollTop;

                while (!newRowsAppeared && !scrollPositionUnchanged) {
                    await scrollByAmount(scrollableEl, stepHeight);
                    newRowsAppeared = initialRowCount !== $(tableSelector).children().length ||
                        initialLastRowText !== lastRowText();
                    scrollPositionUnchanged = scrollableEl.scrollTop === lastScrollTop;
                    lastScrollTop = scrollableEl.scrollTop;
                }

                sendResponse({});
            })(message.selector, sendResponse);
            return true;
        }

        if ("markButton" === message.action) {
            markButton(message.selector, message.kind, sendResponse);
            return true;
        }

        if ("loadMore" === message.action) {
            loadMoreRows(message, sendResponse);
            return true;
        }

        if (typeof message.action === "string" && message.action.indexOf("details") === 0) {
            handleDetailsMessage(message, sendResponse);
            return true;
        }

        sendResponse({});
    });
})();