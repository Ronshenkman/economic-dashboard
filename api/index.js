const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

// Path to dataflows structure JSON and local lookup cache
const DATAFLOWS_FILE = path.join(__dirname, 'dataflows.json');
const CACHE_FILE = process.env.VERCEL || process.env.NODE_ENV === 'production'
    ? '/tmp/series_dataflow_cache.json'
    : path.join(__dirname, 'series_dataflow_cache.json');

// Load dataflows
let dataflows = [];
try {
    dataflows = JSON.parse(fs.readFileSync(DATAFLOWS_FILE, 'utf8'));
} catch (err) {
    console.error('Failed to load dataflows.json:', err.message);
}

// Load or initialize lookup cache with defaults
let cache = {
    "DWH_SRC_0463_MA": { agencyID: "BOI.STATISTICS", dataflowID: "EZER" },
    "CLS11_S3_EX_C_MEDIUM_LOW_M_TREND": { agencyID: "BOI.STATISTICS", dataflowID: "FTR" },
    "CLS11_S3_EX_C_LOW_M_TREND": { agencyID: "BOI.STATISTICS", dataflowID: "FTR" }
};
try {
    if (fs.existsSync(CACHE_FILE)) {
        cache = { ...cache, ...JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) };
    } else {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    }
} catch (err) {
    console.error('Failed to load cache file:', err.message);
}

let mongoClient = null;
let db = null;
const MONGODB_URI = process.env.MONGODB_URI;

let clientPromise = null;

async function connectToMongoDB() {
    if (!MONGODB_URI) {
        console.warn("WARNING: MONGODB_URI environment variable is not defined. Active series will not persist.");
        return null;
    }
    
    if (db) return db;
    
    if (!clientPromise) {
        console.log("Connecting to MongoDB...");
        mongoClient = new MongoClient(MONGODB_URI, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000
        });
        clientPromise = mongoClient.connect().then(() => {
            db = mongoClient.db('economic_dashboard');
            console.log("Connected to MongoDB successfully!");
            return db;
        }).catch(err => {
            console.error("Failed to connect to MongoDB:", err.message);
            clientPromise = null;
            db = null;
            mongoClient = null;
            return null;
        });
    }
    return clientPromise;
}

// Load active series from MongoDB
async function loadSeriesFromMongoDB() {
    if (!db) return null;
    try {
        const collection = db.collection('settings');
        const doc = await collection.findOne({ _id: 'active_series' });
        return doc ? doc.list : [];
    } catch (err) {
        console.error("Failed to load series from MongoDB:", err.message);
        return null;
    }
}

// Save active series to MongoDB
async function saveSeriesToMongoDB(seriesList) {
    if (!db) return false;
    try {
        const collection = db.collection('settings');
        await collection.updateOne(
            { _id: 'active_series' },
            { $set: { list: seriesList, updatedAt: new Date() } },
            { upsert: true }
        );
        return true;
    } catch (err) {
        console.error("Failed to save series to MongoDB:", err.message);
        return false;
    }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Global active series state
let activeSeries = [];

// Initialize active series on startup
async function initActiveSeries() {
    await connectToMongoDB();
    
    if (db) {
        const loadedSeries = await loadSeriesFromMongoDB();
        if (loadedSeries !== null) {
            activeSeries = loadedSeries;
            console.log("Loaded active series from MongoDB:", activeSeries);
            return;
        }
    }
    
    activeSeries = [];
    console.log("Starting with empty active series list (MongoDB connection pending/failed).");
}

// Call init on startup
initActiveSeries();
// Simple CSV parser that handles double quotes
function parseCSV(csvText) {
    const lines = csvText.trim().split(/\r?\n/);
    if (lines.length === 0) return [];
    
    const parseLine = (line) => {
        const result = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current.trim());
        return result.map(val => val.replace(/^"|"$/g, '')); // Strip outer quotes
    };
    
    const headers = parseLine(lines[0]);
    const data = [];
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        const values = parseLine(lines[i]);
        const row = {};
        headers.forEach((header, index) => {
            row[header] = values[index] !== undefined ? values[index] : null;
        });
        data.push(row);
    }
    return data;
}

