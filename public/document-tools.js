/* ======================================================
   DOCUMENT TOOLS — document-tools.js
   दो अलग, independent features — दोनों किसी भी मौजूदा file की
   logic को नहीं छूते:

   1) "📄 कॉपी बनाएं" — वर्तमान में खुले हुए SAVED दस्तावेज़ की एक
      बिलकुल same-to-same नई कॉपी बनाता है (नया backend route
      /api/documents/:id/duplicate इस्तेमाल करके)। ओरिजिनल दस्तावेज़
      को कभी नहीं छेड़ता — गलती से delete होने पर यही कॉपी बचाव है।
      currentDocId कहीं और maintain नहीं करना पड़ा — मौजूदा
      #doc-select dropdown से ही पढ़ लेते हैं (storage.js उसे पहले
      से sync रखता है), इसलिए storage.js में कोई बदलाव नहीं करना पड़ा।

   2) फॉन्ट सिलेक्टर — पूरे दस्तावेज़ का फॉन्ट बदलने के लिए, जिसमें
      एक "Handwritten" (हस्तलिखित जैसा दिखने वाला) फॉन्ट भी शामिल है।
      भविष्य में कोई नया फॉन्ट पसंद आए तो नीचे FONT_OPTIONS में सिर्फ़
      एक लाइन जोड़नी है — index.html या कहीं और कुछ बदलने की ज़रूरत
      नहीं पड़ेगी।
   ====================================================== */

(function () {
    "use strict";

    /* ------------------------------------------------
       1. फॉन्ट सिलेक्टर

       नया फॉन्ट भविष्य में जोड़ना हो तो नीचे बस एक नई लाइन डालें:
         { label: "जो नाम दिखाना है", family: "CSS font-family value", googleFont: "Google Fonts के लिए family= पैरामीटर (वैकल्पिक)" }

       - अगर फॉन्ट पहले से आपके सिस्टम/browser में install है, तो
         googleFont मत दीजिए, बस family में उसका नाम लिख दें।
       - अगर Google Fonts से लाना है, तो googleFont में वही param डालें
         जो fonts.google.com किसी फॉन्ट के embed-link में देता है
         (जैसे "Kalam:wght@400;700") — पहली बार select करते ही यह
         खुद-ब-खुद load हो जाएगा।
    ------------------------------------------------ */
    const FONT_OPTIONS = [
        { label: "डिफ़ॉल्ट (Segoe UI)", family: '"Segoe UI", Arial, sans-serif' },
        { label: "हस्तलिखित (Handwritten)", family: '"Kalam", cursive', googleFont: "Kalam:wght@400;700" },
        { label: "क्लासिक (Tiro Devanagari Hindi)", family: '"Tiro Devanagari Hindi", serif', googleFont: "Tiro+Devanagari+Hindi" }
        // 👉 यहाँ नई लाइन जोड़ें — बस इतना ही काफ़ी है, बाकी सब अपने आप हो जाएगा
    ];

    function loadGoogleFontIfNeeded(googleFontParam) {
        if (!googleFontParam) return; // पहले से system में मौजूद फॉन्ट — कुछ load नहीं करना
        const linkId = "doc-tools-gfont-" + googleFontParam.replace(/[^a-zA-Z0-9]/g, "-");
        if (document.getElementById(linkId)) return; // पहले ही load हो चुका
        const link = document.createElement("link");
        link.id = linkId;
        link.rel = "stylesheet";
        link.href = "https://fonts.googleapis.com/css2?family=" + googleFontParam + "&display=swap";
        document.head.appendChild(link);
    }

    function populateFontSelect() {
        const select = document.getElementById("font-family-select");
        if (!select) return;
        select.innerHTML = FONT_OPTIONS
            .map(function (f, i) {
                return '<option value="' + i + '">' + f.label + "</option>";
            })
            .join("");
    }

    // toolbar के select से call होता है (onchange="updateFontFamily()")
    window.updateFontFamily = function () {
        const select = document.getElementById("font-family-select");
        if (!select) return;
        const opt = FONT_OPTIONS[parseInt(select.value, 10)];
        if (!opt) return;

        loadGoogleFontIfNeeded(opt.googleFont);
        document.documentElement.style.setProperty("--doc-font-family", opt.family);

        // font बदलने से लाइनों की चौड़ाई/wrapping बदलती है, इसलिए
        // font-size/line-height/margin बदलने पर जैसे repagination
        // होता है, वैसे ही यहाँ भी कर देते हैं
        if (window.WPSEditor && window.WPSEditor.scheduleRepagination) {
            window.WPSEditor.scheduleRepagination();
        }
    };

    /* ------------------------------------------------
       2. कॉपी / डुप्लीकेट दस्तावेज़
    ------------------------------------------------ */
    window.docDuplicate = async function () {
        const select = document.getElementById("doc-select");
        const id = select && select.value;
        if (!id) {
            alert("पहले दस्तावेज़ को सेव करें, उसके बाद ही उसकी कॉपी बन सकती है।");
            return;
        }
        try {
            const res = await fetch("/api/documents/" + id + "/duplicate", { method: "POST" });
            if (!res.ok) throw new Error("duplicate failed");
            const copy = await res.json();

            // dropdown में नई कॉपी भी जोड़ दें — मौजूदा दस्तावेज़ पर ही
            // बने रहते हैं, कहीं switch नहीं करते
            const option = document.createElement("option");
            option.value = copy._id;
            option.textContent = copy.title || "बिना नाम";
            select.appendChild(option);

            alert('कॉपी बन गई: "' + (copy.title || "बिना नाम") + '"');
        } catch (e) {
            alert("कॉपी बनाने में समस्या हुई — दोबारा कोशिश करें।");
        }
    };

    function init() {
        populateFontSelect();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
