(() => {
    "use strict";

    // CSS class put on <body> while the page details panel is shown
    const DETAILS_MODE_CLASS = "mode-details";

    // Elements of the list panel, kept in the layout but made inert while hidden
    const LIST_PANEL_IDS = ["wait", "content"];

    /**
     * Shows one of the two extraction modes. The list panel is never hidden with display:none,
     * so its own visibility logic and grid sizing keep working exactly as before.
     * @param {"list"|"details"} mode - Mode to show.
     */
    function setMode(mode) {
        const showDetails = mode === "details";
        document.body.classList.toggle(DETAILS_MODE_CLASS, showDetails);

        const tabList = document.getElementById("tabList");
        const tabDetails = document.getElementById("tabDetails");
        tabList.classList.toggle("is-active", !showDetails);
        tabDetails.classList.toggle("is-active", showDetails);
        tabList.setAttribute("aria-selected", String(!showDetails));
        tabDetails.setAttribute("aria-selected", String(showDetails));

        LIST_PANEL_IDS.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.inert = showDetails;
        });
    }

    document.getElementById("tabList").addEventListener("click", () => setMode("list"));
    document.getElementById("tabDetails").addEventListener("click", () => setMode("details"));
})();
