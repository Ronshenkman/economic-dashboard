// Dashboard State Management
const STATE = {
    // Default series codes requested by user
    defaultSeries: [],
    // Currently active series objects: { code, range }
    activeSeries: [],
    // Map of fullCode -> Chart.js instance
    charts: {},
    // Cache of retrieved series data
    dataCache: {}
};

// Colors for graphs - cycled through for newly added graphs
const CHART_COLORS = [
    { border: '#06b6d4', fill: 'rgba(6, 182, 212, 0.05)', glow: 'rgba(6, 182, 212, 0.3)' }, // Cyan
    { border: '#8b5cf6', fill: 'rgba(139, 92, 246, 0.05)', glow: 'rgba(139, 92, 246, 0.3)' }, // Purple
    { border: '#3b82f6', fill: 'rgba(59, 130, 246, 0.05)', glow: 'rgba(59, 130, 246, 0.3)' }, // Blue
    { border: '#ec4899', fill: 'rgba(236, 72, 153, 0.05)', glow: 'rgba(236, 72, 153, 0.3)' }  // Pink
];

// Initialize application
document.addEventListener('DOMContentLoaded', async () => {
    await initLocalState();
    setupEventListeners();
    setupSearchUI();
    refreshDashboard();
});

// Helper to convert any series code string to a safe CSS selector ID
function getSafeId(code) {
    return code.replace(/[^a-zA-Z0-9]/g, '_');
}

// Helper to normalize activeSeries elements into standard { code, range } objects
function getActiveSeriesObjects() {
    return STATE.activeSeries.map(item => {
        if (typeof item === 'string') {
            return { code: item, range: '5y' };
        }
        return item;
    });
}

// Load active series from server or fallback to defaults/localStorage
async function initLocalState() {
    try {
        const res = await fetch('/api/active-series');
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) {
                STATE.activeSeries = data;
                localStorage.setItem('economic_dashboard_series_v2', JSON.stringify(STATE.activeSeries));
                return;
            }
        }
    } catch (e) {
        console.warn('Failed to load active series from server, using localStorage:', e);
    }

    const saved = localStorage.getItem('economic_dashboard_series_v2');
    if (saved) {
        try {
            STATE.activeSeries = JSON.parse(saved);
        } catch (e) {
            setDefaultActiveSeries();
        }
    } else {
        setDefaultActiveSeries();
    }
}

function setDefaultActiveSeries() {
    STATE.activeSeries = STATE.defaultSeries.map(code => ({
        code,
        range: "5y"
    }));
}

// Save active series list to localStorage and sync with server
function saveStateToLocal() {
    localStorage.setItem('economic_dashboard_series_v2', JSON.stringify(STATE.activeSeries));
    
    // Sync with server in background
    fetch('/api/active-series', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(STATE.activeSeries)
    }).catch(err => {
        console.error("Failed to save active series to server:", err);
    });
}

// Setup elements and listeners
function setupEventListeners() {
    const rangeSelect = document.getElementById('date-range-select');
    const customPickers = document.getElementById('custom-date-pickers');
    const btnRefresh = document.getElementById('btn-refresh');
    const addForm = document.getElementById('add-series-form');
    
    // Quick range selector change (global control)
    rangeSelect.addEventListener('change', (e) => {
        if (e.target.value === 'custom') {
            customPickers.classList.remove('hidden');
            const today = new Date();
            const start = new Date();
            start.setFullYear(today.getFullYear() - 5);
            document.getElementById('start-date-input').value = formatDateForInput(start);
            document.getElementById('end-date-input').value = formatDateForInput(today);
        } else {
            customPickers.classList.add('hidden');
            const globalRange = e.target.value;
            // Sync all active series to the global selection
            STATE.activeSeries = getActiveSeriesObjects().map(s => ({
                ...s,
                range: globalRange
            }));
            saveStateToLocal();
            refreshDashboard();
        }
    });

    // Custom date pickers change
    document.getElementById('start-date-input').addEventListener('change', refreshDashboard);
    document.getElementById('end-date-input').addEventListener('change', refreshDashboard);

    // Refresh button click
    btnRefresh.addEventListener('click', async () => {
        const icon = btnRefresh.querySelector('i');
        icon.classList.add('spin-animation');
        try {
            await initLocalState(); // Sync latest active series from server
        } catch (e) {
            console.error("Failed to sync active series on refresh:", e);
        }
        refreshDashboard().finally(() => {
            setTimeout(() => icon.classList.remove('spin-animation'), 600);
        });
    });

    // Add series form submit
    addForm.addEventListener('submit', handleAddSeries);

    // Sidebar management toggle buttons
    const btnOpenSidebar = document.getElementById('btn-open-sidebar');
    const btnCloseSidebar = document.getElementById('btn-close-sidebar');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    const sidebarOrder = document.getElementById('sidebar-order');

    if (btnOpenSidebar && btnCloseSidebar && sidebarOverlay && sidebarOrder) {
        btnOpenSidebar.addEventListener('click', () => {
            sidebarOverlay.classList.remove('hidden');
            sidebarOrder.classList.remove('hidden');
            // Allow DOM to update before transition class
            setTimeout(() => sidebarOrder.classList.add('active'), 10);
            renderSidebarSeriesList();
        });

        const closeSidebarFn = () => {
            sidebarOrder.classList.remove('active');
            sidebarOverlay.classList.add('hidden');
            // Hide after slide-out transition
            setTimeout(() => {
                if (!sidebarOrder.classList.contains('active')) {
                    sidebarOrder.classList.add('hidden');
                }
            }, 300);
        };

        btnCloseSidebar.addEventListener('click', closeSidebarFn);
        sidebarOverlay.addEventListener('click', closeSidebarFn);
    }
}

