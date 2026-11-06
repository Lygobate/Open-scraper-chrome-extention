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
     * @returns {{ children: jQuery, goodClasses: string[] }}
     *   An object containing:
     *   - `children`: jQuery collection of the best-matching child elements.
     *   - `goodClasses`: Array of the dominant class combinations found.
     */
    function findRepeatingChildren(containerElement) {
        var $children = $(containerElement).children();
        var classComboCounts = {};
        var individualClassCounts = {};

        $children.each(function() {
            if (!["script", "img", "meta", "style"].includes(this.nodeName.toLowerCase()) && $(this).text().trim().length) {
                var sortedClasses = getElementClasses($(this)).sort();
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
                    matches |= hasAllClasses($this, combo);
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
     * @returns {boolean} True if the element has all the specified classes.
     */
    function hasAllClasses($el, classCombo) {
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

    // Event listener references (stored to allow removal)
    var onElementClick, onElementMouseEnter;

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
                    var nodePath = parentPath + "/" + rawNode.nodeName.toLowerCase() + getElementClasses($node).map(cls => "." + cls).join("");
                    pathHistory.push(nodePath);
                    recordCellValue(
                        $node.clone().children().remove().end().text().trim(),
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

        sendResponse({
            data: extractedRows,
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
                if (typeof this.id === "string" && this.id.trim() && !this.id.match(/\d+/g)) {
                    tag += escapeCssSelectorPart(this.id, "#");
                } else if (typeof this.className === "string" && this.className.trim()) {
                    tag += escapeCssSelectorPart(this.className).replace(/\s+/g, ".");
                }
                return tag;
            }).get().join(">");
    }

    /**
     * Activates interactive "Next button" picking mode.
     * Highlights elements on hover and captures the user's click
     * to record the selector of the chosen "Next page" button.
     *
     * @param {Function} sendResponse - Chrome message callback to return the chosen selector.
     */
    function activateNextButtonPickingMode(sendResponse) {
        window.focus();

        onElementMouseEnter = function(event) {
            $(this).is($(event.target)) && (
                $("*").removeClass("tablescraper-hover"),
                $(buildCssSelectorForElement(this)).last().addClass("tablescraper-hover")
            );
        };

        onElementClick = function(event) {
            event.preventDefault();
            (function captureClickedElement(clickEvent) {
                $("*").off("click", onElementClick).off("mouseenter", onElementMouseEnter);
                $(".tablescraper-hover").removeClass("tablescraper-hover");
                $(".tablescraper-next-button").removeClass("tablescraper-next-button");
                var selector = buildCssSelectorForElement(clickEvent.target);
                $(clickEvent.target).addClass("tablescraper-next-button");
                console.log("Next button selector:", selector);
                sendResponse({ selector: selector });
            })(event);
            return false;
        };

        $("*").click(onElementClick).on("mouseenter", onElementMouseEnter);
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

        $("*").off("click", onElementClick).off("mouseenter", onElementMouseEnter);

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
    var MAX_FIELD_SELECTORS = 3;
    var MAX_ANCESTOR_DEPTH = 6;
    var MAX_SELECTOR_TRIES = 1000;
    var MEDIA_ELEMENTS = "img, video, audio";
    // Media inside a hovered element that are compared with its box (large containers hold many)
    var MAX_MEDIA_CANDIDATES = 24;
    // Port kept open by the scraping window while it uses the page: when the window goes away,
    // the picker, highlights and overlay it left are removed
    var DETAILS_PORT_NAME = "openscraper-details-session";
    // Attribute of the element that hosts everything this extension draws in the page
    var LAYER_ATTRIBUTE = "data-openscraper-layer";
    // Space between a highlighted element and its info label, and between the label and the window edges
    var LABEL_GAP = 4;
    // Longest value kept in the info label (the label cuts it visually with an ellipsis anyway)
    var LABEL_VALUE_LENGTH = 200;
    // Boxes are placed again at this interval while shown, for pages that move on their own
    var BOX_REFRESH_MS = 500;

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

    /**
     * Trims a text and collapses its inner whitespace to single spaces.
     * @param {string} text - Raw text.
     * @returns {string} Normalized text.
     */
    function normalizeWhitespace(text) {
        return (text || "").replace(/\s+/g, " ").trim();
    }

    /**
     * Reads the visible text of an element: typed value for form fields, chosen label for a
     * drop-down list, rendered text otherwise. Non-HTML elements (SVG) have no text.
     * @param {Element} element - Element to read.
     * @returns {string} Normalized text, or "".
     */
    function getElementText(element) {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            return normalizeWhitespace(element.value);
        }
        if (element instanceof HTMLSelectElement) {
            var option = element.options[element.selectedIndex];
            return option ? normalizeWhitespace(option.text) : "";
        }
        if (!(element instanceof HTMLElement)) return "";
        return normalizeWhitespace(element.innerText);
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
     * Tells whether a class looks stable across pages: no digits, not a state, not generated.
     * @param {string} className - Class name.
     * @returns {boolean} True for a stable class.
     */
    function isStableClass(className) {
        return className.length > 1 && className.length <= 40 && !/\d/.test(className) &&
            /^[a-zA-Z_-][\w-]*$/.test(className) && !isOwnClass(className) &&
            !STATE_CLASS_PATTERN.test(className) && !GENERATED_CLASS_PATTERN.test(className);
    }

    /**
     * Tells whether an id looks like a word: no digits and few changes between lower case,
     * upper case and other characters (generated ids switch often).
     * @param {string} id - Element id.
     * @returns {boolean} True for a meaningful id.
     */
    function isWordLikeId(id) {
        if (!id || id.length > 40 || /\d/.test(id)) return false;
        var changes = 0;
        var previous = null;
        for (var i = 0; i < id.length; i++) {
            var ch = id[i];
            var type = ch >= "a" && ch <= "z" ? "lower" : (ch >= "A" && ch <= "Z" ? "upper" : "other");
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

        // Rank 3: stable classes, alone then by pairs
        var classes = Array.prototype.filter.call(element.classList, isStableClass).slice(0, 4);
        classes.forEach(function(className) {
            add(tag + "." + escapeCssIdentifier(className), 3);
        });
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
        // Clicks and presses on the layer never reach the page's own listeners
        ["click", "dblclick", "auxclick", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend", "contextmenu"].forEach(function(type) {
            root.addEventListener(type, function(event) { event.stopPropagation(); });
        });
        document.documentElement.appendChild(host);
        document.addEventListener("scroll", scheduleLayerPlacement, true);
        window.addEventListener("resize", scheduleLayerPlacement);
        layerTimer = setInterval(scheduleLayerPlacement, BOX_REFRESH_MS);
        return layer;
    }

    /**
     * Removes the layer when nothing is shown in it any more.
     */
    function releaseLayerIfIdle() {
        if (!layer || fieldPicker || layerBoxes.length || (layer.busy && !layer.busy.hidden)) return;
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
     * Places every box over its element, in page coordinates (boxes follow the page when it scrolls).
     */
    function placeLayerBoxes() {
        if (!layer || !layerBoxes.length) return;
        var origin = layer.host.getBoundingClientRect();
        layerBoxes.forEach(function(entry) {
            var rect = entry.element.getBoundingClientRect();
            var hidden = !entry.element.isConnected || (rect.width === 0 && rect.height === 0);
            entry.box.style.display = hidden ? "none" : "block";
            if (hidden) return;
            entry.box.style.left = (rect.left - origin.left) + "px";
            entry.box.style.top = (rect.top - origin.top) + "px";
            entry.box.style.width = rect.width + "px";
            entry.box.style.height = rect.height + "px";
        });
    }

    /**
     * Draws a box over an element.
     * @param {Element} element - Element to highlight.
     * @param {"hover"|"picked"|"found"} kind - Box style.
     * @returns {Object} Box entry.
     */
    function addLayerBox(element, kind) {
        var entry = { element: element, kind: kind, box: createLayerElement("div", "box " + kind, getLayer().boxes) };
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
    function showFoundElements(elements) {
        clearLayerBoxes("found");
        elements.forEach(function(element) { addLayerBox(element, "found"); });
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
            handled = false;
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
        finish.addEventListener("click", function() { stopFieldPicker(); });

        // Dragging by the header keeps the panel inside the window
        var drag = null;
        head.addEventListener("pointerdown", function(event) {
            var rect = panel.getBoundingClientRect();
            drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
            head.setPointerCapture(event.pointerId);
            event.preventDefault();
        });
        head.addEventListener("pointermove", function(event) {
            if (!drag) return;
            var maxLeft = document.documentElement.clientWidth - panel.offsetWidth;
            var maxTop = document.documentElement.clientHeight - panel.offsetHeight;
            panel.style.right = "auto";
            panel.style.left = Math.max(0, Math.min(maxLeft, event.clientX - drag.dx)) + "px";
            panel.style.top = Math.max(0, Math.min(maxTop, event.clientY - drag.dy)) + "px";
        });
        var endDrag = function() { drag = null; };
        head.addEventListener("pointerup", endDrag);
        head.addEventListener("pointercancel", endDrag);
        return panel;
    }

    /**
     * Turns on the field picker: light dim, crosshair overlay catching the mouse (the page gets
     * no click or hover), hover box with its info label, and the picker panel.
     */
    function startFieldPicker() {
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
            pickedKinds: new Map(),
            port: null
        };
        parts.catcher.addEventListener("mousemove", onPickerPointerMove);
        parts.catcher.addEventListener("click", onPickerClick);
        window.addEventListener("keydown", onPickerKeyDown, true);
        window.focus();
    }

    /**
     * Turns off the field picker and removes everything it drew.
     */
    function stopFieldPicker() {
        if (!fieldPicker) return;
        cancelAnimationFrame(fieldPicker.moveFrame);
        window.removeEventListener("keydown", onPickerKeyDown, true);
        if (layer) {
            layer.catcher.removeEventListener("mousemove", onPickerPointerMove);
            layer.catcher.removeEventListener("click", onPickerClick);
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

    /**
     * Finds the element of a field: the first selector that matches wins.
     * @param {{selectors: string[]}} field - Field.
     * @returns {Element|null} Element, or null.
     */
    function findFieldElement(field) {
        var selectors = field && Array.isArray(field.selectors) ? field.selectors : [];
        for (var i = 0; i < selectors.length; i++) {
            var element = null;
            try {
                element = document.querySelector(selectors[i]);
            } catch (e) {
                element = null;
            }
            if (element) return element;
        }
        return null;
    }

    /**
     * Extracts one value per field from the current page: for each field, the first selector
     * that finds an element wins; a field with no match gives "".
     * @param {Array<{kind: string, selectors: string[]}>} fields - Fields to extract.
     * @returns {string[]} Values, in field order.
     */
    function extractPageDetails(fields) {
        return (fields || []).map(function(field) {
            var element = findFieldElement(field);
            return element ? readFieldValue(element, field.kind) : "";
        });
    }

    /**
     * Tells whether one of the fields' first selectors finds an element with a box on screen.
     * @param {Array<{selectors: string[]}>} fields - Fields.
     * @returns {boolean} True when one is shown.
     */
    function isAnyFieldShown(fields) {
        return fields.some(function(field) {
            var element = findFieldElement({ selectors: (field.selectors || []).slice(0, 1) });
            if (!element) return false;
            var rect = element.getBoundingClientRect();
            return rect.width > 0 || rect.height > 0;
        });
    }

    /**
     * Waits until one of the fields is shown in the page (pages that draw their content late),
     * watching the page's changes, or until the time runs out.
     * @param {Array<{selectors: string[]}>} fields - Fields.
     * @param {number} timeoutMs - Longest wait.
     * @returns {Promise<boolean>} True when a field is shown.
     */
    function waitForAnyField(fields, timeoutMs) {
        return new Promise(function(resolve) {
            if (isAnyFieldShown(fields)) return resolve(true);
            var done = false;
            var finish = function(shown) {
                if (done) return;
                done = true;
                observer.disconnect();
                clearInterval(poll);
                clearTimeout(timer);
                resolve(shown);
            };
            var check = function() {
                if (isAnyFieldShown(fields)) finish(true);
            };
            var observer = new MutationObserver(check);
            observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
            // Layout changes (an image that loads, a style that applies) are not mutations
            var poll = setInterval(check, 100);
            var timer = setTimeout(function() { finish(false); }, Math.max(0, timeoutMs || 0));
        });
    }

    /**
     * Highlights the elements found for the fields (and scrolls to them when none is in view).
     * @param {Array<{selectors: string[]}>} fields - Fields.
     * @returns {boolean[]} Whether each field was found.
     */
    function highlightFields(fields) {
        var found = [];
        var flags = fields.map(function(field) {
            var element = findFieldElement(field);
            if (element && found.indexOf(element) === -1) found.push(element);
            return !!element;
        });
        showFoundElements(found);
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
                sendResponse({ ready: true, url: window.location.href, status: getPageHttpStatus() });
                break;
            case "detailsPickerStart":
                clearLayerBoxes("found");
                setBusyOverlay(false);
                startFieldPicker();
                sendResponse({ ok: true, url: window.location.href });
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
                // Waits for the page to show a field, reads one row and highlights what was found
                (function(fields) {
                    waitForAnyField(fields, message.waitMs).then(function() {
                        try {
                            sendResponse({
                                ok: true,
                                url: window.location.href,
                                values: extractPageDetails(fields),
                                found: message.highlight === false ? [] : highlightFields(fields)
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
                    var element = findFieldElement(field);
                    if (element) {
                        showFoundElements([element]);
                        var entry = layerBoxes[layerBoxes.length - 1];
                        setTimeout(function() {
                            removeLayerBoxes(function(box) { return box === entry; });
                        }, Math.max(200, message.durationMs || 1000));
                    }
                    sendResponse({ ok: true, found: !!element });
                })(message.field);
                break;
            case "detailsClearHighlights":
                clearLayerBoxes("found");
                sendResponse({ ok: true });
                break;
            case "detailsBusy":
                setBusyOverlay(!!message.on);
                sendResponse({ ok: true });
                break;
            case "detailsExtract":
                try {
                    if (typeof message.busy === "boolean") setBusyOverlay(message.busy);
                    var status = getPageHttpStatus();
                    if (status >= 400) {
                        // Error page: its text is not the data of the page that was asked for
                        sendResponse({ ok: false, status: status, url: window.location.href });
                    } else {
                        sendResponse({ ok: true, status: status, url: window.location.href, values: extractPageDetails(message.fields) });
                    }
                } catch (e) {
                    sendResponse({ error: String(e && e.message || e) });
                }
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

        if ("applyConfig" === message.action) {
            // Apply a saved scraping configuration to the page
            (function applyConfig(config, sendResponse) {
                clearAllHighlights();
                $(".tablescraper-hover").removeClass("tablescraper-hover");
                $(".tablescraper-next-button").removeClass("tablescraper-next-button");

                var $tableEl = findElementBySelector(config.tableSelector);
                if ($tableEl && $tableEl.length) {
                    var rawEl = $tableEl.get(0);
                    var rowInfo = findRepeatingChildren(rawEl);
                    detectedTables = [{
                        table: rawEl,
                        goodClasses: rowInfo.goodClasses,
                        children: rowInfo.children,
                        selector: config.tableSelector,
                        robot: null
                    }];
                    currentTableIndex = 0;
                    highlightSelectedTable();

                    var nextSelector = null;
                    var paginationType = config.pagination?.type ?? null;
                    if ("nextButton" === paginationType) {
                        nextSelector = config.pagination.selector;
                        localStorage.setItem("nextSelector:" + window.location.hostname, nextSelector);
                    }

                    sendResponse({
                        tableId: currentTableIndex,
                        tableSelector: detectedTables[currentTableIndex].selector,
                        robot: detectedTables[currentTableIndex].robot,
                        href: window.location.href,
                        hostname: window.location.hostname,
                        nextSelector: nextSelector,
                        paginationType: paginationType
                    });
                } else {
                    sendResponse({ error: "Table not found for selector: " + config.tableSelector });
                }
            })(message.config, sendResponse);
            return true;
        }

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
            activateNextButtonPickingMode(sendResponse);
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
                        el.scrollTop = el.scrollTop + 50;
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
                    el.scrollTop = el.scrollTop + amount;
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

                let newRowsAppeared = false;
                let scrollPositionUnchanged = false;
                let initialRowCount = $(tableSelector).children().length;
                let lastScrollTop = scrollableEl.scrollTop;

                while (!newRowsAppeared && !scrollPositionUnchanged) {
                    await scrollByAmount(scrollableEl, 1000);
                    newRowsAppeared = initialRowCount !== $(tableSelector).children().length;
                    scrollPositionUnchanged = scrollableEl.scrollTop === lastScrollTop;
                    lastScrollTop = scrollableEl.scrollTop;
                }

                sendResponse({});
            })(message.selector, sendResponse);
            return true;
        }

        if ("markNextButton" === message.action) {
            clickNextButton(message.selector, sendResponse, true);
            return true;
        }

        if (typeof message.action === "string" && message.action.indexOf("details") === 0) {
            handleDetailsMessage(message, sendResponse);
            return true;
        }

        sendResponse({});
    });
})();