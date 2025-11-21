const express = require('express');
const http = require('http');
const aedes = require('aedes')();
const WebSocket = require('ws');
const net = require('net');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// 🔧 FIX 1: Use PORT (not HTTP_PORT) for Render compatibility
const httpPort = process.env.PORT ;
const mqttPort = process.env.MQTT_PORT || 1883;

const CONNECTION_TIMEOUT_MS = parseInt(process.env.CONNECTION_TIMEOUT_MS || '60000', 10);

function getConnectionStatus(lastHeartbeat) {
  if (!lastHeartbeat) return 'offline';
  
  // Handle both Date objects and ISO strings
  let last;
  if (lastHeartbeat instanceof Date) {
    last = lastHeartbeat.getTime();
  } else {
    last = new Date(lastHeartbeat).getTime();
  }
  
  if (Number.isNaN(last)) {
    console.warn('⚠️ Invalid lastHeartbeat:', lastHeartbeat);
    return 'offline';
  }
  
  const timeDiff = Date.now() - last;
  const isOnline = timeDiff <= CONNECTION_TIMEOUT_MS;
  
  // Debug logging (can be removed in production)
  if (process.env.DEBUG_CONNECTION === 'true') {
    console.log(`🔍 Connection status check: lastHeartbeat=${lastHeartbeat}, timeDiff=${timeDiff}ms, timeout=${CONNECTION_TIMEOUT_MS}ms, isOnline=${isOnline}`);
  }
  
  return isOnline ? 'online' : 'offline';
}

function withHeartbeat(fields = {}) {
  const now = new Date();
  // Compute connectionStatus from lastHeartbeat to ensure consistency
  const connectionStatus = getConnectionStatus(now);
  return {
    ...fields,
    lastHeartbeat: now,
    connectionStatus, // Use computed status for consistency
  };
}


// 🔧 FIX 2: Updated CORS with production domains
const corsOrigins = [
  'http://localhost:3000',
  'http://localhost:4000',
  'http://localhost:3001',
  'https://coastal-grand-tolr.vercel.app',
  'https://coastal-grand-back.onrender.com'
];
if (process.env.FRONTEND_URL) corsOrigins.push(process.env.FRONTEND_URL);

if (process.env.NODE_ENV !== 'production') {
  // In development, allow any origin (useful for LAN/iOS testing)
  app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));
} else {
  app.use(cors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));
}


app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Server is running', 
    timestamp: new Date().toISOString(),
    endpoints: {
      api: '/api',
      websocket: '/ws',
      mqtt: '/mqtt'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Server-Sent Events endpoint for real-time updates
app.get('/api/events/:hotelId', (req, res) => {
  const hotelId = req.params.hotelId;
  
  // Validate hotel ID
  if (!hotelId || !/^[1-9][0-9]*$/.test(hotelId)) {
    return res.status(400).json({ error: 'Invalid hotel ID' });
  }
  
  // Set SSE headers with better error handling
  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control',
      'X-Accel-Buffering': 'no' // Disable nginx buffering
    });

    // Send initial connection message
    const initialMessage = `data: ${JSON.stringify({ 
      event: 'connected', 
      data: { message: 'SSE connected successfully', hotelId } 
    })}\n\n`;
    
    res.write(initialMessage);
    console.log(`📡 SSE client connected for hotel ${hotelId}`);

    // Store client for broadcasting
    const clientId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    if (!global.sseClients) {
      global.sseClients = new Map();
    }
    global.sseClients.set(clientId, { res, hotelId, connected: true });

    // Send periodic heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      try {
        if (res.writable && global.sseClients && global.sseClients.has(clientId)) {
          res.write(`: heartbeat\n\n`);
        } else {
          clearInterval(heartbeat);
        }
      } catch (error) {
        console.error('Heartbeat error:', error.message);
        clearInterval(heartbeat);
        if (global.sseClients) {
          global.sseClients.delete(clientId);
        }
      }
    }, 30000); // Send heartbeat every 30 seconds

    // Handle client disconnect
    req.on('close', () => {
      console.log(`📡 SSE client disconnected for hotel ${hotelId}`);
      clearInterval(heartbeat);
      if (global.sseClients) {
        global.sseClients.delete(clientId);
      }
    });

    req.on('error', (err) => {
      // Only log non-ECONNRESET errors as they're normal for client disconnects
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        console.error('SSE client error:', err.message);
      }
      clearInterval(heartbeat);
      if (global.sseClients) {
        global.sseClients.delete(clientId);
      }
    });

    // Handle response errors
    res.on('error', (err) => {
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        console.error('SSE response error:', err.message);
      }
      clearInterval(heartbeat);
      if (global.sseClients) {
        global.sseClients.delete(clientId);
      }
    });
    
  } catch (error) {
    console.error('Error setting up SSE connection:', error.message);
    res.status(500).json({ error: 'Failed to establish SSE connection' });
  }
});

// 🔧 FIX 3: Add missing validateHotelId middleware
const validateHotelId = (req, res, next) => {
  const hotelId = req.params.hotelId;
  if (!hotelId || !/^[1-9][0-9]*$/.test(hotelId)) {
    return res.status(400).json({ error: 'Invalid hotel ID' });
  }
  next();
};

// Database connection check middleware
const checkDatabaseConnection = (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'Database not connected' });
  }
  next();
};

// Apply middleware to all API routes
app.use('/api', checkDatabaseConnection);

// MongoDB Connection (your exact code)
const mongoUrl = process.env.MONGO_URL || 'mongodb+srv://yahyaimthiyas:23csr243@cluster0.hsasoax.mongodb.net/hotel_db?retryWrites=true&w=majority';
mongoose.connect(mongoUrl)
  .then(() => {
    console.log('Connected to MongoDB:', mongoUrl.includes('mongodb+srv') ? 'Atlas Cluster' : 'Local Instance');
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    console.log('Please make sure MongoDB is running or update MONGO_URL in .env file');
  });

// Schemas (your exact schemas)
const hotelSchema = new mongoose.Schema({
  id: String,
  name: String,
  location: String,
  address: String,
  phone: String,
  email: String,
  rating: Number,
  description: String,
  image: String,
  status: String,
  lastActivity: String,
  manager: {
    name: String,
    phone: String,
    email: String,
    status: String,
  },
}, { timestamps: true });

