/* ======================================================
   EXAM HEADER — exam-header.js
   एक बटन से पहले पेज में प्रश्न-पत्र का हैडर डाल देता है:
   Coaching का नाम, Class/FM, Subject/Time, एक horizontal rule,
   और पेपर की heading वाली लाइन — बिल्कुल एक तैयार परीक्षा-पत्र के
   ऊपरी हिस्से जैसा। बाकी पूरा दस्तावेज़ (जो कुछ भी उस पेज में पहले
   से लिखा है) जस का तस नीचे बना रहता है — यह सिर्फ़ सबसे ऊपर जुड़ता है।

   बाकी किसी भी फाइल (editor-core.js, pagination.js आदि) की logic
   को नहीं छूता — बिलकुल isolated feature है, chapter-box जैसे ही
   पैटर्न पर बना है (data-no-split="true" ताकि यह हैडर कभी बीच में
   से टूटकर दो पेजों में न बँटे)।

   हैडर के अंदर हर field (Coaching नाम, Class, Subject, FM, Time,
   heading) सामान्य text की तरह ही editable है — बस उस पर क्लिक
   करके अपनी जानकारी टाइप कर दें, जैसे बाकी किसी भी लाइन में करते हैं।
   ====================================================== */

(function () {
    "use strict";

    window.insertQuestionPaperHeader = function () {
        const firstPage = document.querySelector(".page");
        if (!firstPage) return;

        if (firstPage.querySelector(".qp-header")) {
            const proceed = confirm(
                "पहले पेज में पहले से एक हैडर मौजूद है। क्या एक और हैडर जोड़ना चाहते हैं?"
            );
            if (!proceed) return;
        }

        const html =
            '<div class="qp-header" data-no-split="true">' +
            '<div class="qp-coaching-name">Shadab Coaching Centre</div>' +
            '<table class="qp-info-table"><tbody>' +
            '<tr>' +
            '<td><span class="qp-label">Class:</span> <span class="qp-fill">e.g. 10-A</span></td>' +
            '<td><span class="qp-label">FM:</span> <span class="qp-fill">100</span></td>' +
            "</tr>" +
            "<tr>" +
            '<td><span class="qp-label">Subject:</span> <span class="qp-fill">e.g. Mathematics</span></td>' +
            '<td><span class="qp-label">Time:</span> <span class="qp-fill">3 hrs</span></td>' +
            "</tr>" +
            "</tbody></table>" +
            '<hr class="qp-rule">' +
            '<div class="qp-title-box">' +
            '<div class="qp-title-line">|&nbsp; यहाँ पेपर की heading लिखें — जैसे: विज्ञान टेस्ट पेपर — Set 2 &nbsp;|</div>' +
            "</div>" +
            "</div>";

        firstPage.insertAdjacentHTML("afterbegin", html);

        // पेज का math/pagination दोबारा गणना करवा दें (chapter-box वाले
        // बटन में भी यही तरीक़ा इस्तेमाल होता है)
        if (window.WPSEditor && window.WPSEditor.scheduleForPage) {
            window.WPSEditor.scheduleForPage(firstPage);
        } else if (window.WPSEditor && window.WPSEditor.scheduleRepagination) {
            window.WPSEditor.scheduleRepagination();
        }
    };
})();
