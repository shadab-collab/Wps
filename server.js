require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");

const documentsRouter = require("./routes/documents");

const app = express();
const PORT = process.env.PORT || 7700;
const MONGODB_URI = process.env.MONGODB_URI;

app.use(express.json({ limit: "10mb" })); // editor content can be a fairly large HTML blob

// API routes
app.use("/api/documents", documentsRouter);

// Serve the editor's frontend files (index.html, style.css, *.js)
// directly from this same server — put your editor files in a
// folder named "public" next to this server.js.
app.use(express.static(path.join(__dirname, "public")));

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("MongoDB से जुड़ गया");
    app.listen(PORT, () => console.log("Server चल रहा है: http://localhost:" + PORT));
  })
  .catch((err) => {
    console.error("MongoDB से जुड़ने में समस्या:", err.message);
    process.exit(1);
  });