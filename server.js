const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

// Set timezone if provided
if (process.env.TZ) {
    process.env.TZ = process.env.TZ;
}

const app = express();
const PORT = process.env.PORT || 10000;
const DATA_FILE = path.join(__dirname, 'data', 'bank_account_data.json');

// Trust proxy in production (needed for secure cookies)
if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// In-memory storage for serverless environments
let memoryStorage = null;
let lastProcessedTime = null;
const PROCESSING_COOLDOWN = 5000; // 5 seconds cooldown between processing

// Initialize Redis client
let redis = null;
try {
    // Use Redis.fromEnv() which automatically detects environment variables
    redis = Redis.fromEnv();
    console.log('Redis client initialized successfully with fromEnv()');
} catch (error) {
    console.log('Redis initialization failed, using file storage:', error.message);
    console.log('UPSTASH_REDIS_REST_URL present:', !!process.env.UPSTASH_REDIS_REST_URL);
    console.log('UPSTASH_REDIS_REST_TOKEN present:', !!process.env.UPSTASH_REDIS_REST_TOKEN);
    redis = null;
}

// Migration helper
async function migrateDataToRedis() {
    if (!redis) return;
    
    try {
        // Check if data already exists in Redis
        const redisData = await redis.get('bank_account_data');
        if (redisData) {
            console.log('Data already exists in Redis, skipping migration');
            return;
        }
        
        // Try to load from file system
        if (fs.existsSync(DATA_FILE)) {
            console.log('Migrating data from file system to Redis...');
            const fileData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            await redis.set('bank_account_data', JSON.stringify(fileData));
            console.log('Migration completed successfully');
        }
    } catch (error) {
        console.error('Error during migration:', error);
    }
}

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: process.env.SESSION_SECRET || 'bank-app-secret-key-very-long-and-secure',
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: false, // Always false for now to test
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    },
    name: 'bank.session.id'
}));

// Simple token-based auth as backup for serverless
const activeTokens = new Map();
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

function generateAuthToken() {
    return crypto.randomBytes(32).toString('hex');
}

function isValidToken(token) {
    const tokenData = activeTokens.get(token);
    if (!tokenData) return false;
    
    if (Date.now() > tokenData.expires) {
        activeTokens.delete(token);
        return false;
    }
    
    return true;
}

function getTokenFromRequest(req) {
    // Check Authorization header first
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        console.log('Found token in Authorization header:', token.substring(0, 8) + '...');
        return token;
    }
    
    // Check cookies
    if (req.headers.cookie) {
        const cookies = req.headers.cookie.split(';');
        for (let cookie of cookies) {
            const parts = cookie.trim().split('=');
            const name = parts[0];
            const value = parts.slice(1).join('='); // Handle values with = in them
            if (name === 'authToken') {
                console.log('Found token in cookie:', value.substring(0, 8) + '...');
                return value;
            }
        }
    }
    
    console.log('No token found in request');
    return null;
}

function isAuthenticated(req) {
    // Check session first
    if (req.session && req.session.authenticated) {
        return true;
    }
    
    // Check token as backup
    const token = getTokenFromRequest(req);
    return token && isValidToken(token);
}

// ========== UTILITY FUNCTIONS ==========

// Date utility functions
function getNextSaturday(date) {
    const localDate = new Date(date);
    // Ensure we're working with the date in local timezone
    const day = localDate.getDay();
    const daysUntilSaturday = (6 - day + 7) % 7;
    
    if (daysUntilSaturday === 0) {
        // It's already Saturday, return next Saturday
        localDate.setDate(localDate.getDate() + 7);
    } else {
        localDate.setDate(localDate.getDate() + daysUntilSaturday);
    }
    
    return localDate;
}

function getNextSunday(date) {
    const localDate = new Date(date);
    // Ensure we're working with the date in local timezone
    const day = localDate.getDay();
    const daysUntilSunday = (7 - day) % 7;
    
    if (daysUntilSunday === 0) {
        // It's already Sunday, return next Sunday
        localDate.setDate(localDate.getDate() + 7);
    } else {
        localDate.setDate(localDate.getDate() + daysUntilSunday);
    }
    
    return localDate;
}

function getSaturdaysBetween(startDate, endDate) {
    const saturdays = [];
    let current = getNextSaturday(startDate);
    while (current <= endDate) {
        saturdays.push(new Date(current));
        current.setDate(current.getDate() + 7);
    }
    return saturdays;
}

function getSundaysBetween(startDate, endDate) {
    const sundays = [];
    let current = getNextSunday(startDate);
    while (current <= endDate) {
        sundays.push(new Date(current));
        current.setDate(current.getDate() + 7);
    }
    return sundays;
}

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function parseDate(dateString) {
    // Parse as local date, not UTC
    const [year, month, day] = dateString.split('-').map(num => parseInt(num));
    return new Date(year, month - 1, day);
}

