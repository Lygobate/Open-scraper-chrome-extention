(() => {
    "use strict";

    const chromeInstance = chrome;

    /**
     * Converts a JS date value to an Excel date serial number.
     * @param {string} dateStr - Date as text.
     * @param {boolean} is1904 - Use Excel 1904 date system.
     * @returns {number} Serial number representing the date in Excel.
     */
    function dateToExcelSerial(dateStr, is1904) {
        let serialDate = Date.parse(dateStr);
        if (is1904) {
            serialDate += 1462;
        }
        return (serialDate - new Date(Date.UTC(1899, 11, 30))) / 864e5;
    }

    /**
     * Generates a binary XLSX file from the Open Scraper table structure.
     * @param {Object} extractedData - Extracted data with headers (fields) and rows (data).
     * @param {string} sheetName - Name of the Excel worksheet.
     * @returns {string} Binary XLSX file encoded as a string.
     */
    function generateXlsxBinary(extractedData, sheetName) {
        extractedData.data.unshift(extractedData.fields);
        
        const workbook = new function WBook() {
            if (!(this instanceof WBook)) return new WBook();
            this.SheetNames = [];
            this.Sheets = {};
        }();

        const sheetData = ((data) => {
            const cells = {};
            const range = {
                s: { c: 1e7, r: 1e7 },
                e: { c: 0, r: 0 }
            };

            for (let rowIdx = 0; rowIdx !== data.length; ++rowIdx) {
                for (let colIdx = 0; colIdx !== data[rowIdx].length; ++colIdx) {
                    if (range.s.r > rowIdx) range.s.r = rowIdx;
                    if (range.s.c > colIdx) range.s.c = colIdx;
                    if (range.e.r < rowIdx) range.e.r = rowIdx;
                    if (range.e.c < colIdx) range.e.c = colIdx;

                    const cellVal = { v: data[rowIdx][colIdx] };
                    if (cellVal.v !== null) {
                        const cellRef = XLSX.utils.encode_cell({ c: colIdx, r: rowIdx });
                        
                        if (typeof cellVal.v === "number") {
                            cellVal.t = "n";
                        } else if (typeof cellVal.v === "boolean") {
                            cellVal.t = "b";
                        } else if (cellVal.v instanceof Date) {
                            cellVal.t = "n";
                            cellVal.z = XLSX.SSF._table[14];
                            cellVal.v = dateToExcelSerial(cellVal.v);
                        } else {
                            cellVal.t = "s";
                        }
                        cells[cellRef] = cellVal;
                    }
                }
            }

            if (range.s.c < 1e7) {
                cells["!ref"] = XLSX.utils.encode_range(range);
            }
            return cells;
        })(extractedData.data);

        workbook.SheetNames.push(sheetName);
        workbook.Sheets[sheetName] = sheetData;

        return XLSX.write(workbook, {
            type: "binary"
        });
    }

    // --- Global State Variables ---

    // Active tab data extracted from the popup URL
    const currentTab = {
        id: parseInt(getQueryParam("tabid")),
        url: getQueryParam("url")
    };

    // Current scraping state and active configuration
    const scrapingState = {};
    const PREVIEW_LIMIT = 1000;
    const robotsTxtRules = null;

    /**
     * Parses the popup's GET search URL to extract a parameter value.
     * @param {string} paramName - Parameter name.
     * @returns {string} Decoded parameter value.
     */
    function getQueryParam(paramName) {
        const paramsArray = window.location.search.substring(1).split("&");
        for (let i = 0; i < paramsArray.length; i++) {
            const pair = paramsArray[i].split("=");
            if (decodeURIComponent(pair[0]) === paramName) {
                return decodeURIComponent(pair[1]);
            }
        }
    }

    /**
     * Updates the text of a status info container in the popup.
     * @param {string} message - Information or error message.
     * @param {string} elementId - Container DOM ID.
     * @param {boolean} [isStopAction=false] - Indicates whether to stop scraping.
     */
    function showStatusMessage(message, elementId, isStopAction) {
        if (message === "") {
            return $("#" + elementId).hide();
        }
        $("#" + elementId).show().text(message);
        if (isStopAction) {
            stopScraping();
        }
    }

    /**
     * Analyzes raw object data to generate a clean tabular structure
     * by choosing the most optimal paths for column properties.
     * @param {Array<Object>} rawData - Raw object rows read from the target page.
     * @returns {Object} Object containing the final list of columns (fields) and the data matrix (data).
     */
    function findOptimalDataFields(rawData) {
        const rowCount = rawData.length;
        const selectorLengthsCache = {
            "": Infinity
        };
        const fieldCounts = {};
        const detectedFields = {};
        const fieldNamePaths = {};
        const fieldMatchRates = {};

        function getSelectorLength(selector) {
            if (!(selector in selectorLengthsCache)) {
                selectorLengthsCache[selector] = $(
                    "." + selector.replace(/[!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~]/g, "\\$&")
                ).length;
            }
            return selectorLengthsCache[selector];
        }

        // Count the occurrence of each field in the raw objects
        rawData.forEach(function(row) {
            for (const key in row) {
                if (!(key in fieldCounts)) fieldCounts[key] = 0;
                fieldCounts[key]++;
            }
        });

        // Determine clean and unique headers
        Object.keys(fieldCounts)
            .map(function(key) {
                return [fieldCounts[key], key];
            })
            .forEach(function([count, key]) {
                let cleanHeader = "";
                let optimalLen = Infinity;

                key.split(" ")[0].split("/").slice(1).reverse().forEach(function(part) {
                    part.split(".").slice(1).forEach(function(subPart) {
                        const len = getSelectorLength(subPart);
                        if (!(optimalLen < 2 * rowCount || len >= optimalLen)) {
                            cleanHeader = subPart;
                            optimalLen = len;
                        }
                    });
                });

                const suffix = key.split(" ")[1];
                if (suffix && isNaN(suffix)) {
                    cleanHeader += " " + suffix;
                }

                let subIndex = 0;
                const rowPresentMap = rawData.map(row => key in row);

                if (cleanHeader in detectedFields) {
                    detectedFields[cleanHeader].forEach(function(existingMap, idx) {
                        if (!subIndex) {
                            let isDisjoint = true;
                            existingMap.forEach(function(val, innerIdx) {
                                isDisjoint &= !(rowPresentMap[innerIdx] && val);
                            });
                            if (isDisjoint) {
                                subIndex = idx + 1;
                            }
                        }
                    });

                    if (subIndex) {
                        detectedFields[cleanHeader][subIndex - 1] = detectedFields[cleanHeader][subIndex - 1].map(
                            function(val, idx) {
                                return rowPresentMap[idx] || val;
                            }
                        );
                    } else {
                        detectedFields[cleanHeader].push(rowPresentMap);
                        subIndex = detectedFields[cleanHeader].length;
                    }

                    if (subIndex > 1) {
                        cleanHeader += " " + subIndex;
                    }
                } else {
                    detectedFields[cleanHeader] = [rowPresentMap];
                }

                if (!(cleanHeader in fieldNamePaths)) {
                    fieldNamePaths[cleanHeader] = [];
                }
                fieldNamePaths[cleanHeader].push(key);

                if (!(cleanHeader in fieldMatchRates)) {
                    fieldMatchRates[cleanHeader] = 0;
                }
                fieldMatchRates[cleanHeader] += count;
            });

        const seenValuesCache = {};
        const optimalFields = Object.keys(fieldNamePaths).filter(function(field) {
            const valuesArray = [];
            const isIgnored = field in scrapingState.config.deletedFields;
            if (isIgnored) return false;

            const duplicateValuesMap = {};
            rawData.forEach(function(row) {
                let cellVal;
                for (let i = 0; i < fieldNamePaths[field].length; i++) {
                    const keyPath = fieldNamePaths[field][i];
                    if (keyPath in row) {
                        cellVal = row[keyPath];
                        break;
                    }
                }
                if (cellVal !== undefined) {
                    if (!(cellVal in duplicateValuesMap)) duplicateValuesMap[cellVal] = 0;
                    duplicateValuesMap[cellVal]++;
                }
                valuesArray.push(cellVal);
            });

            // Eliminate columns that have a single constant value for the whole table
            const distinctValues = Object.keys(duplicateValuesMap);
            if (distinctValues.length && duplicateValuesMap[distinctValues[0]] === rowCount) {
                return false;
            }

            // Eliminate redundant columns (containing exactly the same value pattern)
            const cacheKey = JSON.stringify(valuesArray);
            if (cacheKey in seenValuesCache) {
                return false;
            }
            seenValuesCache[cacheKey] = 1;

            // Eliminate empty columns or those with very low fill rate (< 20%)
            if (fieldMatchRates[field] < 0.2 * rowCount) {
                return false;
            }

            return true;
        });

        const tabularResult = {
            fields: optimalFields,
            data: rawData.map(function(row) {
                return optimalFields.map(function(field) {
                    for (let i = 0; i < fieldNamePaths[field].length; i++) {
                        const keyPath = fieldNamePaths[field][i];
                        if (keyPath in row) return row[keyPath];
                    }
                    return "";
                });
            })
        };

        return tabularResult;
    }

    /**
     * Renames header fields according to user custom modifications.
     * @param {string[]} fields - Original field names.
     * @returns {string[]} List of names after renaming.
     */
    function applyHeaderRenames(fields) {
        return fields.map(function(field) {
            return field in scrapingState.config.headers ? scrapingState.config.headers[field] : field;
        });
    }

    /**
     * Structures raw data into a clean tabular form ready for export.
     * @param {Array<Object>} rawData - Extracted raw rows.
     * @returns {Object} Formatted data with remapped headers.
     */
    function prepareDataForExport(rawData) {
        const optimalData = findOptimalDataFields(rawData);
        optimalData.fields = applyHeaderRenames(optimalData.fields);
        return optimalData;
    }

    /**
     * Converts a raw binary string to a byte ArrayBuffer.
     * @param {string} binaryStr - Binary string.
     * @returns {ArrayBuffer} The data buffer.
     */
    function stringToArrayBuffer(binaryStr) {
        const buffer = new ArrayBuffer(binaryStr.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i !== binaryStr.length; ++i) {
            view[i] = 255 & binaryStr.charCodeAt(i);
        }
        return buffer;
    }

    /**
     * Downloads a table as a CSV file. Array cells are flattened to a quoted CSV string.
     * The input table is not modified.
     * @param {{fields: string[], data: Array<Array<*>>}} table - Headers and rows to export.
     * @param {string} fileName - Name of the downloaded file.
     * @param {{bom: boolean}} [options] - With bom, the file starts with a UTF-8 byte order mark
     *     and ends with a line break, so that spreadsheet apps read accented text correctly.
     */
    function exportCsv(table, fileName, options) {
        const csvOptions = { quotes: true, escapeChar: '"' };
        const flattened = {
            fields: table.fields.slice(),
            data: table.data.map(row => row.map(cell => (
                Array.isArray(cell) ? Papa.unparse([cell], csvOptions) : cell
            )))
        };
        const text = Papa.unparse(flattened, csvOptions);
        const withBom = !!(options && options.bom);
        saveAs(
            new Blob([withBom ? "\uFEFF" + text + "\r\n" : text], { type: "application/octet-stream" }),
            fileName
        );
    }

    /**
     * Downloads a table as an XLSX file. The input table is not modified.
     * @param {{fields: string[], data: Array<Array<*>>}} table - Headers and rows to export.
     * @param {string} fileName - Name of the downloaded file.
     * @param {string} sheetName - Name of the Excel worksheet.
     */
    function exportXlsx(table, fileName, sheetName) {
        const copy = { fields: table.fields.slice(), data: table.data.slice() };
        saveAs(
            new Blob(
                [stringToArrayBuffer(generateXlsxBinary(copy, sheetName))],
                { type: "application/octet-stream" }
            ),
            fileName
        );
    }

    /**
     * Copies a table to the clipboard as tab-separated values. The input table is not modified.
     * @param {{fields: string[], data: Array<Array<*>>}} table - Headers and rows to copy.
     */
    function copyTsv(table) {
        const tsvString = Papa.unparse({ fields: table.fields, data: table.data }, {
            delimiter: "\t"
        });
        const copyListener = function(e) {
            e.preventDefault();
            if (e.clipboardData) {
                e.clipboardData.setData("text/plain", tsvString);
            } else if (window.clipboardData) {
                window.clipboardData.setData("Text", tsvString);
            }
        };
        window.addEventListener("copy", copyListener);
        document.execCommand("copy");
        window.removeEventListener("copy", copyListener);
    }

    /**
     * Renders the interactive data grid using the Handsontable library.
     */
    function renderHandsontable() {
        const previewData = findOptimalDataFields(scrapingState.data);
        previewData.data = previewData.data.slice(0, PREVIEW_LIMIT);
        scrapingState.previewLength = previewData.data.length;

        const scrollTop = $(".wtHolder").scrollTop();
        const scrollLeft = $(".wtHolder").scrollLeft();
        let hasRendered = false;

        $("#hot").empty();

        const footerEl = document.querySelector(".popup-footer");
        const footerHeight = footerEl ? footerEl.getBoundingClientRect().height : 52;

        new Handsontable($("#hot").get(0), {
            data: previewData.data,
            colHeaders: applyHeaderRenames(previewData.fields),
            wordWrap: false,
            manualColumnResize: true,
            width: $(window).width() - 20,
            height: $(window).height() - $("#hot").get(0).getBoundingClientRect().y - footerHeight,
            afterRender: function() {
                if (!hasRendered) {
                    hasRendered = true;
                    $(".wtHolder").scrollTop(scrollTop);
                    $(".wtHolder").scrollLeft(scrollLeft);
                }
            },
            modifyColWidth: function(width, colIdx) {
                if (width > 200) return 200;
            },
            afterGetColHeader: function(colIdx, headerCell) {
                if (colIdx !== -1) {
                    if ($(headerCell).children().length > 1) {
                        $(".hot-header", headerCell).remove();
                    } else {
                        $(headerCell).click(function() {
                            const self = this;
                            setTimeout(function() {
                                $(".header-input", self).trigger("focus");
                            }, 20);
                        });
                    }

                    const $headerContainer = $("<div>", { class: "hot-header" });
                    const $headerInput = $("<div>", {
                        class: "header-input",
                        contenteditable: "true"
                    });

                    if (scrapingState.config.headers[previewData.fields[colIdx]]) {
                        $headerInput.text(scrapingState.config.headers[previewData.fields[colIdx]]);
                    } else {
                        $headerInput.text(headerCell.firstChild.textContent);
                    }

                    $headerContainer.append($headerInput);

                    // Column deletion button
                    $headerContainer.append(
                        $("<span>", {
                            class: "glyphicon glyphicon-remove remove-column",
                            style: "padding-top: 2.5px"
                        }).click(function() {
                            scrapingState.config.deletedFields[previewData.fields[colIdx]] = true;
                            saveCurrentConfig();
                            $("#resetColumns").show();
                            renderHandsontable();
                        })
                    );

                    $headerInput.get(0).addEventListener("input", function() {
                        scrapingState.config.headers[previewData.fields[colIdx]] = $headerInput.text();
                        saveCurrentConfig();
                    });

                    headerCell.firstChild.style.display = "none";
                    $(headerCell).append($headerContainer);
                }
            },
            beforeOnCellMouseDown: function(event, coords) {
                if (coords.row < 0) {
                    event.stopImmediatePropagation();
                }
            }
        });
    }

    /**
     * Saves the current table's active configuration to the extension's local storage.
     */
    function saveCurrentConfig() {
        localStorage.setItem(scrapingState.configName, JSON.stringify(scrapingState.config));
    }

    /**
     * Displays an error message if extraction is not supported on this site.
     */
    function handleUnsupportedSite() {
        $("#waitHeader").hide();
        showStatusMessage(
            "Open Scraper doesn't support data extraction from this site yet. Our administrators are notified and will try to add support in the future. Thanks for trying us out!",
            "noResponseErr",
            false
        );
    }

    /**
     * Retrieves the pre-saved 'Next' button selector for this host.
     * @returns {string|null} The next button selector or null.
     */
    function getNextPageSelectorFromStorage() {
        return localStorage.getItem("nextSelector:" + scrapingState.hostName);
    }

    /**
     * Callback triggered upon receiving the initial table analysis structure.
     * @param {Object} tableData - Table data and selectors sent by the target tab.
     * @param {boolean} [isInitial=false] - Indicates if it's the initial load.
     */
    function onTableDataReceived(tableData, isInitial) {
        if (!tableData) {
            if (currentTab.reloaded) {
                return handleUnsupportedSite();
            } else {
                currentTab.reloaded = true;
                return chromeInstance.tabs.reload(currentTab.id, {}, function() {
                    chromeInstance.tabs.onUpdated.addListener(function listener(updatedTabId, changeInfo) {
                        if (changeInfo.status === "complete" && updatedTabId === currentTab.id) {
                            chromeInstance.tabs.onUpdated.removeListener(listener);
                            triggerFindTables();
                        }
                    });
                });
            }
        }

        scrapingState.tableId = tableData.tableId;
        scrapingState.scraping = false;
        scrapingState.failedToProcess = false;
        scrapingState.processingError = null;
        scrapingState.tableSelector = tableData.tableSelector;
        scrapingState.hostName = tableData.hostname;
        scrapingState.pages = 0;

        scrapingState.previewLength = 0;
        scrapingState.configName = tableData.hostname + "-config";
        scrapingState.config = JSON.parse(localStorage.getItem(scrapingState.configName)) || {
            headers: {},
            deletedFields: {},
            crawlDelay: 1000,
            maxWait: 20000
        };

        if (Object.keys(scrapingState.config.deletedFields).length) {
            $("#resetColumns").show();
        }

        // Calculate default export filename
        const domainKey = (() => {
            const url = currentTab.url;
            const hostnameParts = new URL(url).hostname.split(".");
            return hostnameParts[0].indexOf("www") > -1 ? hostnameParts[1] : hostnameParts[0];
        })();

        $("#wrongTable").show();

        if (scrapingState.config.infinateScrollChecked) {
            $("#nextButton").hide();
            $("#startScraping").show();
            $("#infinateScroll").prop("checked", true);
        }

        chromeInstance.tabs.sendMessage(
            currentTab.id,
            { action: "getTableData" },
            function(response) {
                if (response && response.error) {
                    showStatusMessage("Something went wrong!", "noResponseErr", true);
                } else if (response.tableId == scrapingState.tableId) {
                    if (response.failedToProcess) {
                        showStatusMessage("Failed to process rows on server. Showing raw data instead.", "error", false);
                        scrapingState.failedToProcess = true;
                        scrapingState.processingError = response.processingError;
                    } else {
                        $("#error").hide();
                        scrapingState.failedToProcess = false;
                    }

                    if (scrapingState.pages || scrapingState.config.infinateScrollChecked) {
                        // Nothing
                    } else {
                        $("#nextButton").show();
                    }

                    if (!scrapingState.pages) {
                        scrapingState.nextSelector = getNextPageSelectorFromStorage();
                        if (scrapingState.nextSelector) {
                            chromeInstance.tabs.sendMessage(
                                currentTab.id,
                                {
                                    action: "markNextButton",
                                    selector: scrapingState.nextSelector
                                },
                                function(markResponse) {
                                    if (!markResponse.error) {
                                        $("#startScraping").show();
                                    }
                                }
                            );
                        }
                    }

                    $("#wait").hide();
                    $("#content").show();
                    showStatusMessage('Download data or locate "Next" to crawl multiple pages', "instructions");

                    scrapingState.data = response.data;
                    scrapingState.pages = 1;
                    scrapingState.lastRows = response.data.length;
                    scrapingState.tableSelector = response.tableSelector;
                    scrapingState.workingTime = 0;

                    updateUiStats();
                    $(".download-button").show();

                    renderHandsontable();

                    // Configuration of download / copy data buttons
                    $("#csv")
                        .off("click")
                        .click(function() {
                            console.log("Downloading CSV...");
                            exportCsv(prepareDataForExport(scrapingState.data), domainKey + ".csv");
                        });

                    $("#xlsx")
                        .off("click")
                        .click(function() {
                            exportXlsx(
                                prepareDataForExport(scrapingState.data),
                                domainKey + ".xlsx",
                                currentTab.url.substring(0, 100)
                            );
                        });

                    $("#copy")
                        .off("click")
                        .click(function() {
                            copyTsv(prepareDataForExport(scrapingState.data));
                        });
                }
            }
        );
    }

    /**
     * Triggers table search in the active page by sending a message to the content script.
     */
    function triggerFindTables() {
        chromeInstance.tabs.sendMessage(
            currentTab.id,
            {
                action: "findTables",
                robots: robotsTxtRules
            },
            function(response) {
                onTableDataReceived(response, true);
            }
        );
    }

    /**
     * Checks if the 'Infinite scroll' mode is checked.
     * @returns {boolean} True if infinite scroll is active.
     */
    function isInfiniteScrollChecked() {
        return $("#infinateScroll").is(":checked");
    }

    /**
     * Stops the current scraping process.
     */
    function stopScraping() {
        scrapingState.scraping = false;
        console.log("Scraping stopped.");
        $("#startScraping").show();
        $("#stopScraping").hide();
        showStatusMessage("Crawling stopped. Please download data or continue crawling.", "instructions");
    }

    /**
     * Updates the scraping information values displayed in the #stats container.
     */
    function updateUiStats() {
        $("#stats")
            .empty()
            .append($("<div>", { text: "Pages scraped: " + scrapingState.pages }))
            .append($("<div>", { text: "Rows collected: " + scrapingState.data.length }))
            .append($("<div>", { text: "Rows from last page: " + scrapingState.lastRows }))
            .append($("<div>", { text: "Working time: " + parseInt(scrapingState.workingTime / 1000) + "s" }));
    }

    // --- Main Interface Initialization Routine ---
    !async function initializePopup() {
        $("#stopScraping").click(stopScraping);

        // Binding of crawl delay management
        $("#crawlDelay").bind("propertychange change click keyup input paste", function() {
            const value = $(this).val();
            if (isNaN(value) || value < 0 || parseInt(1000 * value) >= scrapingState.config.maxWait) {
                return showStatusMessage("Bad min waiting value", "inputError");
            }
            showStatusMessage("", "inputError");
            scrapingState.config.crawlDelay = parseInt(1000 * value);
            saveCurrentConfig();
        });

        $("#maxWait").bind("propertychange change click keyup input paste", function() {
            const value = $(this).val();
            if (isNaN(value) || parseInt(1000 * value) <= scrapingState.config.crawlDelay) {
                return showStatusMessage("Bad max waiting value", "inputError");
            }
            showStatusMessage("", "inputError");
            scrapingState.config.maxWait = parseInt(1000 * value);
            saveCurrentConfig();
        });

        $("#resetColumns").click(function() {
            scrapingState.config.deletedFields = {};
            saveCurrentConfig();
            $("#resetColumns").hide();
            renderHandsontable();
        });

        $("#infinateScroll").click(function() {
            if (scrapingState.config.infinateScrollChecked) {
                scrapingState.config.infinateScrollChecked = false;
                $("#nextButton").show();
                if (getNextPageSelectorFromStorage()) {
                    $("#startScraping").show();
                } else {
                    $("#startScraping").hide();
                }
            } else {
                scrapingState.config.infinateScrollChecked = true;
                $("#nextButton").hide();
                $("#startScraping").show();
            }
            saveCurrentConfig();
        });

        // Listener for URL updates in the source tab
        chromeInstance.tabs.onUpdated.addListener((tabId, changeInfo) => {
            if (tabId === currentTab.id && changeInfo.url) {
                currentTab.url = changeInfo.url;
            }
        });

        // Safety timeout if the target page takes too long to respond
        setTimeout(function() {
            console.log("No response received from the target page.");
            if ($("#waitHeader").is(":visible")) {
                handleUnsupportedSite();
            }
        }, 50000);

        // The window may be resized before the first rows arrive
        $(window).resize(function() {
            if (scrapingState.data) renderHandsontable();
        });

        // Start the initial table search
        triggerFindTables();
    }();

    $("#wrongTable").click(function() {
        $("#hot").empty();
        chromeInstance.tabs.sendMessage(
            currentTab.id,
            { action: "nextTable" },
            onTableDataReceived
        );
    });

    $("#nextButton").click(function() {
        showStatusMessage('Mark "Next" button or link', "instructions");
        scrapingState.gettingNext = true;

        // Recursive polling function for 'Next' button status
        !function pollNextButtonStatus() {
            chromeInstance.tabs.sendMessage(
                currentTab.id,
                { action: "getNextButton" },
                function(response) {
                    if (!scrapingState.scraping) {
                        if (scrapingState.gettingNext) {
                            pollNextButtonStatus();
                        }
                        if (response.selector) {
                            $("#startScraping").show();
                            showStatusMessage(
                                '"Next" button located. Press "Start crawling" to get more pages or mark another button/link if marked incorrectly.',
                                "instructions"
                            );
                            scrapingState.nextSelector = response.selector;
                            localStorage.setItem("nextSelector:" + scrapingState.hostName, response.selector);
                        }
                    }
                }
            );
        }();
    });

    $("#startScraping").click(function() {
        scrapingState.gettingNext = false;
        scrapingState.scraping = true;
        $("#startScraping").hide();
        $("#stopScraping").show();
        showStatusMessage("", "error");
        showStatusMessage('Please wait for more pages or press "Stop crawling".', "instructions");

        if (isInfiniteScrollChecked()) {
            $("#infinateScrollElement").hide();
        }

        let startTime = new Date();

        // Start the recursive crawl routine
        !function crawlNextPage() {
            const scrollDownPage = function(callback) {
                chromeInstance.tabs.sendMessage(
                    currentTab.id,
                    {
                        action: "scrollDown",
                        selector: scrapingState.tableSelector
                    },
                    function(response) {
                        if (response && response.error) {
                            showStatusMessage("", "instructions");
                            return showStatusMessage(response.error, response.errorId || "error", true);
                        }
                        $("#wrongTable").hide();
                        callback();
                    }
                );
            };

            let clickNextPageButton = function(callback) {
                chromeInstance.tabs.sendMessage(
                    currentTab.id,
                    {
                        action: "clickNext",
                        selector: scrapingState.nextSelector
                    },
                    function(response) {
                        if (response && response.error) {
                            showStatusMessage("", "instructions");
                            return showStatusMessage(response.error, response.errorId, true);
                        }
                        $("#wrongTable").hide();
                        callback();
                    }
                );
            };

            if (isInfiniteScrollChecked()) {
                clickNextPageButton = scrollDownPage;
            }

            // Routine to listen and wait for new page load via active network requests
            (function waitForPageToLoad(actionTrigger, onLoadComplete, tabId, maxWaitTime, pollInterval, crawlDelay, checkTabAlive) {
                const activeRequests = {};
                let lastRequestTime = null;
                let isLoaded = false;
                let isTimeoutReached = false;
                const filterRules = {
                    urls: ["<all_urls>"],
                    tabId: tabId,
                    types: ["main_frame", "sub_frame", "stylesheet", "script", "font", "object", "xmlhttprequest", "other"]
                };

                function checkCompletion() {
                    if (!isLoaded && isTimeoutReached) {
                        checkTabAlive(function(isAlive) {
                            if (!isAlive) return triggerErrorCallback();
                            if (!isLoaded) {
                                isLoaded = true;
                                chromeInstance.webRequest.onBeforeRequest.removeListener(onBeforeRequestHandler);
                                chromeInstance.webRequest.onCompleted.removeListener(onCompletedHandler);
                                chromeInstance.webRequest.onErrorOccurred.removeListener(onCompletedHandler);
                                onLoadComplete();
                            }
                        });
                    }
                }

                function onBeforeRequestHandler(details) {
                    activeRequests[details.requestId] = 1;
                    lastRequestTime = new Date();
                }

                function onCompletedHandler(details) {
                    if (lastRequestTime) {
                        delete activeRequests[details.requestId];
                        if (!Object.keys(activeRequests).length) {
                            triggerErrorCallback();
                        }
                    }
                }

                function triggerErrorCallback() {
                    setTimeout(function() {
                        if (new Date() - lastRequestTime < pollInterval || Object.keys(activeRequests).length) {
                            // Waiting
                        } else {
                            checkCompletion();
                        }
                    }, pollInterval);
                }

                chromeInstance.webRequest.onBeforeRequest.addListener(onBeforeRequestHandler, filterRules);
                chromeInstance.webRequest.onCompleted.addListener(onCompletedHandler, filterRules);
                chromeInstance.webRequest.onErrorOccurred.addListener(onCompletedHandler, filterRules);

                (actionTrigger || function(cb) { cb(); })(function() {
                    setTimeout(checkCompletion, maxWaitTime);
                    setTimeout(function() {
                        isTimeoutReached = true;
                        triggerErrorCallback();
                    }, crawlDelay);
                });
            })(
                clickNextPageButton,
                function() {
                    // Page loaded -> retrieve new table data rows
                    chromeInstance.tabs.sendMessage(
                        currentTab.id,
                        {
                            action: "getTableData",
                            selector: scrapingState.tableSelector
                        },
                        function(response) {
                            if (response) {
                                if (response.error) {
                                    showStatusMessage("", "instructions");
                                    return showStatusMessage(response.error, response.errorId || "error", true);
                                }

                                if (response.failedToProcess) {
                                    showStatusMessage("Failed to process rows. Showing raw data instead.", "error", false);
                                    scrapingState.failedToProcess = true;
                                    scrapingState.processingError = response.processingError;
                                } else {
                                    $("#error").hide();
                                    scrapingState.failedToProcess = false;
                                }

                                scrapingState.lastRows = response.data.length;
                                scrapingState.pages++;
                                scrapingState.workingTime += new Date() - startTime;
                                startTime = new Date();

                                // Add collected unique rows
                                (function(newRows) {
                                    scrapingState.data = scrapingState.data.concat(newRows);
                                    const uniqueRowsSet = new Set();
                                    scrapingState.data.forEach(row => uniqueRowsSet.add(JSON.stringify(row)));
                                    scrapingState.data = Array.from(uniqueRowsSet, str => JSON.parse(str));
                                })(response.data);

                                updateUiStats();

                                if (scrapingState.previewLength < PREVIEW_LIMIT) {
                                    renderHandsontable();
                                } else {
                                    showStatusMessage("Preview limited to 1000 rows.", "previewLimit");
                                }

                                if (scrapingState.scraping) {
                                    crawlNextPage();
                                }
                            }
                        }
                    );
                },
                currentTab.id,
                scrapingState.config.maxWait,
                100,
                scrapingState.config.crawlDelay,
                function(callback) {
                    chromeInstance.tabs.sendMessage(currentTab.id, {}, function(response) {
                        callback(response !== undefined);
                    });
                }
            );
        }();
    });

    // Shared helpers for the other panels of the scraping window (see details.js)
    window.OpenScraper = Object.freeze({
        exportCsv: exportCsv,
        exportXlsx: exportXlsx,
        copyTsv: copyTsv,
        /**
         * Returns the list results as displayed (renamed headers), or null before the first read.
         * @returns {{fields: string[], data: Array<Array<*>>}|null} Table of the list tab.
         */
        getListResults: function() {
            if (!scrapingState.data || !scrapingState.config) return null;
            return prepareDataForExport(scrapingState.data);
        }
    });
})();