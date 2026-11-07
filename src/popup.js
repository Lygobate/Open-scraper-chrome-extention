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
    // Height of the grid's column headers (fill count above the name) and space kept below it
    const GRID_HEADER_HEIGHT = 38;
    const GRID_BOTTOM_SPACE = 8;
    // Widest a column gets, and room taken in a header by its two buttons and padding
    const MAX_COL_WIDTH = 200;
    const HEADER_ACTIONS_WIDTH = 56;
    // Room around a value in a grid cell
    const CELL_PADDING = 12;

    // Ways to get more rows than the page shows at first: Min / Max delay defaults (ms), the
    // localStorage key prefix of the page button they click and the label of the action locating it
    const MORE_ROWS_MODES = {
        none: {},
        scroll: { delays: [1000, 20000] },
        next: { delays: [1000, 20000], buttonKey: "nextSelector:", locateLabel: 'Locate "Next" button' },
        loadMore: { delays: [1000, 5000], buttonKey: "loadMoreSelector:", locateLabel: 'Locate "Load more" button' }
    };
    // Delays of a site never configured (those of the "Next" button and of scrolling)
    const DEFAULT_DELAYS = [1000, 20000];
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
     * Escapes text for use in HTML.
     * @param {*} value - Text.
     * @returns {string} Escaped text.
     */
    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
    }

    /**
     * Tells whether a cell holds a value (an empty text or list counts as none).
     * @param {*} cell - Cell value.
     * @returns {boolean} True when filled.
     */
    function isFilledCell(cell) {
        if (cell === null || cell === undefined) return false;
        if (Array.isArray(cell)) return cell.some(isFilledCell);
        return String(cell).trim() !== "";
    }

    /**
     * Returns the "x/y" line shown above a column name: rows with a value / rows collected.
     * @param {number} filled - Rows with a value.
     * @param {number} rows - Rows collected.
     * @returns {string} HTML of the line.
     */
    function getColumnStatHtml(filled, rows) {
        if (!rows) return '<span class="osd-col-stat">&nbsp;</span>';
        return '<span class="osd-col-stat' + (filled < rows ? " is-partial" : "") + '" title="' + filled + " of " + rows +
            ' rows have a value">' + filled + "/" + rows + "</span>";
    }

    /**
     * Returns the width a text takes in the grid.
     * @param {string} text - Text.
     * @param {string} weight - Font weight.
     * @returns {number} Width in pixels.
     */
    function measureText(text, weight) {
        const canvas = measureText.canvas || (measureText.canvas = document.createElement("canvas"));
        const context = canvas.getContext("2d");
        context.font = weight + " 12px " + getComputedStyle(document.body).fontFamily;
        return Math.ceil(context.measureText(text).width);
    }

    /**
     * Returns the starting width of a column: enough for its whole name beside its header
     * buttons and for its values, at most MAX_COL_WIDTH.
     * @param {string} name - Column name.
     * @param {Array<Array<*>>} rows - Rows shown.
     * @param {number} col - Column index.
     * @returns {number} Width in pixels.
     */
    function getColumnWidth(name, rows, col) {
        let content = 0;
        for (let i = 0; i < Math.min(rows.length, 100) && content < MAX_COL_WIDTH; i++) {
            const cell = rows[i][col];
            if (cell !== null && cell !== undefined) content = Math.max(content, measureText(String(cell), "400") + CELL_PADDING);
        }
        return Math.min(MAX_COL_WIDTH, Math.max(content, measureText(name, "500") + HEADER_ACTIONS_WIDTH));
    }

    /**
     * Returns the size available for the list grid: the window width and the height left down
     * to the footer.
     * @returns {{width: number, height: number}} Size in pixels.
     */
    function getListGridSize() {
        const footerEl = document.querySelector(".popup-footer");
        const footerHeight = footerEl ? footerEl.getBoundingClientRect().height : 52;
        scrapingState.tableTop = $("#hot").get(0).getBoundingClientRect().y;
        return {
            width: $(window).width() - 20,
            height: $(window).height() - scrapingState.tableTop - footerHeight - GRID_BOTTOM_SPACE
        };
    }

    /**
     * Fits the list grid to the window, keeping its data, column widths and scroll position.
     */
    function fitListGrid() {
        const grid = scrapingState.grid;
        if (!grid) return;
        const size = getListGridSize();
        if (scrapingState.gridSize && scrapingState.gridSize.width === size.width && scrapingState.gridSize.height === size.height) return;
        const holder = document.querySelector("#hot .ht_master .wtHolder");
        const left = holder ? holder.scrollLeft : 0;
        const top = holder ? holder.scrollTop : 0;
        scrapingState.gridSize = size;
        grid.updateSettings({ width: size.width, height: size.height });
        if (holder) setListGridScroll(holder, left, top);
    }

    /**
     * Scrolls the grid's cells and makes its headers follow: they only move on a scroll event.
     * @param {HTMLElement} holder - Scrolling box of the grid's cells.
     * @param {number} left - Horizontal position.
     * @param {number} top - Vertical position.
     */
    function setListGridScroll(holder, left, top) {
        holder.scrollLeft = left;
        holder.scrollTop = top;
        holder.dispatchEvent(new Event("scroll"));
    }

    /**
     * Removes the list grid.
     */
    function destroyListGrid() {
        if (scrapingState.grid) scrapingState.grid.destroy();
        scrapingState.grid = null;
        scrapingState.gridKey = "";
        $("#hot").empty();
    }

    /**
     * Shows the collected rows in the list grid. Each column header shows its fill count, its
     * name and its actions: rename (pencil) and delete (cross). The grid is kept while its
     * columns stay the same, so new rows, renames and window resizes keep the widths set by
     * dragging a header edge; it is created again only when the columns change, each column
     * that stays keeping its width.
     */
    function renderHandsontable() {
        const previewData = findOptimalDataFields(scrapingState.data);
        const rowTotal = previewData.data.length;
        const fields = previewData.fields;
        const rows = previewData.data.slice(0, PREVIEW_LIMIT);
        // Read by the header renderer of the grid on each render
        scrapingState.gridView = {
            headers: applyHeaderRenames(fields),
            filledCounts: fields.map((_, col) => previewData.data.filter(row => isFilledCell(row[col])).length),
            rowTotal: rowTotal
        };
        scrapingState.previewLength = rows.length;
        scrapingState.gridFields = fields;
        $("#listRowCount").text(rowTotal + (rowTotal === 1 ? " row" : " rows"));

        const key = JSON.stringify([scrapingState.tableId, fields]);
        if (scrapingState.grid && key === scrapingState.gridKey) {
            // Same columns: new rows go into the grid's own array, then one render
            scrapingState.gridData.length = 0;
            rows.forEach(row => scrapingState.gridData.push(row));
            scrapingState.grid.render();
            fitListGrid();
            return;
        }

        // Widths of the columns that stay, by field
        const keptWidths = {};
        const oldGrid = scrapingState.grid;
        if (oldGrid && JSON.parse(scrapingState.gridKey)[0] === scrapingState.tableId) {
            (scrapingState.gridColumns || []).forEach((field, col) => { keptWidths[field] = oldGrid.getColWidth(col); });
        }
        const holder = document.querySelector("#hot .ht_master .wtHolder");
        const left = holder ? holder.scrollLeft : 0;
        const top = holder ? holder.scrollTop : 0;
        destroyListGrid();

        const size = getListGridSize();
        const headers = scrapingState.gridView.headers;
        scrapingState.gridKey = key;
        scrapingState.gridColumns = fields;
        scrapingState.gridSize = size;
        scrapingState.gridData = rows;
        scrapingState.grid = new Handsontable($("#hot").get(0), {
            data: scrapingState.gridData,
            colHeaders: function(col) {
                const view = scrapingState.gridView;
                const name = escapeHtml(view.headers[col] || "");
                return getColumnStatHtml(view.filledCounts[col] || 0, view.rowTotal) +
                    '<span class="osd-col-head"><span class="osd-col-name" title="' + name + '">' + name + "</span>" +
                    '<button type="button" class="osd-col-action" data-col-action="rename" data-col="' + col +
                    '" title="Rename column">&#9998;</button>' +
                    '<button type="button" class="osd-col-action" data-col-action="delete" data-col="' + col +
                    '" title="Delete column">&times;</button></span>';
            },
            rowHeaders: fields.length > 0,
            columnHeaderHeight: GRID_HEADER_HEIGHT,
            wordWrap: false,
            manualColumnResize: true,
            width: size.width,
            height: size.height,
            colWidths: fields.map((field, col) => keptWidths[field] || getColumnWidth(headers[col] || "", rows, col)),
            beforeOnCellMouseDown: function(event, coords) {
                if (coords.row < 0) {
                    event.stopImmediatePropagation();
                }
            }
        });
        const newHolder = document.querySelector("#hot .ht_master .wtHolder");
        if (newHolder) setListGridScroll(newHolder, left, top);
    }

    /**
     * Handles the rename and delete buttons of the column headers.
     * @param {MouseEvent} event - Mouse event in the grid.
     */
    function onGridHeaderAction(event) {
        const button = event.target instanceof Element ? event.target.closest("[data-col-action]") : null;
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.type !== "click" || !scrapingState.gridFields) return;
        const field = scrapingState.gridFields[parseInt(button.dataset.col, 10)];
        if (field === undefined) return;
        if (button.dataset.colAction === "rename") {
            openColumnPrompt(field);
        } else if (button.dataset.colAction === "delete") {
            closeColumnPrompt();
            scrapingState.config.deletedFields[field] = true;
            saveCurrentConfig();
            $("#resetColumns").show();
            renderHandsontable();
        }
    }

    /**
     * Opens the column name box above the grid. Saving an empty name gives the column its
     * original name back.
     * @param {string} field - Original name of the column.
     */
    function openColumnPrompt(field) {
        scrapingState.renamingField = field;
        const input = document.getElementById("listColumnPromptInput");
        input.value = applyHeaderRenames([field])[0];
        input.placeholder = field;
        document.getElementById("listColumnPrompt").hidden = false;
        input.focus();
        input.select();
    }

    /**
     * Closes the column name box.
     */
    function closeColumnPrompt() {
        scrapingState.renamingField = null;
        document.getElementById("listColumnPrompt").hidden = true;
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
     * Retrieves the pre-saved selector of the "Next" or "Load more" button for this host.
     * @param {string} mode - "next" or "loadMore".
     * @returns {string|null} The button selector or null.
     */
    function getButtonSelector(mode) {
        return localStorage.getItem(MORE_ROWS_MODES[mode].buttonKey + scrapingState.hostName);
    }

    /**
     * Gives a host configuration saved before the "More rows" drop-down its choice:
     * "Scroll down" when infinite scroll was checked, else "Next page button" when a "Next"
     * button was located, else "None". Delays that differ from the defaults count as chosen
     * by the user, so that switching the option keeps them.
     * @param {Object} config - Host configuration, changed in place.
     * @param {string} hostName - Host of the page.
     * @returns {Object} The same configuration.
     */
    function migrateMoreRowsConfig(config, hostName) {
        if (typeof config.crawlDelay !== "number" || typeof config.maxWait !== "number") {
            config.crawlDelay = DEFAULT_DELAYS[0];
            config.maxWait = DEFAULT_DELAYS[1];
        }
        if (!MORE_ROWS_MODES[config.moreRows]) {
            config.moreRows = config.infinateScrollChecked ? "scroll"
                : localStorage.getItem("nextSelector:" + hostName) ? "next" : "none";
            config.delaysEdited = config.crawlDelay !== DEFAULT_DELAYS[0] || config.maxWait !== DEFAULT_DELAYS[1];
        }
        delete config.infinateScrollChecked;
        return config;
    }

    /**
     * Returns the chosen way to get more rows.
     * @returns {string} "none", "scroll", "next" or "loadMore".
     */
    function getMoreRowsMode() {
        return scrapingState.config && MORE_ROWS_MODES[scrapingState.config.moreRows] ? scrapingState.config.moreRows : "none";
    }

    /**
     * Returns the instructions shown for the chosen way to get more rows.
     * @param {string} mode - "none", "scroll", "next" or "loadMore".
     * @param {boolean} located - Whether its button is located in the page.
     * @returns {string} Instructions text.
     */
    function getMoreRowsInstructions(mode, located) {
        if (mode === "scroll") return 'Press "Start crawling" to scroll down and get more rows.';
        if (mode === "next") {
            return located
                ? '"Next" button located. Press "Start crawling" to get more pages, or locate it again if it is the wrong one.'
                : 'Locate the "Next" button to crawl more pages.';
        }
        if (mode === "loadMore") {
            return located
                ? '"Load more" button located. Press "Start crawling" to get more rows, or locate it again if it is the wrong one.'
                : 'Locate the "Load more" button to get more rows.';
        }
        return "Download the data, or choose how to get more rows.";
    }

    /**
     * Shows the controls of the chosen way to get more rows: the action that locates its
     * button, the delays, and "Start crawling" once a crawl can start. The located button is
     * marked in the page (any former mark is removed).
     */
    function applyMoreRowsMode() {
        const mode = getMoreRowsMode();
        const modeInfo = MORE_ROWS_MODES[mode];
        const selector = modeInfo.buttonKey ? getButtonSelector(mode) : null;
        if (mode === "next") scrapingState.nextSelector = selector;
        if (mode === "loadMore") scrapingState.loadMoreSelector = selector;

        $("#moreRows").val(mode);
        $("#locateButton").text(modeInfo.locateLabel || "").toggle(!!modeInfo.buttonKey);
        $("#crawlDelays").toggle(mode !== "none");
        $("#crawlDelay").val(scrapingState.config.crawlDelay / 1000);
        $("#maxWait").val(scrapingState.config.maxWait / 1000);
        showStatusMessage("", "inputError");
        $("#startScraping").toggle(mode === "scroll");
        showStatusMessage(getMoreRowsInstructions(mode, false), "instructions");
        if (scrapingState.data) updateUiStats();

        chromeInstance.tabs.sendMessage(
            currentTab.id,
            { action: "markButton", selector: selector, kind: mode },
            function(markResponse) {
                void chromeInstance.runtime.lastError;
                if (!selector || !markResponse || markResponse.error) return;
                if (scrapingState.scraping || getMoreRowsMode() !== mode) return;
                $("#startScraping").show();
                showStatusMessage(getMoreRowsInstructions(mode, true), "instructions");
            }
        );
    }

    /**
     * Ends the picking of a button in the page, if under way.
     */
    function stopButtonPicking() {
        if (!scrapingState.gettingNext) return;
        scrapingState.gettingNext = false;
        chromeInstance.tabs.sendMessage(currentTab.id, { action: "stopButtonPicker" }, function() {
            void chromeInstance.runtime.lastError;
        });
    }

    /**
     * Adds rows read from the page to the collected rows.
     * @param {Array<Object>} newRows - Rows read.
     * @param {boolean} dropKnown - Leave out rows identical to one already collected (for a
     *     list the page has drawn again); otherwise every row is added, repeated values included.
     */
    function addCollectedRows(newRows, dropKnown) {
        if (!dropKnown) {
            scrapingState.data = scrapingState.data.concat(newRows);
            return;
        }
        const knownRows = new Set(scrapingState.data.map(row => JSON.stringify(row)));
        newRows.forEach(function(row) {
            const key = JSON.stringify(row);
            if (!knownRows.has(key)) {
                knownRows.add(key);
                scrapingState.data.push(row);
            }
        });
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

        closeColumnPrompt();
        scrapingState.tableId = tableData.tableId;
        scrapingState.scraping = false;
        scrapingState.failedToProcess = false;
        scrapingState.processingError = null;
        scrapingState.tableSelector = tableData.tableSelector;
        scrapingState.hostName = tableData.hostname;
        scrapingState.pages = 0;
        scrapingState.roundCut = false;

        scrapingState.previewLength = 0;
        scrapingState.configName = tableData.hostname + "-config";
        scrapingState.config = migrateMoreRowsConfig(JSON.parse(localStorage.getItem(scrapingState.configName)) || {
            headers: {},
            deletedFields: {},
            crawlDelay: DEFAULT_DELAYS[0],
            maxWait: DEFAULT_DELAYS[1]
        }, scrapingState.hostName);

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

        chromeInstance.tabs.sendMessage(
            currentTab.id,
            { action: "getTableData" },
            function(response) {
                if (response && response.error) {
                    showStatusMessage("Something went wrong!", "noResponseErr", true);
                } else if (response && response.tableId == scrapingState.tableId) {
                    if (response.failedToProcess) {
                        showStatusMessage("Failed to process rows on server. Showing raw data instead.", "error", false);
                        scrapingState.failedToProcess = true;
                        scrapingState.processingError = response.processingError;
                    } else {
                        $("#error").hide();
                        scrapingState.failedToProcess = false;
                    }

                    $("#wait").hide();
                    $("#content").show();

                    scrapingState.data = response.data;
                    scrapingState.pages = 1;
                    scrapingState.loadRounds = 0;
                    scrapingState.rowCount = response.rowCount;
                    scrapingState.lastRows = response.data.length;
                    scrapingState.tableSelector = response.tableSelector;
                    scrapingState.workingTime = 0;
                    scrapingState.firstRows = response.data.length;
                    scrapingState.uncountedRows = 0;

                    applyMoreRowsMode();
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
     * Stops the current scraping process at once: the crawl run ends (a new run id), so a round
     * still under way is dropped when it answers. A "Next page" or "Scroll down" round cut that
     * way already acted on the page: the next run reads the page first instead of acting again.
     */
    function stopScraping() {
        scrapingState.scraping = false;
        scrapingState.runId = (scrapingState.runId || 0) + 1;
        if (scrapingState.pageRound) scrapingState.roundCut = true;
        if (scrapingState.roundPending) scrapingState.loadMoreCut = true;
        scrapingState.pageRound = scrapingState.roundPending = false;
        console.log("Scraping stopped.");
        $("#stopScraping").hide();
        $("#startScraping").show();
        $("#wrongTable").show();
        $("#moreRows").prop("disabled", false);
        $("#locateButton").toggle(!!MORE_ROWS_MODES[getMoreRowsMode()].buttonKey);
        showStatusMessage("Crawling stopped. Please download data or continue crawling.", "instructions");
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
     * Updates the counters of the #stats tiles.
     * "Load more" counts rounds (clicks that brought rows) instead of pages.
     * Speed: rows added by crawling (beyond the first read) per minute of working time,
     * leaving out the rows whose round was not timed (see crawlWithLoadMore).
     */
    function updateUiStats() {
        const byRound = getMoreRowsMode() === "loadMore";
        const addedRows = scrapingState.data.length - scrapingState.firstRows - scrapingState.uncountedRows;
        const speed = addedRows > 0 && scrapingState.workingTime > 0
            ? (addedRows * 60000 / scrapingState.workingTime).toFixed(1) + " / min" : "–";
        $("#listPages").text(byRound ? scrapingState.loadRounds : scrapingState.pages);
        $("#listPagesLabel").text(byRound ? "rounds" : "pages");
        $("#listRows").text(scrapingState.data.length);
        $("#listLastRows").text(scrapingState.lastRows);
        $("#listLastRowsLabel").text(byRound ? "from last round" : "from last page");
        $("#listDuration").text(formatDuration(scrapingState.workingTime));
        $("#listSpeed").text(speed);
        $("#listRowCount").text(scrapingState.data.length + (scrapingState.data.length === 1 ? " row" : " rows"));
    }

    /**
     * Gets more rows with the page's "Load more" button, round after round. A round clicks the
     * button once every row of the list has been read, then adds the rows it brought: the page
     * keeps the rows already read, so each round reads only the rows after them.
     * Stops when the button is gone (warning) or disabled (all loaded), when a click adds no
     * rows within Max delay, or when the user stops.
     * @param {number} runId - Id of this crawl run: answers of a former run are dropped.
     */
    function crawlWithLoadMore(runId) {
        let startTime = new Date();
        // A round cut by Stop is not timed, but its click may still bring rows: the first round
        // after it then reads them without clicking (it answers before Min delay). Those rows
        // are collected but left out of the speed.
        let afterCut = scrapingState.loadMoreCut;
        scrapingState.loadMoreCut = false;

        !function loadMoreRound() {
            const round = scrapingState.loadRounds + 1;
            const minWait = scrapingState.config.crawlDelay;
            scrapingState.roundPending = true;
            chromeInstance.tabs.sendMessage(
                currentTab.id,
                {
                    action: "loadMore",
                    selector: scrapingState.loadMoreSelector,
                    tableSelector: scrapingState.tableSelector,
                    rowCount: scrapingState.rowCount,
                    minWait: minWait,
                    maxWait: scrapingState.config.maxWait
                },
                function(response) {
                    void chromeInstance.runtime.lastError;
                    if (runId !== scrapingState.runId) return;
                    scrapingState.roundPending = false;
                    const roundTime = new Date() - startTime;
                    const untimedRows = afterCut && roundTime < minWait;
                    afterCut = false;
                    scrapingState.workingTime += roundTime;
                    startTime = new Date();

                    if (!response || response.error) {
                        updateUiStats();
                        showStatusMessage("", "instructions");
                        return showStatusMessage(
                            response ? response.error : "The page did not answer. Reload it and try again.",
                            "error",
                            true
                        );
                    }

                    if (response.status === "rows") {
                        const collectedBefore = scrapingState.data.length;
                        addCollectedRows(response.data, !response.appended);
                        scrapingState.rowCount = response.rowCount;
                        scrapingState.loadRounds = round;
                        scrapingState.lastRows = scrapingState.data.length - collectedBefore;
                        if (untimedRows) scrapingState.uncountedRows += scrapingState.lastRows;
                        updateUiStats();
                        if (scrapingState.previewLength < PREVIEW_LIMIT) {
                            renderHandsontable();
                        } else {
                            showStatusMessage("Preview limited to 1000 rows.", "previewLimit");
                        }
                        return scrapingState.scraping ? loadMoreRound() : stopScraping();
                    }

                    const endMessages = {
                        missing: 'The "Load more" button wasn\'t found on round ' + round +
                            '. If there are more items, locate the button again and press "Start crawling".',
                        disabled: "All items loaded. Download CSV or Excel file.",
                        noRows: 'Clicking "Load more" didn\'t add rows on round ' + round +
                            ". If there are more, raise Max delay or locate the button again."
                    };
                    updateUiStats();
                    stopScraping();
                    showStatusMessage(endMessages[response.status] || "", "finished");
                }
            );
        }();
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
            if (parseInt(1000 * value) !== scrapingState.config.crawlDelay) {
                scrapingState.config.delaysEdited = true;
            }
            scrapingState.config.crawlDelay = parseInt(1000 * value);
            saveCurrentConfig();
        });

        $("#maxWait").bind("propertychange change click keyup input paste", function() {
            const value = $(this).val();
            if (isNaN(value) || parseInt(1000 * value) <= scrapingState.config.crawlDelay) {
                return showStatusMessage("Bad max waiting value", "inputError");
            }
            showStatusMessage("", "inputError");
            if (parseInt(1000 * value) !== scrapingState.config.maxWait) {
                scrapingState.config.delaysEdited = true;
            }
            scrapingState.config.maxWait = parseInt(1000 * value);
            saveCurrentConfig();
        });

        // Rename and delete buttons of the column headers: caught before the grid selects the column
        ["mousedown", "click"].forEach(type => $("#hot").get(0).addEventListener(type, onGridHeaderAction, true));

        $("#listColumnPrompt").on("submit", function(event) {
            event.preventDefault();
            const field = scrapingState.renamingField;
            const name = $("#listColumnPromptInput").val().trim();
            closeColumnPrompt();
            if (field === null || field === undefined || !scrapingState.config) return;
            if (name && name !== field) {
                scrapingState.config.headers[field] = name;
            } else {
                delete scrapingState.config.headers[field];
            }
            saveCurrentConfig();
            renderHandsontable();
        });
        $("#listColumnPromptCancel").click(closeColumnPrompt);
        $("#listColumnPromptInput").on("keydown", function(event) {
            if (event.key === "Escape") {
                event.preventDefault();
                closeColumnPrompt();
            }
        });

        $("#resetColumns").click(function() {
            scrapingState.config.deletedFields = {};
            saveCurrentConfig();
            $("#resetColumns").hide();
            renderHandsontable();
        });

        // Choice of the way to get more rows. Its delay defaults apply while the user has
        // never changed the delays for this host.
        $("#moreRows").change(function() {
            const mode = MORE_ROWS_MODES[$(this).val()] ? $(this).val() : "none";
            const delays = MORE_ROWS_MODES[mode].delays;
            stopButtonPicking();
            scrapingState.config.moreRows = mode;
            if (delays && !scrapingState.config.delaysEdited) {
                scrapingState.config.crawlDelay = delays[0];
                scrapingState.config.maxWait = delays[1];
            }
            saveCurrentConfig();
            applyMoreRowsMode();
        });

        // A button picking left in the page would keep catching its clicks
        window.addEventListener("pagehide", stopButtonPicking);

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

        // The grid follows the window size, keeping its column widths
        $(window).resize(fitListGrid);

        // Controls, messages and the column name box shown or hidden above the table move it
        // down or up after it was drawn: fit it again to the window.
        const tableMoveObserver = new ResizeObserver(function() {
            if (!scrapingState.data || !$("#content").is(":visible")) return;
            if ($("#hot").get(0).getBoundingClientRect().y !== scrapingState.tableTop) fitListGrid();
        });
        $("#content .popup-content-body").children().not(":has(#hot)").each(function() {
            tableMoveObserver.observe(this);
        });

        // Start the initial table search
        triggerFindTables();
    }();

    // Another table of the page: its rows replace those collected, as before any crawl. A page
    // that does not answer (one a crawl opened, still loading) is reloaded and searched again.
    $("#wrongTable").click(function() {
        if (scrapingState.scraping || scrapingState.roundPending || scrapingState.pageRound) return;
        destroyListGrid();
        ["error", "finished", "previewLimit"].forEach(id => showStatusMessage("", id));
        chromeInstance.tabs.sendMessage(
            currentTab.id,
            { action: "nextTable" },
            function(response) {
                void chromeInstance.runtime.lastError;
                if (!response) currentTab.reloaded = false;
                onTableDataReceived(response);
            }
        );
    });

    // Picks the "Next" or "Load more" button: the page catches the next click on it
    $("#locateButton").click(function() {
        const mode = getMoreRowsMode();
        const modeInfo = MORE_ROWS_MODES[mode];
        if (!modeInfo.buttonKey) return;
        const pickId = (scrapingState.pickId || 0) + 1;
        scrapingState.pickId = pickId;
        scrapingState.gettingNext = true;
        showStatusMessage(
            mode === "next" ? 'Click the "Next" button or link in the page.' : 'Click the "Load more" button in the page.',
            "instructions"
        );

        chromeInstance.tabs.sendMessage(
            currentTab.id,
            { action: "getNextButton", kind: mode },
            function(response) {
                void chromeInstance.runtime.lastError;
                // Answers of a former picking (cancelled) are not this one's
                if (pickId !== scrapingState.pickId || !response || !response.selector) return;
                scrapingState.gettingNext = false;
                if (scrapingState.scraping || getMoreRowsMode() !== mode) return;
                localStorage.setItem(modeInfo.buttonKey + scrapingState.hostName, response.selector);
                if (mode === "next") scrapingState.nextSelector = response.selector;
                if (mode === "loadMore") scrapingState.loadMoreSelector = response.selector;
                $("#startScraping").show();
                showStatusMessage(getMoreRowsInstructions(mode, true), "instructions");
            }
        );
    });

    $("#startScraping").click(function() {
        const mode = getMoreRowsMode();
        stopButtonPicking();
        const runId = scrapingState.runId = (scrapingState.runId || 0) + 1;
        let actOnPage = !scrapingState.roundCut;
        scrapingState.roundCut = false;
        scrapingState.scraping = true;
        $("#startScraping").hide();
        $("#wrongTable").hide();
        $("#stopScraping").show();
        $("#locateButton").hide();
        $("#moreRows").prop("disabled", true);
        showStatusMessage("", "error");
        showStatusMessage("", "finished");
        showStatusMessage(
            mode === "next" ? 'Please wait for more pages or press "Stop crawling".' : 'Please wait for more rows or press "Stop crawling".',
            "instructions"
        );

        if (mode === "loadMore") {
            return crawlWithLoadMore(runId);
        }

        let startTime = new Date();

        // Start the recursive crawl routine. A round (scroll or click, wait, read) under way
        // when the crawl stops is dropped; the first round after one cut only reads the page.
        !function crawlNextPage() {
            if (runId !== scrapingState.runId) return;
            scrapingState.pageRound = true;
            const scrollDownPage = function(callback) {
                chromeInstance.tabs.sendMessage(
                    currentTab.id,
                    {
                        action: "scrollDown",
                        selector: scrapingState.tableSelector
                    },
                    function(response) {
                        if (response && response.error && runId === scrapingState.runId) {
                            scrapingState.pageRound = false;
                            showStatusMessage("", "instructions");
                            return showStatusMessage(response.error, response.errorId || "error", true);
                        }
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
                        if (response && response.error && runId === scrapingState.runId) {
                            scrapingState.pageRound = false;
                            showStatusMessage("", "instructions");
                            return showStatusMessage(response.error, response.errorId, true);
                        }
                        callback();
                    }
                );
            };

            if (mode === "scroll") {
                clickNextPageButton = scrollDownPage;
            }
            const pageAction = actOnPage ? clickNextPageButton : null;
            actOnPage = true;

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
                    if (!isLoaded && runId !== scrapingState.runId) return stopWaiting();
                    if (!isLoaded && isTimeoutReached) {
                        checkTabAlive(function(isAlive) {
                            if (!isLoaded && runId !== scrapingState.runId) return stopWaiting();
                            if (!isAlive) return triggerErrorCallback();
                            if (!isLoaded) {
                                stopWaiting();
                                onLoadComplete();
                            }
                        });
                    }
                }

                function stopWaiting() {
                    isLoaded = true;
                    chromeInstance.webRequest.onBeforeRequest.removeListener(onBeforeRequestHandler);
                    chromeInstance.webRequest.onCompleted.removeListener(onCompletedHandler);
                    chromeInstance.webRequest.onErrorOccurred.removeListener(onCompletedHandler);
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
                pageAction,
                function() {
                    // Page loaded -> retrieve new table data rows
                    chromeInstance.tabs.sendMessage(
                        currentTab.id,
                        {
                            action: "getTableData",
                            selector: scrapingState.tableSelector
                        },
                        function(response) {
                            if (runId !== scrapingState.runId) return;
                            scrapingState.pageRound = false;
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
                            if (!scrapingState.scraping) $("#wrongTable").show();
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