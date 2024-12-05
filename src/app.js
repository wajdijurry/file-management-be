const express = require('express');
const cors = require('cors');
const { init } = require('./socket'); // Import the socket singleton
const fileRoutes = require('./routes/fileRoutes');
const auth = require('./middlewares/auth');
const authRoutes = require('./routes/authRoutes');
const connectDB = require('./config/db');
const http = require('http');
const jwt = require('jsonwebtoken');
const scheduleAccessTimeout = require('./schedulers/accessTimeoutScheduler');

const app = express();
const PORT = process.env.PORT || 3000;

const corsOptions = {
    origin: 'http://localhost:8082', // Allow only your frontend's origin
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Allow these methods
    allowedHeaders: ['Content-Type', 'Authorization', 'x-requested-with', 'Range'], // Allow required headers
    optionsSuccessStatus: 200 // For legacy browser support
};

// Create an HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
const io = init(server, corsOptions); // Initialize Socket.IO

io.use((socket, next) => {
    const token = socket.handshake.auth.token; // Retrieve the token
    if (!token) {
        return next(new Error('Authentication error: Token missing'));
    }

    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET); // Verify the token
        socket.userId = payload.userId; // Attach userId to the socket
        next();
    } catch (err) {
        return next(new Error('Authentication error: Invalid token'));
    }
});

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('joinRoom', (userId) => {
        socket.join(userId); // Join the room
        console.log(`User ${socket.id} joined room ${userId}`);
    });
});

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

// Routes
app.use('/api/files', auth, fileRoutes);
app.use('/api/auth', authRoutes);
