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

    // --- Page details extraction: field picker and per-page extraction ---

    // Classes added to page elements by this extension; never used in generated selectors
    var OWN_CLASS_PREFIXES = ["tablescraper-", "openscraper-"];
    // Class names that describe a transient UI state rather than the element itself
    var STATE_CLASS_PATTERN = /^(is-|has-)|^(active|selected|hover|hovered|focus|focused|open|opened|closed|visible|hidden|current|disabled|checked|expanded|collapsed|show|showing|in)$/i;
    // Class names produced by CSS-in-JS tools, regenerated on every build
    var GENERATED_CLASS_PATTERN = /^(sc|css|jsx|emotion|svelte)-/i;
    // Attributes written for automated tests: the most stable anchors on a page
    var TEST_ATTRIBUTES = ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"];
    // Attributes that usually describe what an element is
    var DESCRIPTIVE_ATTRIBUTES = ["aria-label", "itemprop", "role", "name", "title", "alt", "placeholder", "type"];
    var MAX_FIELD_SELECTORS = 3;
    var MAX_ANCESTOR_DEPTH = 6;
    var MAX_SELECTOR_TRIES = 1000;
    var MEDIA_ELEMENTS = "img, video, audio";
    var PICKER_BLOCKED_EVENTS = ["click", "dblclick", "auxclick", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend", "submit"];
    var PICKER_HOVER_CLASS = "openscraper-hover";
    var PICKER_PICKED_CLASS = "openscraper-picked";
    var PICKER_ACTIVE_CLASS = "openscraper-picking";

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
     * Returns the absolute address of the link the element is, or is inside of.
     * @param {Element} element - Element to read.
     * @returns {string} Absolute URL, or "" (no link, or a javascript: link).
     */
    function getElementLink(element) {
        var anchor = element.closest("a[href], area[href]");
        if (!(anchor instanceof HTMLAnchorElement || anchor instanceof HTMLAreaElement)) return "";
        var href = (anchor.href || "").trim();
        return /^javascript:/i.test(href) ? "" : href;
    }

    /**
     * Tells whether two elements occupy the same box on screen (2 px tolerance).
     * @param {Element} first - First element.
     * @param {Element} second - Second element.
     * @returns {boolean} True if both boxes match.
     */
    function haveSameBox(first, second) {
        var a = first.getBoundingClientRect();
        var b = second.getBoundingClientRect();
        return Math.abs(a.left - b.left) <= 2 && Math.abs(a.top - b.top) <= 2 &&
            Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;
    }

    /**
     * Returns the absolute source of the image, video or audio element that the element is,
     * or that fills exactly the element's box (or is its only media when it has no text).
     * @param {Element} element - Element to read.
     * @returns {string} Absolute URL, or "" (no media, or an inline data: source).
     */
    function getElementImage(element) {
        var media = null;
        if (element.matches(MEDIA_ELEMENTS)) {
            media = element;
        } else {
            var candidates = element.querySelectorAll(MEDIA_ELEMENTS);
            for (var i = 0; i < candidates.length && !media; i++) {
                if (haveSameBox(candidates[i], element)) media = candidates[i];
            }
            if (!media && candidates.length === 1 && !getElementText(element)) media = candidates[0];
        }
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

        // Rank 1: descriptive attributes and other data attributes without digits
        DESCRIPTIVE_ATTRIBUTES.forEach(function(name) {
            var value = element.getAttribute(name);
            if (!value || value.length > 60) return;
            if (!/\d/.test(value)) {
                add(tag + buildAttributeSelector(name, value), 1);
            } else if (value.split(/\d/)[0].trim().length >= 3) {
                add(tag + buildAttributeSelector(name, value.split(/\d/)[0], true), 1);
            }
        });
        Array.prototype.forEach.call(element.attributes, function(attribute) {
            var name = attribute.name;
            if (name.indexOf("data-") !== 0 || TEST_ATTRIBUTES.indexOf(name) !== -1) return;
            if (/\d/.test(name) || !attribute.value || attribute.value.length > 40 || /\d/.test(attribute.value)) return;
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
     * Builds the structural path of an element: tag and position at each level, from the
     * closest ancestor with a meaningful id (or from body).
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
            parts.unshift(escapeCssIdentifier(node.localName) + ":nth-of-type(" + getTypeIndex(node) + ")");
            node = node.parentElement;
        }
        parts.unshift("body");
        return parts.join(" > ");
    }

    /**
     * Builds up to three selectors that each find the element first in the page, ordered from
     * the most meaningful to the most fragile. Alternatives avoid reusing the same step, so that
     * one page change does not break all of them; the last one is always the structural path.
     * @param {Element} element - Element picked by the user.
     * @returns {string[]} Selectors.
     */
    function buildFieldSelectors(element) {
        var found = [];
        var tries = 0;
        var ownSteps = getSelectorSteps(element).filter(function(step) { return step.rank <= 4; });

        ownSteps.forEach(function(step) {
            tries++;
            if (selectsFirst(step.selector, element)) {
                found.push({ selector: step.selector, score: step.rank + 0.5, parts: [step.selector] });
            }
        });

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
            var className = Array.prototype.find.call(node.classList, function(cls) { return !isOwnClass(cls); });
            if (className) return className.replace(/\./g, "_");
        }
        return element.localName;
    }

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
     * Tells whether an event comes from the picker's own floating panel.
     * @param {Event} event - DOM event.
     * @returns {boolean} True for panel events.
     */
    function isPickerPanelEvent(event) {
        return !!fieldPicker && event.composedPath().indexOf(fieldPicker.panelHost) !== -1;
    }

    /**
     * Moves the hover highlight to an element.
     * @param {Element|null} element - Element to highlight.
     */
    function setPickerHover(element) {
        if (fieldPicker.hovered) fieldPicker.hovered.classList.remove(PICKER_HOVER_CLASS);
        fieldPicker.hovered = element;
        if (element) element.classList.add(PICKER_HOVER_CLASS);
    }

    /**
     * Adds the fields of an element: its text, its link and its image, when present.
     * The same value kind of the same element is never added twice.
     * @param {Element} element - Element chosen by the user.
     */
    function pickElement(element) {
        if (!element || element === document.body || element === document.documentElement) return;
        var kinds = fieldPicker.pickedKinds.get(element) || [];
        var name = suggestFieldName(element);
        var selectors = null;
        var added = 0;
        [["text", ""], ["link", " link"], ["image", " image"]].forEach(function(entry) {
            var kind = entry[0];
            if (kinds.indexOf(kind) !== -1) return;
            var value = readFieldValue(element, kind);
            if (!value) return;
            selectors = selectors || buildFieldSelectors(element);
            pickedFields.push({ name: name + entry[1], kind: kind, selectors: selectors, sample: value.slice(0, 300) });
            kinds.push(kind);
            added++;
        });
        fieldPicker.pickedKinds.set(element, kinds);
        if (added) element.classList.add(PICKER_PICKED_CLASS);
        updatePickerPanel(added ? "" : "Nothing to extract from this element.");
        answerPickerPolls();
    }

    /**
     * Blocks the page's own reaction to clicks while picking, and picks on click.
     * @param {Event} event - Mouse, pointer, touch or submit event.
     */
    function onPickerBlockedEvent(event) {
        if (isPickerPanelEvent(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (event.type === "click" && event.target instanceof Element) {
            pickElement(fieldPicker.hovered && fieldPicker.hovered.contains(event.target) ? fieldPicker.hovered : event.target);
        }
    }

    /**
     * Highlights the element under the mouse.
     * @param {MouseEvent} event - Mouse over event.
     */
    function onPickerMouseOver(event) {
        if (isPickerPanelEvent(event)) {
            setPickerHover(null);
            return;
        }
        if (event.target instanceof Element && event.target !== fieldPicker.hovered) {
            fieldPicker.ancestorTrail = [];
            setPickerHover(event.target);
        }
    }

    /**
     * Keyboard: Up selects a larger element, Down goes back, Enter picks, Escape finishes.
     * @param {KeyboardEvent} event - Key down event.
     */
    function onPickerKeyDown(event) {
        var hovered = fieldPicker.hovered;
        var handled = true;
        if (event.key === "Escape") {
            stopFieldPicker();
        } else if (event.key === "ArrowUp" && hovered && hovered.parentElement &&
            hovered.parentElement !== document.body && hovered.parentElement !== document.documentElement) {
            fieldPicker.ancestorTrail.push(hovered);
            setPickerHover(hovered.parentElement);
        } else if (event.key === "ArrowDown" && fieldPicker.ancestorTrail.length) {
            setPickerHover(fieldPicker.ancestorTrail.pop());
        } else if (event.key === "Enter" && hovered) {
            pickElement(hovered);
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
     * Creates the small floating panel shown in the page while picking (isolated in a shadow root).
     * @returns {{host: Element, status: Element, count: Element}} Panel elements.
     */
    function createPickerPanel() {
        var host = document.createElement("div");
        host.setAttribute("data-openscraper-picker", "");
        host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;";
        var root = host.attachShadow({ mode: "open" });
        root.innerHTML =
            "<style>" +
            ".panel{font:13px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;color:#f1f5f9;background:#0f172a;" +
            "border:1px solid rgba(6,182,212,.45);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.45);padding:12px 14px;width:260px}" +
            ".title{font-weight:600;color:#06b6d4;margin:0 0 6px}" +
            ".help{color:#94a3b8;margin:0 0 8px}" +
            ".count{margin:0 0 8px}" +
            ".status{color:#f59e0b;margin:0 0 8px;min-height:0}" +
            ".row{display:flex;gap:8px}" +
            "button{font:inherit;border-radius:8px;padding:6px 10px;cursor:pointer;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#f1f5f9}" +
            "button.finish{background:#06b6d4;border-color:#06b6d4;color:#0f172a;font-weight:600;flex:1}" +
            "</style>" +
            "<div class='panel' role='dialog' aria-label='Open Scraper field picker'>" +
            "<p class='title'>Open Scraper: pick fields</p>" +
            "<p class='help'>Click the data to extract. Up/Down arrows select a larger or smaller element, Enter adds it, Escape finishes.</p>" +
            "<p class='count'></p><p class='status'></p>" +
            "<div class='row'><button type='button' class='move'>Move</button><button type='button' class='finish'>Finish picking</button></div>" +
            "</div>";
        root.querySelector(".finish").addEventListener("click", function() { stopFieldPicker(); });
        root.querySelector(".move").addEventListener("click", function() {
            var onRight = host.style.right !== "auto";
            host.style.right = onRight ? "auto" : "16px";
            host.style.left = onRight ? "16px" : "auto";
        });
        document.documentElement.appendChild(host);
        return { host: host, status: root.querySelector(".status"), count: root.querySelector(".count") };
    }

    /**
     * Refreshes the counter and status line of the picker panel.
     * @param {string} status - Status text ("" to clear).
     */
    function updatePickerPanel(status) {
        if (!fieldPicker) return;
        fieldPicker.panel.count.textContent = pickedFields.length + (pickedFields.length === 1 ? " field" : " fields") + " picked";
        fieldPicker.panel.status.textContent = status || "";
    }

    /**
     * Removes the marks left on picked elements.
     */
    function clearPickedMarks() {
        document.querySelectorAll("." + PICKER_PICKED_CLASS).forEach(function(element) {
            element.classList.remove(PICKER_PICKED_CLASS);
        });
    }

    /**
     * Turns on the field picker: hover highlight, click to pick, page clicks blocked.
     */
    function startFieldPicker() {
        if (fieldPicker) return;
        clearPickedMarks();
        pickedFields = [];
        var panel = createPickerPanel();
        fieldPicker = {
            hovered: null,
            ancestorTrail: [],
            pickedKinds: new Map(),
            panel: panel,
            panelHost: panel.host
        };
        document.documentElement.classList.add(PICKER_ACTIVE_CLASS);
        PICKER_BLOCKED_EVENTS.forEach(function(type) {
            window.addEventListener(type, onPickerBlockedEvent, true);
        });
        window.addEventListener("mouseover", onPickerMouseOver, true);
        window.addEventListener("keydown", onPickerKeyDown, true);
        updatePickerPanel("");
        window.focus();
    }

    /**
     * Turns off the field picker. Picked elements stay marked until the next start.
     */
    function stopFieldPicker() {
        if (!fieldPicker) return;
        PICKER_BLOCKED_EVENTS.forEach(function(type) {
            window.removeEventListener(type, onPickerBlockedEvent, true);
        });
        window.removeEventListener("mouseover", onPickerMouseOver, true);
        window.removeEventListener("keydown", onPickerKeyDown, true);
        setPickerHover(null);
        fieldPicker.panelHost.remove();
        document.documentElement.classList.remove(PICKER_ACTIVE_CLASS);
        fieldPicker = null;
        answerPickerPolls();
    }

    /**
     * Extracts one value per field from the current page: for each field, the first selector
     * that finds an element wins; a field with no match gives "".
     * @param {Array<{kind: string, selectors: string[]}>} fields - Fields to extract.
     * @returns {string[]} Values, in field order.
     */
    function extractPageDetails(fields) {
        return (fields || []).map(function(field) {
            var selectors = Array.isArray(field.selectors) ? field.selectors : [];
            for (var i = 0; i < selectors.length; i++) {
                var element = null;
                try {
                    element = document.querySelector(selectors[i]);
                } catch (e) {
                    element = null;
                }
                if (element) return readFieldValue(element, field.kind);
            }
            return "";
        });
    }

    /**
     * Handles the page details messages sent by the scraping window.
     * @param {Object} message - Message with an action starting with "details".
     * @param {Function} sendResponse - Message callback.
     */
    function handleDetailsMessage(message, sendResponse) {
        switch (message.action) {
            case "detailsPing":
                sendResponse({ ready: true, url: window.location.href });
                break;
            case "detailsPickerStart":
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
            case "detailsClearMarks":
                clearPickedMarks();
                sendResponse({ ok: true });
                break;
            case "detailsExtract":
                try {
                    sendResponse({ ok: true, url: window.location.href, values: extractPageDetails(message.fields) });
                } catch (e) {
                    sendResponse({ error: String(e && e.message || e) });
                }
                break;
            default:
                sendResponse({});
        }
    }

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