// Calculate startPeriod and endPeriod based on selected filters (or custom picker override)
function calculateDateParamsForRange(rangeVal) {
    const globalSelect = document.getElementById('date-range-select').value;
    const params = { startPeriod: null, endPeriod: null };
    const today = new Date();
    
    // Custom picker override (acts globally)
    if (globalSelect === 'custom') {
        const startVal = document.getElementById('start-date-input').value;
        const endVal = document.getElementById('end-date-input').value;
        if (startVal) params.startPeriod = startVal;
        if (endVal) params.endPeriod = endVal;
        return params;
    }
    
    if (rangeVal !== 'all') {
        const yearsToSubtract = parseInt(rangeVal);
        const startDate = new Date();
        startDate.setFullYear(today.getFullYear() - yearsToSubtract);
        params.startPeriod = formatDateForInput(startDate);
        params.endPeriod = formatDateForInput(today);
    }
    
    return params;
}

// Format Date object to YYYY-MM-DD for form inputs and API
function formatDateForInput(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

// Refresh the entire dashboard view
async function refreshDashboard() {
    const grid = document.getElementById('dashboard-grid');
    const loader = document.getElementById('grid-loading-indicator');
    
    loader.classList.remove('hidden');
    
    // Clear old charts to prevent memory leaks
    Object.values(STATE.charts).forEach(chart => chart.destroy());
    STATE.charts = {};
    
    // Remove all old cards
    const oldCards = grid.querySelectorAll('.card-indicator');
    oldCards.forEach(card => card.remove());

    const activeObjects = getActiveSeriesObjects();

    if (activeObjects.length === 0) {
        loader.classList.add('hidden');
        grid.insertAdjacentHTML('beforeend', `
            <div class="grid-loading" id="empty-state">
                <i data-lucide="info" style="width: 48px; height: 48px;"></i>
                <p>אין סדרות מוצגות בדשבורד. הזן קוד סדרה למעלה כדי להציג מידע.</p>
            </div>
        `);
        lucide.createIcons();
        return;
    }

    // Fetch all active series in parallel, each with its own local range
    const fetchPromises = activeObjects.map(s => {
        const { startPeriod, endPeriod } = calculateDateParamsForRange(s.range);
        return fetchSeriesData(s.code, startPeriod, endPeriod)
            .then(data => ({ code: s.code, range: s.range, data, error: null }))
            .catch(err => ({ code: s.code, range: s.range, data: null, error: err.message }));
    });
    
    const results = await Promise.all(fetchPromises);
    loader.classList.add('hidden');
    
    // Render each card
    results.forEach((result, index) => {
        if (result.error) {
            renderErrorCard(result.code, result.error);
        } else if (result.data) {
            result.data.range = result.range;
            // Cache retrieved data for offline CSV downloads
            STATE.dataCache[result.code] = result.data;
            renderCard(result.data, index);
        }
    });

    lucide.createIcons();
}

// Fetch single series data from local proxy server
async function fetchSeriesData(code, startPeriod, endPeriod) {
    let url = `/api/series?code=${encodeURIComponent(code)}`;
    if (startPeriod) url += `&startPeriod=${startPeriod}`;
    if (endPeriod) url += `&endPeriod=${endPeriod}`;
    
    const res = await fetch(url);
    if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || `HTTP ${res.status}`);
    }
    
    return await res.json();
}

