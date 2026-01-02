/**
 * @file This script renders an interactive time-series chart for performance metrics.
 * It handles data transformation, filtering by scale and branch, and provides
 * zoom/pan functionality for detailed analysis.
 */

// --- GLOBAL STATE & CONFIGURATION ---

/**
 * @type {Array<Object>}
 * @description Stores the flattened and transformed data for the entire application.
 * Each object represents a single data point.
 * @property {string} branch - The source code branch name.
 * @property {number} scale - The scale factor for the test.
 * @property {string} revision - The git commit hash.
 * @property {Date} ctime - The timestamp of the data point.
 * @property {number} metric - The measured performance metric.
 * @property {number} builder_id - The ID of the plant aka buildbot builder id.
 * @property {number} build_number - The build number aka ID of the test.
 */
let allData = [];

/**
 * @type {Map<number, number>}
 * @description Caches the count of data points for each available scale.
 * Key: scale (number), Value: count (number).
 */
let scaleDataCounts = new Map();

/**
 * @type {{scale: number|null, branches: Array<string>}}
 * @description Holds the current user-selected filter criteria.
 */
const currentFilters = {
  scale: null,
  branches: [],
};

/**
 * @type {Object<string, HTMLElement|d3.Selection>}
 * @description A cache for frequently accessed DOM elements to improve performance.
 */
const DOMElements = {};

/**
 * @const
 * @type {string}
 * @description SVG path data for the branch icon used in the legend.
 */
const BRANCH_ICON_SVG = `<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg"><rect fill="none" height="256" width="256"/><path d="M248,120H187.5a60,60,0,0,0-118.9,0H8a8,8,0,0,0,0,16H68.6a60,60,0,0,0,118.9,0H248a8,8,0,0,0,0-16Z"/></svg>`;

// D3 scaling and axis functions, initialized in renderChart.
let xScale, yScale, xAxis, yAxis, line, xGrid, yGrid;

/**
 * @type {Array<Object>}
 * @description A subset of allData that reflects the currently rendered chart data.
 */
let currentChartData = [];

// --- INITIALIZATION ---

/**
 * Application entry point. Executes when the DOM is fully loaded.
 */
document.addEventListener('DOMContentLoaded', () => {
  try {
    cacheDOMElements();

    // Check if the source data exists.
    if (typeof RESULTS_DATA === 'undefined' || !RESULTS_DATA) {
      throw new Error('RESULTS_DATA is not defined or is empty.');
    }

    // Transform the raw nested data into a flat array suitable for D3.
    allData = transformChartData(RESULTS_DATA);

    // Pre-calculate and cache the number of data points for each scale.
    const counts = d3.rollup(
      allData,
      (v) => v.length,
      (d) => d.scale
    );
    scaleDataCounts = new Map(counts);

    initializeApp(allData);
  } catch (error) {
    // If anything fails during initialization, show the error.
    handleError(error);
  }
});

/**
 * Kicks off the main application logic after initial data processing.
 * @param {Array<Object>} data - The complete dataset.
 */
function initializeApp(data) {
  setupFilterControls(data);
  setupEventListeners();
  applyFiltersAndRender();
  updateLastUpdated(data);
}

// --- DATA TRANSFORMATION ---

/**
 * Transforms a nested data structure into a flat array of objects.
 * This is necessary because D3 works best with flat data arrays.
 * @param {object} nestedData - The raw, nested data object.
 * @returns {Array<object>} A flat array of formatted data points.
 */
function transformChartData(nestedData) {
  const flatData = [];
  const scales = nestedData;

  // Iterate over each scale (e.g., "10", "100").
  for (const scale in scales) {
    const branches = scales[scale];

    // Iterate over each branch within the scale.
    for (const branchName in branches) {
      const branchData = branches[branchName];

      if (branchData.reversed) {
        branchData.reversed.forEach((result) => {
          flatData.push({
            branch: branchName,
            scale: +scale,
            revision: result.revision,
            ctime: new Date(result.ctime * 1000), // Convert UNIX timestamp to Date
            metric: +result.metric,
            builder_id: result.builder_id,
            build_number: result.build_number,
          });
        });
      }
    }
  }

  return flatData;
}