const roomSchema = new mongoose.Schema({
  hotelId: String,
  id: Number,
  number: String,
  status: String,
  hasMasterKey: Boolean,
  hasLowPower: Boolean,
  powerStatus: String,
  occupantType: String,
  cleaningStartTime: String,
  lastHeartbeat: Date,
  connectionStatus: {
    type: String,
    default: 'offline',
  },
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  hotelId: String,
  card_uid: String,
  role: String,
  check_in: String,
  check_out: String,
  duration: Number,
  room: String,
  accessType: String,
}, { timestamps: true });

const alertSchema = new mongoose.Schema({
  hotelId: String,
  card_uid: String,
  role: String,
  alert_message: String,
  triggered_at: String,
  room: String,
}, { timestamps: true });

const deniedSchema = new mongoose.Schema({
  hotelId: String,
  card_uid: String,
  role: String,
  denial_reason: String,
  attempted_at: String,
  room: String,
}, { timestamps: true });

const userSchema = new mongoose.Schema({
  hotelId: String,
  id: String,
  name: String,
  email: String,
  role: String,
  status: String,
  lastLogin: String,
  avatar: String,
}, { timestamps: true });

const cardSchema = new mongoose.Schema({
  hotelId: String,
  id: String,
  roomNumber: String,
  guestName: String,
  status: String,
  expiryDate: String,
  lastUsed: String,
}, { timestamps: true });

const activitySchema = new mongoose.Schema({
  hotelId: String,
  id: String,
  type: String,
  action: String,
  user: String,
  time: String,
}, { timestamps: true });

const powerLogSchema = new mongoose.Schema({
  hotelId: String,
  room: String,
  current: Number,
  timestamp: String,
}, { timestamps: true });

const settingsSchema = new mongoose.Schema({
  hotelId: String,
  minCleaningDurationSeconds: Number,
  lowPowerCurrentThreshold: Number,
}, { timestamps: true });

// Indexes for production performance
attendanceSchema.index({ hotelId: 1, room: 1, createdAt: -1 });
powerLogSchema.index({ hotelId: 1, room: 1, createdAt: -1 });

