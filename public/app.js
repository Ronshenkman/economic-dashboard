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
        const res = await fetch('/api/active-series', { cache: 'no-store' });
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

        const btnSaveSidebarChanges = document.getElementById('btn-save-sidebar-changes');
        if (btnSaveSidebarChanges) {
            btnSaveSidebarChanges.addEventListener('click', async () => {
                const oldHtml = btnSaveSidebarChanges.innerHTML;
                const oldBg = btnSaveSidebarChanges.style.background;
                btnSaveSidebarChanges.disabled = true;
                btnSaveSidebarChanges.innerHTML = `
                    <div class="spinner" style="width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.2); border-top-color: white; border-radius: 50%; animation: spin 0.8s linear infinite; margin-left: 0.5rem; display: inline-block; vertical-align: middle;"></div>
                    <span>שומר שינויים...</span>
                `;
                
                try {
                    const res = await fetch('/api/active-series', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(STATE.activeSeries)
                    });
                    
                    let errorMsg = "שגיאה לא ידועה";
                    if (res.ok) {
                        const data = await res.json();
                        if (data.success) {
                            btnSaveSidebarChanges.style.background = '#10b981';
                            btnSaveSidebarChanges.innerHTML = `
                                <i data-lucide="check" style="width: 16px; height: 16px;"></i>
                                <span>נשמר בענן בהצלחה!</span>
                            `;
                            lucide.createIcons();
                            return;
                        } else {
                            errorMsg = data.error || "Save returned success: false";
                        }
                    } else {
                        try {
                            const errData = await res.json();
                            errorMsg = errData.error || ("HTTP status " + res.status);
                        } catch (e) {
                            errorMsg = "HTTP error " + res.status;
                        }
                    }
                    throw new Error(errorMsg);
                } catch (err) {
                    console.error("Failed manually saving sidebar changes:", err);
                    alert("שגיאה בשמירה בענן:\n" + err.message);
                    btnSaveSidebarChanges.style.background = '#ef4444';
                    btnSaveSidebarChanges.innerHTML = `
                        <i data-lucide="alert-triangle" style="width: 16px; height: 16px;"></i>
                        <span>שגיאה בשמירה!</span>
                    `;
                    lucide.createIcons();
                } finally {
                    setTimeout(() => {
                        btnSaveSidebarChanges.disabled = false;
                        btnSaveSidebarChanges.innerHTML = oldHtml;
                        btnSaveSidebarChanges.style.background = oldBg;
                        lucide.createIcons();
                    }, 2500);
                }
            });
        }
    }

    // Floating Merge Bar actions
    const btnMergeAction = document.getElementById('btn-merge-action');
    const btnMergeCancel = document.getElementById('btn-merge-cancel');
    
    if (btnMergeAction && btnMergeCancel) {
        btnMergeAction.addEventListener('click', mergeSelectedCharts);
        btnMergeCancel.addEventListener('click', () => {
            document.querySelectorAll('.card-select-checkbox:checked').forEach(cb => {
                cb.checked = false;
            });
            updateMergeFloatingBar();
        });
    }

    // Grid change delegation for checkboxes
    const grid = document.getElementById('dashboard-grid');
    if (grid) {
        grid.addEventListener('change', (e) => {
            if (e.target.classList.contains('card-select-checkbox')) {
                updateMergeFloatingBar();
            }
        });
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
// Fetch single series or merged series datasets in parallel
async function fetchItemData(s) {
    const { startPeriod, endPeriod } = calculateDateParamsForRange(s.range);
    if (s.merged) {
        const promises = s.codes.map(async (code) => {
            try {
                const data = await fetchSeriesData(code, startPeriod, endPeriod);
                return { code, data, error: null };
            } catch (err) {
                return { code, data: null, error: err.message };
            }
        });
        const datasets = await Promise.all(promises);
        return { ...s, datasets };
    } else {
        try {
            const data = await fetchSeriesData(s.code, startPeriod, endPeriod);
            return { ...s, data, error: null };
        } catch (err) {
            return { ...s, data: null, error: err.message };
        }
    }
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

    // Fetch all active items in parallel
    const fetchPromises = activeObjects.map(s => fetchItemData(s));
    
    const results = await Promise.all(fetchPromises);
    loader.classList.add('hidden');
    
    // Render each card
    results.forEach((result, index) => {
        if (result.merged) {
            // Cache successfully fetched sub-series for offline downloads & sidebar labels
            result.datasets.forEach(ds => {
                if (ds.data) {
                    ds.data.range = result.range;
                    STATE.dataCache[ds.code] = ds.data;
                }
            });
            renderMergedCard(result, index);
        } else {
            if (result.error) {
                renderErrorCard(result.code, result.error);
            } else if (result.data) {
                result.data.range = result.range;
                // Cache retrieved data for offline CSV downloads
                STATE.dataCache[result.code] = result.data;
                renderCard(result.data, index);
            }
        }
    });

    lucide.createIcons();
    updateMergeFloatingBar();
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
    
    const seriesObj = getActiveSeriesObjects().find(s => s.code === series.fullCode) || {};
    const isNormalized = !!seriesObj.normalized;
    
    // Construct HTML template (hiding code in header and putting inside metadata list)
    const cardHtml = `
        <article class="card-indicator card-${safeId}" id="card-${safeId}" aria-labelledby="title-${safeId}">
            <div class="card-header">
                <div class="card-title-wrap">
                    <div class="card-title-flex">
                        <input type="checkbox" class="card-select-checkbox" data-id="${series.fullCode}" title="בחר למיזוג">
                        <h3 class="card-title" id="title-${safeId}">${series.name}</h3>
                    </div>
                </div>
                <div class="card-actions">
                    <button class="btn-icon-only btn-normalize ${isNormalized ? 'active' : ''}" data-code="${series.fullCode}" title="נרמל בסיס ל-100 בתחילת התקופה">
                        <i data-lucide="percent"></i>
                    </button>
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
    
    // Bind Normalize button
    cardEl.querySelector('.btn-normalize').addEventListener('click', async (e) => {
        const code = e.currentTarget.getAttribute('data-code');
        const btn = e.currentTarget;
        btn.classList.toggle('active');
        
        // Toggle normalized state
        STATE.activeSeries = getActiveSeriesObjects().map(s => {
            if (s.code === code) {
                return { ...s, normalized: !s.normalized };
            }
            return s;
        });
        saveStateToLocal();
        
        await refreshSingleCard(code);
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
    
    // Find normalization state
    const seriesObj = getActiveSeriesObjects().find(s => s.code === series.fullCode) || {};
    const isNormalized = !!seriesObj.normalized;
    
    const dates = series.observations.map(o => o.date);
    let values;
    
    if (isNormalized) {
        const firstObs = series.observations.find(o => o.value !== null && o.value !== undefined);
        const baseValue = (firstObs && firstObs.value !== 0) ? firstObs.value : 1;
        values = series.observations.map(o => o.value !== null ? (o.value / baseValue) * 100 : null);
    } else {
        values = series.observations.map(o => o.value);
    }
    
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
                            if (isNormalized) {
                                const origVal = series.observations[context.dataIndex]?.value;
                                const formattedOrig = origVal !== null && origVal !== undefined ? `${origVal.toLocaleString()} ${unit}` : '';
                                const rawVal = context.raw;
                                const formattedRaw = typeof rawVal === 'number' ? rawVal.toFixed(1) : rawVal;
                                return `מדד: ${formattedRaw} (מקור: ${formattedOrig})`;
                            } else {
                                let formattedVal = context.raw.toLocaleString();
                                return `${formattedVal} ${unit}`;
                            }
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
        let name, codeLabel, itemKey;
        if (s.merged) {
            const successfulNames = s.codes.map(c => {
                if (s.customLabels && s.customLabels[c]) {
                    return s.customLabels[c];
                }
                return STATE.dataCache[c] ? STATE.dataCache[c].name : c;
            });
            name = s.label || successfulNames.join(' + ');
            codeLabel = `[ממוזג] ${s.codes.join(', ')}`;
            itemKey = s.codes.join('_');
        } else {
            const cached = STATE.dataCache[s.code];
            name = cached ? cached.name : s.code;
            codeLabel = s.code;
            itemKey = s.code;
        }
        
        const isFirst = index === 0;
        const isLast = index === activeObjects.length - 1;
        
        return `
            <li class="sidebar-item" draggable="true" data-code="${itemKey}" data-index="${index}">
                <div class="sidebar-item-info">
                    <div class="sidebar-item-name" title="${name}">${name}</div>
                    <div class="sidebar-item-code" title="${codeLabel}">${codeLabel}</div>
                </div>
                <div class="sidebar-item-actions">
                    <button type="button" class="btn-sidebar-arrow btn-move-up" data-index="${index}" ${isFirst ? 'disabled' : ''} title="הזז למעלה">
                        <i data-lucide="chevron-up" style="width: 16px; height: 16px;"></i>
                    </button>
                    <button type="button" class="btn-sidebar-arrow btn-move-down" data-index="${index}" ${isLast ? 'disabled' : ''} title="הזז למטה">
                        <i data-lucide="chevron-down" style="width: 16px; height: 16px;"></i>
                    </button>
                    <button type="button" class="btn-sidebar-delete" data-code="${itemKey}" title="הסר מהדשבורד">
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
            return activeObjects.find(s => {
                if (s.merged) {
                    return s.codes.join('_') === code;
                } else {
                    return s.code === code;
                }
            });
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

// Render merged card container
function renderMergedCard(result, index) {
    const grid = document.getElementById('dashboard-grid');
    const id = result.codes.join('_');
    const safeId = getSafeId(id);
    
    const successfulDatasets = result.datasets.filter(d => d.data && !d.error);
    const title = result.label || successfulDatasets.map(d => (result.customLabels && result.customLabels[d.code]) || d.data.name).join(' + ') || 'גרף ממוזג';
    
    const isNormalized = !!result.normalized;
    
    const cardHtml = `
        <article class="card-indicator card-${safeId}" id="card-${safeId}" aria-labelledby="title-${safeId}">
            <div class="card-header">
                <div class="card-title-wrap">
                    <div class="card-title-flex" style="align-items: center;">
                        <input type="checkbox" class="card-select-checkbox" data-id="${id}" title="בחר למיזוג">
                        <h3 class="card-title" id="title-${safeId}">${title}</h3>
                        <button class="btn-icon-only-mini btn-edit-title" data-id="${id}" title="ערוך כותרת">
                            <i data-lucide="edit-2" style="width: 12px; height: 12px;"></i>
                        </button>
                    </div>
                </div>
                <div class="card-actions">
                    <button class="btn-icon-only btn-normalize ${isNormalized ? 'active' : ''}" data-id="${id}" title="נרמל בסיס ל-100 בתחילת התקופה">
                        <i data-lucide="percent"></i>
                    </button>
                    <select class="card-range-select" data-id="${id}" title="שנה טווח זמן לגרף זה">
                        <option value="1y" ${result.range === '1y' ? 'selected' : ''}>שנה</option>
                        <option value="3y" ${result.range === '3y' ? 'selected' : ''}>3 שנים</option>
                        <option value="5y" ${result.range === '5y' ? 'selected' : ''}>5 שנים</option>
                        <option value="10y" ${result.range === '10y' ? 'selected' : ''}>10 שנים</option>
                        <option value="all" ${result.range === 'all' ? 'selected' : ''}>הכל</option>
                    </select>
                    <button class="btn-icon-only btn-unmerge" data-id="${id}" title="פצל חזרה לגרפים נפרדים">
                        <i data-lucide="git-branch" style="transform: rotate(180deg);"></i>
                    </button>
                    <button class="btn-icon-only btn-download-merged" data-id="${id}" title="הורד נתונים ממוזגים כ-CSV">
                        <i data-lucide="download"></i>
                    </button>
                    <button class="btn-icon-only btn-remove" data-id="${id}" title="הסר מהדשבורד">
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
                    <span>פרטים ומטה-דטה (${successfulDatasets.length} סדרות)</span>
                </button>
                <div class="details-content" id="details-${safeId}">
                    <div class="merged-metadata-content">
                        ${result.datasets.map(ds => {
                            if (ds.error) {
                                return `
                                    <div class="merged-ds-error">
                                        <strong>${ds.code}</strong>: שגיאה בטעינה (${ds.error})
                                    </div>
                                `;
                            }
                            const data = ds.data;
                            const customLabel = (result.customLabels && result.customLabels[data.fullCode]) || '';
                            const displayName = customLabel || data.name;
                            return `
                                <div class="merged-ds-item" data-code="${data.fullCode}">
                                    <div class="merged-ds-title-wrap">
                                        <div class="merged-ds-title-flex">
                                            <h4 class="merged-ds-title">${displayName}</h4>
                                            <button class="btn-icon-only-mini btn-edit-series-label" data-card-id="${id}" data-code="${data.fullCode}" title="ערוך שם בlegend">
                                                <i data-lucide="edit-2" style="width: 12px; height: 12px;"></i>
                                            </button>
                                        </div>
                                    </div>
                                    <table class="metadata-table">
                                        <tbody>
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
                                        </tbody>
                                    </table>
                                </div>
                            `;
                        }).join('<hr class="metadata-divider">')}
                    </div>
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
    
    // Bind Edit Title button
    cardEl.querySelector('.btn-edit-title').addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        startEditingTitle(id);
    });
    
    // Bind Normalize button
    cardEl.querySelector('.btn-normalize').addEventListener('click', async (e) => {
        const cardId = e.currentTarget.getAttribute('data-id');
        const btn = e.currentTarget;
        btn.classList.toggle('active');
        
        // Toggle normalized state
        STATE.activeSeries = getActiveSeriesObjects().map(s => {
            if (s.merged && s.codes.join('_') === cardId) {
                return { ...s, normalized: !s.normalized };
            }
            return s;
        });
        saveStateToLocal();
        
        await refreshSingleMergedCard(cardId);
    });
    
    // Bind Unmerge button
    cardEl.querySelector('.btn-unmerge').addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        unmergeSeries(id);
    });
    
    // Bind Download CSV button
    cardEl.querySelector('.btn-download-merged').addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        downloadMergedCSV(id);
    });
    
    // Bind Remove button
    cardEl.querySelector('.btn-remove').addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        removeSeries(id);
    });

    // Bind Edit Series Label buttons
    cardEl.querySelectorAll('.btn-edit-series-label').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const cId = e.currentTarget.getAttribute('data-card-id');
            const code = e.currentTarget.getAttribute('data-code');
            startEditingSeriesLabel(cId, code);
        });
    });
    
    // Bind Local Range dropdown
    const localSelect = cardEl.querySelector('.card-range-select');
    localSelect.addEventListener('change', async (e) => {
        const newRange = e.target.value;
        const id = e.target.getAttribute('data-id');
        
        STATE.activeSeries = getActiveSeriesObjects().map(s => {
            if (s.merged && s.codes.join('_') === id) {
                return { ...s, range: newRange };
            }
            return s;
        });
        saveStateToLocal();
        
        await refreshSingleMergedCard(id);
    });
    
    // Render Chart.js Graph
    renderMergedChart(result);
}

// Render multiple datasets on a single Chart.js canvas
function renderMergedChart(result) {
    const id = result.codes.join('_');
    const safeId = getSafeId(id);
    const canvasId = `chart-canvas-${safeId}`;
    const canvasEl = document.getElementById(canvasId);
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    
    const isNormalized = !!result.normalized;
    
    const datasets = result.datasets
        .filter(ds => ds.data && !ds.error)
        .map((ds, idx) => {
            const colorScheme = CHART_COLORS[idx % CHART_COLORS.length];
            const customLabel = (result.customLabels && result.customLabels[ds.code]) || ds.data.name;
            
            let dataPoints;
            if (isNormalized) {
                const firstObs = ds.data.observations.find(o => o.value !== null && o.value !== undefined);
                const baseValue = (firstObs && firstObs.value !== 0) ? firstObs.value : 1;
                dataPoints = ds.data.observations.map(o => ({
                    x: o.date,
                    y: o.value !== null ? (o.value / baseValue) * 100 : null
                }));
            } else {
                dataPoints = ds.data.observations.map(o => ({ x: o.date, y: o.value }));
            }
            
            const values = ds.data.observations.map(o => o.value);
            return {
                label: customLabel,
                data: dataPoints,
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
            };
        });
    
    const chart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: '#9ca3af',
                        font: {
                            family: 'Outfit, Assistant',
                            size: 11
                        },
                        boxWidth: 12,
                        boxHeight: 12,
                        useBorderRadius: true,
                        borderRadius: 3
                    },
                    rtl: true
                },
                tooltip: {
                    backgroundColor: '#121826',
                    titleColor: '#9ca3af',
                    bodyColor: '#f3f4f6',
                    borderColor: 'rgba(255, 255, 255, 0.08)',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: true,
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
                        label: (context) => {
                            const label = context.dataset.label || '';
                            const value = context.raw.y;
                            // Find unit measure from the dataset series metadata if available
                            const originalDs = result.datasets.find(ds => {
                                if (!ds.data) return false;
                                const dsLabel = (result.customLabels && result.customLabels[ds.code]) || ds.data.name;
                                return dsLabel === label;
                            });
                            const unit = (originalDs && originalDs.data.metadata['UNIT_MEASURE']) || '';
                            
                            if (isNormalized && originalDs && originalDs.data) {
                                const origObs = originalDs.data.observations[context.dataIndex];
                                const origVal = origObs ? origObs.value : null;
                                const formattedOrig = origVal !== null && origVal !== undefined ? `${origVal.toLocaleString()} ${unit}` : '';
                                const formattedVal = typeof value === 'number' ? value.toFixed(1) : value;
                                return `${label}: ${formattedVal} (מקור: ${formattedOrig})`;
                            } else {
                                let formattedVal = typeof value === 'number' ? value.toLocaleString() : value;
                                return `${label}: ${formattedVal} ${unit}`;
                            }
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
    
    STATE.charts[id] = chart;
}

// Refresh only a single merged card on date selector changes
async function refreshSingleMergedCard(id) {
    const safeId = getSafeId(id);
    const cardEl = document.getElementById(`card-${safeId}`);
    if (!cardEl) return;
    
    cardEl.classList.add('loading');
    
    const seriesObj = getActiveSeriesObjects().find(s => s.merged && s.codes.join('_') === id);
    if (!seriesObj) return;
    
    try {
        const result = await fetchItemData(seriesObj);
        
        // Destroy old chart
        if (STATE.charts[id]) {
            STATE.charts[id].destroy();
        }
        
        // Update details accordion table if needed
        const detailsContainer = cardEl.querySelector('.merged-metadata-content');
        if (detailsContainer) {
            const successfulDatasets = result.datasets.filter(d => d.data && !d.error);
            detailsContainer.innerHTML = result.datasets.map(ds => {
                if (ds.error) {
                    return `
                        <div class="merged-ds-error">
                            <strong>${ds.code}</strong>: שגיאה בטעינה (${ds.error})
                        </div>
                    `;
                }
                const data = ds.data;
                const customLabel = (result.customLabels && result.customLabels[data.fullCode]) || '';
                const displayName = customLabel || data.name;
                return `
                    <div class="merged-ds-item" data-code="${data.fullCode}">
                        <div class="merged-ds-title-wrap">
                            <div class="merged-ds-title-flex">
                                <h4 class="merged-ds-title">${displayName}</h4>
                                <button class="btn-icon-only-mini btn-edit-series-label" data-card-id="${id}" data-code="${data.fullCode}" title="ערוך שם בlegend">
                                    <i data-lucide="edit-2" style="width: 12px; height: 12px;"></i>
                                </button>
                            </div>
                        </div>
                        <table class="metadata-table">
                            <tbody>
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
                            </tbody>
                        </table>
                    </div>
                `;
            }).join('<hr class="metadata-divider">');
            
            // Bind Edit Series Label buttons
            detailsContainer.querySelectorAll('.btn-edit-series-label').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const cId = e.currentTarget.getAttribute('data-card-id');
                    const code = e.currentTarget.getAttribute('data-code');
                    startEditingSeriesLabel(cId, code);
                });
            });

            // Update card header title if there is no custom card-wide label
            const title = result.label || successfulDatasets.map(d => (result.customLabels && result.customLabels[d.code]) || d.data.name).join(' + ') || 'גרף ממוזג';
            const titleEl = cardEl.querySelector('.card-title');
            if (titleEl) {
                titleEl.textContent = title;
            }
            
            const detailsToggleText = cardEl.querySelector('.btn-details-toggle span');
            if (detailsToggleText) {
                detailsToggleText.textContent = `פרטים ומטה-דטה (${successfulDatasets.length} סדרות)`;
            }

            // Re-render lucide icons inside details content
            lucide.createIcons();
        }
        
        renderMergedChart(result);
        
    } catch (err) {
        console.error(`Failed to refresh merged card ${id}:`, err.message);
    } finally {
        cardEl.classList.remove('loading');
    }
}

// Download merged chart data as multi-column aligned CSV
function downloadMergedCSV(id) {
    const seriesObj = getActiveSeriesObjects().find(s => s.merged && s.codes.join('_') === id);
    if (!seriesObj) return;
    
    // Find all successful datasets in state data cache
    const datasets = seriesObj.codes
        .map(code => STATE.dataCache[code])
        .filter(data => data && data.observations && data.observations.length > 0);
        
    if (datasets.length === 0) {
        alert("אין נתונים זמינים להורדה.");
        return;
    }
    
    // Step 1: Collect all unique dates
    const allDatesSet = new Set();
    datasets.forEach(ds => {
        ds.observations.forEach(obs => {
            if (obs.date) allDatesSet.add(obs.date);
        });
    });
    
    const sortedDates = Array.from(allDatesSet).sort((a, b) => new Date(a) - new Date(b));
    
    // Step 2: Build maps of date -> value for each series
    const maps = datasets.map(ds => {
        const map = {};
        ds.observations.forEach(obs => {
            map[obs.date] = obs.value;
        });
        return { name: ds.name, map };
    });
    
    // Step 3: Build CSV
    let csvContent = "\uFEFF"; // Excel BOM
    
    // Headers: Date, Series 1 Name, Series 2 Name, ...
    const headers = [`"תאריך"`, ...maps.map(m => `"${m.name.replace(/"/g, '""')}"`)];
    csvContent += headers.join(",") + "\n";
    
    // Rows
    sortedDates.forEach(date => {
        const row = [date];
        maps.forEach(m => {
            const val = m.map[date];
            row.push(val !== undefined && val !== null ? val : "");
        });
        csvContent += row.join(",") + "\n";
    });
    
    // Trigger download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    
    const safeName = "ממוזג_" + new Date().toISOString().split('T')[0];
    link.setAttribute("download", `${safeName}.csv`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Split a merged series back into single series
function unmergeSeries(id) {
    const activeObjects = getActiveSeriesObjects();
    const itemIndex = activeObjects.findIndex(s => s.merged && s.codes.join('_') === id);
    if (itemIndex === -1) return;
    
    const item = activeObjects[itemIndex];
    // Create single items for each code
    const newSingles = item.codes.map(code => ({ code, range: item.range }));
    
    // Replace the merged item with individual single items
    activeObjects.splice(itemIndex, 1, ...newSingles);
    STATE.activeSeries = activeObjects;
    
    saveStateToLocal();
    refreshDashboard();
    
    // Refresh sidebar list if it's rendered/open
    renderSidebarSeriesList();
}

// Combine all checked charts on the dashboard
function mergeSelectedCharts() {
    const checkedCheckboxes = document.querySelectorAll('.card-select-checkbox:checked');
    if (checkedCheckboxes.length < 2) return;
    
    const idsToMerge = Array.from(checkedCheckboxes).map(cb => cb.getAttribute('data-id'));
    const activeObjects = getActiveSeriesObjects();
    const itemsToMerge = [];
    let firstIndex = -1;
    
    activeObjects.forEach((s, index) => {
        const id = s.merged ? s.codes.join('_') : s.code;
        if (idsToMerge.includes(id)) {
            itemsToMerge.push(s);
            if (firstIndex === -1) {
                firstIndex = index;
            }
        }
    });
    
    if (itemsToMerge.length < 2) return;
    
    // Flatten and gather all codes
    const combinedCodes = [];
    itemsToMerge.forEach(item => {
        if (item.merged) {
            item.codes.forEach(c => {
                if (!combinedCodes.includes(c)) combinedCodes.push(c);
            });
        } else {
            if (!combinedCodes.includes(item.code)) combinedCodes.push(item.code);
        }
    });
    
    // Create the new merged item
    const customLabels = {};
    itemsToMerge.forEach(item => {
        if (item.customLabels) {
            Object.assign(customLabels, item.customLabels);
        }
    });
    
    const newMergedItem = {
        codes: combinedCodes,
        range: itemsToMerge[0].range || '5y',
        merged: true,
        customLabels: customLabels,
        normalized: !!itemsToMerge[0].normalized
    };
    
    // Replace selected cards in activeSeries with the new merged card
    const newActiveSeries = [];
    activeObjects.forEach((s, index) => {
        const id = s.merged ? s.codes.join('_') : s.code;
        if (idsToMerge.includes(id)) {
            if (index === firstIndex) {
                newActiveSeries.push(newMergedItem);
            }
        } else {
            newActiveSeries.push(s);
        }
    });
    
    STATE.activeSeries = newActiveSeries;
    saveStateToLocal();
    refreshDashboard();
}

// Manage floating bar visibility and text
function updateMergeFloatingBar() {
    const checked = document.querySelectorAll('.card-select-checkbox:checked');
    const bar = document.getElementById('merge-floating-bar');
    const text = document.getElementById('merge-bar-text');
    const mergeBtn = document.getElementById('btn-merge-action');
    
    if (!bar || !text || !mergeBtn) return;
    
    if (checked.length > 0) {
        text.textContent = `נבחרו ${checked.length} גרפים למיזוג`;
        bar.classList.add('active');
        bar.classList.remove('hidden');
        
        if (checked.length >= 2) {
            mergeBtn.disabled = false;
            mergeBtn.style.opacity = '1';
        } else {
            mergeBtn.disabled = true;
            mergeBtn.style.opacity = '0.5';
        }
    } else {
        bar.classList.remove('active');
        setTimeout(() => {
            if (!bar.classList.contains('active')) {
                bar.classList.add('hidden');
            }
        }, 300);
    }
}

// Start title edit mode inline
function startEditingTitle(id) {
    const safeId = getSafeId(id);
    const cardEl = document.getElementById(`card-${safeId}`);
    if (!cardEl) return;
    
    const titleWrap = cardEl.querySelector('.card-title-wrap');
    const titleFlex = titleWrap.querySelector('.card-title-flex');
    const currentTitle = titleWrap.querySelector('.card-title').textContent;
    
    // Hide original title flex
    titleFlex.classList.add('hidden');
    
    // Check if edit form already exists
    let editForm = titleWrap.querySelector('.card-title-edit-form');
    if (editForm) {
        editForm.remove();
    }
    
    const formHtml = `
        <form class="card-title-edit-form" style="display: flex; align-items: center; gap: 0.5rem; width: 100%;">
            <input type="text" class="card-title-input" value="${currentTitle.replace(/"/g, '&quot;')}" style="background: rgba(255,255,255,0.05); border: 1px solid var(--panel-border); color: var(--text-primary); padding: 0.25rem 0.5rem; border-radius: var(--border-radius-sm); font-size: 1rem; flex: 1; min-width: 100px;" required>
            <button type="submit" class="btn-icon-only-mini btn-save-title" title="שמור כותרת">
                <i data-lucide="check" style="width: 12px; height: 12px; color: var(--success);"></i>
            </button>
            <button type="button" class="btn-icon-only-mini btn-cancel-title" title="בטל">
                <i data-lucide="x" style="width: 12px; height: 12px; color: var(--danger);"></i>
            </button>
        </form>
    `;
    
    titleWrap.insertAdjacentHTML('beforeend', formHtml);
    lucide.createIcons();
    
    const input = titleWrap.querySelector('.card-title-input');
    input.focus();
    input.select();
    
    const form = titleWrap.querySelector('.card-title-edit-form');
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const newTitle = input.value.trim();
        if (newTitle) {
            saveEditedTitle(id, newTitle);
        }
    });
    
    const cancelBtn = form.querySelector('.btn-cancel-title');
    cancelBtn.addEventListener('click', () => {
        form.remove();
        titleFlex.classList.remove('hidden');
    });
}

