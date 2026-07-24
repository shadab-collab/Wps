/* ======================================================
   PAGE IMAGE EXPORT — page-export.js
   Lets the user pick one or more specific pages (not the whole
   document) and download each as a high-resolution PNG image —
   useful for sharing a single worksheet page on WhatsApp etc.
   without generating a full PDF.
   ====================================================== */

(function() {
  "use strict";
  
  const EXPORT_SCALE = 3; // higher = sharper image, bigger file
  let selectMode = false;
  const selectedWrappers = new Set();
  
  function pageWrappers() {
    return Array.from(document.querySelectorAll(".page-wrapper"));
  }
  
  function addCheckbox(wrapper) {
    if (wrapper.querySelector(".page-select-box")) return;
    const box = document.createElement("div");
    box.className = "page-select-box no-print";
    box.textContent = "☐";
    box.addEventListener("click", function(e) {
      e.preventDefault();
      e.stopPropagation();
      toggleSelected(wrapper, box);
    });
    wrapper.appendChild(box);
  }
  
  function removeCheckboxes() {
    document.querySelectorAll(".page-select-box").forEach((b) => b.remove());
    document.querySelectorAll(".page-wrapper.page-selected").forEach((w) => w.classList.remove("page-selected"));
    selectedWrappers.clear();
  }
  
  function toggleSelected(wrapper, box) {
    if (selectedWrappers.has(wrapper)) {
      selectedWrappers.delete(wrapper);
      wrapper.classList.remove("page-selected");
      box.textContent = "☐";
    } else {
      selectedWrappers.add(wrapper);
      wrapper.classList.add("page-selected");
      box.textContent = "☑";
    }
  }
  
  window.togglePageSelectMode = function() {
    selectMode = !selectMode;
    const btn = document.getElementById("select-pages-btn");
    if (selectMode) {
      pageWrappers().forEach(addCheckbox);
      if (btn) btn.classList.add("btn-success");
    } else {
      removeCheckboxes();
      if (btn) btn.classList.remove("btn-success");
    }
  };
  
  async function exportWrapperAsImage(wrapper, index) {
    const page = wrapper.querySelector(".page");
    if (!page || !window.html2canvas) return;
    const canvas = await window.html2canvas(page, {
      scale: EXPORT_SCALE,
      useCORS: true,
      backgroundColor: "#ffffff"
    });
    const dataUrl = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = "page-" + (index + 1) + ".png";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  
  window.exportSelectedPagesAsImage = async function() {
    if (!window.html2canvas) {
      alert("Image export library अभी लोड नहीं हुई, कृपया थोड़ी देर बाद कोशिश करें।");
      return;
    }
    if (!selectedWrappers.size) {
      alert("पहले 'Select Pages' चालू करके कम-से-कम एक page चुनें।");
      return;
    }
    const wrappers = pageWrappers();
    for (const wrapper of selectedWrappers) {
      const index = wrappers.indexOf(wrapper);
      await exportWrapperAsImage(wrapper, index);
    }
  };
})();