const Hotel = mongoose.model('Hotel', hotelSchema);
const Room = mongoose.model('Room', roomSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const Alert = mongoose.model('Alert', alertSchema);
const Denied = mongoose.model('Denied', deniedSchema);
const User = mongoose.model('User', userSchema);
const Card = mongoose.model('Card', cardSchema);
const Activity = mongoose.model('Activity', activitySchema);
const PowerLog = mongoose.model('PowerLog', powerLogSchema);
const Settings = mongoose.model('Settings', settingsSchema);

// Helper to map raw role values from devices to normalized access types
function getAccessType(role) {
  if (!role) return 'unknown';
  const normalized = role.toLowerCase();
  if (normalized === 'guest') return 'guest';
  if (normalized === 'maintenance' || normalized === 'housekeeping') return 'housekeeping';
  if (normalized === 'manager' || normalized === 'master') return 'master';
  return 'unknown';
}

// Minimum housekeeping duration (in seconds) required for a room to become vacant
const MIN_CLEANING_DURATION_SECONDS = 20 * 60; // 20 minutes

// Threshold below which we consider power usage to be "low" (in amps, approximate)
const LOW_POWER_CURRENT_THRESHOLD = 0.2;

async function getSettingsForHotel(hotelId) {
  const defaults = {
    minCleaningDurationSeconds: MIN_CLEANING_DURATION_SECONDS,
    lowPowerCurrentThreshold: LOW_POWER_CURRENT_THRESHOLD,
  };

  if (!hotelId) {
    return defaults;
  }

  try {
    const settings = await Settings.findOne({ hotelId });
    if (!settings) return defaults;

    return {
      minCleaningDurationSeconds: settings.minCleaningDurationSeconds || MIN_CLEANING_DURATION_SECONDS,
      lowPowerCurrentThreshold: settings.lowPowerCurrentThreshold || LOW_POWER_CURRENT_THRESHOLD,
    };
  } catch (error) {
    console.error('Error loading settings for hotel', hotelId, error);
    return defaults;
  }
}

// Initialize Hotel Data (your exact function)
async function initializeHotels() {
  const hotels = [
    {
      id: "1",
      name: "Coastal Grand Hotel - Ooty",
      location: "Ooty, Tamil Nadu",
      address: "456 Hill Road, Ooty, Tamil Nadu",
      phone: "+91 90476 28844",
      email: "rajesh.kumar@coastalgrand.com",
      rating: 4.7,
      description: "Scenic hill station hotel with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "active",
      lastActivity: "2 minutes ago",
      manager: {
        name: "Rajesh Kumar",
        phone: "+91 90476 28844",
        email: "rajesh.kumar@coastalgrand.com",
        status: "online",
      },
    },
    {
      id: "2",
      name: "Coastal Grand Hotel - Salem",
      location: "Salem, Tamil Nadu",
      address: "123 Main Street, Salem, Tamil Nadu",
      phone: "+91 90476 28844",
      email: "priya.devi@coastalgrand.com",
      rating: 4.8,
      description: "Premium hotel in the heart of Salem with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "active",
      lastActivity: "5 minutes ago",
      manager: {
        name: "Priya Devi",
        phone: "+91 90476 28844",
        email: "priya.devi@coastalgrand.com",
        status: "online",
      },
    },
    {
      id: "3",
      name: "Coastal Grand Hotel - Yercaud",
      location: "Yercaud, Tamil Nadu",
      address: "789 Mountain View, Yercaud, Tamil Nadu",
      phone: "+91 90476 28844",
      email: "arun.balaji@coastalgrand.com",
      rating: 4.6,
      description: "Scenic hill station hotel with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "active",
      lastActivity: "10 minutes ago",
      manager: {
        name: "Arun Balaji",
        phone: "+91 90476 28844",
        email: "arun.balaji@coastalgrand.com",
        status: "online",
      },
    },
    {
      id: "4",
      name: "Coastal Grand Hotel - Puducherry",
      location: "Puducherry, Union Territory",
      address: "321 Beach Road, Puducherry, Union Territory",
      phone: "+91 90476 28844",
      email: "lakshmi.priya@coastalgrand.com",
      rating: 4.5,
      description: "Heritage hotel with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "maintenance",
      lastActivity: "1 hour ago",
      manager: {
        name: "Lakshmi Priya",
        phone: "+91 90476 28844",
        email: "lakshmi.priya@coastalgrand.com",
        status: "online",
      },
    },
    {
      id: "5",
      name: "Coastal Grand Hotel - Namakkal",
      location: "Namakkal, Tamil Nadu",
      address: "654 City Center, Namakkal, Tamil Nadu",
      phone: "+91 90476 28844",
      email: "senthil.kumar@coastalgrand.com",
      rating: 4.4,
      description: "Premium hotel with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "active",
      lastActivity: "15 minutes ago",
      manager: {
        name: "Senthil Kumar",
        phone: "+91 90476 28844",
        email: "senthil.kumar@coastalgrand.com",
        status: "online",
      },
    },
    {
      id: "6",
      name: "Coastal Grand Hotel - Chennai",
      location: "Chennai, Tamil Nadu",
      address: "987 Marina Beach Road, Chennai, Tamil Nadu",
      phone: "+91 90476 28844",
      email: "vijay.anand@coastalgrand.com",
      rating: 4.9,
      description: "Metropolitan hotel with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "active",
      lastActivity: "30 minutes ago",
      manager: {
        name: "Vijay Anand",
        phone: "+91 90476 28844",
        email: "vijay.anand@coastalgrand.com",
        status: "online",
      },
    },
    {
      id: "7",
      name: "Coastal Grand Hotel - Bangalore",
      location: "Bangalore, Karnataka",
      address: "147 MG Road, Bangalore, Karnataka",
      phone: "+91 90476 28844",
      email: "deepa.sharma@coastalgrand.com",
      rating: 4.7,
      description: "Metropolitan hotel with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "active",
      lastActivity: "45 minutes ago",
      manager: {
        name: "Deepa Sharma",
        phone: "+91 90476 28844",
        email: "deepa.sharma@coastalgrand.com",
        status: "online",
      },
    },
    {
      id: "8",
      name: "Coastal Grand Hotel - Kotagiri",
      location: "Kotagiri, Tamil Nadu",
      address: "258 Tea Estate Road, Kotagiri, Tamil Nadu",
      phone: "+91 90476 28844",
      email: "mohan.raj@coastalgrand.com",
      rating: 4.6,
      description: "Scenic hill station hotel with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "active",
      lastActivity: "1 hour ago",
      manager: {
        name: "Mohan Raj",
        phone: "+91 90476 28844",
        email: "mohan.raj@coastalgrand.com",
        status: "online",
      },
    },
  ];

  for (const hotel of hotels) {
    await Hotel.findOneAndUpdate({ id: hotel.id }, hotel, { upsert: true });
  }
  console.log("Hotels initialized");
}

// Initialize Room Data for all hotels (your exact function)
async function initializeRooms() {
  const hotels = await Hotel.find();
  
  for (const hotel of hotels) {
    const hotelId = hotel.id;
    const roomCount = getRoomCountForHotel(hotelId);
    
    // Generate realistic room numbers: 101-115 for floor 1, 201-215 for floor 2
    const roomsPerFloor = Math.ceil(roomCount / 2); // Split rooms between 2 floors
    let roomId = 1;
    
    // Floor 1: 101-115
    for (let i = 101; i <= 100 + roomsPerFloor; i++) {
      const roomData = {
        hotelId: hotelId,
        id: roomId,
        number: i.toString(),
        status: 'vacant',
        hasMasterKey: false,
        hasLowPower: false,
        powerStatus: 'off',
        occupantType: null,
        connectionStatus: 'offline',
        lastHeartbeat: null,
      };
      
      await Room.findOneAndUpdate(
        { hotelId: hotelId, number: i.toString() },
        roomData,
        { upsert: true }
      );
      roomId++;
    }
    
    // Floor 2: 201-215 (if needed)
    if (roomCount > roomsPerFloor) {
      const remainingRooms = roomCount - roomsPerFloor;
      for (let i = 201; i <= 200 + remainingRooms; i++) {
        const roomData = {
          hotelId: hotelId,
          id: roomId,
          number: i.toString(),
          status: 'vacant',
          hasMasterKey: false,
          hasLowPower: false,
          powerStatus: 'off',
          occupantType: null,
        connectionStatus: 'offline',
        lastHeartbeat: null,
        };
        
        await Room.findOneAndUpdate(
          { hotelId: hotelId, number: i.toString() },
          roomData,
          { upsert: true }
        );
        roomId++;
      }
    }
  }
  console.log("Rooms initialized for all hotels");
}

// Get room count for each hotel (your exact function)
function getRoomCountForHotel(hotelId) {
  const roomCounts = {
    "1": 25, // Ooty
    "2": 30, // Salem
    "3": 20, // Yercaud
    "4": 28, // Puducherry
    "5": 22, // Namakkal
    "6": 30, // Chennai
    "7": 30, // Bangalore
    "8": 18, // Kotagiri
  };
  return roomCounts[hotelId] || 20;
}

// Fix existing room records with inconsistent connectionStatus
async function fixRoomConnectionStatus() {
  try {
    const rooms = await Room.find({});
    let fixed = 0;
    for (const room of rooms) {
      const computedStatus = getConnectionStatus(room.lastHeartbeat);
      if (room.connectionStatus !== computedStatus) {
        await Room.updateOne(
          { _id: room._id },
          { $set: { connectionStatus: computedStatus } }
        );
        fixed++;
      }
    }
    if (fixed > 0) {
      console.log(`✅ Fixed connectionStatus for ${fixed} room(s)`);
    }
  } catch (error) {
    console.error('Error fixing room connectionStatus:', error);
  }
}

mongoose.connection.once('open', async () => {
  await initializeHotels();
  await initializeRooms();
  await fixRoomConnectionStatus();
  
  // Periodically sync connectionStatus in database with computed status
  // This ensures database stays in sync even if there are timing issues
  setInterval(async () => {
    try {
      const rooms = await Room.find({});
      for (const room of rooms) {
        const computedStatus = getConnectionStatus(room.lastHeartbeat);
        // Only update if different to avoid unnecessary writes
        if (room.connectionStatus !== computedStatus) {
          await Room.updateOne(
            { _id: room._id },
            { $set: { connectionStatus: computedStatus } }
          );
        }
      }
    } catch (error) {
      console.error('Error syncing room connectionStatus:', error);
    }
  }, 30000); // Run every 30 seconds
});


// 🔧 FIX 4: Create HTTP server BEFORE using it
const server = http.createServer(app);

// 🔧 FIX 5: MQTT over WebSocket setup (for ESP32)
const mqttWsServer = new WebSocket.Server({
  server,
  path: '/mqtt' // WebSocket endpoint at /mqtt for ESP32
});

// 🔧 Frontend WebSocket server for real-time updates
const frontendWsServer = new WebSocket.Server({
  server,
  path: '/ws',
  verifyClient: (info) => {
    console.log('WebSocket connection attempt from:', info.origin);
    return true; // Allow all connections for now
  }
});

// Store frontend clients separately
const frontendClients = new Set();

// Handle frontend WebSocket connections
frontendWsServer.on('connection', function(ws, req) {
  const clientIP = req.socket.remoteAddress;
  const origin = req.headers.origin;
  console.log(`🔗 Frontend client connected via WebSocket from ${clientIP}, origin: ${origin}`);
  
  // Set connection timeout
  const connectionTimeout = setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'Connection timeout');
    }
  }, 300000); // 5 minutes timeout
  
  frontendClients.add(ws);
  
  try {
    // Send initial connection confirmation
    ws.send(JSON.stringify({ 
      event: 'connected', 
      data: { message: 'WebSocket connected successfully' } 
    }));
  } catch (error) {
    console.error('Error sending initial WebSocket message:', error.message);
    frontendClients.delete(ws);
    clearTimeout(connectionTimeout);
    return;
  }
  
  // Set up ping/pong for connection health
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch (error) {
        console.error('WebSocket ping error:', error.message);
        clearInterval(pingInterval);
        clearTimeout(connectionTimeout);
        frontendClients.delete(ws);
      }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000); // Ping every 30 seconds
  
  ws.on('pong', () => {
    // Reset timeout on pong response
    clearTimeout(connectionTimeout);
  });
  
  ws.on('close', (code, reason) => {
    console.log(`📡 Frontend WebSocket client disconnected: ${code} ${reason?.toString() || 'No reason'}`);
    clearInterval(pingInterval);
    clearTimeout(connectionTimeout);
    frontendClients.delete(ws);
  });
  
  ws.on('error', (error) => {
    // Only log non-connection reset errors
    if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') {
      console.error('Frontend WebSocket error:', error.message);
    }
    clearInterval(pingInterval);
    clearTimeout(connectionTimeout);
    frontendClients.delete(ws);
  });
});

