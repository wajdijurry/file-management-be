const mongoose = require('mongoose');

const folderSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    path: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    deleted: {
        type: Boolean,
        default: false
    },
    fileCount: {
        type: Number,
        default: 0
    },
    folderCount: {
        type: Number,
        default: 0
    },
    userId: {type: String, ref: 'User', required: true}
});

module.exports = mongoose.model('Folder', folderSchema);