// Refresh only a single card on local date selector changes
async function refreshSingleCard(code) {
    const safeId = getSafeId(code);
    const cardEl = document.getElementById(`card-${safeId}`);
    if (!cardEl) return;
    
    cardEl.classList.add('loading');
    
    const seriesObj = getActiveSeriesObjects().find(s => s.code === code) || { range: '5y' };
    const { startPeriod, endPeriod } = calculateDateParamsForRange(seriesObj.range);
    
    try {
        const data = await fetchSeriesData(code, startPeriod, endPeriod);
        
        // Save in cache
        STATE.dataCache[code] = data;
        
        // Destroy old chart
        if (STATE.charts[code]) {
            STATE.charts[code].destroy();
        }
        
        // Get scheme color
        const index = getActiveSeriesObjects().findIndex(s => s.code === code);
        const colorScheme = CHART_COLORS[index % CHART_COLORS.length];
        
        // Render updated chart
        renderChart(data, colorScheme);
        
        // Update metadata details table content
        const tableBody = cardEl.querySelector('.metadata-table tbody');
        if (tableBody) {
            tableBody.innerHTML = `
                <tr>
                    <th>קוד סדרה</th>
                    <td><span class="card-code">${data.fullCode}</span></td>
                </tr>
                <tr>
                    <th>עולם תוכן (Dataflow)</th>
                    <td>${data.dataflow}</td>
                </tr>
                ${Object.entries(data.metadata).map(([key, value]) => `
                    <tr>
                        <th>${translateMetadataKey(key)}</th>
                        <td>${value}</td>
                    </tr>
                `).join('')}
            `;
        }
        
        // Update Title if it changed
        const titleEl = cardEl.querySelector('.card-title');
        if (titleEl) titleEl.textContent = data.name;
        
    } catch (err) {
        console.error(`Failed to refresh card ${code}:`, err.message);
    } finally {
        cardEl.classList.remove('loading');
    }
}

