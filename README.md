# WPS Editor Backend — Deploy Guide (Render + MongoDB Atlas)

## Folder structure
```
backend/
  server.js
  models/Document.js
  routes/documents.js
  package.json
  .env.example
  public/              <-- यहाँ अपनी editor की सारी files डालें
    index.html
    style.css
    editor-core.js
    editor-extras.js
    pagination.js
    zoom-keyboard.js
    storage.js
```

`public` फ़ोल्डर बनाकर उसमें editor की सभी frontend files (index.html, style.css, सारी .js files) copy कर दें — server उन्हें सीधे serve कर देगा, अलग से hosting की ज़रूरत नहीं।

## Steps

1. **MongoDB Atlas**: अपने account में एक नया (free tier) cluster बनाएं, एक database user बनाएं, "Connection string" कॉपी करें (mongodb+srv://... से शुरू होगी)।

2. **local test (optional)**:
   ```
   cd backend
   npm install
   cp .env.example .env
   # .env में अपनी असली MONGODB_URI डालें
   npm start
   ```
   फिर `http://localhost:7700` खोलकर देखें editor और save/load काम कर रहा है या नहीं।

3. **GitHub पर push करें** (backend फ़ोल्डर सहित पूरा project)।

4. **Render पर नया "Web Service" बनाएं**:
   - अपना GitHub repo select करें
   - Root Directory: `backend` (अगर backend अलग फ़ोल्डर में है)
   - **Runtime: "Docker" चुनें** (Node नहीं) — Render अपने-आप `backend/Dockerfile` को पहचानकर उसी से build करेगा
   - Environment Variables में जोड़ें: `MONGODB_URI` = अपनी Atlas connection string

5. Deploy होने के बाद Render जो URL देगा, वही आपका live editor है।

## PDF/Image Export में Hindi Font क्यों Docker से ठीक हुआ

पहले हमने `@sparticuz/chromium` (AWS Lambda के लिए बनाया गया एक बहुत हल्का Chromium) इस्तेमाल किया था — उसमें Devanagari जैसी जटिल लिपियों की rendering-क्षमता ही सीमित/छँटी हुई थी, सिर्फ़ font जोड़ने से ठीक नहीं होता।

अब `Dockerfile` के ज़रिए हम खुद:
- **पूरा असली Chromium** install करते हैं (`apt-get install chromium`)
- **Noto fonts** (Devanagari सहित) install करते हैं (`fonts-noto`)

इससे PDF और Image export दोनों में हिंदी हमेशा सही दिखेगी, बिना किसी internet-निर्भर font-loading के।

## PDF Direct-Download के बारे में ज़रूरी बात

"💾 Save A4 PDF" बटन अब backend पर एक headless browser (Puppeteer) चलाकर असली PDF बनाता है और सीधे download कर देता है — पहले वाला browser का print-dialog अब नहीं खुलता।

इसके लिए 2 नई dependencies जुड़ी हैं (`package.json` में पहले से शामिल): `puppeteer-core` और `@sparticuz/chromium`। यह हल्का combo है (सर्वरलेस/सीमित-resource hosting के लिए ही बनाया गया है), पर फिर भी headless Chromium चलाना सामान्य API कॉल से भारी है।

- Render के **free tier** पर यह धीमा हो सकता है या कभी-कभी memory सीमा से टकरा सकता है — अगर ऐसा हो तो थोड़ा इंतज़ार करके दोबारा कोशिश करें, या ज़रूरत पड़े तो paid tier पर upgrade करें।
- अगर direct-download काम न करे, तो toolbar में मौजूद **"🖨️ Print (fallback)"** बटन से पुराना, browser का print-dialog वाला तरीका हमेशा उपलब्ध है — यह कभी नहीं टूटेगा, चाहे backend में कुछ भी दिक्कत हो।

# यहाँ फॉन्ट फाइलें डालें (permanent तरीक़ा — GitHub)

अगर कोई फॉन्ट हमेशा के लिए, सबके लिए उपलब्ध कराना है (सिर्फ़ अपने
device पर नहीं), तो:

1. फॉन्ट फाइल (.ttf / .otf / .woff / .woff2) यहाँ इसी फ़ोल्डर में डालें
   (GitHub पर सीधे upload कर सकते हैं — "Add file → Upload files")

2. `public/document-tools.js` फाइल खोलें, `CUSTOM_FONT_FILES` वाली
   लिस्ट में एक लाइन जोड़ें:

   ```js
   { label: "जो नाम दिखाना है", family: "कोई भी unique नाम", file: "fonts/आपकी-फाइल.woff2" }
   ```

3. Save/deploy करें — फॉन्ट selector dropdown में अपने-आप आ जाएगा।

---

**तुरंत टेस्ट करना है, GitHub में डाले बिना?**
Editor के toolbar में "➕ फॉन्ट अपलोड" बटन से सीधे अपने फ़ोन/कंप्यूटर
से कोई भी फॉन्ट फाइल चुनकर तुरंत इस्तेमाल कर सकते हैं — वह उसी
ब्राउज़र में याद भी रह जाता है। बस वह तरीक़ा सिर्फ़ उसी डिवाइस/ब्राउज़र
पर काम करता है; हर जगह के लिए ऊपर वाला GitHub तरीक़ा इस्तेमाल करें।
