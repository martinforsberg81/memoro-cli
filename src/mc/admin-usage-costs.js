const KINDS = ['regular', 'test', 'review', 'admin', 'otherManaged'];
const count = value => Number.isSafeInteger(value) && value >= 0;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : null;
const quality = value => ['actual', 'partial', 'estimate'].includes(value) ? value : 'unknown';
const DAY_MS = 86400_000;
const DAILY_COUNTS = { uniqueUsers: 'users', uniqueUsers7d: 'users7d',
  aiUsers: 'aiUsers', aiUsers7d: 'aiUsers7d', aiQuestions: 'aiQuestions' };
const DAILY_KEYS = ['date', 'window7d', 'collectionStartedAt', 'groups', ...Object.keys(DAILY_COUNTS)];
const GROUP_KEYS = ['kind', ...Object.values(DAILY_COUNTS)];
const utcDate = ms => new Date(ms).toISOString().slice(0, 10);
const midnight = day => `${day}T00:00:00.000Z`;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function projectUsage(body) {
  if (body?.ok !== true || body.timezone !== 'UTC' || body.activityBasis !== 'active_session_last_seen' || !Array.isArray(body.groups) || body.groups.length !== KINDS.length) throw Error('invalid_shape');
  const windows = {};
  for (const key of ['yesterdayStart', 'todayStart', 'sevenDaysStart', 'end']) {
    windows[key] = timestamp(body.windows?.[key]);
    if (!windows[key]) throw Error('invalid_shape');
  }
  if (Date.parse(windows.todayStart) - Date.parse(windows.yesterdayStart) !== 86400_000 || Date.parse(windows.end) - Date.parse(windows.sevenDaysStart) !== 7 * 86400_000 || Date.parse(windows.todayStart) > Date.parse(windows.end)) throw Error('invalid_shape');
  const groups = KINDS.map(kind => {
    const matches = body.groups.filter(group => group?.kind === kind);
    const group = matches[0];
    if (matches.length !== 1 || !['total', 'activeYesterday', 'activeLastSevenDays'].every(key => count(group[key])) || group.activeYesterday > group.total || group.activeLastSevenDays > group.total || group.activeYesterday > group.activeLastSevenDays) throw Error('invalid_shape');
    return { kind, total: group.total, activeYesterday: group.activeYesterday, activeLastSevenDays: group.activeLastSevenDays };
  });
  return { timezone: 'UTC', activityBasis: 'active_session_last_seen', windows, groups };
}

export function projectDailyUsage(body, legacy) {
  if (Object.hasOwn(body, 'dailyUsageError')) throw Error('invalid_daily_usage');
  if (!Object.hasOwn(body, 'dailyUsage')) return null;
  const daily = body.dailyUsage;
  if (!exactKeys(daily, DAILY_KEYS)) throw Error('invalid_daily_usage');
  const marker = daily.collectionStartedAt;
  const markerDay = typeof marker === 'string' ? date(marker.slice(0, 10)) : null;
  if (marker !== null && (!markerDay || marker !== midnight(markerDay))) throw Error('invalid_daily_usage');

  const waiting = daily.date === null;
  const window = daily.window7d;
  if (waiting) {
    if (window !== null) throw Error('invalid_daily_usage');
  } else {
    if (!date(daily.date) || Date.parse(daily.date) >= Date.parse(legacy.windows.todayStart)
      || !exactKeys(window, ['start', 'end', 'complete']) || !date(window.start) || window.end !== daily.date
      || Date.parse(window.end) - Date.parse(window.start) !== 6 * DAY_MS || typeof window.complete !== 'boolean'
      || (window.complete && (!markerDay || markerDay >= window.start))) throw Error('invalid_daily_usage');
  }

  if (!Array.isArray(daily.groups) || daily.groups.length !== KINDS.length) throw Error('invalid_daily_usage');
  const complete = window?.complete === true;
  const groups = legacy.groups.map(({ kind, total }) => {
    const matches = daily.groups.filter(group => group?.kind === kind);
    const group = matches[0];
    if (matches.length !== 1 || !exactKeys(group, GROUP_KEYS)) throw Error('invalid_daily_usage');
    for (const key of ['users', 'aiUsers', 'aiQuestions']) {
      if (waiting ? group[key] !== null : !count(group[key])) throw Error('invalid_daily_usage');
    }
    for (const [day, week] of [['users', 'users7d'], ['aiUsers', 'aiUsers7d']]) {
      if (complete ? !count(group[week]) || group[week] > total || group[day] > group[week] : group[week] !== null) {
        throw Error('invalid_daily_usage');
      }
    }
    return group;
  });
  for (const [headline, metric] of Object.entries(DAILY_COUNTS)) {
    const value = daily[headline];
    if (groups[0][metric] === null ? value !== null
      : !count(value) || groups.reduce((sum, group) => sum + group[metric], 0) !== value) throw Error('invalid_daily_usage');
  }
  return { ...daily, groups };
}

export function laggingUsageDate(usage, fetchedAt) {
  const latest = usage.data?.dailyUsage?.date;
  return latest && latest < utcDate(Date.parse(fetchedAt) - DAY_MS) ? latest : null;
}