// Render dynamic card and chart for a successful series retrieval
function renderCard(series, index) {
    const grid = document.getElementById('dashboard-grid');
    const colorScheme = CHART_COLORS[index % CHART_COLORS.length];
    const safeId = getSafeId(series.fullCode);
    
    // Construct HTML template (hiding code in header and putting inside metadata list)
    const cardHtml = `
        <article class="card-indicator card-${safeId}" id="card-${safeId}" aria-labelledby="title-${safeId}">
            <div class="card-header">
                <div class="card-title-wrap">
                    <h3 class="card-title" id="title-${safeId}">${series.name}</h3>
                </div>
                <div class="card-actions">
                    <select class="card-range-select" data-code="${series.fullCode}" title="שנה טווח זמן לגרף זה">
                        <option value="1y" ${series.range === '1y' ? 'selected' : ''}>שנה</option>
                        <option value="3y" ${series.range === '3y' ? 'selected' : ''}>3 שנים</option>
                        <option value="5y" ${series.range === '5y' ? 'selected' : ''}>5 שנים</option>
                        <option value="10y" ${series.range === '10y' ? 'selected' : ''}>10 שנים</option>
                        <option value="all" ${series.range === 'all' ? 'selected' : ''}>הכל</option>
                    </select>
                    <button class="btn-icon-only btn-download" data-code="${series.fullCode}" title="הורד נתונים כ-CSV">
                        <i data-lucide="download"></i>
                    </button>
                    <button class="btn-icon-only btn-remove" data-code="${series.fullCode}" title="הסר מהדשבורד">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
            </div>
            
            <div class="chart-container">
                <canvas id="chart-canvas-${safeId}"></canvas>
            </div>
            
            <div class="card-details">
                <button class="btn-details-toggle" aria-expanded="false" data-target="details-${safeId}">
                    <i data-lucide="chevron-down"></i>
                    <span>הצג מטה-דטה של הסדרה</span>
                </button>
                <div class="details-content" id="details-${safeId}">
                    <table class="metadata-table">
                        <tbody>
                            <tr>
                                <th>קוד סדרה</th>
                                <td><span class="card-code">${series.fullCode}</span></td>
                            </tr>
                            <tr>
                                <th>עולם תוכן (Dataflow)</th>
                                <td>${series.dataflow}</td>
                            </tr>
                            ${Object.entries(series.metadata).map(([key, value]) => `
                                <tr>
                                    <th>${translateMetadataKey(key)}</th>
                                    <td>${value}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </article>
    `;
    
    grid.insertAdjacentHTML('beforeend', cardHtml);
    
    const cardEl = document.getElementById(`card-${safeId}`);
    
    // Bind Details Accordion Toggle
    const toggleBtn = cardEl.querySelector('.btn-details-toggle');
    const detailsDiv = cardEl.querySelector('.details-content');
    toggleBtn.addEventListener('click', () => {
        const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
        toggleBtn.setAttribute('aria-expanded', !expanded);
        toggleBtn.classList.toggle('expanded');
        detailsDiv.classList.toggle('expanded');
    });
    
    // Bind Download CSV button
    cardEl.querySelector('.btn-download').addEventListener('click', (e) => {
        const code = e.currentTarget.getAttribute('data-code');
        downloadSeriesCSV(code);
    });
    
    // Bind Remove button
    cardEl.querySelector('.btn-remove').addEventListener('click', (e) => {
        const code = e.currentTarget.getAttribute('data-code');
        removeSeries(code);
    });
    
    // Bind Local Range Dropdown Selector
    const localSelect = cardEl.querySelector('.card-range-select');
    localSelect.addEventListener('change', async (e) => {
        const newRange = e.target.value;
        const code = e.target.getAttribute('data-code');
        
        // Update range for this specific series
        STATE.activeSeries = getActiveSeriesObjects().map(s => {
            if (s.code === code) {
                return { ...s, range: newRange };
            }
            return s;
        });
        saveStateToLocal();
        
        await refreshSingleCard(code);
    });
    
    // Render Chart.js Graph
    renderChart(series, colorScheme);
}

// Render chart using Chart.js on the canvas
function renderChart(series, colorScheme) {
    const safeId = getSafeId(series.fullCode);
    const canvasId = `chart-canvas-${safeId}`;
    const ctx = document.getElementById(canvasId).getContext('2d');
    
    const dates = series.observations.map(o => o.date);
    const values = series.observations.map(o => o.value);
    
    const chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dates,
            datasets: [{
                label: series.name,
                data: values,
                borderColor: colorScheme.border,
                backgroundColor: colorScheme.fill,
                borderWidth: 2.5,
                tension: 0.2,
                pointRadius: values.length > 150 ? 0 : 2.5,
                pointHoverRadius: 6,
                pointBackgroundColor: colorScheme.border,
                pointBorderColor: '#0b0f19',
                pointBorderWidth: 1.5,
                fill: true,
                shadowColor: colorScheme.glow,
                shadowBlur: 10
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: '#121826',
                    titleColor: '#9ca3af',
                    bodyColor: '#f3f4f6',
                    borderColor: 'rgba(255, 255, 255, 0.08)',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: false,
                    rtl: true,
                    titleFont: {
                        family: 'Outfit, Assistant',
                        size: 11
                    },
                    bodyFont: {
                        family: 'Outfit, Assistant',
                        size: 13,
                        weight: 'bold'
                    },
                    callbacks: {
                        title: (tooltipItems) => {
                            return tooltipItems[0].label;
                        },
                        label: (context) => {
                            const unit = series.metadata['UNIT_MEASURE'] || '';
                            let formattedVal = context.raw.toLocaleString();
                            return `${formattedVal} ${unit}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        parser: 'yyyy-MM-dd',
                        tooltipFormat: 'dd/MM/yyyy',
                        displayFormats: {
                            day: 'dd/MM/yy',
                            month: 'MM/yyyy',
                            quarter: 'QQ/yyyy',
                            year: 'yyyy'
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.03)',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#9ca3af',
                        font: {
                            family: 'Outfit, Assistant',
                            size: 10
                        }
                    }
                },
                y: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.04)',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#9ca3af',
                        font: {
                            family: 'Outfit, Assistant',
                            size: 10
                        },
                        callback: function(value) {
                            return value.toLocaleString();
                        }
                    }
                }
            }
        }
    });
    
    STATE.charts[series.fullCode] = chart;
}