// --- DOM & EVENT SETUP ---

/**
 * Caches references to key DOM elements to avoid repeated queries.
 */
function cacheDOMElements() {
  Object.assign(DOMElements, {
    svg: d3.select('#chart-svg'),
    tooltip: d3.select('.tooltip'),
    scaleFilter: document.getElementById('chooseScale'),
    legendContainer: d3.select('#legend-container'),
    lastUpdated: document.getElementById('lastUpdated'),
    branchSelectButton: document.getElementById('branch-select-button'),
    branchFilterDropdown: document.getElementById('branch-filter-dropdown'),
    branchListContainer: document.getElementById('branch-list-container'),
    branchSelectAll: document.getElementById('branch-select-all'),
    branchDeselectAll: document.getElementById('branch-deselect-all'),
    modeZero: document.getElementById('mode-zero'),
    modeZoom: document.getElementById('mode-zoom'),
  });
}

/**
 * Sets up the initial state and options for the filter controls.
 * @param {Array<Object>} data - The complete dataset, used to derive filter options.
 */
function setupFilterControls(data) {
  const uniqueScales = [...scaleDataCounts.keys()].sort((a, b) => a - b);
  DOMElements.scaleFilter.innerHTML = ''; // Clear existing options

  uniqueScales.forEach((scale) => {
    const option = document.createElement('option');
    option.value = scale;
    const count = scaleDataCounts.get(scale);
    option.textContent = `${scale} (${count} results)`;
    DOMElements.scaleFilter.appendChild(option);
  });

  // Set the default scale and update the UI.
  currentFilters.scale = uniqueScales[0] || null;
  DOMElements.scaleFilter.value = currentFilters.scale;

  updateBranchFilter();
}

/**
 * Attaches all necessary event listeners to the DOM elements.
 */
function setupEventListeners() {
  // Listener for the scale filter dropdown.
  DOMElements.scaleFilter.addEventListener('change', (event) => {
    currentFilters.scale = +event.target.value;
    updateBranchFilter(true); // Reset branches when scale changes
    applyFiltersAndRender();
  });

  // Listeners for Y-axis mode radio buttons.
  document.querySelectorAll('input[name="y_axis_mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      updateYAxis(currentChartData);
    });
  });

  // Listener to toggle the branch filter dropdown.
  DOMElements.branchSelectButton.addEventListener('click', () => {
    const isHidden =
      DOMElements.branchFilterDropdown.style.display === 'none' ||
      !DOMElements.branchFilterDropdown.style.display;
    DOMElements.branchFilterDropdown.style.display = isHidden
      ? 'block'
      : 'none';
  });

  // Listener to close the branch dropdown when clicking outside of it.
  document.addEventListener('click', (event) => {
    if (
      !DOMElements.branchSelectButton.contains(event.target) &&
      !DOMElements.branchFilterDropdown.contains(event.target)
    ) {
      DOMElements.branchFilterDropdown.style.display = 'none';
    }
  });

  // Listener for changes to branch selection checkboxes.
  DOMElements.branchListContainer.addEventListener('change', (event) => {
    if (event.target.type === 'checkbox') {
      currentFilters.branches = Array.from(
        DOMElements.branchListContainer.querySelectorAll('input:checked')
      ).map((checkbox) => checkbox.value);
      updateBranchButtonText();
      applyFiltersAndRender();
    }
  });

  // Listeners for "Select All" and "Deselect All" buttons.
  DOMElements.branchSelectAll.addEventListener('click', () =>
    toggleAllBranches(true)
  );
  DOMElements.branchDeselectAll.addEventListener('click', () =>
    toggleAllBranches(false)
  );
}