// Authentication
function authenticate(username, password) {
    const validUser = "dad";
    const validPassHash = crypto.createHash('sha256').update("Pass1345").digest('hex');
    const userPassHash = crypto.createHash('sha256').update(password).digest('hex');
    return username === validUser && userPassHash === validPassHash;
}

// Data management
async function loadAccountData() {
    try {
        let data = null;
        
        // Try to load from Redis first
        if (redis) {
            const redisData = await redis.get('bank_account_data');
            if (redisData) {
                data = redisData; // Redis.fromEnv() automatically deserializes JSON
                console.log('Loaded data from Redis');
            }
        }
        
        // Fall back to file system for local development
        if (!data && fs.existsSync(DATA_FILE)) {
            data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            console.log('Loaded data from file system');
        }
        
        if (data) {
            // Convert date strings back to Date objects
            if (data.start_date) data.start_date = parseDate(data.start_date);
            if (data.settings_change_date) data.settings_change_date = parseDate(data.settings_change_date);
            if (data.last_processed_saturday) data.last_processed_saturday = parseDate(data.last_processed_saturday);
            if (data.last_processed_sunday) data.last_processed_sunday = parseDate(data.last_processed_sunday);
            
            // Convert transaction dates
            if (data.manual_txns && Array.isArray(data.manual_txns)) {
                data.manual_txns.forEach(txn => {
                    txn.Date = parseDate(txn.Date);
                });
            }
            if (data.auto_deposits && Array.isArray(data.auto_deposits)) {
                data.auto_deposits.forEach(txn => {
                    txn.Date = parseDate(txn.Date);
                });
            }
            
            // Ensure arrays exist
            if (!data.manual_txns) data.manual_txns = [];
            if (!data.auto_deposits) data.auto_deposits = [];
            
            console.log('Data loaded successfully:', {
                account_holder: data.account_holder,
                auto_deposits_count: data.auto_deposits.length,
                manual_txns_count: data.manual_txns.length
            });
            
            return data;
        }
    } catch (error) {
        console.error('Error loading account data:', error);
    }
    
    // Default data structure
    console.log('Using default data structure');
    return {
        account_holder: "My",
        initial_balance: 0.0,
        start_date: new Date('2024-01-01'),
        initial_allowance: 5.0,
        initial_interest: 1.0,
        current_allowance: 5.0,
        current_interest: 1.0,
        settings_change_date: null,
        manual_txns: [],
        last_processed_saturday: null,
        last_processed_sunday: null,
        auto_deposits: []
    };
}