// Perform concurrent lookup across all dataflows to find a series
async function findDataflowForSeries(seriesCode) {
    const firstSegment = seriesCode.split('.')[0];
    
    // Check local in-memory cache first
    if (cache[firstSegment]) {
        return cache[firstSegment];
    }
    if (cache[seriesCode]) {
        return cache[seriesCode];
    }
    
    // Check MongoDB cache if connected (shared across serverless instances)
    if (db) {
        try {
            const collection = db.collection('dataflow_cache');
            const cached = await collection.findOne({ _id: firstSegment });
            if (cached) {
                cache[firstSegment] = { agencyID: cached.agencyID, dataflowID: cached.dataflowID };
                return cache[firstSegment];
            }
        } catch (err) {
            console.error("Failed to query dataflow_cache in MongoDB:", err.message);
        }
    }
    
    console.log(`Cache miss for series code: ${seriesCode}. Starting concurrent lookup...`);
    
    // We will test all dataflows concurrently
    // Limit concurrency to not overwhelm the system/network (e.g. max 15 concurrent requests)
    const batchSize = 15;
    for (let i = 0; i < dataflows.length; i += batchSize) {
        const batch = dataflows.slice(i, i + batchSize);
        const promises = batch.map(async (df) => {
            const baseUrl = `https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/${df.agencyID}/${df.id}/${df.version}`;
            
            // Try querying using the first segment as a path key (since it is the short SERIES_CODE)
            // Or the full seriesCode
            const urls = [
                `${baseUrl}/${firstSegment}?format=csv&lastNObservations=1`,
                `${baseUrl}/${seriesCode}?format=csv&lastNObservations=1`
            ];
            
            for (const url of urls) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 sec timeout
                    
                    const res = await fetch(url, { signal: controller.signal });
                    clearTimeout(timeoutId);
                    
                    if (res.ok) {
                        const text = await res.text();
                        const lines = text.trim().split('\n');
                        if (lines.length > 1) {
                            return { found: true, agencyID: df.agencyID, dataflowID: df.id };
                        }
                    }
                } catch (err) {
                    // Ignore error
                }
            }
            return { found: false };
        });
        
        const results = await Promise.all(promises);
        const hit = results.find(r => r.found);
        if (hit) {
            // Save to local cache
            cache[firstSegment] = { agencyID: hit.agencyID, dataflowID: hit.dataflowID };
            
            // Save to MongoDB cache if connected
            if (db) {
                try {
                    const collection = db.collection('dataflow_cache');
                    await collection.updateOne(
                        { _id: firstSegment },
                        { $set: { agencyID: hit.agencyID, dataflowID: hit.dataflowID, updatedAt: new Date() } },
                        { upsert: true }
                    );
                    console.log(`Saved series ${firstSegment} dataflow mapping to MongoDB cache.`);
                } catch (err) {
                    console.error("Failed to save dataflow mapping to MongoDB cache:", err.message);
                }
            }
            
            try {
                fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
            } catch (err) {
                console.error('Failed to write cache file:', err.message);
            }
            return cache[firstSegment];
        }
    }
    
    return null;
}

