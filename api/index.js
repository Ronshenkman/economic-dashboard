const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

// A robust custom fetch function using Node's built-in https module
// Compatible with all Node.js versions and environments (including serverless)
function kvFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        try {
            const urlObj = new URL(url);
            const reqOptions = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: options.method || 'GET',
                headers: options.headers || {}
            };
            
            // Set standard headers for proxy compatibility
            if (!reqOptions.headers['User-Agent']) {
                reqOptions.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
            }
            
            if (reqOptions.method === 'POST' || reqOptions.method === 'PUT') {
                if (options.body) {
                    reqOptions.headers['Content-Length'] = Buffer.byteLength(options.body);
                } else {
                    reqOptions.headers['Content-Length'] = '0';
                }
            }
            
            const timeout = options.timeout || 8000;
            
            const req = https.request(reqOptions, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode,
                        text: () => Promise.resolve(data)
                    });
                });
            });
            
            req.on('error', (err) => {
                reject(err);
            });
            
            req.setTimeout(timeout, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            
            if (options.body) {
                req.write(options.body);
            }
            req.end();
        } catch (err) {
            reject(err);
        }
    });
}

const app = express();
const PORT = process.env.PORT || 3000;

// Path to dataflows structure JSON and local lookup cache
const DATAFLOWS_FILE = path.join(__dirname, 'dataflows.json');
const CACHE_FILE = path.join(__dirname, 'series_dataflow_cache.json');

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

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Global active series state
// Uses multi-key approach on keyvalue.immanuel.co to avoid URL length limits:
//   Key "n" -> count of series (hex encoded number string)
//   Key "sN" -> "CODE:RANGE" for series index N (hex encoded)
const KV_APP_KEY = "econ_dash_ronshenkman_v6"; // Unique app key

let activeSeries = [];

// Helper: decode a raw KV response string (strips quotes, decodes hex)
function decodeKvValue(rawText) {
    let text = rawText.trim();
    if (text.startsWith('"') && text.endsWith('"')) {
        text = text.slice(1, -1);
    }
    if (!text) return null;
    return Buffer.from(text, 'hex').toString('utf8');
}

// Load all active series from multi-key KV store
async function loadSeriesFromKV() {
    try {
        // Step 1: Get count
        const countUrl = `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${KV_APP_KEY}/n`;
        const countRes = await kvFetch(countUrl, { timeout: 8000 });
        if (!countRes.ok) return null;
        const countText = await countRes.text();
        const countDecoded = decodeKvValue(countText);
        if (!countDecoded) return [];
        const count = parseInt(countDecoded);
        if (isNaN(count) || count < 0) return [];
        if (count === 0) return [];
        
        // Step 2: Load all series in parallel
        const promises = Array.from({ length: count }, (_, i) => {
            const url = `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${KV_APP_KEY}/s${i}`;
            return kvFetch(url, { timeout: 8000 }).then(async res => {
                if (!res.ok) return null;
                const text = await res.text();
                const decoded = decodeKvValue(text);
                if (!decoded) return null;
                const colonIdx = decoded.indexOf(':');
                if (colonIdx === -1) return null;
                const code = decoded.substring(0, colonIdx);
                const range = decoded.substring(colonIdx + 1);
                return { code, range };
            }).catch(() => null);
        });
        
        const results = await Promise.all(promises);
        return results.filter(Boolean);
    } catch (err) {
        console.error("Failed to load series from KV store:", err.message);
        return null;
    }
}

// Save all active series to multi-key KV store
async function saveSeriestoKV(seriesList) {
    try {
        // Save count first
        const countHex = Buffer.from(String(seriesList.length), 'utf8').toString('hex');
        const countUrl = `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${KV_APP_KEY}/n/${countHex}`;
        const countRes = await kvFetch(countUrl, { method: 'POST', timeout: 8000 });
        if (!countRes.ok) {
            const t = await countRes.text();
            console.error('Failed to save count to KV:', countRes.status, t.substring(0, 100));
            return false;
        }
        
        // Save each series in parallel
        const savePromises = seriesList.map((s, i) => {
            const value = `${s.code}:${s.range}`;
            const valueHex = Buffer.from(value, 'utf8').toString('hex');
            const url = `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${KV_APP_KEY}/s${i}/${valueHex}`;
            return kvFetch(url, { method: 'POST', timeout: 8000 }).then(async res => {
                if (!res.ok) {
                    const t = await res.text();
                    console.error(`Failed to save series ${i} (${s.code}):`, res.status, t.substring(0, 100));
                    return false;
                }
                return true;
            }).catch(err => {
                console.error(`Error saving series ${i} (${s.code}):`, err.message);
                return false;
            });
        });
        
        const results = await Promise.all(savePromises);
        const allOk = results.every(Boolean);
        if (!allOk) {
            console.error('Some series failed to save to KV store');
        }
        return allOk;
    } catch (err) {
        console.error("Failed to save series to KV store:", err.message);
        return false;
    }
}

// Initialize active series on startup
async function initActiveSeries() {
    const kvSeries = await loadSeriesFromKV();
    if (kvSeries !== null && kvSeries.length >= 0) {
        activeSeries = kvSeries;
        console.log("Loaded active series from KV store:", activeSeries);
    } else {
        activeSeries = [];
        console.log("Starting with empty active series list.");
    }
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
    
    // Check cache first
    if (cache[firstSegment]) {
        return cache[firstSegment];
    }
    if (cache[seriesCode]) {
        return cache[seriesCode];
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
            // Save to cache
            cache[firstSegment] = { agencyID: hit.agencyID, dataflowID: hit.dataflowID };
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
    
    const searchCacheDir = path.join(__dirname, 'search_cache');
    if (!fs.existsSync(searchCacheDir)) {
        try { fs.mkdirSync(searchCacheDir); } catch (e) {}
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
    
    // Always fetch fresh from KV store
    const kvSeries = await loadSeriesFromKV();
    if (kvSeries !== null) {
        activeSeries = kvSeries;
    }
    // else: use in-memory cached value
    
    res.json(activeSeries);
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
    
    activeSeries = list;
    
    // Save to KV store using multi-key approach
    const kvSaved = await saveSeriestoKV(activeSeries);
    
    if (kvSaved) {
        console.log("Successfully saved", activeSeries.length, "series to KV store");
        res.json({ success: true, count: activeSeries.length });
    } else {
        console.error("Failed to save series to KV store");
        // Still return success if we have in-memory state (best effort)
        res.status(500).json({ 
            success: false, 
            error: 'Failed to persist to KV store. Changes are in-memory only until next save.' 
        });
    }
});

if (process.env.NODE_ENV !== 'production' || require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}

module.exports = app;
