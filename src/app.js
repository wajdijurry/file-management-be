const express = require('express');
const cors = require('cors');
const { init } = require('./socket');
const fileRoutes = require('./routes/fileRoutes');
const videoRoutes = require('./routes/videoRoutes');
const imageRoutes = require('./routes/imageRoutes');
const auth = require('./middlewares/auth');
const authRoutes = require('./routes/authRoutes');
const connectDB = require('./config/db');
const http = require('http');
const scheduleAccessTimeout = require('./schedulers/accessTimeoutScheduler');

const app = express();
const PORT = process.env.PORT || 3000;

const corsOptions = {
    origin: 'http://localhost:8082',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-requested-with', 'Range'],
    optionsSuccessStatus: 200
};

// Create an HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
const io = init(server, corsOptions);

app.use(cors(corsOptions));

// Handle preflight requests for all routes
app.options('*', cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to MongoDB
connectDB().then(() => {
    // Start the scheduler after database connection is established
    scheduleAccessTimeout();
    
    // Start the server
    server.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}).catch(err => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Don't exit for cancellation errors
    if (!error.cancelled) {
        process.exit(1);
    }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit for cancellation errors
    if (!reason.cancelled) {
        process.exit(1);
    }
});

// Routes
app.use('/api/files', auth, fileRoutes);
app.use('/api/video', auth, videoRoutes);
app.use('/api/image', auth, imageRoutes);
app.use('/api/auth', authRoutes);