// API proxy endpoint to retrieve a series' data
app.get('/api/series', async (req, res) => {
    const { code, startPeriod, endPeriod } = req.query;
    if (!code) {
        return res.status(400).json({ error: 'Missing required query parameter: code' });
    }
    
    await connectToMongoDB();
    
    try {
        const flowInfo = await findDataflowForSeries(code);
        if (!flowInfo) {
            return res.status(404).json({ error: `Series code ${code} not found in any available dataflows.` });
        }
        
        // Construct the BOI SDMX URL
        // We query with labels=both, locale=he, bom=include to get Hebrew titles and descriptions
        let url = `https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/${flowInfo.agencyID}/${flowInfo.dataflowID}/1.0/${code}?format=csv&labels=both&locale=he&bom=include`;
        
        if (startPeriod) {
            url += `&startPeriod=${startPeriod}`;
        }
        if (endPeriod) {
            url += `&endPeriod=${endPeriod}`;
        }
        
        console.log(`Fetching BOI data from: ${url}`);
        const boiRes = await fetch(url);
        if (!boiRes.ok) {
            const errText = await boiRes.text();
            console.error(`BOI API returned error: ${boiRes.status} ${boiRes.statusText}`, errText);
            return res.status(boiRes.status).json({ error: `BOI API error: ${boiRes.statusText}` });
        }
        
        const csvText = await boiRes.text();
        const parsedData = parseCSV(csvText);
        
        if (parsedData.length === 0) {
            return res.json({
                seriesCode: code.split('.')[0],
                fullCode: code,
                dataflow: flowInfo.dataflowID,
                name: code,
                observations: []
            });
        }
        
        // Date normalization function to standard YYYY-MM-DD
        const normalizeDate = (dateStr) => {
            if (!dateStr) return null;
            dateStr = dateStr.trim();
            
            // YYYY-MM-DD
            if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                return dateStr;
            }
            
            // YYYY-MM
            if (/^\d{4}-\d{2}$/.test(dateStr)) {
                return `${dateStr}-01`;
            }
            
            // YYYY-MXX (e.g. 2026-M01)
            const mMatch = dateStr.match(/^(\d{4})-M(\d{2})$/i);
            if (mMatch) {
                return `${mMatch[1]}-${mMatch[2]}-01`;
            }
            
            // YYYY-QX (e.g. 2020-Q2)
            const qMatch = dateStr.match(/^(\d{4})-Q([1-4])$/i);
            if (qMatch) {
                const quarter = parseInt(qMatch[2]);
                const months = ["01", "04", "07", "10"];
                return `${qMatch[1]}-${months[quarter - 1]}-01`;
            }
            
            // YYYY
            if (/^\d{4}$/.test(dateStr)) {
                return `${dateStr}-01-01`;
            }
            
            return dateStr;
        };

        // Extract series descriptive metadata and format observations
        const firstRow = parsedData[0];
        
        // Attempt to find series title/name.
        // If labels=both is used, the SERIES_CODE column often has: "CODE - DESCRIPTION"
        let seriesName = code.split('.')[0];
        const rawCodeValue = firstRow['SERIES_CODE'] || firstRow['﻿SERIES_CODE'] || ''; // Handle potential BOM
        
        // We look for 'שם סדרה' (Hebrew for Series Name) or similar columns first, as they are most friendly
        if (firstRow['שם סדרה']) {
            seriesName = firstRow['שם סדרה'];
        } else if (firstRow['SERIES_NAME']) {
            seriesName = firstRow['SERIES_NAME'];
        } else if (rawCodeValue && rawCodeValue.includes(' - ')) {
            seriesName = rawCodeValue.split(' - ').slice(1).join(' - ').trim();
        } else if (firstRow['SHORT_TITLE']) {
            seriesName = firstRow['SHORT_TITLE'];
        }
        
        // Map observations
        const observations = parsedData
            .map(row => {
                const date = normalizeDate(row['TIME_PERIOD']);
                const valueStr = row['OBS_VALUE'];
                const value = valueStr !== null && valueStr !== undefined ? parseFloat(valueStr) : null;
                return { date, value };
            })
            .filter(obs => obs.date && obs.value !== null && !isNaN(obs.value))
            // Sort chronologically
            .sort((a, b) => new Date(a.date) - new Date(b.date));
            
        // Map other metadata fields from the first row (excluding date, value, and system fields)
        const metadata = {};
        Object.keys(firstRow).forEach(key => {
            const cleanKey = key.replace(/^\uFEFF/, ''); // Strip BOM
            if (!['TIME_PERIOD', 'OBS_VALUE', 'SERIES_CODE', 'TIME_FORMAT', 'RELEASE_STATUS'].includes(cleanKey)) {
                metadata[cleanKey] = firstRow[key];
            }
        });
        
        res.json({
            seriesCode: code.split('.')[0],
            fullCode: code,
            dataflow: flowInfo.dataflowID,
            name: seriesName,
            observations,
            metadata
        });
        
    } catch (err) {
        console.error(`Error handling /api/series:`, err.message);
        res.status(500).json({ error: `Internal Server Error: ${err.message}` });
    }
});

// Endpoint to list all dataflows for informational queries
app.get('/api/dataflows', (req, res) => {
    res.json(dataflows);
});