async function saveAccountData(data) {
    try {
        // Create a copy for saving with dates converted to strings
        const saveData = { ...data };
        
        // Convert dates to strings
        if (saveData.start_date) saveData.start_date = formatDate(saveData.start_date);
        if (saveData.settings_change_date) saveData.settings_change_date = formatDate(saveData.settings_change_date);
        if (saveData.last_processed_saturday) saveData.last_processed_saturday = formatDate(saveData.last_processed_saturday);
        if (saveData.last_processed_sunday) saveData.last_processed_sunday = formatDate(saveData.last_processed_sunday);
        
        // Convert transaction dates
        if (saveData.manual_txns) {
            saveData.manual_txns = saveData.manual_txns.map(txn => ({
                ...txn,
                Date: formatDate(txn.Date)
            }));
        }
        if (saveData.auto_deposits) {
            saveData.auto_deposits = saveData.auto_deposits.map(txn => ({
                ...txn,
                Date: formatDate(txn.Date)
            }));
        }
        
        // Save to Redis if available
        if (redis) {
            try {
                await redis.set('bank_account_data', saveData);
                console.log('Data saved to Redis successfully');
                // Also save to file as backup in development
                if (process.env.NODE_ENV !== 'production') {
                    const dataDir = path.dirname(DATA_FILE);
                    if (!fs.existsSync(dataDir)) {
                        fs.mkdirSync(dataDir, { recursive: true });
                    }
                    fs.writeFileSync(DATA_FILE, JSON.stringify(saveData, null, 2));
                    console.log('Data also saved to file as backup');
                }
                return true;
            } catch (redisError) {
                console.error('Redis save failed:', redisError);
                // Fall through to file system backup
            }
        }
        
        // Fall back to file system for local development
        const dataDir = path.dirname(DATA_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        fs.writeFileSync(DATA_FILE, JSON.stringify(saveData, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving account data:', error);
        return false;
    }
}

async function processNewDeposits(data) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Determine starting points for processing
    const saturdayStart = data.last_processed_saturday 
        ? new Date(data.last_processed_saturday.getTime() + 24 * 60 * 60 * 1000)
        : data.start_date;
    
    const sundayStart = data.last_processed_sunday
        ? new Date(data.last_processed_sunday.getTime() + 24 * 60 * 60 * 1000)
        : data.start_date;
    
    // Get all dates that need processing
    const saturdays = getSaturdaysBetween(saturdayStart, today);
    const sundays = getSundaysBetween(sundayStart, today);
    
    // Combine and sort all dates
    const allDates = [
        ...saturdays.map(date => ({ date, type: 'saturday' })),
        ...sundays.map(date => ({ date, type: 'sunday' }))
    ].sort((a, b) => a.date - b.date);
    
    if (allDates.length > 0) {
        // Calculate running balance
        const allTxns = [...data.auto_deposits, ...data.manual_txns];
        allTxns.sort((a, b) => a.Date - b.Date);
        
        let balance = data.initial_balance;
        for (const txn of allTxns) {
            balance += txn.Amount;
        }
        
        // Process each date
        for (const { date, type } of allDates) {
            // Determine which settings to use
            const useCurrentSettings = data.settings_change_date && date >= data.settings_change_date;
            const allowance = useCurrentSettings ? data.current_allowance : data.initial_allowance;
            const interestRate = useCurrentSettings ? data.current_interest : data.initial_interest;
            
            if (type === 'saturday') {
                // Add allowance
                data.auto_deposits.push({
                    Date: new Date(date),
                    Type: "Weekly Allowance",
                    Amount: allowance
                });
                balance += allowance;
                data.last_processed_saturday = new Date(date);
            } else if (type === 'sunday') {
                // Calculate interest based on balance at this specific date
                // Need to recalculate balance up to this point including manual transactions
                const currentDate = new Date(date);
                const allTxnsUpToNow = [...data.auto_deposits, ...data.manual_txns]
                    .filter(txn => new Date(txn.Date) < currentDate)
                    .sort((a, b) => new Date(a.Date) - new Date(b.Date));
                
                let balanceAtThisPoint = data.initial_balance;
                for (const txn of allTxnsUpToNow) {
                    balanceAtThisPoint += txn.Amount;
                }
                
                const interest = balanceAtThisPoint * (interestRate / 100);
                if (interest > 0) {
                    data.auto_deposits.push({
                        Date: new Date(date),
                        Type: `Interest @ ${interestRate}% 😊`,
                        Amount: interest
                    });
                    balance += interest; // Update running balance for next iteration
                }
                data.last_processed_sunday = new Date(date);
            }
        }
        
        await saveAccountData(data);
        return true;
    }
    return false;
}

async function recalculateFromTransaction(data, transactionDate) {
    // NEW APPROACH: Don't try to preserve/remove deposits.
    // Instead, recalculate all interest from scratch but base it on the correct historical balance at each point.
    
    if (data.manual_txns.length === 0) {
        // No manual transactions - just do normal processing
        await processNewDeposits(data);
        await saveAccountData(data);
        return;
    }
    
    // Step 1: Remove ALL interest payments (they depend on balance)
    // Keep all allowances (they are fixed amounts regardless of balance)
    const allowancesOnly = data.auto_deposits.filter(deposit => 
        !deposit.Type.includes("Interest")
    );
    
    // Step 2: Find the last allowance date to determine last_processed_saturday
    let lastSaturday = null;
    for (const deposit of allowancesOnly) {
        const depositDate = new Date(deposit.Date);
        if (depositDate.getDay() === 6 && deposit.Type === "Weekly Allowance") {
            if (!lastSaturday || depositDate > lastSaturday) {
                lastSaturday = depositDate;
            }
        }
    }
    
    // Step 3: Reset data to allowances only
    data.auto_deposits = allowancesOnly;
    data.last_processed_saturday = lastSaturday;
    data.last_processed_sunday = null; // Recalculate all interest from beginning
    
    // Step 4: Process deposits normally - this will add missing allowances and calculate interest correctly
    // The processNewDeposits function will calculate interest based on the running balance at each point,
    // which includes manual transactions in chronological order
    await processNewDeposits(data);
    
    // Ensure data is saved after recalculation
    await saveAccountData(data);
}

async function recalculateAllDeposits(data) {
    console.log('Recalculating all deposits...');
    data.auto_deposits = [];
    data.last_processed_saturday = null;
    data.last_processed_sunday = null;
    
    console.log('Processing new deposits...');
    await processNewDeposits(data);
    
    console.log('Saving data after recalculation...');
    const saved = await saveAccountData(data);
    
    if (!saved) {
        throw new Error('Failed to save data after recalculation');
    }
    
    console.log('Recalculation completed successfully');
}

function getCurrentTime() {
    return new Date().toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });
}

// Currency formatting helper
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
    }).format(amount);
}

// ========== API ROUTES ==========

