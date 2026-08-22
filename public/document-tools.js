/* ======================================================
   DOCUMENT TOOLS — document-tools.js
   तीन अलग, independent features — सब किसी भी मौजूदा file की
   logic को नहीं छूते:

   1) "📄 कॉपी बनाएं" — वर्तमान में खुले हुए SAVED दस्तावेज़ की एक
      बिलकुल same-to-same नई कॉपी बनाता है (नया backend route
      /api/documents/:id/duplicate इस्तेमाल करके)। ओरिजिनल दस्तावेज़
      को कभी नहीं छेड़ता — गलती से delete होने पर यही कॉपी बचाव है।
      currentDocId कहीं और maintain नहीं करना पड़ा — मौजूदा
      #doc-select dropdown से ही पढ़ लेते हैं (storage.js उसे पहले
      से sync रखता है), इसलिए storage.js में कोई बदलाव नहीं करना पड़ा।

   2) फॉन्ट सिलेक्टर — तीन तरीक़ों से फॉन्ट जोड़े जा सकते हैं:
        a) Google Fonts / system फॉन्ट → नीचे FONT_OPTIONS में लाइन जोड़ें
        b) GitHub में डाली गई फॉन्ट फाइल (public/fonts/ फ़ोल्डर में) →
           नीचे CUSTOM_FONT_FILES में लाइन जोड़ें
        c) सीधे फ़ोन/कंप्यूटर से "➕ फॉन्ट अपलोड" बटन से — कुछ भी
           edit करने की ज़रूरत नहीं, फाइल चुनते ही dropdown में आ
           जाता है और अगली बार भी (उसी ब्राउज़र में) याद रहता है
   ====================================================== */