// Endpoint to fetch and parse all series under a specific dataflow (with cache)
app.get('/api/series-search', async (req, res) => {
    const { dataflowID, agencyID } = req.query;
    if (!dataflowID || !agencyID) {
        return res.status(400).json({ error: 'Missing required parameters: dataflowID, agencyID' });
    }
    
    const searchCacheDir = process.env.VERCEL || process.env.NODE_ENV === 'production'
        ? '/tmp/search_cache'
        : path.join(__dirname, 'search_cache');
    if (!fs.existsSync(searchCacheDir)) {
        try { fs.mkdirSync(searchCacheDir, { recursive: true }); } catch (e) {}
    }
    
    const cacheFilePath = path.join(searchCacheDir, `${dataflowID}.json`);
    if (fs.existsSync(cacheFilePath)) {
        try {
            const cachedData = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
            return res.json(cachedData);
        } catch (e) {
            // ignore and refetch
        }
    }
    
    try {
        const url = `https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/${agencyID}/${dataflowID}/1.0/*?format=csv&lastNObservations=1&labels=both&locale=he&bom=include`;
        console.log(`Fetching series list for ${dataflowID} from BOI API...`);
        
        const boiRes = await fetch(url);
        if (!boiRes.ok) {
            return res.status(boiRes.status).json({ error: `BOI API error: ${boiRes.statusText}` });
        }
        
        const csvText = await boiRes.text();
        const parsed = parseCSV(csvText);
        
        const list = parsed.map(row => {
            const keys = Object.keys(row);
            if (keys.length < 2) return null;
            
            // Handle BOM or clean keys
            const cleanKeys = keys.map(k => k.replace(/^\uFEFF/, ''));
            const codeKeyIdx = cleanKeys.indexOf('SERIES_CODE');
            
            let code = null;
            let name = null;
            
            if (codeKeyIdx !== -1) {
                code = row[keys[codeKeyIdx]];
                // Search for the name column
                const nameKeyIdx = cleanKeys.findIndex(k => k.includes('שם סדרה') || k.includes('NAME') || k.includes('TITLE') || k.includes('SHORT_TITLE'));
                if (nameKeyIdx !== -1) {
                    name = row[keys[nameKeyIdx]];
                } else {
                    name = row[keys[1]];
                }
            } else {
                code = row[keys[0]];
                name = row[keys[1]];
            }
            
            if (!code || !name) return null;
            
            // Extract metadata
            let freqKeyIdx = cleanKeys.indexOf('תדירות');
            if (freqKeyIdx === -1) freqKeyIdx = cleanKeys.indexOf('FREQ');
            let frequency = freqKeyIdx !== -1 ? row[keys[freqKeyIdx]] : null;
            
            if (frequency) {
                frequency = frequency.trim();
                const freqMap = {
                    'D': 'יומי',
                    'W': 'שבועי',
                    'M': 'חודשי',
                    'Q': 'רבעוני',
                    'A': 'שנתי'
                };
                frequency = freqMap[frequency] || frequency;
            }
            
            const dateKeyIdx = cleanKeys.indexOf('TIME_PERIOD');
            const lastDate = dateKeyIdx !== -1 ? row[keys[dateKeyIdx]] : null;
            
            let adjKeyIdx = cleanKeys.indexOf('ניכוי עונתיות');
            if (adjKeyIdx === -1) adjKeyIdx = cleanKeys.indexOf('ADJUSTMENT');
            let seasonalAdjustment = adjKeyIdx !== -1 ? row[keys[adjKeyIdx]] : null;
            
            if (seasonalAdjustment) {
                seasonalAdjustment = seasonalAdjustment.trim();
                if (seasonalAdjustment === '_Z') {
                    seasonalAdjustment = 'לא רלוונטי';
                } else {
                    const adjMap = {
                        'N': 'נתון מקורי',
                        'S': 'מנוכה עונתיות',
                        'T': 'מגמה',
                        'Y': 'מנוכה עונתיות'
                    };
                    seasonalAdjustment = adjMap[seasonalAdjustment] || seasonalAdjustment;
                }
            }
            
            return {
                code: code.trim(),
                name: name.trim(),
                frequency: frequency || 'לא ידוע',
                lastDate: lastDate ? lastDate.trim() : 'לא ידוע',
                seasonalAdjustment: seasonalAdjustment || 'לא רלוונטי'
            };
        }).filter(item => item !== null);
        
        // Remove duplicates if any
        const uniqueList = [];
        const seen = new Set();
        for (const item of list) {
            if (!seen.has(item.code)) {
                seen.add(item.code);
                uniqueList.push(item);
            }
        }
        
        // Save to cache
        try {
            fs.writeFileSync(cacheFilePath, JSON.stringify(uniqueList, null, 2));
        } catch (err) {
            console.error('Failed to write search cache file:', err.message);
        }
        
        res.json(uniqueList);
        
    } catch (err) {
        console.error(`Error handling /api/series-search:`, err.message);
        res.status(500).json({ error: `Internal Server Error: ${err.message}` });
    }
});

// Endpoint to get active series
app.get('/api/active-series', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    
    await connectToMongoDB();
    
    if (!db) {
        return res.status(500).json({ error: 'Database connection not established. Please define MONGODB_URI.' });
    }
    
    const loadedSeries = await loadSeriesFromMongoDB();
    if (loadedSeries !== null) {
        activeSeries = loadedSeries;
        res.json(activeSeries);
    } else {
        res.status(500).json({ error: 'Failed to retrieve active series from database' });
    }
});

// Endpoint to update active series
app.post('/api/active-series', async (req, res) => {
    const list = req.body;
    console.log("POST /api/active-series received:", JSON.stringify(list));
    
    if (!list || !Array.isArray(list)) {
        return res.status(400).json({ 
            success: false, 
            error: 'Body must be a JSON array of series. Received type: ' + (typeof list) 
        });
    }
    
    await connectToMongoDB();
    
    if (!db) {
        return res.status(500).json({ 
            success: false, 
            error: 'Database connection not established. Please define MONGODB_URI.' 
        });
    }
    
    activeSeries = list;
    
    const saved = await saveSeriesToMongoDB(activeSeries);
    if (saved) {
        console.log("Successfully saved", activeSeries.length, "series to MongoDB");
        res.json({ success: true, count: activeSeries.length });
    } else {
        console.error("Failed to save series to MongoDB");
        res.status(500).json({ 
            success: false, 
            error: 'Failed to persist to database.' 
        });
    }
});

if (process.env.NODE_ENV !== 'production' || require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}

module.exports = app;
