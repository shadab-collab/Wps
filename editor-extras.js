/* ======================================================
   EDITOR EXTRAS — editor-extras.js
   The newest, most actively-evolving features: Markdown-block
   raw-edit toggle (tables/headings/lists) and marker-driven line
   tools (■ serial numbers, ◆ bold-line toggle). Kept separate from
   editor-core.js so ongoing changes/bug-fixes here never risk the
   more settled core (formatting, paste, math, images).
   ====================================================== */

(function() {
  "use strict";
  
  window.WPSEditor = window.WPSEditor || {};
  
  /* ==================================================
     4B. MARKDOWN BLOCK RAW-EDIT TOGGLE
     Tables, headings, and bullet lists behave like LaTeX
     formulas: double-tap reveals the underlying Markdown source
     (freely editable — add/remove table rows, list items,
     change heading level, etc.), tapping away re-renders it.
     Single tap still does normal in-place text editing (e.g.
     fixing a typo in one table cell), since that's handled by
     ordinary contenteditable and isn't touched by this.
  ================================================== */
  // Like el.textContent, but for any rendered .latex-formula inside,
  // uses its stored data-latex source instead of the live rendered
  // text — KaTeX embeds a hidden copy of the raw LaTeX (for screen
  // readers) inside every formula it renders, and plain .textContent
  // would pull that in too, duplicating the formula when round-
  // tripped back to raw Markdown.
  function cleanTextForMarkdown(el) {
    let result = "";
    el.childNodes.forEach((node) => {
      if (node.nodeType === 3) {
        result += node.nodeValue;
      } else if (node.nodeType === 1) {
        if (node.classList && node.classList.contains("latex-formula")) {
          result += node.getAttribute("data-latex") || "";
        } else {
          result += cleanTextForMarkdown(node);
        }
      }
    });
    return result;
  }
  
  function domTableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (!rows.length) return "";
    const lines = rows.map((tr) => {
      const cells = Array.from(tr.children).map((c) => cleanTextForMarkdown(c).trim());
      return "| " + cells.join(" | ") + " |";
    });
    const colCount = rows[0].children.length;
    const sep = "|" + Array(colCount).fill(" --- ").join("|") + "|";
    lines.splice(1, 0, sep);
    return lines.join("\n");
  }
  
  function domListToMarkdown(list) {
    const items = Array.from(list.children).filter((c) => c.tagName === "LI");
    return items.map((li) => "- " + cleanTextForMarkdown(li).trim()).join("\n");
  }
  
  function domHeadingToMarkdown(h) {
    const level = Number(h.tagName.charAt(1));
    return "#".repeat(level) + " " + cleanTextForMarkdown(h).trim();
  }
  
  function markdownSourceFor(el) {
    if (el.tagName === "TABLE") return domTableToMarkdown(el);
    if (el.tagName === "UL" || el.tagName === "OL") return domListToMarkdown(el);
    if (/^H[1-6]$/.test(el.tagName)) return domHeadingToMarkdown(el);
    return cleanTextForMarkdown(el);
  }
  
  // Reuses the same paste-time Markdown parser to turn edited raw
  // text back into a rendered element, so raw-edit and paste always
  // agree on syntax.
  function markdownSourceToElement(raw) {
    const html = window.WPSEditor.cleanPasteToParagraphs(raw) || "<p></p>";
    const temp = document.createElement("div");
    temp.innerHTML = html;
    return temp.firstElementChild || document.createTextNode(raw);
  }
  
  function watchForMdBlockExit(editableEl) {
    function check() {
      const sel = window.getSelection();
      const stillInside = sel.rangeCount > 0 && editableEl.isConnected && editableEl.contains(sel.getRangeAt(0).startContainer);
      if (!stillInside) {
        document.removeEventListener("selectionchange", check);
        const raw = editableEl.textContent;
        const rendered = markdownSourceToElement(raw);
        attachMarkdownEditToggle(rendered);
        editableEl.replaceWith(rendered);
        if (window.WPSEditor.scheduleRepagination) window.WPSEditor.scheduleRepagination();
      }
    }
    document.addEventListener("selectionchange", check);
  }
  
  function attachMarkdownEditToggle(el) {
    if (!el || !el.dataset || el.dataset.mdEditable === "1") return;
    el.dataset.mdEditable = "1";
    el.addEventListener("dblclick", function(e) {
      e.preventDefault();
      e.stopPropagation();
      const page = window.WPSEditor.closestPage(el);
      if (!page) return;
      const raw = markdownSourceFor(el);
      
      const editable = document.createElement("div");
      editable.className = "md-raw-edit";
      editable.contentEditable = "true";
      editable.textContent = raw;
      el.replaceWith(editable);
      
      const range = document.createRange();
      range.selectNodeContents(editable);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      page.focus({ preventScroll: true });
      
      watchForMdBlockExit(editable);
    });
  }
  
  function attachMarkdownBlocksInPage(page) {
    page.querySelectorAll("table, h1, h2, h3, h4, h5, h6, ul, ol").forEach(attachMarkdownEditToggle);
  }
  
  /* ==================================================
     MARKER-DRIVEN LINE TOOLS
     ■ at the start of a line: "क्रमांक" button turns runs of
     consecutive ■-marked lines into 1,2,3... — each gap in
     marking restarts the count at 1 for the next run.
     ◆ at the start of a line: "Bold Line" button independently
     toggles bold for every ◆-marked line in the whole document.
  ================================================== */
  const SERIAL_MARKER = "■";
  const BOLD_MARKER = "◆";
  
  function allBlocksInDocOrder() {
    return Array.from(document.querySelectorAll(".page p, .page li"));
  }
  
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  
  function findFirstTextNodeStartingWith(el, marker) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue.trimStart().indexOf(marker) === 0) return node;
    }
    return null;
  }
  
  window.applySerialNumbers = function() {
    const blocks = allBlocksInDocOrder();
    let counter = 0;
    let prevWasMarked = false;
    blocks.forEach((el) => {
      const isMarked = el.textContent.trimStart().indexOf(SERIAL_MARKER) === 0;
      if (isMarked) {
        counter = prevWasMarked ? counter + 1 : 1;
        const textNode = findFirstTextNodeStartingWith(el, SERIAL_MARKER);
        if (textNode) {
          textNode.nodeValue = textNode.nodeValue.replace(
            new RegExp("^(\\s*)" + escapeRegExp(SERIAL_MARKER) + "\\s*"),
            "$1" + counter + ". "
          );
        }
      }
      prevWasMarked = isMarked;
    });
    window.WPSEditor.scheduleRepagination();
  };
  
  window.toggleBoldLines = function() {
    const blocks = allBlocksInDocOrder();
    blocks.forEach((el) => {
      if (el.textContent.trimStart().indexOf(BOLD_MARKER) === 0) {
        el.style.fontWeight = el.style.fontWeight === "bold" ? "" : "bold";
      }
    });
    window.WPSEditor.scheduleRepagination();
  };
  
  Object.assign(window.WPSEditor, {
    attachMarkdownBlocksInPage: attachMarkdownBlocksInPage
  });
})();