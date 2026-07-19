const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const RENDER_API_URL = process.env.RENDER_API_URL || 'https://recharge-bot-dashboard.onrender.com/api';
const SESSION_SECRET = process.env.SESSION_SECRET || 'your-secret-key';

console.log('🚀 Starting User Dashboard...');
console.log(`📡 Backend API URL: ${RENDER_API_URL}`);
console.log(`🔐 Session Secret: ${SESSION_SECRET ? '✅ Set' : '❌ Not set'}`);

// ============================================
// MIDDLEWARE
// ============================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ============================================
// SEPARATE SESSION STORES FOR USER AND ADMIN
// ============================================

// Create separate MemoryStore instances
const userSessionStore = new MemoryStore({
    checkPeriod: 86400000 // Clean up expired sessions daily
});

const adminSessionStore = new MemoryStore({
    checkPeriod: 86400000 // Clean up expired sessions daily
});

// User session middleware
const userSession = session({
    secret: SESSION_SECRET + '_user',
    resave: false,
    saveUninitialized: false,
    name: 'user.sid', // Different cookie name
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        httpOnly: true,
        sameSite: 'lax',
        path: '/'
    },
    store: userSessionStore
});

// Admin session middleware
const adminSession = session({
    secret: SESSION_SECRET + '_admin',
    resave: false,
    saveUninitialized: false,
    name: 'admin.sid', // Different cookie name
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        httpOnly: true,
        sameSite: 'lax',
        path: '/'
    },
    store: adminSessionStore
});

// Apply session middleware based on route
app.use((req, res, next) => {
    // Admin routes get admin session
    if (req.path.startsWith('/admin')) {
        adminSession(req, res, next);
    } 
    // User routes get user session
    else if (req.path.startsWith('/user')) {
        userSession(req, res, next);
    } 
    // Root and other routes - check both (priority to user)
    else {
        userSession(req, res, () => {
            // Also attach admin session if needed
            adminSession(req, res, next);
        });
    }
});

// ============================================
// SESSION DEBUG MIDDLEWARE (Lighter version)
// ============================================

app.use((req, res, next) => {
    // Only log important routes
    if (req.path.includes('/login') || req.path.includes('/verify') || req.path.includes('/dashboard') || req.path.includes('/logout')) {
        const sessionType = req.path.startsWith('/admin') ? 'Admin' : 'User';
        const sessionData = req.session ? {
            id: req.sessionID,
            userId: req.session.userId,
            userVerified: req.session.userVerified,
            adminLoggedIn: req.session.adminLoggedIn,
            adminUser: req.session.adminUser
        } : null;
        console.log(`📝 ${sessionType} - ${req.method} ${req.path}`);
        console.log(`  Session ID: ${req.sessionID}`);
        console.log(`  Session Data:`, sessionData);
    }
    next();
});

// ============================================
// IN-MEMORY STORAGE
// ============================================

const discoveredUsers = new Map();
const userFees = new Map();

// ============================================
// USER ROUTES
// ============================================

// User login page
app.get('/user/login', (req, res) => {
    console.log('📄 User login page requested');
    
    if (req.session && req.session.userVerified && req.session.userId) {
        console.log('✅ User already logged in, redirecting to dashboard');
        return res.redirect('/user/dashboard');
    }
    res.render('user-login', {
        title: 'User Login',
        error: null
    });
});

