const express = require('express');
const fs = require('fs');
const path = require('path');

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

// Global active series state file and key
const ACTIVE_SERIES_FILE = path.join(__dirname, 'active_series.json');
const KV_APP_KEY = "econ_dash_ronshenkman_active_series_v2"; // Unique key for the user
const KV_KEY = "active_series";

let activeSeries = [];

// Initialize active series
async function initActiveSeries() {
    // 1. Try loading from keyvalue.immanuel.co
    try {
        const getUrl = `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${KV_APP_KEY}/${KV_KEY}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 sec timeout
        const res = await fetch(getUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (res.ok) {
            let text = await res.text();
            text = text.trim();
            if (text.startsWith('"') && text.endsWith('"')) {
                text = text.slice(1, -1);
            }
            if (text) {
                const decoded = Buffer.from(text, 'hex').toString('utf8');
                activeSeries = JSON.parse(decoded);
                console.log("Loaded active series from KV store:", activeSeries);
                return;
            }
        }
    } catch (err) {
        console.error("Failed to load active series from KV store, trying local file:", err.message);
    }
    
    // 2. Try loading from local file
    try {
        if (fs.existsSync(ACTIVE_SERIES_FILE)) {
            activeSeries = JSON.parse(fs.readFileSync(ACTIVE_SERIES_FILE, 'utf8'));
            console.log("Loaded active series from local file:", activeSeries);
            return;
        }
    } catch (err) {
        console.error("Failed to load active series from local file:", err.message);
    }
    
    // Default to empty array
    activeSeries = [];
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
            
            return {
                code: code.trim(),
                name: name.trim()
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
    try {
        const getUrl = `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${KV_APP_KEY}/${KV_KEY}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const kvRes = await fetch(getUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (kvRes.ok) {
            let text = await kvRes.text();
            text = text.trim();
            if (text.startsWith('"') && text.endsWith('"')) {
                text = text.slice(1, -1);
            }
            if (text) {
                const decoded = Buffer.from(text, 'hex').toString('utf8');
                activeSeries = JSON.parse(decoded);
            }
        }
    } catch (err) {
        console.error("Failed to update active series from KV store in GET, using cached:", err.message);
    }
    res.json(activeSeries);
});

// Endpoint to update active series
app.post('/api/active-series', async (req, res) => {
    const list = req.body;
    if (!Array.isArray(list)) {
        return res.status(400).json({ error: 'Body must be a JSON array of series' });
    }
    
    activeSeries = list;
    
    // 1. Save to KV store
    let kvSaved = false;
    try {
        const hexData = Buffer.from(JSON.stringify(activeSeries), 'utf8').toString('hex');
        const updateUrl = `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${KV_APP_KEY}/${KV_KEY}/${hexData}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const kvRes = await fetch(updateUrl, { method: 'POST', signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (kvRes.ok) {
            const resp = await kvRes.text();
            if (resp.trim() === 'true') {
                kvSaved = true;
            }
        }
    } catch (err) {
        console.error("Failed to save active series to KV store:", err.message);
    }
    
    // 2. Save to local file (fails gracefully on read-only filesystem)
    let fileSaved = false;
    try {
        fs.writeFileSync(ACTIVE_SERIES_FILE, JSON.stringify(activeSeries, null, 2));
        fileSaved = true;
    } catch (err) {
        console.log("Local file write skipped or failed (expected on serverless):", err.message);
    }
    
    res.json({ success: true, kvSaved, fileSaved });
});

if (process.env.NODE_ENV !== 'production' || require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}

module.exports = app;