// --- FILTERING & DATA LOGIC ---

/**
 * Applies the current filters to the dataset and triggers a re-render.
 */
function applyFiltersAndRender() {
  const dataForScale = allData.filter((d) => d.scale === currentFilters.scale);
  const allBranchesForScale = [...new Set(dataForScale.map((d) => d.branch))]
    .sort()
    .reverse();

  // Create a color scale specific to the branches of the selected scale.
  const colorScale = d3
    .scaleOrdinal(d3.schemeTableau10)
    .domain(allBranchesForScale);

  const filteredData = dataForScale.filter((d) =>
    currentFilters.branches.includes(d.branch)
  );

  renderChart(filteredData, colorScale);
  renderLegend(allBranchesForScale, colorScale);
}

/**
 * Updates the branch filter dropdown based on the currently selected scale.
 * @param {boolean} [reset=true] - If true, resets the selection to all available branches.
 */
function updateBranchFilter(reset = true) {
  const availableBranches = [
    ...new Set(
      allData
        .filter((d) => d.scale === currentFilters.scale)
        .map((d) => d.branch)
    ),
  ]
    .sort()
    .reverse();

  if (reset) {
    currentFilters.branches = [...availableBranches];
  }

  DOMElements.branchListContainer.innerHTML = '';
  availableBranches.forEach((branch) => {
    const id = `branch-cb-${branch.replace(/\W/g, '-')}`; // Sanitize ID
    const isChecked = currentFilters.branches.includes(branch);
    const label = document.createElement('label');
    label.setAttribute('for', id);
    label.innerHTML = `<input type="checkbox" id="${id}" value="${branch}" ${
      isChecked ? 'checked' : ''
    }><span>${branch}</span>`;
    DOMElements.branchListContainer.appendChild(label);
  });

  updateBranchButtonText();
}

/**
 * Updates the text on the branch selection button to reflect the current selection count.
 */
function updateBranchButtonText() {
  const selectedCount = currentFilters.branches.length;
  const totalCount =
    DOMElements.branchListContainer.querySelectorAll('input').length;

  let buttonText = `${selectedCount} Branches Selected`;
  if (selectedCount === totalCount) {
    buttonText = 'All Branches Selected';
  } else if (selectedCount === 0) {
    buttonText = 'No Branches Selected';
  }

  DOMElements.branchSelectButton.textContent = buttonText;
}

/**
 * Selects or deselects all branch checkboxes at once.
 * @param {boolean} shouldSelect - True to select all, false to deselect all.
 */
function toggleAllBranches(shouldSelect) {
  const checkboxes = DOMElements.branchListContainer.querySelectorAll('input');
  checkboxes.forEach((cb) => (cb.checked = shouldSelect));

  currentFilters.branches = shouldSelect
    ? Array.from(checkboxes).map((cb) => cb.value)
    : [];

  updateBranchButtonText();
  applyFiltersAndRender();
}

// --- CHART RENDERING ---

/**
 * Renders the main chart, context chart, and all associated elements (axes, lines, etc.).
 * @param {Array<Object>} data - The filtered data to be rendered.
 * @param {d3.ScaleOrdinal} colorScale - The color scale for the branches.
 */
