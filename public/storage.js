/* ======================================================
   DOCUMENT STORAGE — storage.js
   Talks to the backend (/api/documents) to save/load/list/delete
   documents, plus debounced auto-save. Kept in its own file since
   it's the piece most likely to change if the backend evolves —
   nothing in editor-core/editor-extras/pagination/zoom-keyboard
   depends on this file existing at all (the editor works fine
   standalone without a backend; this just adds persistence).
   ====================================================== */

(function() {
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
     API CALLS
  ------------------------------------------------ */
  async function apiListDocuments() {
    const res = await fetch(API_BASE);
    if (!res.ok) throw new Error("list failed");
    return res.json();
  }
  
  async function apiGetDocument(id) {
    const res = await fetch(API_BASE + "/" + id);
    if (!res.ok) throw new Error("get failed");
    return res.json();
  }
  
  async function apiCreateDocument(title, content) {
    const res = await fetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content })
    });
    if (!res.ok) throw new Error("create failed");
    return res.json();
  }
  
  async function apiUpdateDocument(id, title, content) {
    const res = await fetch(API_BASE + "/" + id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content })
    });
    if (!res.ok) throw new Error("update failed");
    return res.json();
  }
  
  async function apiDeleteDocument(id) {
    const res = await fetch(API_BASE + "/" + id, { method: "DELETE" });
    if (!res.ok) throw new Error("delete failed");
    return res.json();
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
      const doc = currentDocId ?
        await apiUpdateDocument(currentDocId, title, content) :
        await apiCreateDocument(title, content);
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
      
      // re-wire the restored pages (listeners, math, pagination)
      document.querySelectorAll(".page").forEach((page) => {
        window.WPSEditor.attachPageListeners(page);
        window.WPSEditor.renderMathInPage(page);
      });
      window.WPSEditor.renumberPages();
      window.WPSEditor.repaginateAll();
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
     PUBLIC (toolbar buttons call these)
  ------------------------------------------------ */
  window.docSaveNow = function() {
    saveDocument(false);
  };
  window.docNew = function() {
    newDocument();
  };
  window.docOpenSelected = function() {
    const id = docSelect() && docSelect().value;
    if (id) loadDocument(id);
  };
  window.docDelete = function() {
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
