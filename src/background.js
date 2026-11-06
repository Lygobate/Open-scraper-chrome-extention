(() => {
    "use strict";

    const chromeInstance = chrome;

    /**
     * Opens the main Open Scraper interface in a standalone popup window for the specified tab.
     * @param {Object} tab - Chrome tab object.
     */
    function openPopupForTab(tab) {
        const searchParams = new URLSearchParams({
            tabid: String(tab.id ?? ""),
            url: tab.url ?? ""
        });
        chromeInstance.windows.create({
            url: chromeInstance.runtime.getURL("src/popup.html?" + searchParams.toString()),
            type: "popup",
            width: 720,
            height: 690
        });
    }

    // --- Extension Event Listeners ---

    // Open scraping tool on extension icon click
    chromeInstance.action.onClicked.addListener(openPopupForTab);
})();