// Add error handling for WebSocket server
frontendWsServer.on('error', (error) => {
  console.error('Frontend WebSocket Server error:', error);
});

console.log('🔧 Frontend WebSocket server initialized on /ws endpoint');

// 🔧 FIX 6: Updated broadcastToClients function for frontend clients (WebSocket + SSE)
function broadcastToClients(event, data) {
  const message = JSON.stringify({ event, data });
  console.log(`Broadcasting to ${frontendClients.size} WebSocket clients and ${global.sseClients ? global.sseClients.size : 0} SSE clients:`, { event, data });
  
  // Broadcast to WebSocket clients with improved error handling
  const disconnectedWsClients = [];
  frontendClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (error) {
        // Only log non-connection errors
        if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') {
          console.error('Error broadcasting to WebSocket client:', error.message);
        }
        disconnectedWsClients.push(client);
      }
    } else {
      disconnectedWsClients.push(client);
    }
  });
  
  // Clean up disconnected WebSocket clients
  disconnectedWsClients.forEach(client => frontendClients.delete(client));

  // Broadcast to SSE clients with improved error handling
  if (global.sseClients && global.sseClients.size > 0) {
    const sseMessage = `data: ${message}\n\n`;
    const disconnectedSseClients = [];
    
    global.sseClients.forEach((client, clientId) => {
      try {
        // Check if response is still writable
        if (client.res && client.res.writable && client.connected !== false) {
          client.res.write(sseMessage);
        } else {
          disconnectedSseClients.push(clientId);
        }
      } catch (error) {
        // Only log non-connection errors
        if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_WRITE_AFTER_END') {
          console.error('Error broadcasting to SSE client:', error.message);
        }
        disconnectedSseClients.push(clientId);
      }
    });
    
    // Clean up disconnected SSE clients
    disconnectedSseClients.forEach(clientId => {
      if (global.sseClients) {
        global.sseClients.delete(clientId);
      }
    });
  }
}

mqttWsServer.on('connection', function(ws, req) {
  try {
    const stream = WebSocket.createWebSocketStream(ws, { encoding: 'utf8' });
    aedes.handle(stream);
    console.log('🔗 MQTT client connected via WebSocket');
    
    ws.on('close', () => {
      console.log('📡 MQTT WebSocket client disconnected');
    });
    
    ws.on('error', (error) => {
      console.error('MQTT WebSocket error:', error);
    });
  } catch (error) {
    console.error('Error handling MQTT WebSocket connection:', error);
    ws.close();
  }
});

// 🔧 FIX 7: Conditional MQTT TCP server (only for local development)
if (process.env.NODE_ENV !== 'production') {
  const tcpServer = net.createServer(aedes.handle);
  tcpServer.listen(mqttPort, () => {
    console.log(`📡 MQTT broker (TCP) listening on port ${mqttPort} [LOCAL ONLY]`);
  });
} else {
  console.log('🚫 TCP MQTT server disabled in production (Render limitation)');
}