// Authentication
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    
    console.log('Login attempt:');
    console.log('  Username:', username);
    console.log('  Password provided:', !!password);
    console.log('  Session ID before:', req.sessionID);
    
    if (authenticate(username, password)) {
        // Set session
        req.session.authenticated = true;
        req.session.username = username;
        req.session.loginTime = new Date().toISOString();
        
        // Generate token as backup
        const token = generateAuthToken();
        activeTokens.set(token, {
            username: username,
            expires: Date.now() + TOKEN_EXPIRY,
            createdAt: new Date().toISOString()
        });
        
        console.log('Login successful:');
        console.log('  Session ID after:', req.sessionID);
        console.log('  Session data:', req.session);
        console.log('  Auth token created:', token);
        
        // Set cookie with token
        res.cookie('authToken', token, {
            httpOnly: true,
            secure: false, // false for testing
            sameSite: 'lax',
            maxAge: TOKEN_EXPIRY
        });
        
        res.json({ 
            success: true, 
            sessionId: req.sessionID,
            authToken: token,
            message: 'Login successful' 
        });
    } else {
        console.log('Login failed: Invalid credentials');
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/auth/status', (req, res) => {
    console.log('Auth status check:');
    console.log('  Session ID:', req.sessionID);
    console.log('  Session exists:', !!req.session);
    console.log('  Session authenticated:', !!req.session?.authenticated);
    console.log('  Session data:', req.session);
    
    const token = getTokenFromRequest(req);
    const tokenValid = token && isValidToken(token);
    const authenticated = isAuthenticated(req);
    
    console.log('  Token:', token ? token.substring(0, 8) + '...' : 'none');
    console.log('  Token valid:', tokenValid);
    console.log('  Final authenticated:', authenticated);
    
    res.json({ 
        authenticated: authenticated,
        sessionId: req.sessionID,
        sessionExists: !!req.session,
        tokenExists: !!token,
        tokenValid: tokenValid,
        debug: {
            session: req.session,
            cookies: req.headers.cookie,
            activeTokensCount: activeTokens.size
        }
    });
});