function renderChart(data, colorScale) {
  currentChartData = data;
  const { svg } = DOMElements;
  svg.selectAll('*').remove(); // Clear previous render

  if (data.length === 0) {
    svg
      .append('text')
      .attr('x', '50%')
      .attr('y', '50%')
      .attr('text-anchor', 'middle')
      .text('No data for selected filters.')
      .style('fill', '#6b7280');
    return;
  }

  // --- Chart Dimensions & Scales ---
  const mainChartHeight = 400;
  const contextChartHeight = 80;
  const spacing = 60;
  svg.attr('height', mainChartHeight + spacing + contextChartHeight);

  const width = svg.node().getBoundingClientRect().width;
  const margin = { top: 20, right: 30, bottom: 40, left: 60 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = mainChartHeight - margin.top - margin.bottom;

  const xInitialDomain = d3.extent(data, (d) => d.ctime);
  const yInitialDomain = [0, d3.max(data, (d) => d.metric) * 1.05];

  xScale = d3.scaleTime().domain(xInitialDomain).range([0, chartWidth]);
  yScale = d3.scaleLinear().domain(yInitialDomain).range([chartHeight, 0]);

  // Adjust Y-scale based on the selected mode.
  const yAxisMode = document.querySelector(
    'input[name="y_axis_mode"]:checked'
  ).value;
  if (yAxisMode === 'zoom') {
    const yMin = d3.min(data, (d) => d.metric);
    yScale.domain([yMin * 0.95, d3.max(data, (d) => d.metric) * 1.05]);
  }

  // --- Main Chart Setup ---
  const chart = svg
    .append('g')
    .attr('transform', `translate(${margin.left}, ${margin.top})`);

  svg
    .append('defs')
    .append('clipPath')
    .attr('id', 'chart-clip')
    .append('rect')
    .attr('width', chartWidth)
    .attr('height', chartHeight);

  // --- Axes and Grids ---
  xAxis = d3.axisBottom(xScale).ticks(5).tickFormat(d3.timeFormat('%b %d, %Y'));
  yAxis = d3.axisLeft(yScale).ticks(8);
  xGrid = d3.axisBottom(xScale).ticks(5).tickSize(-chartHeight).tickFormat('');
  yGrid = d3.axisLeft(yScale).tickSize(-chartWidth).tickFormat('');

  chart
    .append('g')
    .attr('class', 'grid x-grid')
    .attr('transform', `translate(0, ${chartHeight})`)
    .call(xGrid);
  chart.append('g').attr('class', 'grid y-grid').call(yGrid);
  const xAxisGroup = chart
    .append('g')
    .attr('class', 'axis x-axis-group')
    .attr('transform', `translate(0, ${chartHeight})`)
    .call(xAxis);
  const yAxisGroup = chart
    .append('g')
    .attr('class', 'axis y-axis-group')
    .call(yAxis);

  // --- Data Visualization (Lines) ---
  const clipArea = chart.append('g').attr('clip-path', 'url(#chart-clip)');

  line = d3
    .line()
    .x((d) => xScale(d.ctime))
    .y((d) => yScale(d.metric));
  const groupedData = d3.group(data, (d) => d.branch);

  clipArea
    .selectAll('.line')
    .data(groupedData)
    .join('path')
    .attr('class', 'line')
    .attr('fill', 'none')
    .attr('stroke', ([branch]) => colorScale(branch))
    .attr('stroke-width', 2)
    .attr('d', ([, values]) => line(values.sort((a, b) => a.ctime - b.ctime)));

  // --- Context Chart (Brush Navigator) ---
  const contextTopPosition = mainChartHeight + margin.top;
  const contextGroup = svg
    .append('g')
    .attr('class', 'context')
    .attr('transform', `translate(${margin.left}, ${contextTopPosition})`);
  const xScale2 = d3.scaleTime().domain(xInitialDomain).range([0, chartWidth]);
  const yScale2 = d3
    .scaleLinear()
    .domain(yInitialDomain)
    .range([contextChartHeight, 0]);

  const contextLine = d3
    .line()
    .x((d) => xScale2(d.ctime))
    .y((d) => yScale2(d.metric));

  contextGroup
    .selectAll('.context-line')
    .data(groupedData)
    .join('path')
    .attr('fill', 'none')
    .attr('stroke', ([branch]) => colorScale(branch))
    .attr('stroke-opacity', 0.7)
    .attr('stroke-width', 1)
    .attr('d', ([, values]) =>
      contextLine(values.sort((a, b) => a.ctime - b.ctime))
    );

  contextGroup
    .append('g')
    .attr('transform', `translate(0, ${contextChartHeight})`)
    .call(
      d3
        .axisBottom(xScale2)
        .ticks(width / 100)
        .tickFormat(d3.timeFormat('%b %Y'))
    );

  // --- Zoom and Brush Logic ---
  const contextBrush = d3
    .brushX()
    .extent([
      [0, 0],
      [chartWidth, contextChartHeight],
    ])
    .on('end', brushedContext);

  const contextBrushGroup = contextGroup
    .append('g')
    .attr('class', 'brush context-brush')
    .call(contextBrush);

  const xAxisBrush = d3
    .brushX()
    .extent([
      [0, 0],
      [chartWidth, chartHeight],
    ])
    .on('end', brushedXAxis);

  const branchCircles = clipArea
    .selectAll('.data-circle')
    .data(data)
    .join('circle')
    .attr('class', 'data-circle')
    .attr('cx', (d) => xScale(d.ctime))
    .attr('cy', (d) => yScale(d.metric))
    .attr('r', 4)
    .attr('fill', (d) => colorScale(d.branch))
    .attr('stroke', 'white')
    .attr('stroke-width', 1);

  const xAxisBrushGroup = clipArea
    .append('g')
    .attr('class', 'brush xaxis-brush')
    .call(xAxisBrush);

  // --- Interaction Event Handling ---

  // Ensure circles are always on top of the brush overlay for tooltip interaction.
  branchCircles.raise();

  // Attach tooltip behavior to the data circles.
  setupTooltip(branchCircles, colorScale);

  // Attach zoom reset and keyboard navigation listeners.
  clipArea.on('dblclick', resetZoom); // Attach to clipArea to fix event capture issue.
  svg
    .on('mouseover', () => window.addEventListener('keydown', handleKeyDown))
    .on('mouseout', () => window.removeEventListener('keydown', handleKeyDown));

  // --- Chart Update and Interaction Functions (scoped to renderChart) ---

  /** Redraws the chart elements with a transition. */
  function redrawChart(duration = 500) {
    const t = svg.transition().duration(duration).ease(d3.easeCubicInOut);
    xAxisGroup.transition(t).call(xAxis.scale(xScale));
    chart.select('.x-grid').transition(t).call(xGrid.scale(xScale));
    updateYAxis(currentChartData, duration);
  }

  /** Handles brushing on the main chart's X-axis. */
  function brushedXAxis(event) {
    if (event.selection) {
      const [x0, x1] = event.selection.map(xScale.invert);
      xScale.domain([x0, x1]);
      xAxisBrushGroup.call(xAxisBrush.move, null); // Clear brush selection
      contextBrushGroup.call(contextBrush.move, xScale.domain().map(xScale2)); // Update context brush
      redrawChart();
    }
  }

  /** Handles brushing on the context navigator chart. */
  function brushedContext(event) {
    if (event.selection) {
      const [x0, x1] = event.selection.map(xScale2.invert);
      xScale.domain([x0, x1]);
      redrawChart();
      xAxisBrushGroup.call(xAxisBrush.move, null); // Clear main brush
    }
  }

  /** Resets the chart's zoom to the initial full view. */
  function resetZoom() {
    xScale.domain(xInitialDomain);
    contextBrushGroup.call(contextBrush.move, null);
    xAxisBrushGroup.call(xAxisBrush.move, null);
    redrawChart();
  }

  /** Handles keyboard events for panning (left/right arrows) and resetting (escape). */
  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      resetZoom();
      return;
    }
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      const percentage = event.key === 'ArrowLeft' ? -0.1 : 0.1;
      const [x0, x1] = xScale.domain();
      const timeSpan = x1.getTime() - x0.getTime();
      const shift = timeSpan * percentage;

      xScale.domain([
        new Date(x0.getTime() + shift),
        new Date(x1.getTime() + shift),
      ]);

      contextBrushGroup.call(contextBrush.move, xScale.domain().map(xScale2));
      xAxisBrushGroup.call(xAxisBrush.move, null);
      redrawChart(100);
    }
  };
}