export function projectCosts(body) {
  if (body?.ok !== true || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month) || !['thisMonth', 'aiThisMonth', 'today'].every(key => body.cards?.[key] && typeof body.cards[key] === 'object' && !Array.isArray(body.cards[key]))) throw Error('invalid_shape');
  const vendor = body.cards.thisMonth;
  const throughDate = date(vendor?.throughDate);
  const recorded = vendor?.scope === 'external_vendor' && vendor.source === 'actual' && count(vendor.vendorRows) && vendor.vendorRows > 0 && count(vendor.vendorDays) && vendor.vendorDays > 0 && throughDate?.startsWith(body.month);
  const aiMonth = body.cards.aiThisMonth;
  return { month: body.month,
    vendor: { usd: recorded ? amount(vendor.usd) : null, source: recorded ? 'actual' : 'unknown',
      throughDate: recorded ? throughDate : null, days: recorded ? vendor.vendorDays : null },
    aiMonth: { usd: aiMonth?.scope === 'ai_rollup' && quality(aiMonth.source) !== 'unknown' ? amount(aiMonth.usd) : null, source: quality(aiMonth?.source) },
    aiToday: { usd: body.cards.today?.source === 'estimate' ? amount(body.cards.today.usd) : null, source: 'estimate' },
  };
}

export function renderUsageCosts(usage, costs) {
  const out = ['', 'USAGE'];
  if (usage.availability === 'unavailable') out.push('unknown (usage source unavailable)');
  else {
    const { windows, groups, dailyUsage } = usage.data;
    // Individually safe integers can add up to more than a Number can represent exactly.
    const total = groups.reduce((sum, group) => sum + BigInt(group.total), 0n);
    const totalLine = `${total} ${total === 1n ? 'account' : 'accounts'} in total`;
    const groupTotal = group => `${group.kind}: ${group.total} ${group.total === 1 ? 'account' : 'accounts'}`;
    if (dailyUsage?.date) {
      const { date: day, window7d: { start, end, complete }, collectionStartedAt,
        uniqueUsers, uniqueUsers7d, aiUsers, aiUsers7d, aiQuestions } = dailyUsage;
      const interval = `${start} – ${end}`;
      const since = collectionStartedAt ? ` since ${utcDate(Date.parse(collectionStartedAt) + DAY_MS)}` : '';
      out.push(`Unique users ${day}: ${uniqueUsers}`);
      out.push(`Unique users ${complete ? `${interval}: ${uniqueUsers7d}` : `last 7 days: collecting${since}`}`);
      out.push(`Asked the assistant ${day}: ${aiUsers} (${aiQuestions} ${aiQuestions === 1 ? 'question' : 'questions'}); ${complete ? `${interval}: ${aiUsers7d}` : 'last 7 days: collecting'}`);
      out.push(totalLine, 'Daily usage counts accounts with signed-in app requests per UTC day, from the nightly rollup. Groups are as of the rollup and can be revised for seven days.');
      for (const [i, group] of groups.entries()) {
        const { users, users7d, aiUsers, aiUsers7d } = dailyUsage.groups[i];
        out.push(`${groupTotal(group)}; ${day} used ${users}, assistant ${aiUsers}; last 7 days ${complete ? `used ${users7d}, assistant ${aiUsers7d}` : 'collecting'}`);
      }
    } else if (dailyUsage) {
      out.push('Unique users: waiting for the first nightly rollup', totalLine, ...groups.map(groupTotal));
    } else {
      if (usage.availability === 'available') out.push('Daily usage is unavailable on this server.');
      out.push(totalLine);
      out.push(`UTC session-recency windows: yesterday [${windows.yesterdayStart}, ${windows.todayStart}), trailing 168 hours [${windows.sevenDaysStart}, ${windows.end})`);
      out.push('Account totals exclude deleted accounts. Admin takes precedence over managed groups.');
      out.push('Session recency counts active accounts with an active session last seen in the window. A return visit or sign-out can change earlier counts.');
      for (const group of groups) out.push(`${groupTotal(group)}, with a session last seen yesterday ${group.activeYesterday}, trailing 168 hours ${group.activeLastSevenDays}`);
    }
  }
  out.push('', 'COSTS');
  if (costs.availability !== 'available') out.push('unknown (costs source unavailable)');
  else {
    const { month, vendor, aiMonth, aiToday } = costs.data;
    const money = value => value === null ? 'unknown' : `USD ${value.toFixed(2)}`;
    out.push(`External vendors ${month} (UTC): ${money(vendor.usd)}; ${vendor.source}; recorded through ${vendor.throughDate || 'unknown'}; ${vendor.days ?? 'unknown'} days represented`);
    out.push(`AI metered ${month} to date (UTC): ${money(aiMonth.usd)}; ${aiMonth.source}`);
    out.push(`AI metered today (UTC): ${money(aiToday.usd)}; estimate`);
    out.push('Vendor imports can be incomplete. AI metering overlaps vendor costs; do not add these amounts. No income, margin or currency conversion inferred.');
  }
  return out;
}
