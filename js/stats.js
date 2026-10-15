(function () {
  const $ = (id) => document.getElementById(id);
  const datePicker = $('date-picker');
  const statusLine = $('status-line');

  // 空字串代表「今天」：會自動更新，並跟著跨日。
  let selectedDate = new URLSearchParams(location.search).get('date') || '';
  let chart = null;
  let loading = false;

  datePicker.max = taipeiToday();
  datePicker.value = selectedDate || datePicker.max;

  datePicker.addEventListener('change', () => {
    selectedDate = datePicker.value === taipeiToday() ? '' : datePicker.value;
    syncUrl();
    load();
  });

  $('today-btn').addEventListener('click', () => {
    selectedDate = '';
    datePicker.value = taipeiToday();
    syncUrl();
    load();
  });

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const data = await Api.stats(selectedDate);
      render(data);
      statusLine.className = 'status-line muted';
      statusLine.textContent = data.isToday
        ? `最後更新 ${timeOfIso(data.generatedAt)}，每 ${STATS_REFRESH_MS / 1000} 秒自動更新`
        : `${data.date} 全天資料`;
    } catch (err) {
      statusLine.className = 'status-line error';
      statusLine.textContent = `讀取失敗：${err.message}`;
    } finally {
      loading = false;
    }
  }

  function render(data) {
    datePicker.max = data.isToday ? data.date : datePicker.max;
    if (!selectedDate) datePicker.value = data.date;

    // 累積人數
    $('total-label').textContent = data.isToday ? '今日累積' : '當日累積';
    $('total').textContent = fmt(data.total);
    $('total-sub').textContent = data.isToday ? `截至 ${timeOfIso(data.generatedAt).slice(0, 5)}` : '全天';

    // 今天顯示本小時新增；過去日期顯示尖峰時段
    if (data.isToday) {
      const current = data.hours[data.hours.length - 1];
      $('hour-label').textContent = '本小時新增';
      $('hour-value').textContent = fmt(current.new);
      $('hour-sub').textContent = hourRange(current.hour);
    } else {
      const peak = data.hours.reduce((a, b) => (b.new > a.new ? b : a), data.hours[0]);
      $('hour-label').textContent = '尖峰時段';
      $('hour-value').textContent = peak.new > 0 ? fmt(peak.new) : '–';
      $('hour-sub').textContent = peak.new > 0 ? hourRange(peak.hour) : '沒有資料';
    }

    // 與前一天同時段比較
    const prev = data.previousDay;
    if (prev) {
      const diff = data.total - prev.sameTimeCumulative;
      $('prev-value').textContent = fmt(prev.sameTimeCumulative);
      const sub = $('prev-sub');
      sub.textContent = '';
      const span = document.createElement('span');
      span.className = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
      span.textContent = diff === 0 ? '與前一天相同' : `今天${diff > 0 ? '多' : '少'} ${fmt(Math.abs(diff))} 人`;
      sub.appendChild(span);
      if (prev.sameTimeCumulative > 0 && diff !== 0) {
        sub.appendChild(document.createTextNode(`（${diff > 0 ? '+' : ''}${Math.round(diff / prev.sameTimeCumulative * 100)}%）`));
      }
    } else {
      $('prev-value').textContent = '–';
      $('prev-sub').textContent = '前一天沒有資料';
    }

    // 兩天都報到
    if (data.returning == null) {
      $('returning-value').textContent = '–';
      $('returning-sub').textContent = '前一天沒有資料';
    } else {
      $('returning-value').textContent = fmt(data.returning);
      $('returning-sub').textContent = data.total > 0
        ? `佔${data.isToday ? '今日' : '當日'} ${Math.round(data.returning / data.total * 100)}%`
        : '人';
    }

    $('dup-value').textContent = fmt(data.duplicateAttempts);

    renderChart(data);
  }

  function renderChart(data) {
    const prevHours = data.previousDay ? data.previousDay.hours : [];
    const range = chartRange(data, prevHours);
    const hours = [];
    for (let h = range.start; h <= range.end; h++) hours.push(h);

    const labels = hours.map((h) => `${String(h).padStart(2, '0')}:00`);
    const byHour = (list, h, key) => (list[h] ? list[h][key] : null);
    const datasets = [
      {
        type: 'bar',
        label: '每小時新增',
        data: hours.map((h) => byHour(data.hours, h, 'new')),
        backgroundColor: cssVar('--chart-bar'),
        borderRadius: 4,
        yAxisID: 'yNew',
        order: 2
      },
      {
        type: 'line',
        label: data.isToday ? '今日累積' : '當日累積',
        data: hours.map((h) => byHour(data.hours, h, 'cumulative')),
        borderColor: cssVar('--chart-line'),
        backgroundColor: cssVar('--chart-line'),
        borderWidth: 3,
        pointRadius: 3,
        tension: 0.2,
        yAxisID: 'yCum',
        order: 1
      }
    ];
    if (data.previousDay) {
      datasets.push({
        type: 'line',
        label: `前一天累積（${data.previousDay.date.slice(5)}）`,
        data: hours.map((h) => byHour(prevHours, h, 'cumulative')),
        borderColor: cssVar('--chart-prev'),
        backgroundColor: cssVar('--chart-prev'),
        borderWidth: 2,
        borderDash: [6, 4],
        pointRadius: 0,
        tension: 0.2,
        yAxisID: 'yCum',
        order: 0
      });
    }

    if (chart) {
      chart.data.labels = labels;
      chart.data.datasets = datasets;
      chart.update();
      return;
    }

    const textColor = cssVar('--muted');
    const gridColor = cssVar('--border');
    chart = new Chart($('hourly-chart'), {
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: textColor, usePointStyle: true, sort: (a, b) => a.datasetIndex - b.datasetIndex }
          },
          tooltip: {
            callbacks: {
              title: (items) => hourRange(hours[items[0].dataIndex]),
              label: (item) => `${item.dataset.label}：${fmt(item.parsed.y)} 人`
            }
          }
        },
        scales: {
          x: { ticks: { color: textColor }, grid: { display: false } },
          yNew: {
            position: 'left',
            beginAtZero: true,
            title: { display: true, text: '每小時新增', color: textColor },
            ticks: { color: textColor, precision: 0 },
            grid: { color: gridColor }
          },
          yCum: {
            position: 'right',
            beginAtZero: true,
            title: { display: true, text: '累積人數', color: textColor },
            ticks: { color: textColor, precision: 0 },
            grid: { display: false }
          }
        }
      }
    });
  }

  /**
   * 圖表顯示的小時範圍：從兩天中最早有資料的小時開始，省略凌晨沒有人的時段。
   * 今天顯示到目前這個小時；過去日期顯示到最後有資料的小時。
   */
  function chartRange(data, prevHours) {
    const firstWithData = (list) => list.findIndex((h) => h.new > 0);
    const lastWithData = (list) => {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].new > 0) return i;
      return -1;
    };

    const firsts = [firstWithData(data.hours), firstWithData(prevHours)].filter((i) => i >= 0);
    const end = data.isToday
      ? data.hours.length - 1
      : Math.max(lastWithData(data.hours), lastWithData(prevHours), 0);
    const start = firsts.length ? Math.min(Math.min(...firsts), end) : 0;
    return { start, end };
  }

  function syncUrl() {
    const url = new URL(location.href);
    if (selectedDate) url.searchParams.set('date', selectedDate);
    else url.searchParams.delete('date');
    history.replaceState(null, '', url);
  }

  function taipeiToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function fmt(n) {
    return n == null ? '–' : Number(n).toLocaleString();
  }

  load();
  setInterval(() => {
    if (!selectedDate && !document.hidden) load();
  }, STATS_REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!selectedDate && !document.hidden) load();
  });
})();
