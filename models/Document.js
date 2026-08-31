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
        }
    },
    { timestamps: true }
);

module.exports = mongoose.model("Document", documentSchema);