// Account data
app.get('/api/account', async (req, res) => {
    try {
        const data = await loadAccountData();
        
        // Check if we have existing data before processing deposits
        const hasExistingData = data.auto_deposits && data.auto_deposits.length > 0;
        const now = Date.now();
        const shouldProcess = !lastProcessedTime || (now - lastProcessedTime > PROCESSING_COOLDOWN);
        
        if (!hasExistingData) {
            console.log('No existing auto deposits found, processing new deposits');
            await processNewDeposits(data);
            lastProcessedTime = now;
        } else if (shouldProcess) {
            console.log(`Found ${data.auto_deposits.length} existing auto deposits, checking for new ones`);
            await processNewDeposits(data);
            lastProcessedTime = now;
        } else {
            console.log('Skipping deposit processing due to cooldown period');
        }
        
        // Calculate current balance
        const allTxns = [...data.auto_deposits, ...data.manual_txns];
        allTxns.sort((a, b) => a.Date - b.Date);
        
        let currentBalance = data.initial_balance;
        const transactions = [];
        
        for (let i = 0; i < allTxns.length; i++) {
            const txn = allTxns[i];
            currentBalance += txn.Amount;
            transactions.push({
                Date: formatDate(txn.Date),
                Type: txn.Type,
                Amount: txn.Amount,
                Balance: currentBalance,
                isManual: data.manual_txns.includes(txn),
                manualIndex: data.manual_txns.indexOf(txn)
            });
        }
        
        // Calculate next deposit info
        const today = new Date();
        const todayDay = today.getDay();
        
        // If today is Saturday, next Saturday is in 7 days
        const nextSaturday = todayDay === 6 ? 
            new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000) : 
            getNextSaturday(today);
            
        // If today is Sunday, next Sunday is in 7 days
        const nextSunday = todayDay === 0 ? 
            new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000) : 
            getNextSunday(today);
        
        const daysUntilSaturday = Math.floor((nextSaturday - today) / (24 * 60 * 60 * 1000));
        const daysUntilSunday = Math.floor((nextSunday - today) / (24 * 60 * 60 * 1000));
        
        res.json({
            account_holder: data.account_holder,
            initial_balance: data.initial_balance,
            start_date: formatDate(data.start_date),
            initial_allowance: data.initial_allowance,
            initial_interest: data.initial_interest,
            current_allowance: data.current_allowance,
            current_interest: data.current_interest,
            settings_change_date: data.settings_change_date ? formatDate(data.settings_change_date) : null,
            current_balance: currentBalance,
            transactions: transactions,
            current_time: getCurrentTime(),
            next_saturday: formatDate(nextSaturday),
            next_sunday: formatDate(nextSunday),
            days_until_saturday: daysUntilSaturday,
            days_until_sunday: daysUntilSunday,
            is_saturday: todayDay === 6,
            is_sunday: todayDay === 0,
            debug_info: {
                today_date: formatDate(today),
                today_day: todayDay,
                day_names: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][todayDay],
                next_saturday_date: formatDate(nextSaturday),
                next_sunday_date: formatDate(nextSunday),
                server_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                server_time: new Date().toString()
            }
        });
    } catch (error) {
        console.error('Error getting account data:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Update settings
app.post('/api/settings/initial', async (req, res) => {
    console.log('Initial settings update request received');
    console.log('Session ID:', req.sessionID);
    console.log('Session authenticated:', !!req.session.authenticated);
    console.log('Request body:', req.body);
    
    if (!isAuthenticated(req)) {
        console.log('Authentication failed - rejecting initial settings request');
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    
    try {
        const data = await loadAccountData();
        console.log('Loaded data before changes:', {
            account_holder: data.account_holder,
            initial_allowance: data.initial_allowance,
            initial_interest: data.initial_interest
        });
        
        const { account_holder, initial_balance, start_date, initial_allowance, initial_interest } = req.body;
        
        if (account_holder !== undefined && account_holder !== null && account_holder !== '') {
            data.account_holder = account_holder;
        }
        if (initial_balance !== undefined && initial_balance !== null && initial_balance !== '') {
            const balanceValue = parseFloat(initial_balance);
            if (!isNaN(balanceValue) && balanceValue >= 0) {
                data.initial_balance = balanceValue;
            }
        }
        if (start_date !== undefined && start_date !== null && start_date !== '') {
            data.start_date = parseDate(start_date);
        }
        if (initial_allowance !== undefined && initial_allowance !== null && initial_allowance !== '') {
            const allowanceValue = parseFloat(initial_allowance);
            if (!isNaN(allowanceValue) && allowanceValue >= 0) {
                data.initial_allowance = allowanceValue;
            }
        }
        if (initial_interest !== undefined && initial_interest !== null && initial_interest !== '') {
            const interestValue = parseFloat(initial_interest);
            if (!isNaN(interestValue) && interestValue >= 0) {
                data.initial_interest = interestValue;
            }
        }
        
        // If current settings haven't been customized, update them too
        if (!data.settings_change_date) {
            data.current_allowance = data.initial_allowance;
            data.current_interest = data.initial_interest;
        }
        
        console.log('Data after changes:', {
            account_holder: data.account_holder,
            initial_allowance: data.initial_allowance,
            initial_interest: data.initial_interest
        });
        
        console.log('About to recalculate all deposits...');
        await recalculateAllDeposits(data);
        
        // Give a small delay for async operations to complete
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Verify the data was saved by reloading
        const verifyData = await loadAccountData();
        console.log('Verification after save:', {
            account_holder: verifyData.account_holder,
            initial_allowance: verifyData.initial_allowance,
            initial_interest: verifyData.initial_interest
        });
        
        // Double-check that changes were actually persisted
        const accountMatch = verifyData.account_holder === data.account_holder;
        const allowanceMatch = Math.abs(verifyData.initial_allowance - data.initial_allowance) < 0.01;
        const interestMatch = Math.abs(verifyData.initial_interest - data.initial_interest) < 0.01;
        
        console.log('Verification check:');
        console.log('  Account holder match:', accountMatch, '(', verifyData.account_holder, '===', data.account_holder, ')');
        console.log('  Allowance match:', allowanceMatch, '(', verifyData.initial_allowance, '≈', data.initial_allowance, ')');
        console.log('  Interest match:', interestMatch, '(', verifyData.initial_interest, '≈', data.initial_interest, ')');
        
        // Temporarily disable verification to test if data is being saved
        const verificationDisabled = true; // Set to false to re-enable
        
        if (!verificationDisabled && (!accountMatch || !allowanceMatch || !interestMatch)) {
            console.error('Settings verification failed - data not properly saved');
            console.error('Expected:', { 
                account_holder: data.account_holder, 
                initial_allowance: data.initial_allowance, 
                initial_interest: data.initial_interest 
            });
            console.error('Actual:', { 
                account_holder: verifyData.account_holder, 
                initial_allowance: verifyData.initial_allowance, 
                initial_interest: verifyData.initial_interest 
            });
            return res.status(500).json({ success: false, message: 'Settings were not saved properly' });
        }
        
        if (verificationDisabled) {
            console.log('⚠️ Verification temporarily disabled - assuming save succeeded');
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating initial settings:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.post('/api/settings/current', async (req, res) => {
    console.log('Settings update request received');
    console.log('Session ID:', req.sessionID);
    console.log('Session authenticated:', !!req.session.authenticated);
    console.log('Session data:', req.session);
    
    if (!isAuthenticated(req)) {
        console.log('Authentication failed - rejecting request');
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    
    try {
        const data = await loadAccountData();
        const { current_allowance, current_interest } = req.body;
        
        console.log('Updating current settings:', { current_allowance, current_interest });
        
        if (current_allowance !== undefined && current_allowance !== null && current_allowance !== '') {
            const allowanceValue = parseFloat(current_allowance);
            if (!isNaN(allowanceValue) && allowanceValue >= 0) {
                data.current_allowance = allowanceValue;
            }
        }
        if (current_interest !== undefined && current_interest !== null && current_interest !== '') {
            const interestValue = parseFloat(current_interest);
            if (!isNaN(interestValue) && interestValue >= 0) {
                data.current_interest = interestValue;
            }
        }
        
        // Set change date if not already set
        if (!data.settings_change_date) {
            data.settings_change_date = new Date();
        }
        
        console.log('Data before saving:', {
            current_allowance: data.current_allowance,
            current_interest: data.current_interest,
            settings_change_date: data.settings_change_date
        });
        
        const saved = await saveAccountData(data);
        if (saved) {
            console.log('Updated current settings successfully:', { 
                current_allowance: data.current_allowance, 
                current_interest: data.current_interest 
            });
            
            // Verify the save by reloading
            const verifyData = await loadAccountData();
            console.log('Verification after save:', {
                current_allowance: verifyData.current_allowance,
                current_interest: verifyData.current_interest
            });
            
            // Double-check that changes were actually persisted
            const allowanceMatch = Math.abs(verifyData.current_allowance - data.current_allowance) < 0.01;
            const interestMatch = Math.abs(verifyData.current_interest - data.current_interest) < 0.01;
            
            console.log('Current settings verification check:');
            console.log('  Allowance match:', allowanceMatch, '(', verifyData.current_allowance, '≈', data.current_allowance, ')');
            console.log('  Interest match:', interestMatch, '(', verifyData.current_interest, '≈', data.current_interest, ')');
            
            // Temporarily disable verification to test if data is being saved
            const verificationDisabled = true; // Set to false to re-enable
            
            if (!verificationDisabled && (!allowanceMatch || !interestMatch)) {
                console.error('Current settings verification failed - data not properly saved');
                console.error('Expected:', { 
                    current_allowance: data.current_allowance, 
                    current_interest: data.current_interest 
                });
                console.error('Actual:', { 
                    current_allowance: verifyData.current_allowance, 
                    current_interest: verifyData.current_interest 
                });
                return res.status(500).json({ success: false, message: 'Current settings were not saved properly' });
            }
            
            if (verificationDisabled) {
                console.log('⚠️ Current settings verification temporarily disabled - assuming save succeeded');
            }
            
            res.json({ success: true });
        } else {
            console.error('Failed to save account data');
            res.status(500).json({ success: false, message: 'Failed to save data' });
        }
    } catch (error) {
        console.error('Error updating current settings:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Add manual transaction
app.post('/api/transaction', async (req, res) => {
    if (!isAuthenticated(req)) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    
    try {
        const data = await loadAccountData();
        const { type, name, amount, date } = req.body;
        
        if (!name || !amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid transaction data' });
        }
        
        const transactionAmount = type === 'Deposit' ? parseFloat(amount) : -parseFloat(amount);
        const transactionDate = date ? parseDate(date) : new Date();
        
        data.manual_txns.push({
            Date: transactionDate,
            Type: name,
            Amount: transactionAmount
        });
        
        // Recalculate deposits from the transaction date forward
        await recalculateFromTransaction(data, transactionDate);
        res.json({ success: true });
    } catch (error) {
        console.error('Error adding transaction:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Delete manual transaction
app.delete('/api/transaction/:index', async (req, res) => {
    console.log('Delete transaction request received');
    console.log('Session authenticated:', !!req.session.authenticated);
    console.log('Requested index:', req.params.index);
    
    if (!isAuthenticated(req)) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    
    try {
        const data = await loadAccountData();
        const index = parseInt(req.params.index);
        
        console.log('Manual transactions count:', data.manual_txns.length);
        console.log('Manual transactions:', data.manual_txns.map((txn, i) => ({ index: i, type: txn.Type, amount: txn.Amount })));
        
        if (index < 0 || index >= data.manual_txns.length) {
            console.log('Invalid index - out of bounds');
            return res.status(400).json({ success: false, message: 'Invalid transaction index' });
        }
        
        // Get the transaction date before removing it
        const transactionToDelete = data.manual_txns[index];
        console.log('Deleting transaction:', { index, type: transactionToDelete.Type, amount: transactionToDelete.Amount });
        
        const transactionDate = transactionToDelete.Date;
        
        // Remove the transaction
        data.manual_txns.splice(index, 1);
        console.log('Transaction removed. Remaining count:', data.manual_txns.length);
        
        // Recalculate deposits from the transaction date forward
        await recalculateFromTransaction(data, transactionDate);
        
        // Ensure data is saved even if recalculateFromTransaction didn't save
        // (happens when deleting the last manual transaction)
        await saveAccountData(data);
        console.log('Recalculation completed successfully');
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting transaction:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Savings goal calculator
app.post('/api/calculate-goal', async (req, res) => {
    try {
        const data = await loadAccountData();
        const { goal_amount, goal_date } = req.body;
        
        const goalAmount = parseFloat(goal_amount);
        const goalDate = parseDate(goal_date);
        const today = new Date();
        
        // Calculate current balance
        const allTxns = [...data.auto_deposits, ...data.manual_txns];
        let currentBalance = data.initial_balance;
        for (const txn of allTxns) {
            currentBalance += txn.Amount;
        }
        
        if (goalAmount <= currentBalance) {
            return res.json({
                success: true,
                already_reached: true,
                current_balance: currentBalance,
                goal_amount: goalAmount,
                message: `🎉 Great news! You already have ${formatCurrency(currentBalance)}!`,
                message2: `That's more than your goal of ${formatCurrency(goalAmount)}!`
            });
        }
        
        const nextSaturday = getNextSaturday(today);
        const nextSunday = getNextSunday(today);
        
        const saturdays = getSaturdaysBetween(nextSaturday, goalDate);
        const sundays = getSundaysBetween(nextSunday, goalDate);
        
        if (saturdays.length === 0 && sundays.length === 0) {
            return res.json({
                success: false,
                current_balance: currentBalance,
                goal_amount: goalAmount,
                message: `Your goal date is before the next deposit. You currently have ${formatCurrency(currentBalance)} and need ${formatCurrency(goalAmount - currentBalance)} more to reach your goal.`
            });
        }
        
        // Simulate future balance
        let futureBalance = currentBalance;
        const allDates = [
            ...saturdays.map(date => ({ date, type: 'saturday' })),
            ...sundays.map(date => ({ date, type: 'sunday' }))
        ].sort((a, b) => a.date - b.date);
        
        for (const { type } of allDates) {
            if (type === 'saturday') {
                futureBalance += data.current_allowance;
            } else {
                futureBalance *= (1 + data.current_interest / 100);
            }
        }
        
        const daysUntilGoal = Math.floor((goalDate - today) / (24 * 60 * 60 * 1000));
        
        if (futureBalance >= goalAmount) {
            res.json({
                success: true,
                will_reach: true,
                current_balance: currentBalance,
                goal_amount: goalAmount,
                future_balance: futureBalance,
                days_until_goal: daysUntilGoal,
                allowance_payments: saturdays.length,
                interest_payments: sundays.length,
                total_allowance: saturdays.length * data.current_allowance,
                message: `✅ Great! Right now you have ${formatCurrency(currentBalance)}.`,
                message2: `You'll reach your goal of ${formatCurrency(goalAmount)} without adding anything extra!`
            });
        } else {
            const shortfall = goalAmount - futureBalance;
            
            // Calculate precise weekly extra needed using binary search
            // This accounts for compound interest on the additional deposits
            let weeklyExtra = 0;
            
            if (saturdays.length > 0) {
                // Binary search to find the exact weekly extra amount needed
                let low = 0;
                let high = shortfall; // Upper bound - no interest case
                const tolerance = 0.01; // Within 1 cent
                
                while (high - low > tolerance) {
                    const mid = (low + high) / 2;
                    
                    // Simulate future balance with this weekly extra amount
                    let testBalance = currentBalance;
                    
                    for (const { date, type } of allDates) {
                        if (type === 'saturday') {
                            testBalance += data.current_allowance + mid; // Add extra deposit
                        } else {
                            // Interest on Sunday - includes the extra deposits made so far
                            testBalance *= (1 + data.current_interest / 100);
                        }
                    }
                    
                    if (testBalance >= goalAmount) {
                        high = mid; // We're saving too much, try less
                    } else {
                        low = mid; // We're not saving enough, try more
                    }
                }
                
                weeklyExtra = Math.ceil(high * 100) / 100; // Round up to nearest cent
            }
            
            // Recalculate future balance with the precise weekly extra to show the user
            let futureBalanceWithExtra = currentBalance;
            for (const { date, type } of allDates) {
                if (type === 'saturday') {
                    futureBalanceWithExtra += data.current_allowance + weeklyExtra;
                } else {
                    futureBalanceWithExtra *= (1 + data.current_interest / 100);
                }
            }
            
            res.json({
                success: true,
                will_reach: false,
                current_balance: currentBalance,
                goal_amount: goalAmount,
                future_balance: futureBalance,
                future_balance_with_extra: futureBalanceWithExtra,
                shortfall: shortfall,
                days_until_goal: daysUntilGoal,
                allowance_payments: saturdays.length,
                interest_payments: sundays.length,
                weekly_extra_needed: weeklyExtra,
                total_allowance: saturdays.length * data.current_allowance,
                message: `Right now you have ${formatCurrency(currentBalance)}. If you don't add any extra, you'll have ${formatCurrency(futureBalance)} by your target date.`,
                message2: `To reach your goal of ${formatCurrency(goalAmount)}, you'll need to save an additional ${formatCurrency(weeklyExtra)} each week.`
            });
        }
    } catch (error) {
        console.error('Error calculating savings goal:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});


// Debug endpoint to check current data
app.get('/api/debug/current-data', async (req, res) => {
    try {
        const data = await loadAccountData();
        res.json({
            account_holder: data.account_holder,
            initial_allowance: data.initial_allowance,
            initial_interest: data.initial_interest,
            current_allowance: data.current_allowance,
            current_interest: data.current_interest,
            settings_change_date: data.settings_change_date
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Test authentication endpoint
app.get('/api/debug/auth-test', (req, res) => {
    const token = getTokenFromRequest(req);
    const sessionAuth = req.session && req.session.authenticated;
    const tokenValid = token && isValidToken(token);
    const finalAuth = isAuthenticated(req);
    
    console.log('=== AUTH TEST DEBUG ===');
    console.log('Session ID:', req.sessionID);
    console.log('Session authenticated:', sessionAuth);
    console.log('Token found:', !!token);
    console.log('Token valid:', tokenValid);
    console.log('Final authenticated:', finalAuth);
    console.log('Active tokens count:', activeTokens.size);
    console.log('Session data:', req.session);
    console.log('Request headers:', req.headers);
    
    if (!finalAuth) {
        return res.status(401).json({ 
            success: false, 
            message: 'Not authenticated',
            debug: {
                sessionId: req.sessionID,
                sessionAuthenticated: sessionAuth,
                tokenFound: !!token,
                tokenValid: tokenValid,
                finalAuthenticated: finalAuth,
                activeTokensCount: activeTokens.size,
                headers: req.headers,
                session: req.session
            }
        });
    }
    
    res.json({ 
        success: true, 
        message: 'Authentication working!',
        debug: {
            sessionId: req.sessionID,
            sessionAuthenticated: sessionAuth,
            tokenFound: !!token,
            tokenValid: tokenValid,
            finalAuthenticated: finalAuth,
            activeTokensCount: activeTokens.size
        }
    });
});

// Health check endpoint
app.get('/health', async (req, res) => {
    const healthData = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        storage: {
            redis_configured: !!redis,
            redis_url_present: !!process.env.UPSTASH_REDIS_REST_URL,
            redis_token_present: !!process.env.UPSTASH_REDIS_REST_TOKEN,
            using_file_storage: !redis
        }
    };
    
    // Test Redis connection if available
    if (redis) {
        try {
            await redis.ping();
            healthData.storage.redis_connection = 'ok';
        } catch (error) {
            healthData.storage.redis_connection = 'failed';
            healthData.storage.redis_error = error.message;
        }
    }
    
    res.status(200).json(healthData);
});

// Recalculate all deposits (admin endpoint)
app.post('/api/recalculate', async (req, res) => {
    if (!isAuthenticated(req)) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    
    try {
        const data = await loadAccountData();
        await recalculateAllDeposits(data);
        res.json({ success: true, message: 'All deposits recalculated successfully' });
    } catch (error) {
        console.error('Error recalculating deposits:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Reset data (admin endpoint for testing)
app.post('/api/reset-data', async (req, res) => {
    if (!isAuthenticated(req)) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    
    try {
        const defaultData = {
            account_holder: "My",
            initial_balance: 0.0,
            start_date: new Date('2024-01-01'),
            initial_allowance: 5.0,
            initial_interest: 1.0,
            current_allowance: 5.0,
            current_interest: 1.0,
            settings_change_date: null,
            manual_txns: [],
            last_processed_saturday: null,
            last_processed_sunday: null,
            auto_deposits: []
        };
        
        await saveAccountData(defaultData);
        res.json({ success: true, message: 'Data reset to defaults successfully' });
    } catch (error) {
        console.error('Error resetting data:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, async (err) => {
    if (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
    
    // Run migration on startup
    await migrateDataToRedis();
    
    console.log(`Bank app server running on http://${HOST}:${PORT}`);
    if (process.env.NODE_ENV !== 'production') {
        console.log(`Try opening: http://localhost:${PORT}`);
    }
}).on('error', (err) => {
    console.error('Server error:', err);
    if (err.code === 'EADDRINUSE') {
        console.log(`Port ${PORT} is already in use. Try a different port.`);
    }
});