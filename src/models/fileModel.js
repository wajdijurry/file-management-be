const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
    name: {type: String, required: true},
    path: {type: String, required: true},
    size: {type: Number, required: true},
    mimetype: {type: String, required: true},
    createdAt: {type: Date, default: Date.now},
    deleted: {type: Boolean, default: false},
    userId: {type: String, ref: 'User', required: true}
});

module.exports = mongoose.model('File', fileSchema);