// Handle MQTT publishes from ESP32 (your exact code)
aedes.on('publish', async (packet, client) => {
  if (packet.topic.startsWith('campus/room/')) {
    try {
      const data = JSON.parse(packet.payload.toString());
      const [, , building, floor, roomNum, type] = packet.topic.split('/');
      
      // Validate MQTT data
      if (!floor || !roomNum || !type) {
        console.error('Invalid MQTT topic format:', packet.topic);
        return;
      }
      
      data.room = roomNum;
      data.hotelId = floor; // Map floor to hotelId

      let newActivity = null;

      if (type === 'attendance') {
        const accessType = getAccessType(data.role);
        data.accessType = accessType;
        await new Attendance(data).save();
        console.log(`Saved attendance for room ${roomNum} in hotel ${data.hotelId}:`, data);

        // Update room status with enhanced logic for guest / housekeeping / master
        let update = {};
        let hasMasterKeyUpdate = {};
        let extraRoomFields = {};

        const { minCleaningDurationSeconds } = await getSettingsForHotel(data.hotelId);

        if (data.check_in) {
          if (accessType === 'guest') {
            update = {
              status: 'occupied',
              occupantType: 'guest',
              powerStatus: 'on',
            };
          } else if (accessType === 'housekeeping') {
            update = {
              status: 'cleaning',
              occupantType: 'housekeeping',
              powerStatus: 'on',
            };
            extraRoomFields = { cleaningStartTime: data.check_in };
          } else if (accessType === 'master') {
            hasMasterKeyUpdate = { hasMasterKey: true };
          } else {
            const status = data.role === 'Maintenance' ? 'maintenance' : 'occupied';
            update = {
              status,
              occupantType: data.role.toLowerCase(),
              powerStatus: 'on',
            };
            if (data.role === 'Manager') {
              hasMasterKeyUpdate = { hasMasterKey: true };
            }
          }
        } else {
          if (accessType === 'guest') {
            update = {
              status: 'dirty',
              occupantType: null,
              powerStatus: 'off',
            };
          } else if (accessType === 'housekeeping') {
            const durationSeconds = data.duration ? Number(data.duration) : null;
            if (durationSeconds !== null && durationSeconds >= minCleaningDurationSeconds) {
              update = {
                status: 'vacant',
                occupantType: null,
                powerStatus: 'off',
                cleaningStartTime: null,
              };
            } else {
              update = {
                status: 'cleaning',
                occupantType: 'housekeeping',
                powerStatus: 'off',
              };
            }
          } else if (accessType === 'master') {
            hasMasterKeyUpdate = { hasMasterKey: false };
          } else {
            update = {
              status: 'vacant',
              occupantType: null,
              powerStatus: 'off',
            };
            if (data.role === 'Manager') {
              hasMasterKeyUpdate = { hasMasterKey: false };
            }
          }
        }

        const roomUpdatePayload = withHeartbeat({ ...update, ...hasMasterKeyUpdate, ...extraRoomFields });
        if (Object.keys(roomUpdatePayload).length > 0) {
          const updatedRoom = await Room.findOneAndUpdate(
            { hotelId: data.hotelId, number: roomNum },
            roomUpdatePayload,
            { upsert: true, new: true }
          );
          broadcastToClients(`roomUpdate:${data.hotelId}`, { roomNum, ...roomUpdatePayload });
        }

        // Create activity
        const activityType = data.check_in ? 'checkin' : 'checkout';
        const action = `${data.role} checked ${data.check_in ? 'in' : 'out'} to Room ${data.room}`;
        const time = data.check_in || data.check_out;
        newActivity = {
          hotelId: data.hotelId,
          id: new Date().getTime().toString(),
          type: activityType,
          action,
          user: data.role,
          time,
        };
      } else if (type === 'power') {
        const current = typeof data.current === 'number' ? data.current : Number(data.current || 0);
        const timestamp = data.timestamp || new Date().toISOString();
        try {
          await new PowerLog({
            hotelId: data.hotelId,
            room: roomNum,
            current,
            timestamp,
          }).save();
        } catch (err) {
          console.error('Error saving power log (MQTT):', err);
        }

        const { lowPowerCurrentThreshold } = await getSettingsForHotel(data.hotelId);
        const hasLowPower = current <= lowPowerCurrentThreshold;
        const roomUpdatePayload = withHeartbeat({
          hasLowPower,
          powerStatus: current > 0 ? 'on' : 'off',
        });

        const updatedRoom = await Room.findOneAndUpdate(
          { hotelId: data.hotelId, number: roomNum },
          roomUpdatePayload,
          { upsert: true, new: true }
        );
        broadcastToClients(`roomUpdate:${data.hotelId}`, { roomNum, ...roomUpdatePayload });
      } else if (type === 'alerts') {
        await new Alert(data).save();
        console.log(`Saved alert for room ${roomNum} in hotel ${data.hotelId}:`, data);
        const heartbeatUpdate = withHeartbeat();
        await Room.findOneAndUpdate(
          { hotelId: data.hotelId, number: roomNum },
          heartbeatUpdate,
          { upsert: true }
        );
        broadcastToClients(`roomUpdate:${data.hotelId}`, { roomNum, ...heartbeatUpdate });

        // Create activity
        const activityType = 'security';
        const action = `Alert: ${data.alert_message} for ${data.role} in Room ${data.room}`;
        const time = data.triggered_at;
        newActivity = {
          hotelId: data.hotelId,
          id: new Date().getTime().toString(),
          type: activityType,
          action,
          user: 'System',
          time,
        };
      } else if (type === 'denied_access') {
        await new Denied(data).save();
        console.log(`Saved denied access for room ${roomNum} in hotel ${data.hotelId}:`, data);
        const heartbeatUpdate = withHeartbeat();
        await Room.findOneAndUpdate(
          { hotelId: data.hotelId, number: roomNum },
          heartbeatUpdate,
          { upsert: true }
        );
        broadcastToClients(`roomUpdate:${data.hotelId}`, { roomNum, ...heartbeatUpdate });

        // Create activity
        const action = `Denied access to ${data.role}: ${data.denial_reason} for Room ${data.room}`;
        const time = data.attempted_at;
        newActivity = {
          hotelId: data.hotelId,
          id: new Date().getTime().toString(),
          type: 'security',
          action,
          user: data.role,
          time,
        };
      }

      if (newActivity) {
        const savedActivity = await new Activity(newActivity).save();
        broadcastToClients(`activityUpdate:${data.hotelId}`, savedActivity);
      }
    } catch (err) {
      console.error('Error processing MQTT message:', err);
    }
  }
});