(function () {
    "use strict";

    /* ------------------------------------------------
       2a. Google Fonts / पहले से system में मौजूद फॉन्ट

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

    /* ------------------------------------------------
       2b. GitHub में डाली गई फॉन्ट फाइलें (public/fonts/ फ़ोल्डर)

       Steps:
         1) डाउनलोड की हुई फॉन्ट फाइल (.ttf/.otf/.woff/.woff2) को
            public/fonts/ फ़ोल्डर में डाल दें (GitHub पर उसी फ़ोल्डर
            में upload कर दें)।
         2) नीचे यहाँ एक लाइन जोड़ें:
              { label: "जो नाम दिखाना है", family: "कोई भी unique नाम", file: "fonts/आपकी-फाइल.woff2" }
         3) Save करके redeploy/refresh करें — फॉन्ट dropdown में आ जाएगा।

       यह तरीक़ा स्थायी (permanent) है — सबके लिए हमेशा उपलब्ध रहेगा,
       चाहे उन्होंने कुछ भी upload न किया हो।
    ------------------------------------------------ */
    const CUSTOM_FONT_FILES = [
        // उदाहरण (असल इस्तेमाल के लिए अनकमेंट करें और फाइल public/fonts/ में डालें):
        // { label: "मेरा फॉन्ट", family: "MeraFont", file: "fonts/MeraFont.woff2" }
    ];

    // dropdown में दिखने वाली पूरी combined लिस्ट — यही असल source of truth है,
    // FONT_OPTIONS/CUSTOM_FONT_FILES से शुरू होकर runtime में अपलोड किए फॉन्ट भी
    // इसी में जुड़ते हैं
    let ALL_FONTS = FONT_OPTIONS.slice();

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

    // GitHub/public/fonts/ वाली फॉन्ट फाइलों के लिए @font-face रजिस्टर करता है
    function registerLocalFontFile(family, filePath) {
        const styleId = "doc-tools-localfont-" + family.replace(/[^a-zA-Z0-9]/g, "-");
        if (document.getElementById(styleId)) return;
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent =
            '@font-face { font-family: "' + family + '"; src: url("' + filePath + '"); font-display: swap; }';
        document.head.appendChild(style);
    }

    function populateFontSelect() {
        const select = document.getElementById("font-family-select");
        if (!select) return;
        const prevValue = select.value;
        select.innerHTML = ALL_FONTS
            .map(function (f, i) {
                return '<option value="' + i + '">' + f.label + "</option>";
            })
            .join("");
        // अगर चुना हुआ फॉन्ट अभी भी लिस्ट में मौजूद है तो उसे फिर select रखें
        if (prevValue !== "" && parseInt(prevValue, 10) < ALL_FONTS.length) {
            select.value = prevValue;
        }
    }

    // toolbar के select से call होता है (onchange="updateFontFamily()")
    window.updateFontFamily = function () {
        const select = document.getElementById("font-family-select");
        if (!select) return;
        const opt = ALL_FONTS[parseInt(select.value, 10)];
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
       2c. फ़ोन/कंप्यूटर से सीधे फॉन्ट अपलोड ("➕ फॉन्ट अपलोड" बटन)

       कोई भी .ttf/.otf/.woff/.woff2 फाइल चुनते ही:
         - वह तुरंत document में load होकर dropdown में जुड़ जाती है
         - इसी ब्राउज़र में (localStorage में) याद रह जाती है, यानी
           अगली बार खोलने पर दोबारा select करने की ज़रूरत नहीं
       ध्यान रहे — यह सिर्फ़ उसी ब्राउज़र/डिवाइस पर काम करता है जिसमें
       अपलोड किया गया था। हर डिवाइस/browser पर हमेशा के लिए चाहिए तो
       ऊपर वाला (b) GitHub फ़ोल्डर तरीक़ा इस्तेमाल करें।
    ------------------------------------------------ */
    const UPLOAD_STORAGE_KEY = "wps-uploaded-fonts";

    function readUploadedFontsFromStorage() {
        try {
            return JSON.parse(localStorage.getItem(UPLOAD_STORAGE_KEY) || "[]");
        } catch (e) {
            return [];
        }
    }

    function saveUploadedFontsToStorage(list) {
        try {
            localStorage.setItem(UPLOAD_STORAGE_KEY, JSON.stringify(list));
        } catch (e) {
            // storage भर गया हो या browser ने मना कर दिया हो तो चुपचाप छोड़ दें —
            // फॉन्ट फिर भी इसी session में इस्तेमाल होता रहेगा
        }
    }

    // dataURL (base64) से असल FontFace बनाकर document.fonts में जोड़ता है, और
    // dropdown लिस्ट (ALL_FONTS) में entry भी डालता है
    async function activateUploadedFont(label, familyName, dataUrl) {
        const buffer = await (await fetch(dataUrl)).arrayBuffer();
        const fontFace = new FontFace(familyName, buffer);
        await fontFace.load();
        document.fonts.add(fontFace);
        ALL_FONTS.push({ label: "📎 " + label, family: '"' + familyName + '"' });
    }

    window.handleFontUpload = async function (event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        const label = file.name.replace(/\.[^.]+$/, ""); // extension हटाकर नाम
        const familyName = "Uploaded-" + Date.now();

        try {
            const dataUrl = await new Promise(function (resolve, reject) {
                const reader = new FileReader();
                reader.onload = function () { resolve(reader.result); };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });

            await activateUploadedFont(label, familyName, dataUrl);
            populateFontSelect();

            // नया अपलोड किया फॉन्ट तुरंत select करके लगा भी दें
            const select = document.getElementById("font-family-select");
            if (select) {
                select.value = String(ALL_FONTS.length - 1);
                window.updateFontFamily();
            }

            // localStorage में सेव करें ताकि अगली बार अपने-आप वापस आ जाए
            const stored = readUploadedFontsFromStorage();
            stored.push({ label: label, familyName: familyName, dataUrl: dataUrl });
            saveUploadedFontsToStorage(stored);

            alert('फॉन्ट "' + label + '" जुड़ गया और लागू भी हो गया।');
        } catch (e) {
            alert("यह फॉन्ट फाइल load नहीं हो पाई — कोई और फाइल आज़माएँ।");
        } finally {
            event.target.value = ""; // ताकि वही फाइल दोबारा चुनने पर भी onchange चले
        }
    };

    // पिछली बार अपलोड किए फॉन्ट्स को वापस लोड करना (पेज खुलते ही)
    async function restoreUploadedFonts() {
        const stored = readUploadedFontsFromStorage();
        for (const item of stored) {
            try {
                await activateUploadedFont(item.label, item.familyName, item.dataUrl);
            } catch (e) {
                // कोई खराब entry हो तो उसे नज़रअंदाज़ करके बाक़ी लोड होते रहें
            }
        }
    }

    /* ------------------------------------------------
       3. कॉपी / डुप्लीकेट दस्तावेज़
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

    async function init() {
        // GitHub/public/fonts/ वाली custom फाइलों को register करके ALL_FONTS में जोड़ें
        CUSTOM_FONT_FILES.forEach(function (f) {
            registerLocalFontFile(f.family, f.file);
            ALL_FONTS.push({ label: f.label, family: '"' + f.family + '"' });
        });

        await restoreUploadedFonts(); // पहले अपलोड किए फॉन्ट वापस लाएँ
        populateFontSelect();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