/**
 * Updates the Y-axis domain based on the selected mode ('zero' or 'zoom').
 * @param {Array<Object>} data - The data currently visible in the chart.
 * @param {number} [duration=250] - The transition duration in milliseconds.
 */
function updateYAxis(data, duration = 250) {
  if (!data || data.length === 0 || !yScale) return;

  const yAxisMode = document.querySelector(
    'input[name="y_axis_mode"]:checked'
  ).value;
  const { svg } = DOMElements;

  const [xMin, xMax] = xScale.domain();
  const visibleData = data.filter((d) => d.ctime >= xMin && d.ctime <= xMax);

  // Determine new Y-domain based on mode
  if (yAxisMode === 'zoom' && visibleData.length > 0) {
    const yMin = d3.min(visibleData, (d) => d.metric);
    const yMax = d3.max(visibleData, (d) => d.metric);
    yScale.domain([yMin * 0.95, yMax * 1.05]); // Zoom to visible data range
  } else {
    const yMax = d3.max(data, (d) => d.metric);
    yScale.domain([0, yMax * 1.05]); // Start from zero
  }

  // Animate the update of the Y-axis, grid, lines, and circles.
  const t = svg.transition().duration(duration);
  svg.select('.axis.y-axis-group').transition(t).call(yAxis);
  svg.select('.grid.y-grid').transition(t).call(yGrid.scale(yScale));
  svg
    .selectAll('.line')
    .transition(t)
    .attr('d', ([, values]) => line(values));
  svg
    .selectAll('.data-circle')
    .transition(t)
    .attr('cx', (d) => xScale(d.ctime))
    .attr('cy', (d) => yScale(d.metric));
}