// HTTP API Endpoints for Frontend (your exact routes)
app.get('/api/hotel/:hotelId', validateHotelId, async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ id: req.params.hotelId });
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }
    const rooms = await Room.find({ hotelId: req.params.hotelId });
    const totalRooms = rooms.length;
    const activeRooms = rooms.filter((r) => r.status === 'occupied' || r.status === 'maintenance').length;
    const occupancy = totalRooms ? Math.round((activeRooms / totalRooms) * 100) : 0;
    res.json({ ...hotel.toObject(), totalRooms, activeRooms, occupancy });
  } catch (error) {
    console.error('Error fetching hotel:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/settings/:hotelId', validateHotelId, async (req, res) => {
  try {
    const hotelId = req.params.hotelId;
    const effective = await getSettingsForHotel(hotelId);
    res.json({ hotelId, ...effective });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/settings/:hotelId', validateHotelId, async (req, res) => {
  try {
    const hotelId = req.params.hotelId;
    const { minCleaningDurationSeconds, lowPowerCurrentThreshold } = req.body;

    const update = {};
    if (typeof minCleaningDurationSeconds === 'number') {
      update.minCleaningDurationSeconds = minCleaningDurationSeconds;
    }
    if (typeof lowPowerCurrentThreshold === 'number') {
      update.lowPowerCurrentThreshold = lowPowerCurrentThreshold;
    }

    const settings = await Settings.findOneAndUpdate(
      { hotelId },
      update,
      { new: true, upsert: true }
    );

    const effective = {
      minCleaningDurationSeconds: settings.minCleaningDurationSeconds || MIN_CLEANING_DURATION_SECONDS,
      lowPowerCurrentThreshold: settings.lowPowerCurrentThreshold || LOW_POWER_CURRENT_THRESHOLD,
    };

    res.json({ hotelId, ...effective });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/hotel/:hotelId', validateHotelId, async (req, res) => {
  try {
    await Hotel.findOneAndUpdate({ id: req.params.hotelId }, req.body, { upsert: true });
    res.json({ message: 'Hotel updated successfully' });
  } catch (error) {
    console.error('Error updating hotel:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/hotels', async (req, res) => {
  try {
    const hotels = await Hotel.find();
    const hotelsWithStats = await Promise.all(
      hotels.map(async (hotel) => {
        const rooms = await Room.find({ hotelId: hotel.id });
        const totalRooms = rooms.length;
        const activeRooms = rooms.filter((r) => r.status === 'occupied' || r.status === 'maintenance').length;
        const occupancy = totalRooms ? Math.round((activeRooms / totalRooms) * 100) : 0;
        return { ...hotel.toObject(), totalRooms, activeRooms, occupancy };
      })
    );
    res.json(hotelsWithStats);
  } catch (error) {
    console.error('Error fetching hotels:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/rooms/:hotelId', validateHotelId, async (req, res) => {
  try {
    const rooms = await Room.find({ hotelId: req.params.hotelId }).sort({ number: 1 });
    const roomsWithConnection = rooms.map((room) => {
      const obj = room.toObject();
      // Always recompute connectionStatus from lastHeartbeat, ignoring stored value
      const connectionStatus = getConnectionStatus(obj.lastHeartbeat);
      return {
        ...obj,
        lastHeartbeat: obj.lastHeartbeat ? obj.lastHeartbeat.toISOString() : null,
        connectionStatus, // Override any stored connectionStatus with computed value
        isOnline: connectionStatus === 'online',
      };
    });
    res.json(roomsWithConnection);
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/attendance/:hotelId', validateHotelId, async (req, res) => {
  try {
    const data = await Attendance.find({ hotelId: req.params.hotelId }).sort({ createdAt: -1 });
    res.json(data);
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/alerts/:hotelId', validateHotelId, async (req, res) => {
  try {
    const data = await Alert.find({ hotelId: req.params.hotelId }).sort({ createdAt: -1 });
    res.json(data);
  } catch (error) {
    console.error('Error fetching alerts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/denied_access/:hotelId', validateHotelId, async (req, res) => {
  try {
    const data = await Denied.find({ hotelId: req.params.hotelId }).sort({ createdAt: -1 });
    res.json(data);
  } catch (error) {
    console.error('Error fetching denied access:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/users/:hotelId', validateHotelId, async (req, res) => {
  try {
    const data = await User.find({ hotelId: req.params.hotelId });
    res.json(data);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/cards/:hotelId', validateHotelId, async (req, res) => {
  try {
    const data = await Card.find({ hotelId: req.params.hotelId });
    res.json(data);
  } catch (error) {
    console.error('Error fetching cards:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/activity/:hotelId', validateHotelId, async (req, res) => {
  try {
    const data = await Activity.find({ hotelId: req.params.hotelId }).sort({ createdAt: -1 });
    res.json(data);
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/power/:hotelId', validateHotelId, async (req, res) => {
  try {
    const hotelId = req.params.hotelId;

    const latestPerRoom = await PowerLog.aggregate([
      { $match: { hotelId } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$room',
          room: { $first: '$room' },
          hotelId: { $first: '$hotelId' },
          current: { $first: '$current' },
          timestamp: { $first: '$timestamp' },
        },
      },
      {
        $project: {
          _id: 0,
          room: 1,
          hotelId: 1,
          current: 1,
          timestamp: 1,
        },
      },
      { $sort: { room: 1 } },
    ]);

    res.json(latestPerRoom);
  } catch (error) {
    console.error('Error fetching power logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ESP32 Data Handler - Direct HTTP endpoint for ESP32 communication
app.post('/api/mqtt-data', async (req, res) => {
  try {
    const { topic, data } = req.body;
    
    if (!topic || !data) {
      return res.status(400).json({ error: 'Missing topic or data' });
    }

    // Parse topic: campus/room/{building}/{floor}/{roomNum}/{type}
    const topicParts = topic.split('/');
    if (topicParts.length !== 6 || topicParts[0] !== 'campus' || topicParts[1] !== 'room') {
      return res.status(400).json({ error: 'Invalid topic format' });
    }

    const [, , building, floor, roomNum, type] = topicParts;
    
    // Add room and hotelId to data
    const processedData = {
      ...data,
      room: roomNum,
      hotelId: floor
    };

    let newActivity = null;

    if (type === 'attendance') {
      const accessType = getAccessType(processedData.role);
      processedData.accessType = accessType;
      await new Attendance(processedData).save();
      console.log(`Saved attendance for room ${roomNum} in hotel ${processedData.hotelId}:`, processedData);

      // Update room status with enhanced logic for guest / housekeeping / master
      let update = {};
      let hasMasterKeyUpdate = {};
      let extraRoomFields = {};

      const { minCleaningDurationSeconds } = await getSettingsForHotel(processedData.hotelId);

      if (processedData.check_in) {
        if (accessType === 'guest') {
          update = {
            status: 'occupied',
            occupantType: 'guest',
            powerStatus: 'on',
          };
        } else if (accessType === 'housekeeping') {
          update = {
            status: 'cleaning',
            occupantType: 'housekeeping',
            powerStatus: 'on',
          };
          extraRoomFields = { cleaningStartTime: processedData.check_in };
        } else if (accessType === 'master') {
          hasMasterKeyUpdate = { hasMasterKey: true };
        } else {
          const status = processedData.role === 'Maintenance' ? 'maintenance' : 'occupied';
          update = {
            status,
            occupantType: processedData.role.toLowerCase(),
            powerStatus: 'on',
          };
          if (processedData.role === 'Manager') {
            hasMasterKeyUpdate = { hasMasterKey: true };
          }
        }
      } else {
        if (accessType === 'guest') {
          update = {
            status: 'dirty',
            occupantType: null,
            powerStatus: 'off',
          };
        } else if (accessType === 'housekeeping') {
          const durationSeconds = processedData.duration ? Number(processedData.duration) : null;
          if (durationSeconds !== null && durationSeconds >= minCleaningDurationSeconds) {
            update = {
              status: 'vacant',
              occupantType: null,
              powerStatus: 'off',
              cleaningStartTime: null,
            };
          } else {
            update = {
              status: 'cleaning',
              occupantType: 'housekeeping',
              powerStatus: 'off',
            };
          }
        } else if (accessType === 'master') {
          hasMasterKeyUpdate = { hasMasterKey: false };
        } else {
          update = {
            status: 'vacant',
            occupantType: null,
            powerStatus: 'off',
          };
          if (processedData.role === 'Manager') {
            hasMasterKeyUpdate = { hasMasterKey: false };
          }
        }
      }

      const roomUpdatePayload = withHeartbeat({ ...update, ...hasMasterKeyUpdate, ...extraRoomFields });
      if (Object.keys(roomUpdatePayload).length > 0) {
        await Room.findOneAndUpdate(
          { hotelId: processedData.hotelId, number: roomNum },
          roomUpdatePayload,
          { upsert: true, new: true }
        );
        broadcastToClients(`roomUpdate:${processedData.hotelId}`, { roomNum, ...roomUpdatePayload });
      }

      // Create activity
      const activityType = processedData.check_in ? 'checkin' : 'checkout';
      const action = `${processedData.role} checked ${processedData.check_in ? 'in' : 'out'} to Room ${processedData.room}`;
      const time = processedData.check_in || processedData.check_out;
      newActivity = {
        hotelId: processedData.hotelId,
        id: new Date().getTime().toString(),
        type: activityType,
        action,
        user: processedData.role,
        time,
      };
    } else if (type === 'power') {
      const current = typeof processedData.current === 'number'
        ? processedData.current
        : Number(processedData.current || 0);
      const timestamp = processedData.timestamp || new Date().toISOString();

      try {
        await new PowerLog({
          hotelId: processedData.hotelId,
          room: roomNum,
          current,
          timestamp,
        }).save();
      } catch (err) {
        console.error('Error saving power log (HTTP):', err);
      }

      const { lowPowerCurrentThreshold } = await getSettingsForHotel(processedData.hotelId);
      const hasLowPower = current <= lowPowerCurrentThreshold;
      const roomUpdatePayload = withHeartbeat({
        hasLowPower,
        powerStatus: current > 0 ? 'on' : 'off',
      });

      await Room.findOneAndUpdate(
        { hotelId: processedData.hotelId, number: roomNum },
        roomUpdatePayload,
        { upsert: true, new: true }
      );

      broadcastToClients(`roomUpdate:${processedData.hotelId}`, { roomNum, ...roomUpdatePayload });
    } else if (type === 'alerts') {
      await new Alert(processedData).save();
      console.log(`Saved alert for room ${roomNum} in hotel ${processedData.hotelId}:`, processedData);
      const heartbeatUpdate = withHeartbeat();
      await Room.findOneAndUpdate(
        { hotelId: processedData.hotelId, number: roomNum },
        heartbeatUpdate,
        { upsert: true }
      );
      broadcastToClients(`roomUpdate:${processedData.hotelId}`, { roomNum, ...heartbeatUpdate });

      // Create activity
      const activityType = 'security';
      const action = `Alert: ${processedData.alert_message} for ${processedData.role} in Room ${processedData.room}`;
      const time = processedData.triggered_at;
      newActivity = {
        hotelId: processedData.hotelId,
        id: new Date().getTime().toString(),
        type: activityType,
        action,
        user: 'System',
        time,
      };
    } else if (type === 'denied_access') {
      await new Denied(processedData).save();
      console.log(`Saved denied access for room ${roomNum} in hotel ${processedData.hotelId}:`, processedData);
      const heartbeatUpdate = withHeartbeat();
      await Room.findOneAndUpdate(
        { hotelId: processedData.hotelId, number: roomNum },
        heartbeatUpdate,
        { upsert: true }
      );
      broadcastToClients(`roomUpdate:${processedData.hotelId}`, { roomNum, ...heartbeatUpdate });

      // Create activity
      const action = `Denied access to ${processedData.role}: ${processedData.denial_reason} for Room ${processedData.room}`;
      const time = processedData.attempted_at;
      newActivity = {
        hotelId: processedData.hotelId,
        id: new Date().getTime().toString(),
        type: 'security',
        action,
        user: processedData.role,
        time,
      };
    }

    if (newActivity) {
      const savedActivity = await new Activity(newActivity).save();
      broadcastToClients(`activityUpdate:${processedData.hotelId}`, savedActivity);
    }

    res.json({ success: true, message: 'Data processed successfully' });
  } catch (error) {
    console.error('Error processing ESP32 data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Fallback MQTT simulation endpoint
app.post('/api/simulate-mqtt', async (req, res) => {
  try {
    const { topic, payload } = req.body;
    
    if (!topic || !payload) {
      return res.status(400).json({ error: 'Missing topic or payload' });
    }

    // Parse the payload as JSON
    let data;
    try {
      data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    // Simulate the MQTT message processing
    const topicParts = topic.split('/');
    if (topicParts.length >= 6) {
      const [, , building, floor, roomNum, type] = topicParts;
      
      data.room = roomNum;
      data.hotelId = floor;

      let newActivity = null;

      if (type === 'attendance') {
        const accessType = getAccessType(data.role);
        data.accessType = accessType;
        await new Attendance(data).save();
        console.log(`Simulated MQTT - Saved attendance for room ${roomNum}:`, data);
        
        // Update room status (same logic as MQTT handler)
        let update = {};
        let hasMasterKeyUpdate = {};
        let extraRoomFields = {};

        if (data.check_in) {
          if (accessType === 'guest') {
            update = {
              status: 'occupied',
              occupantType: 'guest',
              powerStatus: 'on',
            };
          } else if (accessType === 'housekeeping') {
            update = {
              status: 'cleaning',
              occupantType: 'housekeeping',
              powerStatus: 'on',
            };
            extraRoomFields = { cleaningStartTime: data.check_in };
          } else if (accessType === 'master') {
            hasMasterKeyUpdate = { hasMasterKey: true };
          } else {
            const status = data.role === 'Maintenance' ? 'maintenance' : 'occupied';
            update = {
              status,
              occupantType: data.role.toLowerCase(),
              powerStatus: 'on',
            };
            if (data.role === 'Manager') {
              hasMasterKeyUpdate = { hasMasterKey: true };
            }
          }
        } else {
          if (accessType === 'guest') {
            update = {
              status: 'dirty',
              occupantType: null,
              powerStatus: 'off',
            };
          } else if (accessType === 'housekeeping') {
            update = {
              status: 'vacant',
              occupantType: null,
              powerStatus: 'off',
              cleaningStartTime: null,
            };
          } else if (accessType === 'master') {
            hasMasterKeyUpdate = { hasMasterKey: false };
          } else {
            update = {
              status: 'vacant',
              occupantType: null,
              powerStatus: 'off',
            };
            if (data.role === 'Manager') {
              hasMasterKeyUpdate = { hasMasterKey: false };
            }
          }
        }
        
        const roomUpdatePayload = withHeartbeat({ ...update, ...hasMasterKeyUpdate, ...extraRoomFields });
        if (Object.keys(roomUpdatePayload).length > 0) {
          await Room.findOneAndUpdate(
            { hotelId: data.hotelId, number: roomNum },
            roomUpdatePayload,
            { upsert: true, new: true }
          );
          broadcastToClients(`roomUpdate:${data.hotelId}`, { roomNum, ...roomUpdatePayload });
        }

        const activityType = data.check_in ? 'checkin' : 'checkout';
        const action = `${data.role} checked ${data.check_in ? 'in' : 'out'} to Room ${data.room}`;
        const time = data.check_in || data.check_out;
        newActivity = {
          hotelId: data.hotelId,
          id: new Date().getTime().toString(),
          type: activityType,
          action,
          user: data.role,
          time,
        };
      } else if (type === 'alerts') {
        await new Alert(data).save();
        console.log(`Simulated MQTT - Saved alert for room ${roomNum}:`, data);
        const heartbeatUpdate = withHeartbeat();
        await Room.findOneAndUpdate(
          { hotelId: data.hotelId, number: roomNum },
          heartbeatUpdate,
          { upsert: true }
        );
        broadcastToClients(`roomUpdate:${data.hotelId}`, { roomNum, ...heartbeatUpdate });
        
        newActivity = {
          hotelId: data.hotelId,
          id: new Date().getTime().toString(),
          type: 'security',
          action: `Alert: ${data.alert_message} for ${data.role} in Room ${data.room}`,
          user: 'System',
          time: data.triggered_at,
        };
      } else if (type === 'denied_access') {
        await new Denied(data).save();
        console.log(`Simulated MQTT - Saved denied access for room ${roomNum}:`, data);
        const heartbeatUpdate = withHeartbeat();
        await Room.findOneAndUpdate(
          { hotelId: data.hotelId, number: roomNum },
          heartbeatUpdate,
          { upsert: true }
        );
        broadcastToClients(`roomUpdate:${data.hotelId}`, { roomNum, ...heartbeatUpdate });
        
        newActivity = {
          hotelId: data.hotelId,
          id: new Date().getTime().toString(),
          type: 'security',
          action: `Denied access to ${data.role}: ${data.denial_reason} for Room ${data.room}`,
          user: data.role,
          time: data.attempted_at,
        };
      }

      if (newActivity) {
        const savedActivity = await new Activity(newActivity).save();
        broadcastToClients(`activityUpdate:${data.hotelId}`, savedActivity);
      }
    }

    res.json({ success: true, message: 'MQTT simulation processed successfully' });
  } catch (error) {
    console.error('Error in MQTT simulation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check route (your exact route)
app.get('/health', (req, res) => res.json({ 
  status: 'ok',
  mqtt_websocket: 'enabled',
  tcp_mqtt: process.env.NODE_ENV !== 'production' ? 'enabled' : 'disabled'
}));

// 🔧 FIX 8: Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    mongoose.connection.close();
    process.exit(0);
  });
});

server.listen(httpPort, () => {
  const host = process.env.RENDER_EXTERNAL_URL || `http://localhost:${httpPort}`;
  const wsUrl = host.startsWith('https://')
    ? host.replace(/^https/, 'wss') + '/mqtt'
    : host.replace(/^http/, 'ws') + '/mqtt';

  console.log(`🚀 HTTP/WebSocket server running on port ${httpPort}`);
  console.log(`📡 MQTT over WebSocket: ${wsUrl}`);
  console.log(`🌐 API endpoints available at ${host}/api`);
});
