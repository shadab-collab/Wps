const mongoose = require("mongoose");

// Deliberately minimal: title + the full saved HTML content of the
// editor's pages, plus automatic createdAt/updatedAt timestamps.
const documentSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            default: "बिना नाम"
        },
        content: {
            type: String, // innerHTML of #pages-container
            default: ""
        },
        settings: {
            // font size, line-height, margins, font-family — the CSS
            // custom-property values active when the document was last
            // saved. Optional/backward-compatible: old documents simply
            // have {} here and fall back to whatever the editor's
            // current defaults are.
            type: Object,
            default: {}
        },
        archived: {
            // Docs the user doesn't need right now but might later —
            // kept out of the normal "सेव्ड दस्तावेज़" list/dropdown so
            // that list stays short, but still fully open-able from the
            // separate "आर्काइव" list on the homepage. Missing on old
            // documents (from before this field existed) is treated the
            // same as false by the list queries in routes/documents.js.
            type: Boolean,
            default: false
        }
    },
    { timestamps: true }
);

module.exports = mongoose.model("Document", documentSchema);