// --- UI COMPONENTS ---

/**
 * Configures and manages the tooltip behavior for data points.
 * @param {d3.Selection} circles - The D3 selection of data point circles.
 * @param {d3.ScaleOrdinal} colorScale - The color scale for branches.
 */
function setupTooltip(circles, colorScale) {
  const { tooltip } = DOMElements;
  const container = d3.select('main');

  circles
    .style('cursor', 'pointer')
    .on('mouseover', function (event, d) {
      d3.select(this).raise().transition().attr('r', 7); // Enlarge circle on hover

      tooltip
        .html(
          `<div class="tooltip-date">${d3.timeFormat('%A, %B %d, %Y')(
            d.ctime
          )}</div>
           <div class="version-item">
             <span class="version-color" style="background-color:${colorScale(
               d.branch
             )}"></span>
             <span class="version-name">${d.branch}</span>
             <span class="version-value">${d.metric.toFixed(2)}</span>
           </div>
           <div class="commit-details">
             <a href="https://github.com/postgres/postgres/commit/${
               d.revision
             }" target="_blank">Commit ${d.revision.substring(0, 8)}</a><br>
             <a href="http://140.211.11.131:8010/#/builders/${
               d.builder_id
             }/builds/${
               d.build_number
             }" target="_blank">Test results</a>
           </div>`
        )
        .classed('show', true);

      // --- Smart Positioning Logic ---
      const tooltipNode = tooltip.node();
      const tooltipWidth = tooltipNode.offsetWidth;
      const tooltipHeight = tooltipNode.offsetHeight;
      const offset = 20;

      const containerRect = container.node().getBoundingClientRect();
      const pointX = event.clientX - containerRect.left;
      const pointY = event.clientY - containerRect.top;

      // Prioritized placement options
      const placements = [
        {
          name: 'top',
          x: pointX - tooltipWidth / 2,
          y: pointY - tooltipHeight - offset,
        },
        { name: 'bottom', x: pointX - tooltipWidth / 2, y: pointY + offset },
        { name: 'right', x: pointX + offset, y: pointY - tooltipHeight / 2 },
        {
          name: 'left',
          x: pointX - tooltipWidth - offset,
          y: pointY - tooltipHeight / 2,
        },
      ];

      // Find the first placement that fits within the container bounds
      let finalPlacement = placements.find(
        (p) =>
          p.x >= 0 &&
          p.y >= 0 &&
          p.x + tooltipWidth <= containerRect.width &&
          p.y + tooltipHeight <= containerRect.height
      );

      // Fallback to top placement and clamp if none fit perfectly
      if (!finalPlacement) {
        finalPlacement = placements[0]; // Default to top
        finalPlacement.x = Math.max(
          0,
          Math.min(finalPlacement.x, containerRect.width - tooltipWidth)
        );
        finalPlacement.y = Math.max(0, finalPlacement.y);
      }

      const arrowMap = {
        top: 'arrow-down',
        right: 'arrow-left',
        bottom: 'arrow-up',
        left: 'arrow-right',
      };

      tooltip
        .attr('class', 'tooltip show') // Reset classes
        .classed(arrowMap[finalPlacement.name], true)
        .style('left', `${finalPlacement.x}px`)
        .style('top', `${finalPlacement.y}px`);
    })
    .on('mouseout', function () {
      d3.select(this).transition().attr('r', 4); // Shrink circle back

      // Hide tooltip only if the mouse doesn't move onto the tooltip itself.
      setTimeout(() => {
        if (!tooltip.node().matches(':hover')) {
          tooltip.classed('show', false);
        }
      }, 100);
    });

  // Ensure the tooltip hides when the mouse leaves it.
  tooltip.on('mouseleave', () => {
    tooltip.classed('show', false);
  });
}