// Save edited title to activeSeries state
function saveEditedTitle(id, newTitle) {
    STATE.activeSeries = getActiveSeriesObjects().map(s => {
        if (s.merged && s.codes.join('_') === id) {
            return { ...s, label: newTitle };
        }
        return s;
    });
    saveStateToLocal();
    refreshDashboard();
    
    // Update sidebar if it is open
    renderSidebarSeriesList();
}

// Start editing a series label inside a merged chart
function startEditingSeriesLabel(cardId, code) {
    const safeCardId = getSafeId(cardId);
    const cardEl = document.getElementById(`card-${safeCardId}`);
    if (!cardEl) return;
    
    // Find the merged-ds-item for this series code
    const dsItem = cardEl.querySelector(`.merged-ds-item[data-code="${code}"]`);
    if (!dsItem) return;
    
    const titleWrap = dsItem.querySelector('.merged-ds-title-wrap');
    const titleFlex = titleWrap.querySelector('.merged-ds-title-flex');
    const currentTitle = titleFlex.querySelector('.merged-ds-title').textContent;
    
    // Hide titleFlex
    titleFlex.style.display = 'none';
    
    // Check if form already exists
    let editForm = titleWrap.querySelector('.series-label-edit-form');
    if (editForm) {
        editForm.remove();
    }
    
    const formHtml = `
        <form class="series-label-edit-form" style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; width: 100%;">
            <input type="text" class="series-label-input" value="${currentTitle.replace(/"/g, '&quot;')}" style="background: rgba(255,255,255,0.05); border: 1px solid var(--panel-border); color: var(--text-primary); padding: 0.25rem 0.5rem; border-radius: var(--border-radius-sm); font-size: 0.9rem; flex: 1; min-width: 100px;" required>
            <button type="submit" class="btn-icon-only-mini btn-save-series-label" title="שמור שם">
                <i data-lucide="check" style="width: 12px; height: 12px; color: var(--success);"></i>
            </button>
            <button type="button" class="btn-icon-only-mini btn-cancel-series-label" title="בטל">
                <i data-lucide="x" style="width: 12px; height: 12px; color: var(--danger);"></i>
            </button>
        </form>
    `;
    
    titleWrap.insertAdjacentHTML('beforeend', formHtml);
    lucide.createIcons();
    
    const input = titleWrap.querySelector('.series-label-input');
    input.focus();
    input.select();
    
    const form = titleWrap.querySelector('.series-label-edit-form');
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const newLabel = input.value.trim();
        if (newLabel) {
            saveEditedSeriesLabel(cardId, code, newLabel);
        }
    });
    
    const cancelBtn = form.querySelector('.btn-cancel-series-label');
    cancelBtn.addEventListener('click', () => {
        form.remove();
        titleFlex.style.display = 'flex';
    });
}

// Save edited series label to activeSeries state
function saveEditedSeriesLabel(cardId, code, newLabel) {
    STATE.activeSeries = getActiveSeriesObjects().map(s => {
        if (s.merged && s.codes.join('_') === cardId) {
            const customLabels = s.customLabels || {};
            return {
                ...s,
                customLabels: {
                    ...customLabels,
                    [code]: newLabel
                }
            };
        }
        return s;
    });
    saveStateToLocal();
    
    // Refresh only the affected card to update the legend, tooltip, details view, etc.
    refreshSingleMergedCard(cardId);
    
    // Update sidebar if it is open
    renderSidebarSeriesList();
}