// Verify user ID
app.post('/user/verify', async (req, res) => {
    try {
        const { user_id } = req.body;
        console.log('📥 User login attempt with ID:', user_id);

        if (!user_id || user_id.trim() === '') {
            return res.render('user-login', {
                title: 'User Login',
                error: 'Please enter your User ID'
            });
        }

        console.log(`🔍 Verifying user: ${user_id.trim()}`);

        const response = await axios.get(`${RENDER_API_URL}/users/verify/${user_id.trim()}`, {
            timeout: 10000
        });
        
        console.log('📡 Verification response:', response.data);

        if (!response.data.exists) {
            return res.render('user-login', {
                title: 'User Login',
                error: 'User not found. Please check your User ID.'
            });
        }

        // Store in user session only
        req.session.userVerified = true;
        req.session.userId = user_id.trim();
        req.session.username = response.data.username || 'User';
        
        // Save session explicitly
        req.session.save((err) => {
            if (err) {
                console.error('❌ Error saving user session:', err);
                return res.render('user-login', {
                    title: 'User Login',
                    error: 'Session error. Please try again.'
                });
            }
            
            console.log('✅ User session saved successfully');
            console.log(`  User Session ID: ${req.sessionID}`);
            console.log(`  User ID: ${req.session.userId}`);

            // Save to discovered users
            discoveredUsers.set(user_id.trim(), {
                userId: user_id.trim(),
                username: response.data.username || 'User',
                firstSeen: new Date().toISOString(),
                lastLogin: new Date().toISOString()
            });
            console.log(`💾 Saved user ${user_id.trim()} to discovered users (total: ${discoveredUsers.size})`);

            res.redirect('/user/dashboard');
        });

    } catch (error) {
        console.error('❌ Error verifying user:', error.message);
        if (error.code === 'ECONNABORTED') {
            return res.render('user-login', {
                title: 'User Login',
                error: 'Connection timeout. Please try again.'
            });
        }
        res.render('user-login', {
            title: 'User Login',
            error: 'Service temporarily unavailable. Please try again later.'
        });
    }
});

// User dashboard
app.get('/user/dashboard', async (req, res) => {
    if (!req.session || !req.session.userVerified || !req.session.userId) {
        console.log('❌ Unauthorized user dashboard access attempt');
        return res.redirect('/user/login');
    }

    try {
        const userId = req.session.userId;
        console.log(`📊 Fetching data for user: ${userId}`);

        const [rechargesRes, withdrawsRes] = await Promise.all([
            axios.get(`${RENDER_API_URL}/users/${userId}/recharges`, { timeout: 10000 }),
            axios.get(`${RENDER_API_URL}/users/${userId}/withdraws`, { timeout: 10000 })
        ]);

        const rechargeRecords = rechargesRes.data.records || [];
        const withdrawRecords = withdrawsRes.data.records || [];

        const totalRechargeAmount = rechargeRecords.reduce((sum, r) => sum + (r.amount || 0), 0);
        const totalWithdrawAmount = withdrawRecords.reduce((sum, r) => sum + (r.amount || 0), 0);
        const totalRechargeCount = rechargeRecords.length;
        const totalWithdrawCount = withdrawRecords.length;

        let activeDepositAmount = 0;
        const totalRecords = rechargeRecords.length;
        rechargeRecords.forEach((record, index) => {
            const isLatest = index >= totalRecords - 3;
            if (!isLatest) {
                activeDepositAmount += record.amount;
            }
        });

        let pendingWithdrawAmount = 0;
        withdrawRecords.forEach(record => {
            const statusMap = {
                '待审核': 'Pendiente de Revisión',
                '已完成': 'Completado',
                '已拒绝': 'Rechazado',
                '处理中': 'En Proceso',
                '审核中': 'En Revisión',
                '已通过': 'Aprobado',
                '已取消': 'Cancelado',
                '待处理': 'Pendiente'
            };
            const translatedStatus = statusMap[record.status] || record.status || 'Desconocido';
            const isApproved = translatedStatus === 'Aprobado' || translatedStatus === 'Completado';
            if (!isApproved) {
                pendingWithdrawAmount += (record.amount || 0);
            }
        });

        const feeData = userFees.get(userId) || { depositFee: 10, withdrawFee: 5 };
        const userDepositFee = feeData.depositFee || 10;
        const userWithdrawFee = feeData.withdrawFee || 5;

        console.log(`✅ Loaded ${totalRechargeCount} recharges and ${totalWithdrawCount} withdraws`);

        res.render('user-dashboard', {
            title: 'My Dashboard',
            username: req.session.username || 'User',
            userId: userId,
            totalRechargeAmount,
            totalWithdrawAmount,
            totalRechargeCount,
            totalWithdrawCount,
            rechargeRecords,
            withdrawRecords,
            activeDepositAmount,
            pendingWithdrawAmount,
            userDepositFee,
            userWithdrawFee,
            error: null
        });

    } catch (error) {
        console.error('❌ Error loading user dashboard:', error.message);
        res.render('user-dashboard', {
            title: 'My Dashboard',
            username: req.session.username || 'User',
            userId: req.session.userId,
            totalRechargeAmount: 0,
            totalWithdrawAmount: 0,
            totalRechargeCount: 0,
            totalWithdrawCount: 0,
            rechargeRecords: [],
            withdrawRecords: [],
            activeDepositAmount: 0,
            pendingWithdrawAmount: 0,
            userDepositFee: 10,
            userWithdrawFee: 5,
            error: 'Failed to load records. Please refresh the page.'
        });
    }
});