// Generate and trigger download of series data as CSV with Excel UTF-8 BOM
function downloadSeriesCSV(code) {
    const series = STATE.dataCache[code];
    if (!series || !series.observations || series.observations.length === 0) {
        alert("אין נתונים זמינים להורדה עבור סדרה זו.");
        return;
    }
    
    // Add BOM (\uFEFF) to make sure Excel opens Hebrew correctly
    let csvContent = "\uFEFF";
    csvContent += `"תאריך","ערך"\n`;
    
    series.observations.forEach(obs => {
        csvContent += `"${obs.date}",${obs.value}\n`;
    });
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    
    // Create clean file name based on series name
    const safeName = series.name.replace(/[^a-zA-Z0-9א-ת\s-_]/g, '').trim();
    link.setAttribute("download", `${safeName || 'data'}.csv`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Render error state for a card
function renderErrorCard(code, errorMessage) {
    const grid = document.getElementById('dashboard-grid');
    const safeId = getSafeId(code);
    
    const cardHtml = `
        <article class="card-indicator error-card" id="card-${safeId}">
            <div class="card-header">
                <div class="card-title-wrap">
                    <h3 class="card-title text-danger">שגיאה בטעינת הסדרה</h3>
                </div>
                <div class="card-actions">
                    <button class="btn-icon-only btn-remove" data-code="${code}" title="הסר מהדשבורד">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
            </div>
            <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 0.75rem; color: #fca5a5; padding: 2rem; background: rgba(239, 68, 68, 0.03); border-radius: var(--border-radius-md); border: 1px dashed rgba(239, 68, 68, 0.2);">
                <i data-lucide="alert-triangle" style="width: 36px; height: 36px;"></i>
                <p style="font-size: 0.9rem; text-align: center;">${errorMessage}</p>
                <p style="font-size: 0.75rem; font-family: var(--font-numeric); opacity: 0.75;">${code}</p>
            </div>
        </article>
    `;
    
    grid.insertAdjacentHTML('beforeend', cardHtml);
    
    document.getElementById(`card-${safeId}`).querySelector('.btn-remove').addEventListener('click', (e) => {
        const code = e.currentTarget.getAttribute('data-code');
        removeSeries(code);
    });
}

// Handle submission of a new series code to add to dashboard
async function handleAddSeries(e) {
    e.preventDefault();
    
    const input = document.getElementById('series-code-input');
    const btn = document.getElementById('btn-submit-series');
    const spinner = document.getElementById('submit-spinner');
    const errorMsg = document.getElementById('form-error-msg');
    
    const code = input.value.trim();
    if (!code) return;
    
    const activeObjects = getActiveSeriesObjects();
    
    // Check if already active
    if (activeObjects.some(s => s.code === code)) {
        showFormError("הסדרה הזו כבר קיימת בדשבורד שלך.");
        return;
    }
    
    // Show spinner
    btn.disabled = true;
    spinner.classList.remove('hidden');
    errorMsg.classList.add('hidden');
    
    try {
        const { startPeriod, endPeriod } = calculateDateParamsForRange("5y"); // Default to 5y on add
        const data = await fetchSeriesData(code, startPeriod, endPeriod);
        
        // Success! Add to state
        STATE.activeSeries.push({ code, range: "5y" });
        saveStateToLocal();
        
        await refreshDashboard();
        
        // Update sidebar if it is open/rendered
        const sidebarList = document.getElementById('sidebar-series-list');
        if (sidebarList) {
            renderSidebarSeriesList();
        }
        
        input.value = '';
    } catch (err) {
        showFormError(`קוד סדרה לא נמצא או שגיאה בקבלת הנתונים. פרטי השגיאה: ${err.message}`);
    } finally {
        btn.disabled = false;
        spinner.classList.add('hidden');
    }
}

// Show validation or fetch errors in the form
function showFormError(message) {
    const errorMsg = document.getElementById('form-error-msg');
    const errorText = document.getElementById('error-text');
    errorText.textContent = message;
    errorMsg.classList.remove('hidden');
}

// Remove series code from dashboard
function removeSeries(code) {
    STATE.activeSeries = getActiveSeriesObjects().filter(s => s.code !== code);
    saveStateToLocal();
    refreshDashboard();
    
    // Update sidebar if it is open/rendered
    const sidebarList = document.getElementById('sidebar-series-list');
    if (sidebarList) {
        renderSidebarSeriesList();
    }
}

// Translate common SDMX metadata keys to user-friendly Hebrew labels
function translateMetadataKey(key) {
    const translations = {
        'FREQ': 'תדירות דגימה',
        'UNIT_MEASURE': 'יחידת מידה',
        'UNIT_MULT': 'מכפיל יחידה',
        'DATA_SOURCE': 'מקור הנתון',
        'TIME_COLLECT': 'זמן איסוף',
        'PUB_WEBSITE': 'פרסום באתר',
        'CONF_STATUS': 'רמת סודיות',
        'DECIMALS': 'ספרות אחרי הנקודה',
        'BASE_CURRENCY': 'מטבע בסיס',
        'COUNTER_CURRENCY': 'מטבע נגדי',
        'DATA_TYPE': 'סוג נתון',
        'MAIN_SUBJECT': 'נושא ראשי',
        'SUBJECT': 'תת נושא',
        'ADJUSTMENT': 'סוג התאמה',
        'TRADE_FLOW': 'זרימת סחר',
        'COUNTERPART_AREA': 'מדינת יעד/מקור',
        'ACTIVITY_CBS_2011': 'ענף כלכלי (למ"ס 2011)',
        'PRICE_INDEX_TYPE': 'סוג מדד מחירים',
        'TRD_PRODUCT': 'מוצר סחר',
        'REF_AREA': 'אזור גיאוגרפי'
    };
    
    return translations[key] || key;
}

// Setup Category-based Search UI
function setupSearchUI() {
    const btnToggleSearch = document.getElementById('btn-toggle-search');
    const searchPanel = document.getElementById('search-panel');
    const categorySelect = document.getElementById('search-category-select');
    const filterWrap = document.getElementById('search-filter-wrap');
    const keywordInput = document.getElementById('search-keyword-input');
    const placeholderMsg = document.getElementById('search-placeholder-msg');
    const loadingIndicator = document.getElementById('search-loading-indicator');
    const resultsWrapper = document.getElementById('results-list-wrapper');
    const resultsTbody = document.getElementById('search-results-tbody');
    
    let currentCategorySeries = [];
    let categoriesLoaded = false;

    // Toggle search panel visibility
    btnToggleSearch.addEventListener('click', async () => {
        const isHidden = searchPanel.classList.toggle('hidden');
        
        // Load categories dropdown once
        if (!isHidden && !categoriesLoaded) {
            try {
                const res = await fetch('/api/dataflows');
                if (!res.ok) throw new Error("Failed to load");
                const dataflows = await res.json();
                
                // Sort by Hebrew name if possible
                dataflows.sort((a, b) => {
                    const nameA = a.names.he || a.names.en || '';
                    const nameB = b.names.he || b.names.en || '';
                    return nameA.localeCompare(nameB, 'he');
                });
                
                categorySelect.innerHTML = `<option value="" disabled selected>בחר נושא מהרשימה...</option>` +
                    dataflows.map(df => {
                        const name = df.names.he || df.names.en || df.id;
                        return `<option value="${df.id}" data-agency="${df.agencyID}">${name} (${df.id})</option>`;
                    }).join('');
                
                categoriesLoaded = true;
            } catch (err) {
                console.error("Failed to load categories:", err);
                categorySelect.innerHTML = `<option value="" disabled>שגיאה בטעינת קטגוריות</option>`;
            }
        }
    });

    // Handle category selection
    categorySelect.addEventListener('change', async (e) => {
        const option = categorySelect.selectedOptions[0];
        const dataflowID = option.value;
        const agencyID = option.getAttribute('data-agency');
        
        if (!dataflowID || !agencyID) return;
        
        // Show loading state
        placeholderMsg.classList.add('hidden');
        resultsWrapper.classList.add('hidden');
        filterWrap.classList.add('hidden');
        loadingIndicator.classList.remove('hidden');
        keywordInput.value = '';
        currentCategorySeries = [];
        
        try {
            const res = await fetch(`/api/series-search?dataflowID=${dataflowID}&agencyID=${agencyID}`);
            if (!res.ok) throw new Error("API error");
            
            currentCategorySeries = await res.json();
            
            // Render table
            renderSearchResults(currentCategorySeries);
            
            loadingIndicator.classList.add('hidden');
            resultsWrapper.classList.remove('hidden');
            filterWrap.classList.remove('hidden');
        } catch (err) {
            console.error("Error loading series list:", err);
            loadingIndicator.classList.add('hidden');
            placeholderMsg.classList.remove('hidden');
            placeholderMsg.querySelector('p').textContent = "שגיאה בטעינת סדרות הנתונים מקטגוריה זו. נסה נושא אחר.";
        }
    });

    // Handle real-time filtering
    keywordInput.addEventListener('input', () => {
        const query = keywordInput.value.trim().toLowerCase();
        if (!query) {
            renderSearchResults(currentCategorySeries);
            return;
        }
        
        const filtered = currentCategorySeries.filter(item => {
            const codeMatch = item.code.toLowerCase().includes(query);
            const nameMatch = item.name.toLowerCase().includes(query);
            return codeMatch || nameMatch;
        });
        
        renderSearchResults(filtered);
    });

    // Render search results to the table
    function renderSearchResults(items) {
        if (items.length === 0) {
            resultsTbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 2rem; color: var(--text-muted);">
                        לא נמצאו סדרות העונות לסינון שהזנת.
                    </td>
                </tr>
            `;
            return;
        }
        
        const activeCodes = getActiveSeriesObjects().map(s => s.code);
        
        resultsTbody.innerHTML = items.map(item => {
            const isAlreadyAdded = activeCodes.includes(item.code);
            const buttonHtml = isAlreadyAdded 
                ? `<button type="button" class="btn btn-primary btn-add-table" disabled style="opacity: 0.5; background: rgba(16, 185, 129, 0.1); color: #a7f3d0; border-color: rgba(16, 185, 129, 0.2); pointer-events: none;">
                       <i data-lucide="check" style="width: 14px; height: 14px;"></i>
                       <span>נוסף</span>
                   </button>`
                : `<button type="button" class="btn btn-accent btn-add-table" data-code="${item.code}">
                       <i data-lucide="plus" style="width: 14px; height: 14px;"></i>
                       <span>הוסף</span>
                   </button>`;
            
            return `
                <tr>
                    <td>${item.name}</td>
                    <td>${item.code}</td>
                    <td>${item.frequency || 'לא ידוע'}</td>
                    <td>${item.lastDate || 'לא ידוע'}</td>
                    <td>${item.seasonalAdjustment || 'לא רלוונטי'}</td>
                    <td style="text-align: center; white-space: nowrap;">${buttonHtml}</td>
                </tr>
            `;
        }).join('');
        
        lucide.createIcons();
        
        // Add click events to table add buttons
        resultsTbody.querySelectorAll('.btn-add-table:not([disabled])').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const code = btn.getAttribute('data-code');
                if (!code) return;
                
                // Show loading spinner on the button
                const oldHtml = btn.innerHTML;
                btn.disabled = true;
                btn.innerHTML = `<div class="spinner" style="width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.2); border-top-color: white; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>`;
                
                try {
                    // Call the add series logic
                    const activeObjects = getActiveSeriesObjects();
                    if (activeObjects.some(s => s.code === code)) {
                        alert("הסדרה הזו כבר קיימת בדשבורד שלך.");
                        return;
                    }
                    
                    const { startPeriod, endPeriod } = calculateDateParamsForRange("5y");
                    await fetchSeriesData(code, startPeriod, endPeriod);
                    
                    STATE.activeSeries.push({ code, range: "5y" });
                    saveStateToLocal();
                    await refreshDashboard();
                    
                    // Update sidebar if it is open/rendered
                    const sidebarList = document.getElementById('sidebar-series-list');
                    if (sidebarList) {
                        renderSidebarSeriesList();
                    }
                    
                    // Update the button state to "Added"
                    btn.className = "btn btn-primary btn-add-table";
                    btn.style.opacity = "0.5";
                    btn.style.background = "rgba(16, 185, 129, 0.1)";
                    btn.style.color = "#a7f3d0";
                    btn.style.borderColor = "rgba(16, 185, 129, 0.2)";
                    btn.style.pointerEvents = "none";
                    btn.innerHTML = `<i data-lucide="check" style="width: 14px; height: 14px;"></i><span>נוסף</span>`;
                    lucide.createIcons();
                } catch (err) {
                    alert(`שגיאה בהוספת הסדרה: ${err.message}`);
                    btn.disabled = false;
                    btn.innerHTML = oldHtml;
                    lucide.createIcons();
                }
            });
        });
    }
}

