// Premium lineup auto-verify — runs on GitHub Actions.
// Fires ONCE per unverified game, ~60 minutes before first pitch:
//   • pulls the now-posted MLB lineups
//   • marks matching stored rows ● Confirmed + locked, updates batting slots
//   • drops scratched projected players, flags brand-new ones as unscored
//   • mirrors verification into every market (hr/kP/kB/bbP/bbB)
//   • writes a per-game marker so it can never double-fire
// Uses Firestore REST with the league's open rules — no secrets needed.

const PROJECT = 'mlb-bets-d196c';
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const MLB = 'https://statsapi.mlb.com';

/* ── PT clock ── */
function ptParts() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const g = t => f.find(p => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hh: +g('hour'), mm: +g('minute') };
}

/* ── Firestore REST value codec (only the shapes this app stores) ── */
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  const fields = {};
  for (const k of Object.keys(v)) fields[k] = enc(v[k]);
  return { mapValue: { fields } };
}
function dec(v) {
  if (v == null) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) {
    const o = {};
    const f = v.mapValue.fields || {};
    for (const k of Object.keys(f)) o[k] = dec(f[k]);
    return o;
  }
  return null;
}

async function fsGet(path) {
  const r = await fetch(`${FS}/${path}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore GET ${path}: ${r.status}`);
  const doc = await r.json();
  const o = {};
  for (const k of Object.keys(doc.fields || {})) o[k] = dec(doc.fields[k]);
  return o;
}
async function fsPatch(path, obj, maskFields) {
  const fields = {};
  for (const k of Object.keys(obj)) fields[k] = enc(obj[k]);
  const mask = maskFields.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const r = await fetch(`${FS}/${path}?${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error(`Firestore PATCH ${path}: ${r.status} ${await r.text()}`);
}

/* ── main ── */
(async () => {
  const now = ptParts();
  const date = now.date;
  const nowMin = now.hh * 60 + now.mm;
  console.log(`[tick] ${date} ${String(now.hh).padStart(2,'0')}:${String(now.mm).padStart(2,'0')} PT`);

  // Day doc must exist (Jaren loads the morning slate); otherwise nothing to verify.
  const day = await fsGet(`fable_hits/${date}`);
  if (!day || !Array.isArray(day.rows) || !day.rows.length) {
    console.log('No day doc / no rows — exiting.');
    return;
  }

  // Games + start times (+ lineups so a firing tick needs no second fetch)
  const schedRes = await fetch(`${MLB}/api/v1/schedule?sportId=1&date=${date}&hydrate=lineups,team,probablePitcher`);
  const sched = await schedRes.json();
  const games = sched?.dates?.[0]?.games || [];
  if (!games.length) { console.log('No games today — exiting.'); return; }

  const markers = (await fsGet(`app_settings/lineup_autoruns_${date}`)) || {};

  // Which teams already fully verified in the stored rows?
  const teamVerified = {};
  for (const r of day.rows) {
    if (teamVerified[r.team] === undefined) teamVerified[r.team] = true;
    if (!r.verified) teamVerified[r.team] = false;
  }

  let fired = 0;
  for (const g of games) {
    const pk = String(g.gamePk);
    if (markers[pk]) continue;

    const start = new Date(g.gameDate);
    const sp = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(start);
    const sMin = +sp.find(p => p.type === 'hour').value * 60 + +sp.find(p => p.type === 'minute').value;
    const lead = sMin - nowMin;
    // Hourly ticks: fire in the (15, 90] window before first pitch — the 75-minute
    // span guarantees exactly one hourly tick lands for any start time. If lineups
    // aren't posted yet at that tick, the game is NOT marked done and retries next hour.
    if (lead <= 15 || lead > 90) continue;

    const hAb = g.teams?.home?.team?.abbreviation || '';
    const aAb = g.teams?.away?.team?.abbreviation || '';
    const needs = (teamVerified[hAb] === false) || (teamVerified[aAb] === false);
    if (!needs) { console.log(`${aAb}@${hAb} T-${lead}m — already verified, marking done.`); markers[pk] = true; continue; }

    console.log(`FIRING ${aAb}@${hAb} — first pitch in ${lead} min`);
    const sides = [
      { ab: aAb, posted: (g.lineups?.awayPlayers || []).slice(0, 9) },
      { ab: hAb, posted: (g.lineups?.homePlayers || []).slice(0, 9) }
    ];
    for (const side of sides) {
      if (teamVerified[side.ab] !== false) continue;
      if (side.posted.length < 9) { console.log(`  ${side.ab}: lineup still not posted — leaving projected.`); continue; }
      const postedIds = new Map(side.posted.map((p, i) => [p.id, i + 1]));

      // rows: verify matches, update slot, drop scratches, add unscored newcomers
      const keep = [];
      const seenIds = new Set();
      for (const r of day.rows) {
        if (r.team !== side.ab) { keep.push(r); continue; }
        if (postedIds.has(r.id)) {
          r.verified = true; r.locked = true; r.autoVerified = true; r.slot = postedIds.get(r.id);
          seenIds.add(r.id); keep.push(r);
        } // else scratched — dropped
      }
      for (const p of side.posted) {
        if (seenIds.has(p.id)) continue;
        keep.push({
          id: p.id, name: p.fullName, team: side.ab,
          opp: side.ab === hAb ? aAb : hAb,
          slot: postedIds.get(p.id), pit: '', pHand: '',
          verified: true, locked: true, autoVerified: true, prob: null, unscored: true
        });
        console.log(`  ${side.ab}: NEW in lineup, unscored: ${p.fullName}`);
      }
      day.rows = keep;

      // markets: verify matching ids on this team; drop scratched
      if (day.mk) {
        for (const m of Object.keys(day.mk)) {
          day.mk[m] = (day.mk[m] || []).filter(r => {
            if (r.team !== side.ab) return true;
            if (m === 'kP' || m === 'bbP') { r.verified = true; r.autoVerified = true; return true; } // pitcher rows verify on lineup post
            if (postedIds.has(r.id)) { r.verified = true; r.autoVerified = true; return true; }
            return false;
          });
        }
      }
      teamVerified[side.ab] = true;
      console.log(`  ${side.ab}: verified & locked.`);
    }
    const allDone = teamVerified[hAb] !== false && teamVerified[aAb] !== false;
    if (allDone) markers[pk] = true;
    else console.log(`  ${aAb}@${hAb}: a lineup is still unposted — will retry next hour.`);
    fired++;
  }

  if (fired) {
    day.ts = Date.now();
    const mask = ['rows', 'ts'].concat(day.mk ? ['mk'] : []);
    const payload = { rows: day.rows, ts: day.ts };
    if (day.mk) payload.mk = day.mk;
    await fsPatch(`fable_hits/${date}`, payload, mask);
    console.log(`Pushed updated day doc (${day.rows.length} rows).`);
  }
  // persist markers even for "already verified" games so ticks stay cheap
  await fsPatch(`app_settings/lineup_autoruns_${date}`, markers, Object.keys(markers));
  console.log(fired ? `Done — fired for ${fired} game(s).` : 'Nothing in the T-60 window — exiting.');
})().catch(e => { console.error(e); process.exit(1); });
