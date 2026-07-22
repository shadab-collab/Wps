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
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment Variables में जोड़ें: `MONGODB_URI` = अपनी Atlas connection string

5. Deploy होने के बाद Render जो URL देगा, वही आपका live editor है।