// Render the list of series inside the sidebar manage panel
function renderSidebarSeriesList() {
    const listEl = document.getElementById('sidebar-series-list');
    if (!listEl) return;
    
    const activeObjects = getActiveSeriesObjects();
    
    if (activeObjects.length === 0) {
        listEl.innerHTML = `
            <li style="text-align: center; padding: 2rem; color: var(--text-muted); font-size: 0.9rem;">
                אין סדרות פעילות בדשבורד.
            </li>
        `;
        return;
    }
    
    listEl.innerHTML = activeObjects.map((s, index) => {
        const cached = STATE.dataCache[s.code];
        const name = cached ? cached.name : s.code;
        
        const isFirst = index === 0;
        const isLast = index === activeObjects.length - 1;
        
        return `
            <li class="sidebar-item" draggable="true" data-code="${s.code}" data-index="${index}">
                <div class="sidebar-item-info">
                    <div class="sidebar-item-name" title="${name}">${name}</div>
                    <div class="sidebar-item-code" title="${s.code}">${s.code}</div>
                </div>
                <div class="sidebar-item-actions">
                    <button type="button" class="btn-sidebar-arrow btn-move-up" data-index="${index}" ${isFirst ? 'disabled' : ''} title="הזז למעלה">
                        <i data-lucide="chevron-up" style="width: 16px; height: 16px;"></i>
                    </button>
                    <button type="button" class="btn-sidebar-arrow btn-move-down" data-index="${index}" ${isLast ? 'disabled' : ''} title="הזז למטה">
                        <i data-lucide="chevron-down" style="width: 16px; height: 16px;"></i>
                    </button>
                    <button type="button" class="btn-sidebar-delete" data-code="${s.code}" title="הסר מהדשבורד">
                        <i data-lucide="trash-2" style="width: 16px; height: 16px;"></i>
                    </button>
                </div>
            </li>
        `;
    }).join('');
    
    lucide.createIcons();
    setupSidebarEvents();
}