/**
 * Renders the legend based on available branches and their colors.
 * @param {Array<string>} branches - A list of unique branch names for the current scale.
 * @param {d3.ScaleOrdinal} colorScale - The color scale mapping branches to colors.
 */
function renderLegend(branches, colorScale) {
  const { legendContainer } = DOMElements;

  const items = legendContainer
    .selectAll('.legend-item')
    .data(branches, (d) => d)
    .join(
      (enter) => {
        const item = enter
          .append('div')
          .attr('class', 'legend-item')
          .attr('data-branch', (d) => d);

        // Clicking a legend item toggles the corresponding checkbox in the filter dropdown.
        item.on('click', (event, d) => {
          const checkbox = DOMElements.branchListContainer.querySelector(
            `input[value="${d}"]`
          );
          if (checkbox) {
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change', { bubbles: true })); // Programmatically trigger change event
          }
        });

        return item;
      },
      (update) => update,
      (exit) => exit.remove()
    );

  // Set the content and color for all entering and updating items.
  items
    .html((d) => `${BRANCH_ICON_SVG}<span>${d}</span>`)
    .each(function (d) {
      d3.select(this).select('svg path').attr('fill', colorScale(d));
    });

  // Apply 'inactive' class based on the current filter selection.
  items.classed('inactive', (d) => !currentFilters.branches.includes(d));
}

/**
 * Updates the "Last Updated" text with the most recent date from the data.
 * @param {Array<Object>} data - The complete dataset.
 */
function updateLastUpdated(data) {
  if (!data || data.length === 0) return;
  const maxDate = d3.max(data, (d) => d.ctime);
  DOMElements.lastUpdated.textContent = `Last updated: ${d3.timeFormat(
    '%b %d, %Y'
  )(maxDate)}`;
}

/** * Handles errors by logging them and displaying a user-friendly message in the SVG.
 * @param {Error} error - The error object containing details about the failure.
 */
function handleError(error) {
  console.error('Error:', error);
  // Ensure DOMElements.svg is available before trying to use it.
  if (DOMElements && DOMElements.svg) {
    DOMElements.svg.selectAll('*').remove();
    DOMElements.svg
      .append('text')
      .attr('x', '50%')
      .attr('y', '50%')
      .attr('text-anchor', 'middle')
      .attr('fill', 'red')
      .text(`Error: ${error.message}`);
  }
}
