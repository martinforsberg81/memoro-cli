const KINDS = ['regular', 'test', 'review', 'admin', 'otherManaged'];
const count = value => Number.isSafeInteger(value) && value >= 0;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : null;
const quality = value => ['actual', 'partial', 'estimate'].includes(value) ? value : 'unknown';

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
  if (usage.availability !== 'available') out.push('unknown (usage source unavailable)');
  else {
    const { windows, groups } = usage.data;
    out.push(`UTC windows: yesterday [${windows.yesterdayStart}, ${windows.todayStart}); last 7 days [${windows.sevenDaysStart}, ${windows.end})`);
    out.push('Accounts exclude deleted; groups are disjoint (admin takes precedence). Activity: distinct active accounts with an active session last-seen in the window.');
    for (const group of groups) out.push(`${group.kind}: ${group.total} accounts; active yesterday ${group.activeYesterday}; active 7d ${group.activeLastSevenDays}`);
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