// Attach Drag & Drop and Up/Down Button Click handlers to sidebar elements
function setupSidebarEvents() {
    const listEl = document.getElementById('sidebar-series-list');
    if (!listEl) return;
    
    const items = listEl.querySelectorAll('.sidebar-item');
    
    // Up click handler
    listEl.querySelectorAll('.btn-move-up').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = parseInt(btn.getAttribute('data-index'));
            swapSeries(index, index - 1);
        });
    });
    
    // Down click handler
    listEl.querySelectorAll('.btn-move-down').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = parseInt(btn.getAttribute('data-index'));
            swapSeries(index, index + 1);
        });
    });
    
    // Delete click handler
    listEl.querySelectorAll('.btn-sidebar-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const code = btn.getAttribute('data-code');
            removeSeries(code);
            renderSidebarSeriesList();
        });
    });
    
    // Drag & Drop event bindings
    items.forEach(item => {
        item.addEventListener('dragstart', (e) => {
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.getAttribute('data-index'));
        });
        
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
        });
    });
    
    listEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        const draggingItem = listEl.querySelector('.dragging');
        if (!draggingItem) return;
        
        const siblings = [...listEl.querySelectorAll('.sidebar-item:not(.dragging)')];
        
        const nextSibling = siblings.find(sibling => {
            const box = sibling.getBoundingClientRect();
            const offset = e.clientY - box.top - box.height / 2;
            return offset < 0;
        });
        
        listEl.insertBefore(draggingItem, nextSibling);
    });
    
    listEl.addEventListener('drop', (e) => {
        e.preventDefault();
        
        // Rebuild order from DOM child ordering
        const newOrderCodes = [...listEl.querySelectorAll('.sidebar-item')].map(item => item.getAttribute('data-code'));
        const activeObjects = getActiveSeriesObjects();
        
        const newActiveSeries = newOrderCodes.map(code => {
            return activeObjects.find(s => s.code === code);
        }).filter(s => s !== undefined);
        
        STATE.activeSeries = newActiveSeries;
        saveStateToLocal();
        refreshDashboard();
        renderSidebarSeriesList();
    });
}

// Swap positions of two active series indices
function swapSeries(idxA, idxB) {
    const temp = STATE.activeSeries[idxA];
    STATE.activeSeries[idxA] = STATE.activeSeries[idxB];
    STATE.activeSeries[idxB] = temp;
    saveStateToLocal();
    refreshDashboard();
    renderSidebarSeriesList();
}