// User logout - Only destroys user session
app.get('/user/logout', (req, res) => {
    const userId = req.session?.userId || 'unknown';
    console.log(`👋 User logged out: ${userId}`);
    
    // Destroy only the user session
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying user session:', err);
        }
        // Clear the user session cookie
        res.clearCookie('user.sid', { path: '/' });
        console.log('✅ User session destroyed (admin session remains active if any)');
        res.redirect('/user/login');
    });
});

// ============================================
// ADMIN ROUTES
// ============================================

// Admin login page
app.get('/admin/login', (req, res) => {
    console.log('📄 Admin login page requested');
    
    if (req.session && req.session.adminLoggedIn) {
        return res.redirect('/admin/dashboard');
    }
    
    const error = req.query.error || null;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Admin Login</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        </head>
        <body class="bg-gray-100 flex items-center justify-center min-h-screen p-4">
            <div class="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full">
                <div class="text-center mb-6">
                    <div class="bg-indigo-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto">
                        <i class="fas fa-shield-alt text-indigo-600 text-2xl"></i>
                    </div>
                    <h1 class="text-2xl font-bold text-gray-800 mt-4">Acceso Admin</h1>
                    <p class="text-sm text-gray-500">Ingresa tus credenciales</p>
                </div>
                
                ${error ? `
                <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm text-center">
                    <i class="fas fa-exclamation-circle mr-2"></i>${error}
                </div>
                ` : ''}
                
                <form action="/admin/verify" method="POST" id="loginForm">
                    <div class="mb-4">
                        <label class="block text-sm font-medium text-gray-700 mb-2">
                            <i class="fas fa-user mr-2 text-indigo-500"></i>Usuario
                        </label>
                        <input type="text" name="username" id="username" required 
                               class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                               placeholder="admin" value="admin">
                    </div>
                    <div class="mb-6">
                        <label class="block text-sm font-medium text-gray-700 mb-2">
                            <i class="fas fa-lock mr-2 text-indigo-500"></i>Contraseña
                        </label>
                        <input type="password" name="password" id="password" required 
                               class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                               placeholder="••••••••" value="admin123">
                    </div>
                    <button type="submit" id="loginBtn"
                            class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5 rounded-lg transition flex items-center justify-center gap-2">
                        <i class="fas fa-sign-in-alt"></i> Ingresar
                    </button>
                </form>
                
                <div class="mt-4 text-center text-xs text-gray-400">
                    <i class="fas fa-lock mr-1"></i> Acceso restringido
                </div>
                
                <div class="mt-4 p-3 bg-gray-50 rounded-lg text-xs text-gray-500">
                    <p><strong>Credenciales de prueba:</strong></p>
                    <p>Usuario: <span class="font-mono">admin</span></p>
                    <p>Contraseña: <span class="font-mono">admin123</span></p>
                </div>
            </div>
            
            <script>
                document.getElementById('loginForm').addEventListener('submit', function(e) {
                    const btn = document.getElementById('loginBtn');
                    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verificando...';
                    btn.disabled = true;
                });
            </script>
        </body>
        </html>
    `);
});

// Admin verify
app.post('/admin/verify', (req, res) => {
    const { username, password } = req.body;
    
    console.log('🔐 Admin login attempt:');
    console.log('  Username:', username);
    console.log('  Session ID:', req.sessionID);
    
    const ADMIN_USER = process.env.ADMIN_USER || 'admin';
    const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
    
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        req.session.adminLoggedIn = true;
        req.session.adminUser = username;
        
        req.session.save((err) => {
            if (err) {
                console.error('❌ Error saving admin session:', err);
                return res.redirect('/admin/login?error=Session%20error');
            }
            
            console.log('✅ Admin logged in successfully');
            console.log('  Admin Session ID:', req.sessionID);
            return res.redirect('/admin/dashboard');
        });
    } else {
        console.log('❌ Failed admin login attempt - invalid credentials');
        res.redirect('/admin/login?error=Usuario%20o%20contrase%C3%B1a%20incorrectos');
    }
});

// Admin dashboard
app.get('/admin/dashboard', (req, res) => {
    if (!req.session || !req.session.adminLoggedIn) {
        console.log('❌ Unauthorized admin dashboard access');
        return res.redirect('/admin/login');
    }

    try {
        console.log('📊 Admin dashboard loading...');
        console.log(`👥 ${discoveredUsers.size} users discovered so far`);
        
        res.render('admin-dashboard', {
            title: 'Admin Dashboard',
            userCount: discoveredUsers.size,
            error: null
        });
        
    } catch (error) {
        console.error('❌ Error loading admin dashboard:', error.message);
        res.render('admin-dashboard', {
            title: 'Admin Dashboard',
            userCount: 0,
            error: 'Failed to load dashboard'
        });
    }
});

// Admin logout - Only destroys admin session
app.get('/admin/logout', (req, res) => {
    console.log('👋 Admin logged out');
    
    // Destroy only the admin session
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying admin session:', err);
        }
        // Clear the admin session cookie
        res.clearCookie('admin.sid', { path: '/' });
        console.log('✅ Admin session destroyed (user session remains active if any)');
        res.redirect('/admin/login');
    });
});

// ============================================
// ADMIN API - USERS
// ============================================

// Admin API - Get all discovered users
app.get('/admin/api/users', (req, res) => {
    if (!req.session || !req.session.adminLoggedIn) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        console.log(`📊 Fetching ${discoveredUsers.size} discovered users...`);
        
        const userIds = Array.from(discoveredUsers.keys());
        const users = [];
        
        const fetchPromises = userIds.map(async (userId) => {
            try {
                const [rechargesRes, withdrawsRes] = await Promise.all([
                    axios.get(`${RENDER_API_URL}/users/${userId}/recharges`, { timeout: 5000 }),
                    axios.get(`${RENDER_API_URL}/users/${userId}/withdraws`, { timeout: 5000 })
                ]);
                
                const rechargeRecords = rechargesRes.data.records || [];
                const withdrawRecords = withdrawsRes.data.records || [];
                
                let activeDepositAmount = 0;
                const totalRecords = rechargeRecords.length;
                rechargeRecords.forEach((record, index) => {
                    const isLatest = index >= totalRecords - 3;
                    if (!isLatest) {
                        activeDepositAmount += record.amount;
                    }
                });
                
                let pendingWithdrawAmount = 0;
                withdrawRecords.forEach(record => {
                    const statusMap = {
                        '待审核': 'Pendiente de Revisión',
                        '已完成': 'Completado',
                        '已拒绝': 'Rechazado',
                        '处理中': 'En Proceso',
                        '审核中': 'En Revisión',
                        '已通过': 'Aprobado',
                        '已取消': 'Cancelado',
                        '待处理': 'Pendiente'
                    };
                    const translatedStatus = statusMap[record.status] || record.status || 'Desconocido';
                    const isApproved = translatedStatus === 'Aprobado' || translatedStatus === 'Completado';
                    if (!isApproved) {
                        pendingWithdrawAmount += (record.amount || 0);
                    }
                });
                
                const userInfo = discoveredUsers.get(userId);
                const feeData = userFees.get(userId) || { depositFee: 0, withdrawFee: 0 };
                
                return {
                    userId: userId,
                    username: userInfo?.username || `User_${userId}`,
                    status: 'active',
                    activeDeposit: activeDepositAmount,
                    pendingWithdraw: pendingWithdrawAmount,
                    rechargeCount: rechargeRecords.length,
                    withdrawCount: withdrawRecords.length,
                    totalRechargeAmount: rechargeRecords.reduce((sum, r) => sum + (r.amount || 0), 0),
                    totalWithdrawAmount: withdrawRecords.reduce((sum, r) => sum + (r.amount || 0), 0),
                    firstSeen: userInfo?.firstSeen || 'N/A',
                    lastLogin: userInfo?.lastLogin || 'N/A',
                    depositFee: feeData.depositFee || 0,
                    withdrawFee: feeData.withdrawFee || 0
                };
            } catch (error) {
                console.error(`Error fetching data for user ${userId}:`, error.message);
                const userInfo = discoveredUsers.get(userId);
                const feeData = userFees.get(userId) || { depositFee: 0, withdrawFee: 0 };
                return {
                    userId: userId,
                    username: userInfo?.username || `User_${userId}`,
                    status: 'active',
                    activeDeposit: 0,
                    pendingWithdraw: 0,
                    rechargeCount: 0,
                    withdrawCount: 0,
                    totalRechargeAmount: 0,
                    totalWithdrawAmount: 0,
                    firstSeen: userInfo?.firstSeen || 'N/A',
                    lastLogin: userInfo?.lastLogin || 'N/A',
                    depositFee: feeData.depositFee || 0,
                    withdrawFee: feeData.withdrawFee || 0
                };
            }
        });
        
        Promise.all(fetchPromises).then((usersData) => {
            users.push(...usersData);
            console.log(`✅ Returning ${users.length} users`);
            res.json({ users });
        }).catch((error) => {
            console.error('Error processing users:', error);
            res.status(500).json({ error: error.message });
        });
        
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: error.message });
    }
});

// Admin API - Add user manually
app.post('/admin/api/add-user', async (req, res) => {
    if (!req.session || !req.session.adminLoggedIn) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        const { userId, username } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }
        
        const verifyRes = await axios.get(`${RENDER_API_URL}/users/verify/${userId}`, { 
            timeout: 5000 
        });
        
        if (!verifyRes.data.exists) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        discoveredUsers.set(userId, {
            userId: userId,
            username: username || verifyRes.data.username || `User_${userId}`,
            firstSeen: new Date().toISOString(),
            lastLogin: new Date().toISOString()
        });
        
        console.log(`✅ Manually added user ${userId} (total: ${discoveredUsers.size})`);
        res.json({ 
            success: true, 
            message: `User ${userId} added successfully`,
            totalUsers: discoveredUsers.size
        });
        
    } catch (error) {
        console.error('Error adding user:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ADMIN API - FEE MANAGEMENT
// ============================================

// Admin API - Update user fees
app.post('/admin/api/update-fees', async (req, res) => {
    if (!req.session || !req.session.adminLoggedIn) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        const { userId, depositFee, withdrawFee } = req.body;
        
        console.log('📝 Received fee update request:');
        console.log('  User ID:', userId);
        console.log('  Deposit Fee:', depositFee);
        console.log('  Withdraw Fee:', withdrawFee);
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }
        
        if (depositFee === undefined || depositFee === null || isNaN(depositFee)) {
            return res.status(400).json({ error: 'Invalid deposit fee value' });
        }
        
        if (withdrawFee === undefined || withdrawFee === null || isNaN(withdrawFee)) {
            return res.status(400).json({ error: 'Invalid withdraw fee value' });
        }
        
        const depositFeeNum = parseFloat(depositFee);
        const withdrawFeeNum = parseFloat(withdrawFee);
        
        if (depositFeeNum < 0 || depositFeeNum > 100) {
            return res.status(400).json({ error: 'Deposit fee must be between 0 and 100' });
        }
        
        if (withdrawFeeNum < 0 || withdrawFeeNum > 100) {
            return res.status(400).json({ error: 'Withdraw fee must be between 0 and 100' });
        }
        
        if (!discoveredUsers.has(userId)) {
            try {
                const verifyRes = await axios.get(`${RENDER_API_URL}/users/verify/${userId}`, { 
                    timeout: 5000 
                });
                
                if (!verifyRes.data.exists) {
                    return res.status(404).json({ error: 'User not found' });
                }
                
                discoveredUsers.set(userId, {
                    userId: userId,
                    username: verifyRes.data.username || `User_${userId}`,
                    firstSeen: new Date().toISOString(),
                    lastLogin: new Date().toISOString()
                });
            } catch (error) {
                return res.status(404).json({ error: 'User not found' });
            }
        }
        
        const feeData = {
            depositFee: depositFeeNum,
            withdrawFee: withdrawFeeNum,
            updatedAt: new Date().toISOString()
        };
        userFees.set(userId, feeData);
        
        console.log(`💲 Updated fees for user ${userId}: Deposit ${depositFeeNum}%, Withdraw ${withdrawFeeNum}%`);
        
        res.json({ 
            success: true, 
            message: `Fees updated: Deposit ${depositFeeNum}%, Withdraw ${withdrawFeeNum}%`,
            depositFee: depositFeeNum,
            withdrawFee: withdrawFeeNum
        });
        
    } catch (error) {
        console.error('Error updating fees:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

// Admin API - Get user fees
app.get('/admin/api/get-fees/:userId', (req, res) => {
    if (!req.session || !req.session.adminLoggedIn) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        const { userId } = req.params;
        const feeData = userFees.get(userId) || { depositFee: 0, withdrawFee: 0 };
        
        res.json({ 
            userId: userId,
            depositFee: feeData.depositFee || 0,
            withdrawFee: feeData.withdrawFee || 0,
            updatedAt: feeData.updatedAt || null
        });
        
    } catch (error) {
        console.error('Error getting fees:', error);
        res.status(500).json({ error: error.message });
    }
});

// Admin view single user
app.get('/admin/user/:userId', async (req, res) => {
    if (!req.session || !req.session.adminLoggedIn) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        const userId = req.params.userId;
        console.log(`🔍 Admin viewing user: ${userId}`);
        
        const [userRes, rechargesRes, withdrawsRes] = await Promise.all([
            axios.get(`${RENDER_API_URL}/users/verify/${userId}`, { timeout: 5000 }),
            axios.get(`${RENDER_API_URL}/users/${userId}/recharges`, { timeout: 5000 }),
            axios.get(`${RENDER_API_URL}/users/${userId}/withdraws`, { timeout: 5000 })
        ]);
        
        const user = userRes.data;
        const rechargeRecords = rechargesRes.data.records || [];
        const withdrawRecords = withdrawsRes.data.records || [];
        
        let activeDepositAmount = 0;
        const totalRecords = rechargeRecords.length;
        rechargeRecords.forEach((record, index) => {
            const isLatest = index >= totalRecords - 3;
            if (!isLatest) {
                activeDepositAmount += record.amount;
            }
        });
        
        let pendingWithdrawAmount = 0;
        withdrawRecords.forEach(record => {
            const statusMap = {
                '待审核': 'Pendiente de Revisión',
                '已完成': 'Completado',
                '已拒绝': 'Rechazado',
                '处理中': 'En Proceso',
                '审核中': 'En Revisión',
                '已通过': 'Aprobado',
                '已取消': 'Cancelado',
                '待处理': 'Pendiente'
            };
            const translatedStatus = statusMap[record.status] || record.status || 'Desconocido';
            const isApproved = translatedStatus === 'Aprobado' || translatedStatus === 'Completado';
            if (!isApproved) {
                pendingWithdrawAmount += (record.amount || 0);
            }
        });
        
        const feeData = userFees.get(userId) || { depositFee: 0, withdrawFee: 0 };
        
        res.json({
            user,
            rechargeRecords,
            withdrawRecords,
            totalRecharges: rechargeRecords.length,
            totalWithdraws: withdrawRecords.length,
            totalRechargeAmount: rechargeRecords.reduce((sum, r) => sum + (r.amount || 0), 0),
            totalWithdrawAmount: withdrawRecords.reduce((sum, r) => sum + (r.amount || 0), 0),
            activeDeposit: activeDepositAmount,
            pendingWithdraw: pendingWithdrawAmount,
            depositFee: feeData.depositFee || 0,
            withdrawFee: feeData.withdrawFee || 0
        });
        
    } catch (error) {
        console.error('❌ Error fetching user details:', error.message);
        res.status(500).json({ error: 'Failed to fetch user details' });
    }
});

// ============================================
// FEE PAYMENT ROUTES
// ============================================

// Fee payment page
app.get('/user/fee-payment/:type', async (req, res) => {
    if (!req.session || !req.session.userVerified || !req.session.userId) {
        return res.redirect('/user/login');
    }

    try {
        const userId = req.session.userId;
        const feeType = req.params.type;
        
        const [rechargesRes, withdrawsRes] = await Promise.all([
            axios.get(`${RENDER_API_URL}/users/${userId}/recharges`, { timeout: 10000 }),
            axios.get(`${RENDER_API_URL}/users/${userId}/withdraws`, { timeout: 10000 })
        ]);

        const rechargeRecords = rechargesRes.data.records || [];
        const withdrawRecords = withdrawsRes.data.records || [];

        let activeDepositAmount = 0;
        const totalRecords = rechargeRecords.length;
        rechargeRecords.forEach((record, index) => {
            const isLatest = index >= totalRecords - 3;
            if (!isLatest) {
                activeDepositAmount += record.amount;
            }
        });

        let pendingWithdrawAmount = 0;
        withdrawRecords.forEach(record => {
            const statusMap = {
                '待审核': 'Pendiente de Revisión',
                '已完成': 'Completado',
                '已拒绝': 'Rechazado',
                '处理中': 'En Proceso',
                '审核中': 'En Revisión',
                '已通过': 'Aprobado',
                '已取消': 'Cancelado',
                '待处理': 'Pendiente'
            };
            const translatedStatus = statusMap[record.status] || record.status || 'Desconocido';
            const isApproved = translatedStatus === 'Aprobado' || translatedStatus === 'Completado';
            if (!isApproved) {
                pendingWithdrawAmount += (record.amount || 0);
            }
        });

        const feeData = userFees.get(userId) || { depositFee: 10, withdrawFee: 5 };
        
        let totalAmount, feePercentage, feeAmount;

        if (feeType === 'direct') {
            totalAmount = activeDepositAmount;
            feePercentage = feeData.depositFee || 10;
        } else if (feeType === 'pending') {
            totalAmount = pendingWithdrawAmount;
            feePercentage = feeData.withdrawFee || 5;
        } else {
            return res.redirect('/user/dashboard');
        }

        feeAmount = totalAmount * (feePercentage / 100);

        res.render('fee-payment', {
            title: 'Pago de Comisión',
            username: req.session.username || 'User',
            userId: userId,
            feeType: feeType,
            feePercentage: feePercentage,
            totalAmount: totalAmount,
            feeAmount: feeAmount,
            error: null
        });

    } catch (error) {
        console.error('❌ Error loading fee payment page:', error.message);
        res.redirect('/user/dashboard');
    }
});

// ============================================
// HEALTH CHECK & ROOT
// ============================================

// Health check
app.get('/api/health', (req, res) => {
    // Check both sessions
    let userSessionData = null;
    let adminSessionData = null;
    
    // We need to check if sessions exist
    if (req.session) {
        // This is the active session
        if (req.session.userVerified) {
            userSessionData = {
                userId: req.session.userId,
                username: req.session.username
            };
        }
        if (req.session.adminLoggedIn) {
            adminSessionData = {
                adminUser: req.session.adminUser
            };
        }
    }
    
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        backend: RENDER_API_URL,
        users: discoveredUsers.size,
        sessionStore: 'Separate MemoryStores for User and Admin',
        sessions: {
            user: userSessionData,
            admin: adminSessionData
        }
    });
});

// Root redirect
app.get('/', (req, res) => {
    res.redirect('/user/login');
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).send('Something went wrong!');
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log(`✅ User Dashboard running on http://localhost:${PORT}`);
    console.log(`📡 Backend API: ${RENDER_API_URL}`);
    console.log(`👥 Session stores: Separate MemoryStores for User and Admin`);
    console.log(`🔐 Admin credentials: ${process.env.ADMIN_USER || 'admin'} / ${process.env.ADMIN_PASS || 'admin123'}`);
    console.log(`🔍 Debug mode: ON - Check logs for session details`);
});

// Export for Vercel (if needed)
module.exports = app;
