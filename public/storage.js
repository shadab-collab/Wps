/* ======================================================
   DOCUMENT STORAGE — storage.js
   Talks to the backend (/api/documents) to save/load/list/delete
   documents, plus debounced auto-save. Kept in its own file since
   it's the piece most likely to change if the backend evolves —
   nothing in editor-core/editor-extras/pagination/zoom-keyboard
   depends on this file existing at all (the editor works fine
   standalone without a backend; this just adds persistence).
   ====================================================== */

(function () {
    "use strict";

    const API_BASE = "/api/documents";
    const AUTOSAVE_DELAY = 8000; // ms of no typing before auto-saving

    let currentDocId = null;
    let autoSaveTimer = null;
    let saving = false;

    function pagesContainer() {
        return document.getElementById("pages-container");
    }

    function titleInput() {
        return document.getElementById("doc-title-input");
    }

    function docSelect() {
        return document.getElementById("doc-select");
    }

    function setStatus(text) {
        const el = document.getElementById("save-status");
        if (el) el.textContent = text;
    }

    /* ------------------------------------------------
       LAST-VIEWED PAGE (per saved document, remembered locally on
       this device/browser). zoom-keyboard.js reports the page nearest
       the top of the viewport whenever a pan/pinch gesture settles;
       loadDocument() below jumps straight there instead of always
       landing on page 1 of a 50-60 page document.
    ------------------------------------------------ */
    function lastPageKey(id) {
        return "wps-last-page:" + id;
    }

    window.WPSEditor = window.WPSEditor || {};
    window.WPSEditor.rememberLastPage = function (pageNumber) {
        if (!currentDocId || !pageNumber) return;
        try {
            localStorage.setItem(lastPageKey(currentDocId), String(pageNumber));
        } catch (e) {
            /* storage full/unavailable — not worth interrupting anything for */
        }
    };

    /* ------------------------------------------------
       API CALLS
    ------------------------------------------------ */
    async function apiListDocuments(archived) {
        const res = await fetch(API_BASE + (archived ? "?archived=true" : ""));
        if (!res.ok) throw new Error("list failed");
        return res.json();
    }

    async function apiGetDocument(id) {
        const res = await fetch(API_BASE + "/" + id);
        if (!res.ok) throw new Error("get failed");
        return res.json();
    }

    async function apiCreateDocument(title, content, settings) {
        const res = await fetch(API_BASE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, content, settings })
        });
        if (!res.ok) throw new Error("create failed");
        return res.json();
    }

    async function apiUpdateDocument(id, title, content, settings) {
        const res = await fetch(API_BASE + "/" + id, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, content, settings })
        });
        if (!res.ok) throw new Error("update failed");
        return res.json();
    }

    async function apiDeleteDocument(id) {
        const res = await fetch(API_BASE + "/" + id, { method: "DELETE" });
        if (!res.ok) throw new Error("delete failed");
        return res.json();
    }

    // Archive = "not needed right now, might be later" — kept out of
    // the normal Saved list/dropdown but never deleted; unarchive just
    // reverses it. Both are a single PUT with no body.
    async function apiArchiveDocument(id) {
        const res = await fetch(API_BASE + "/" + id + "/archive", { method: "PUT" });
        if (!res.ok) throw new Error("archive failed");
        return res.json();
    }

    async function apiUnarchiveDocument(id) {
        const res = await fetch(API_BASE + "/" + id + "/unarchive", { method: "PUT" });
        if (!res.ok) throw new Error("unarchive failed");
        return res.json();
    }

    /* ------------------------------------------------
       PER-DOCUMENT SETTINGS (font size, line spacing, margins,
       font family) — saved alongside content so that a document
       reopens exactly as it was left, instead of always coming
       back in the editor's current/default formatting.
    ------------------------------------------------ */
    const SETTINGS_VARS = [
        "--font-size", "--line-height",
        "--top-margin", "--bottom-margin", "--inside-margin", "--outside-margin",
        "--gutter-margin", "--column-gap",
        "--doc-font-family"
    ];

    function collectCurrentSettings() {
        const style = getComputedStyle(document.documentElement);
        const settings = {};
        SETTINGS_VARS.forEach((v) => {
            const val = style.getPropertyValue(v).trim();
            if (val) settings[v] = val;
        });
        return settings;
    }

    function applySettings(settings) {
        if (!settings || typeof settings !== "object") return;

        SETTINGS_VARS.forEach((v) => {
            if (settings[v]) document.documentElement.style.setProperty(v, settings[v]);
        });

        // toolbar के input boxes को भी sync करें ताकि UI झूठ न बोले
        // (जैसे font-size box में 9 दिखे जबकि असल में 14pt लागू है)
        const setInputValue = (id, cssVar, parseUnit) => {
            const el = document.getElementById(id);
            const raw = settings[cssVar];
            if (!el || !raw) return;
            const num = parseFloat(raw);
            if (!isNaN(num)) el.value = parseUnit ? num : raw;
        };
        setInputValue("font-size-input", "--font-size", true);
        setInputValue("line-height-input", "--line-height", true);
        setInputValue("top-margin", "--top-margin", true);
        setInputValue("bottom-margin", "--bottom-margin", true);
        setInputValue("inside-margin", "--inside-margin", true);
        setInputValue("outside-margin", "--outside-margin", true);
        setInputValue("gutter-margin", "--gutter-margin", true);
        setInputValue("column-gap-margin", "--column-gap", true);

        if (window.WPSEditor && window.WPSEditor.syncFontSelectorUI) {
            window.WPSEditor.syncFontSelectorUI(settings["--doc-font-family"]);
        }
    }

    /* ------------------------------------------------
       SAVE / LOAD / NEW
    ------------------------------------------------ */
    async function saveDocument(silent) {
        if (saving) return; // avoid overlapping saves
        saving = true;
        if (!silent) setStatus("सेव हो रहा है...");
        try {
            const title = (titleInput() && titleInput().value.trim()) || "बिना नाम";
            const content = pagesContainer().innerHTML;
            const settings = collectCurrentSettings();
            const doc = currentDocId
                ? await apiUpdateDocument(currentDocId, title, content, settings)
                : await apiCreateDocument(title, content, settings);
            currentDocId = doc._id;
            setStatus("सेव हो गया ✓");
            await refreshDocList();
        } catch (e) {
            setStatus("सेव नहीं हो पाया — फिर कोशिश करें");
        } finally {
            saving = false;
        }
    }

    async function loadDocument(id) {
        setStatus("खुल रहा है...");
        try {
            const doc = await apiGetDocument(id);
            pagesContainer().innerHTML = doc.content || "";
            currentDocId = doc._id;
            if (titleInput()) titleInput().value = doc.title || "";
            applySettings(doc.settings);

            // re-wire the restored pages (listeners, math, pagination)
            document.querySelectorAll(".page").forEach((page) => {
                window.WPSEditor.attachPageListeners(page);
                window.WPSEditor.renderMathInPage(page);
            });
            window.WPSEditor.renumberPages();
            window.WPSEditor.repaginateAll(() => {
                // Jump back to wherever the user last left off reading/
                // editing this document, instead of always landing on
                // page 1 and making them re-scroll through everything —
                // only meaningful once pagination has settled, so this
                // runs as repaginateAll's completion callback.
                let lastPage = null;
                try {
                    lastPage = localStorage.getItem(lastPageKey(currentDocId));
                } catch (e) {
                    /* storage unavailable — just open at page 1, same as before */
                }
                if (lastPage && window.WPSEditor.scrollToPageNumber) {
                    window.WPSEditor.scrollToPageNumber(parseInt(lastPage, 10));
                }
            });
            setStatus("खुल गया ✓");
        } catch (e) {
            setStatus("खोलने में समस्या हुई");
        }
    }

    function newDocument() {
        currentDocId = null;
        if (titleInput()) titleInput().value = "";
        const container = pagesContainer();
        container.innerHTML = "";
        const wrapper = window.WPSEditor.createPageWrapper(1);
        container.appendChild(wrapper);
        const page = wrapper.querySelector(".page");
        page.innerHTML = "<p><br></p>";
        window.WPSEditor.renumberPages();
        setStatus("नया दस्तावेज़");
    }

    async function refreshDocList() {
        const select = docSelect();
        if (!select) return;
        try {
            const docs = await apiListDocuments();
            select.innerHTML =
                '<option value="">-- दस्तावेज़ चुनें --</option>' +
                docs
                    .map((d) => '<option value="' + d._id + '">' + (d.title || "बिना नाम") + "</option>")
                    .join("");
            if (currentDocId) select.value = currentDocId;
        } catch (e) {
            /* list refresh failing shouldn't block editing */
        }
    }

    async function deleteCurrentDocument() {
        if (!currentDocId) return;
        try {
            await apiDeleteDocument(currentDocId);
            newDocument();
            await refreshDocList();
        } catch (e) {
            setStatus("हटाने में समस्या हुई");
        }
    }

    /* ------------------------------------------------
       AUTO-SAVE
    ------------------------------------------------ */
    function scheduleAutoSave() {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(() => saveDocument(true), AUTOSAVE_DELAY);
    }

    /* ------------------------------------------------
       LANDING SCREEN (shown on first load — choose New or Saved
       before touching the editor at all)
    ------------------------------------------------ */
    function landingScreen() {
        return document.getElementById("landing-screen");
    }

    window.showNewDocPrompt = function () {
        const savedList = document.getElementById("landing-saved-list");
        const newForm = document.getElementById("landing-new-form");
        if (savedList) savedList.style.display = "none";
        if (newForm) newForm.style.display = "flex";
    };

    // Renders the one shared list panel — used for both the normal
    // "सेव्ड दस्तावेज़" list and the "आर्काइव" list (same look/element,
    // just a different data source and a different per-item action
    // button: archive vs restore). Each item still opens on click same
    // as before; the action button sits inside the same row and stops
    // the click from bubbling up to that open-on-click handler.
    async function renderDocListPanel(archived, actionLabel, actionFn) {
        const newForm = document.getElementById("landing-new-form");
        const listEl = document.getElementById("landing-saved-list");
        if (newForm) newForm.style.display = "none";
        if (!listEl) return;
        listEl.style.display = "block";
        listEl.innerHTML = "लोड हो रहा है...";
        try {
            const docs = await apiListDocuments(archived);
            if (!docs.length) {
                listEl.innerHTML = "<p>" + (archived ? "आर्काइव खाली है।" : "कोई सेव्ड दस्तावेज़ नहीं मिला।") + "</p>";
                return;
            }
            listEl.innerHTML = docs
                .map(
                    (d) =>
                        '<div class="landing-doc-item" onclick="openFromLanding(\'' + d._id + '\')">' +
                            '<span class="landing-doc-title">' + (d.title || "बिना नाम") +
                            ' <span class="landing-doc-date">(' + new Date(d.updatedAt).toLocaleDateString("hi-IN") + ")</span></span>" +
                            '<button class="landing-doc-action-btn" onclick="event.stopPropagation(); ' +
                                actionFn + "('" + d._id + "')\">" + actionLabel + "</button>" +
                        "</div>"
                )
                .join("");
        } catch (e) {
            listEl.innerHTML = "<p>सूची लाने में समस्या हुई।</p>";
        }
    }

    window.showSavedDocsList = function () {
        renderDocListPanel(false, "🗄️ आर्काइव", "archiveDocument");
    };

    // "काम नहीं है अभी, शायद भविष्य में काम पड़े" वाले दस्तावेज़ों की
    // अलग सूची — होमपेज पर सेव्ड के बगल में तीसरा बटन।
    window.showArchivedDocsList = function () {
        renderDocListPanel(true, "♻️ वापस लाएँ", "unarchiveDocument");
    };

    // Saved → Archive. Only flips the flag on the backend — nothing
    // about the document's content/title/settings changes, and it's
    // never deleted. Refreshes both this list (the doc should drop
    // out of it now) and the toolbar's document dropdown.
    window.archiveDocument = async function (id) {
        try {
            await apiArchiveDocument(id);
            window.showSavedDocsList();
            refreshDocList();
        } catch (e) {
            alert("आर्काइव करने में समस्या हुई");
        }
    };

    // Archive → Saved (the reverse move).
    window.unarchiveDocument = async function (id) {
        try {
            await apiUnarchiveDocument(id);
            window.showArchivedDocsList();
            refreshDocList();
        } catch (e) {
            alert("वापस लाने में समस्या हुई");
        }
    };

    window.confirmNewDocFromLanding = function () {
        const input = document.getElementById("landing-title-input");
        const name = input ? input.value.trim() : "";
        if (!name) {
            alert("कृपया दस्तावेज़ का नाम लिखें");
            return;
        }
        newDocument();
        if (titleInput()) titleInput().value = name;
        if (landingScreen()) landingScreen().style.display = "none";
    };

    window.openFromLanding = function (id) {
        loadDocument(id);
        if (landingScreen()) landingScreen().style.display = "none";
    };

    /* ------------------------------------------------
       PUBLIC (toolbar buttons call these)
    ------------------------------------------------ */
    window.docSaveNow = function () {
        saveDocument(false);
    };
    window.docNew = function () {
        newDocument();
    };
    window.docOpenSelected = function () {
        const id = docSelect() && docSelect().value;
        if (id) loadDocument(id);
    };
    window.docDelete = function () {
        deleteCurrentDocument();
    };

    function init() {
        refreshDocList();
        const container = pagesContainer();
        if (container) container.addEventListener("input", scheduleAutoSave);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
