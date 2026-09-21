/**
 * BeatLeader -> MSU Season sheets
 *
 * THE CONTRACT
 * A sheet is fillable if all three are true:
 *   1. It is discovered (auto by default, or named in CONFIG.gridSheets).
 *   2. Somewhere in it, a row (or column) holds map names that appear in the
 *      Config map table. That line marks the start of a block.
 *   3. Below (or beside) that line, cells in the name line hold player names
 *      that appear in the Config player table. Those are the score lines.
 *
 * Everything else is invisible: team headers, difficulty rows, formula rows,
 * blank spacers, extra blocks, extra columns. Rows whose name cell is empty or
 * unrecognised are never written to, so protected percentage formulas are safe.
 *
 * Config columns are found by HEADER TEXT, not position - insert, move, or
 * reorder columns freely. Only renaming a header needs a change here.
 */

const API = 'https://api.beatleader.com';
const PAGE_SIZE = 100;

/** Writes blocked by protected ranges during the current run. */
let SKIPPED = 0;

const CONFIG = {
  // ---- Which sheets to fill ---------------------------------------------
  gridSheets: 'auto',
  excludeSheets: ['Config', 'SONGINFO', 'Notes', 'Scratch'],

  overrides: {
    'QUALSCustomColors': { shade: 'player' },
    'QUALSAccColors':    { shade: 'gradient' },
    'POOL 1':            { shade: 'player' },
  },

  // ---- Defaults applied to every sheet ----------------------------------
  defaults: {
    orientation: 'playersDown',   // or 'mapsDown' (players across, maps down)
    nameLine: 2,                  // column holding player names (2 = B)
    metric: 'score',              // score | modifiedScore | acc | pp | rank | scoreId | date | modifiers
    shade: 'none',                // player | gradient | none

    // What to do with a score cell the API has no score for:
    //   true   - never clear it (stale numbers survive forever)
    //   false  - always clear it (wipes hand-entered scores too)
    //   'auto' - clear only cells this script wrote, identified by the replay
    //            link stamped on them. Hand-typed bare numbers are left alone.
    //
    // 'auto' needs linkReplays on. Cells written before linkReplays was turned
    // on are plain numbers and read as manual, so they persist until they get
    // overwritten once.
    preserveManual: 'auto',

    addNotes: true,               // song name + mapper as a note on the map header

    // Write scores as =HYPERLINK(...) pointing at the BeatLeader replay viewer.
    // The cell still evaluates to the number, so percentage formulas, the
    // gradient, and the audit all keep working on it.
    linkReplays: true,
    linkUnderline: false,         // true to keep the usual underlined-link look
  },

  replayUrl: 'https://replay.beatleader.xyz/?scoreId=',

  // Text colour for any cell the colouring passes do not set contrast ink on.
  // Must be explicit: resetting to default renders HYPERLINK cells link-blue.
  defaultInk: '#000000',

  // ---- Config sheet ------------------------------------------------------
  configSheet: 'Config',
  configHeaderRow: 1,
  columns: {
    playerName:     'Players',
    playerId:       'PlayerID',
    colorPrimary:   'ColorHEXPrimary',      // name + score cells
    colorSecondary: 'ColorHEXSecondary',    // percentage row
    mapName:        'Maps',
    mapId:          'MapID',
  },

  skipIds: ['', 'NULL', 'N/A', 'TBD', '-'],

  // ---- Per-player colours (shade: 'player') ------------------------------
  playerColors: {
    fillNameCell: true,      // primary
    fillScoreCells: true,    // primary
    fillPercentRow: true,    // secondary - the row directly below the score row
    textContrast: true,      // flip text to white on dark fills
  },

  // ---- Gradient (shade: 'gradient') --------------------------------------
  colorScale: {
    low:  '#F0A6A0',
    mid:  '#FBE7A6',
    high: '#A9D8A4',
    scope: 'block',      // 'block' = per team, 'sheet' = all blocks together

    // Background for a score cell with no numeric value in it. This is the
    // only pass that touches those cells, so it decides what a missing score
    // looks like:
    //   'reset'   - no fill at all (stale gradient colours are removed)
    //   'keep'    - leave whatever colour is already there
    //   '#RRGGBB' - a specific colour
    blankColor: 'reset',

    singleValue: 'mid',

    // The gradient only ranks score cells. These set everything else in a
    // player's row so a gradient sheet doesn't keep stale custom colours.
    // Set either to null to leave those cells untouched.
    percentRowColor: '#FFFFFF',   // the accuracy row under each score row
    nameCellColor: '#FFFFFF',     // the player's name cell
  },

  // ---- Named cells -------------------------------------------------------
  // Create these with Data -> Named ranges. Both are optional; if a named
  // range does not exist the feature is simply off.
  //   BL_LastUpdated : shows "Updated Sep 10, 2:47 PM - 43 scores"
  //   BL_Refresh     : a checkbox that runs a refresh when ticked
  statusRangeName: 'BL_LastUpdated',
  refreshRangeName: 'BL_Refresh',

  // ---- Max scores --------------------------------------------------------
  syncMaxScores: true,
  songInfoSheet: 'SONGINFO',
  songInfoSourceSheet: 'QUALSCustomColors',
  songInfoRow: 4,
  songInfoColOffset: -1,         // grid column C -> SONGINFO column B
};

const METRIC_DIRECTION = {
  score: 1, modifiedScore: 1, acc: 1, pp: 1,
  rank: -1,
  scoreId: 0, date: 0, modifiers: 0,
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('BeatLeader')
    .addItem('Refresh scores', 'refreshScores')
    .addItem('Recolour only (no fetch)', 'recolourOnly')
    .addItem('Clear colours', 'clearShading')
    .addSeparator()
    .addItem('Repair percent formulas', 'repairPercentFormulas')
    .addItem('Update max scores (SONGINFO)', 'updateSongInfo')
    .addItem('Check my sheets', 'checkSheets')
    .addItem('Find unverified scores', 'findUnverifiedScores')
    .addItem('Clear junk scores', 'clearJunkScores')
    .addSeparator()
    .addItem('Install triggers', 'installTriggers')
    .addItem('Trigger status', 'checkTriggers')
    .addToUi();
}

// ===========================================================================
//  Main
// ===========================================================================

function refreshScores() {
  const ss = SpreadsheetApp.getActive();
  SKIPPED = 0;
  const ctx = buildContext(ss);
  const boards = fetchLeaderboards(dedupe(values(ctx.mapIds)));

  const maxed = CONFIG.syncMaxScores ? syncSongInfo(ss, ctx, boards) : 0;

  let written = 0;
  let cleared = 0;
  resolveSheets(ss).forEach(spec => {
    const result = fillSheet(spec.sheet, spec.opts, ctx, boards);
    written += result.written;
    cleared += result.cleared;
  });

  const blocked = SKIPPED
    ? ' - ' + SKIPPED + ' blocked (check permissions)'
    : '';
  writeStatus(ss, 'Updated ' + formatNow(ss) + ' - ' + written + ' scores' + blocked);

  // toast only exists in the spreadsheet UI; web app and trigger runs skip it.
  try {
    ss.toast(
      'Wrote ' + written + ' scores, ' + maxed + ' max scores.' +
      (cleared ? ' Cleared ' + cleared + ' stale.' : '') + blocked +
      (ctx.notes.length ? ' Notes: ' + dedupe(ctx.notes).join('; ') : ''),
      'BeatLeader', (ctx.notes.length || SKIPPED) ? 15 : 5
    );
  } catch (err) { /* not running with a UI attached */ }

  return written;
}

function recolourOnly() {
  const ss = SpreadsheetApp.getActive();
  const ctx = buildContext(ss, true);
  resolveSheets(ss).forEach(spec => {
    const grid = readGrid(spec.sheet, spec.opts);
    const blocks = findBlocks(grid, ctx.mapIds, spec.opts);
    applyShading(spec.sheet, spec.opts, ctx, grid, blocks);
  });
  ss.toast('Recoloured from current values.', 'BeatLeader', 5);
}

function clearShading() {
  const ss = SpreadsheetApp.getActive();
  const ctx = buildContext(ss, true);

  resolveSheets(ss).forEach(spec => {
    const grid = readGrid(spec.sheet, spec.opts);
    const blocks = findBlocks(grid, ctx.mapIds, spec.opts);
    const cells = [];
    blocks.forEach(block => {
      const cols = Object.keys(block.cols).map(Number);
      eachPlayerRow(grid, block, spec.opts, ctx, r => {
        cells.push({ r: r, c: spec.opts.nameLine - 1, value: null });
        cells.push({ r: r + 1, c: spec.opts.nameLine - 1, value: null });
        cols.forEach(c => {
          cells.push({ r: r, c: c, value: null });
          cells.push({ r: r + 1, c: c, value: null });
        });
      });
    });
    applyCells(spec.sheet, cells, spec.opts, 'background');
    applyCells(spec.sheet,
      cells.map(x => ({ r: x.r, c: x.c, value: CONFIG.defaultInk })),
      spec.opts, 'fontColor');                               // stale ink too
  });

  ss.toast('Colours cleared.', 'BeatLeader', 5);
}

function checkSheets() {
  const ss = SpreadsheetApp.getActive();
  const ctx = buildContext(ss);
  const lines = [];

  resolveSheets(ss).forEach(spec => {
    const grid = readGrid(spec.sheet, spec.opts);
    const blocks = findBlocks(grid, ctx.mapIds, spec.opts);
    if (!blocks.length) { lines.push(spec.sheet.getName() + ': no map names found'); return; }

    blocks.forEach(b => {
      const names = [];
      for (let r = b.line + 1; r < b.end; r++) {
        const key = norm(grid[r][spec.opts.nameLine - 1]);
        if (key && ctx.playerIds[key]) names.push(grid[r][spec.opts.nameLine - 1]);
      }
      lines.push(spec.sheet.getName() + ' [' + spec.opts.shade + '] line ' + (b.line + 1) + ': ' +
                 Object.keys(b.cols).length + ' maps, ' + names.length + ' players (' +
                 (names.join(', ') || 'none matched') + ')');
    });
  });

  const noPrimary = Object.keys(ctx.playerIds).filter(k => !ctx.primary[k]);
  const noSecondary = Object.keys(ctx.playerIds).filter(k => !ctx.secondary[k]);
  if (noPrimary.length) lines.push('No ' + CONFIG.columns.colorPrimary + ': ' + noPrimary.join(', '));
  if (noSecondary.length) lines.push('No ' + CONFIG.columns.colorSecondary + ': ' + noSecondary.join(', '));

  lines.push('Named cells: ' +
    (ss.getRangeByName(CONFIG.statusRangeName) ? CONFIG.statusRangeName + ' found' : CONFIG.statusRangeName + ' NOT set') + ', ' +
    (ss.getRangeByName(CONFIG.refreshRangeName) ? CONFIG.refreshRangeName + ' found' : CONFIG.refreshRangeName + ' NOT set'));

  if (ctx.notes.length) lines.push('Config issues: ' + dedupe(ctx.notes).join('; '));

  SpreadsheetApp.getUi().alert('BeatLeader - sheet check', lines.join('\n\n'), SpreadsheetApp.getUi().ButtonSet.OK);
}

function buildContext(ss, namesOnly) {
  const notes = [];
  const col = CONFIG.columns;

  const table = readConfigSheet(ss, notes);
  const players  = table(col.playerName, col.playerId);
  const primary  = table(col.playerName, col.colorPrimary);
  const secondary = table(col.playerName, col.colorSecondary);
  const maps     = table(col.mapName, col.mapId);

  const playerIds = {};
  Object.keys(players).forEach(name => {
    if (namesOnly) { playerIds[name] = true; return; }
    const id = resolvePlayerId(players[name]);
    if (id) playerIds[name] = id;
    else notes.push('no usable ID for player "' + name + '"');
  });

  const mapIds = {};
  Object.keys(maps).forEach(name => { mapIds[name] = parseLeaderboardId(maps[name]); });

  return {
    playerIds: playerIds,
    primary: hexTable(primary, notes, col.colorPrimary),
    secondary: hexTable(secondary, notes, col.colorSecondary),
    mapIds: mapIds,
    notes: notes,
  };
}

function hexTable(raw, notes, label) {
  const out = {};
  Object.keys(raw).forEach(name => {
    const hex = normHex(raw[name]);
    if (hex) out[name] = hex;
    else notes.push('unreadable ' + label + ' for "' + name + '"');
  });
  return out;
}

function resolveSheets(ss) {
  const out = [];

  const add = entry => {
    const name = typeof entry === 'string' ? entry : entry.name;
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;

    const opts = {};
    Object.keys(CONFIG.defaults).forEach(k => { opts[k] = CONFIG.defaults[k]; });

    const named = CONFIG.overrides && CONFIG.overrides[name];
    if (named) Object.keys(named).forEach(k => { opts[k] = named[k]; });
    if (typeof entry === 'object') {
      Object.keys(entry).forEach(k => { if (k !== 'name') opts[k] = entry[k]; });
    }

    if (opts.shade === true) opts.shade = 'gradient';
    if (opts.shade === false) opts.shade = 'none';

    out.push({ sheet: sheet, opts: opts });
  };

  if (CONFIG.gridSheets === 'auto') {
    ss.getSheets().forEach(sheet => {
      const name = sheet.getName();
      if (name === CONFIG.configSheet) return;
      if (CONFIG.excludeSheets.indexOf(name) !== -1) return;
      add(name);
    });
  } else {
    CONFIG.gridSheets.forEach(add);
  }
  return out;
}

// ===========================================================================
//  Grid handling
// ===========================================================================

function readGrid(sheet, opts) {
  const data = sheet.getDataRange().getValues();
  return opts.orientation === 'mapsDown' ? transpose(data) : data;
}

/** Same shape as readGrid, but holding formulas ('' where a cell is a value). */
function readFormulas(sheet, opts) {
  const data = sheet.getDataRange().getFormulas();
  return opts.orientation === 'mapsDown' ? transpose(data) : data;
}

/**
 * Whether a score cell the API has no score for should be emptied.
 *
 * Under 'auto' the replay link is the tell: linkReplays writes every score as
 * =HYPERLINK("<replayUrl>...", 12345), so a cell carrying that formula was
 * written by this script and is safe to clear. A bare number was typed by a
 * person and is left alone.
 */
function shouldClear(r, c, opts, formulas) {
  if (opts.preserveManual === false) return true;
  if (opts.preserveManual !== 'auto') return false;
  const f = (formulas && formulas[r]) ? formulas[r][c] : '';
  return !!f && f.indexOf(CONFIG.replayUrl) !== -1;
}

function findBlocks(grid, mapIds, opts) {
  const out = [];
  for (let r = 0; r < grid.length; r++) {
    const cols = {};
    for (let c = opts.nameLine; c < grid[r].length; c++) {
      const key = norm(grid[r][c]);
      if (key && mapIds[key]) cols[c] = key;
    }
    if (Object.keys(cols).length) out.push({ line: r, cols: cols });
  }
  out.forEach((b, i) => { b.end = i + 1 < out.length ? out[i + 1].line : grid.length; });
  return out;
}

function eachScoreCell(grid, block, opts, ctx, fn) {
  for (let r = block.line + 1; r < block.end; r++) {
    const key = norm(grid[r][opts.nameLine - 1]);
    if (!key || !ctx.playerIds[key]) continue;
    Object.keys(block.cols).forEach(c => fn(r, Number(c), key));
  }
}

function eachPlayerRow(grid, block, opts, ctx, fn) {
  for (let r = block.line + 1; r < block.end; r++) {
    const key = norm(grid[r][opts.nameLine - 1]);
    if (!key || !ctx.playerIds[key]) continue;
    fn(r, key);
  }
}

/** Returns { written, cleared }. */
function fillSheet(sheet, opts, ctx, boards) {
  const grid = readGrid(sheet, opts);
  const blocks = findBlocks(grid, ctx.mapIds, opts);
  if (!blocks.length) return { written: 0, cleared: 0 };

  // Read once, before any writes - the formulas are the record of what this
  // script wrote on the previous run.
  const formulas = opts.preserveManual === 'auto' ? readFormulas(sheet, opts) : null;

  const writes = [];
  const notes = [];
  const lines = [];
  let written = 0;
  let cleared = 0;

  blocks.forEach(block => {
    eachScoreCell(grid, block, opts, ctx, (r, c, key) => {
      const board = boards[ctx.mapIds[block.cols[c]]];
      const score = board ? board.byPlayer[ctx.playerIds[key]] : null;

      if (score) {
        const value = extractMetric(score, opts.metric);
        writes.push({ r: r, c: c, value: cellFor(value, score, opts) });
        lines.push({ r: r, c: c, value: opts.linkUnderline ? 'underline' : 'none' });
        grid[r][c] = value;                     // logical value, not the formula
        written++;
      } else if (shouldClear(r, c, opts, formulas)) {
        writes.push({ r: r, c: c, value: '' });
        lines.push({ r: r, c: c, value: 'none' });   // drop leftover link styling
        if (grid[r][c] !== '') cleared++;
        grid[r][c] = '';
      }
    });

    if (opts.addNotes) {
      Object.keys(block.cols).forEach(c => {
        c = Number(c);
        const board = boards[ctx.mapIds[block.cols[c]]];
        notes.push({ r: block.line, c: c, value: board ? board.label : '' });
      });
    }
  });

  applyCells(sheet, writes, opts, 'value');
  if (lines.length) applyCells(sheet, lines, opts, 'fontLine');
  if (notes.length) applyCells(sheet, notes, opts, 'note');
  applyShading(sheet, opts, ctx, grid, blocks);

  return { written: written, cleared: cleared };
}

/**
 * Wraps a score in a link to its replay. HYPERLINK returns its label, so a
 * numeric label leaves the cell numeric - arithmetic, comparisons, and the
 * IF(...="") check in the percentage formulas all behave as before.
 */
function cellFor(value, score, opts) {
  if (!opts.linkReplays || !score || !score.id) return value;

  let label;
  if (typeof value === 'number') label = String(value);
  else if (typeof value === 'string' && value) label = '"' + value.replace(/"/g, '""') + '"';
  else return value;                            // dates and blanks stay plain

  return '=HYPERLINK("' + CONFIG.replayUrl + score.id + '",' + label + ')';
}

// ===========================================================================
//  Colouring
// ===========================================================================

function applyShading(sheet, opts, ctx, grid, blocks) {
  if (opts.shade === 'player') return shadePlayers(sheet, opts, ctx, grid, blocks);
  if (opts.shade === 'gradient') return shadeGradient(sheet, opts, ctx, grid, blocks);
}

/**
 * Paints each player's row in their own colours: primary on the name and score
 * cells, secondary on the percentage row directly below, aligned to the same
 * columns. Cells that get no fill have their font colour reset, so stale white
 * ink from a previous colour never survives.
 */
function shadePlayers(sheet, opts, ctx, grid, blocks) {
  const pc = CONFIG.playerColors;
  const fills = [];
  const fonts = [];
  const down = opts.orientation === 'playersDown';

  const paint = (r, c, hex) => {
    fills.push({ r: r, c: c, value: hex });
    fonts.push({ r: r, c: c, value: pc.textContrast ? readableInk(hex) : null });
  };
  const reset = (r, c) => { fonts.push({ r: r, c: c, value: CONFIG.defaultInk }); };

  blocks.forEach(block => {
    const cols = Object.keys(block.cols).map(Number);
    const nameCol = opts.nameLine - 1;

    eachPlayerRow(grid, block, opts, ctx, (r, key) => {
      const one = ctx.primary[key];
      const two = ctx.secondary[key];

      // Score row: name cell + score cells in primary.
      if (one) {
        if (pc.fillNameCell) paint(r, nameCol, one);
        if (pc.fillScoreCells) cols.forEach(c => paint(r, c, one));
      } else {
        if (pc.fillNameCell) reset(r, nameCol);
        if (pc.fillScoreCells) cols.forEach(c => reset(r, c));
      }

      // Percentage row: same columns, in secondary.
      if (pc.fillPercentRow && down) {
        if (two) {
          if (pc.fillNameCell) paint(r + 1, nameCol, two);
          cols.forEach(c => paint(r + 1, c, two));
        } else {
          if (pc.fillNameCell) reset(r + 1, nameCol);
          cols.forEach(c => reset(r + 1, c));
        }
      }
    });
  });

  applyCells(sheet, fills, opts, 'background');
  applyCells(sheet, fonts, opts, 'fontColor');
}

function shadeGradient(sheet, opts, ctx, grid, blocks) {
  const dir = METRIC_DIRECTION[opts.metric];
  if (!dir) return;

  const cs = CONFIG.colorScale;
  const cells = [];
  const fonts = [];
  const down = opts.orientation === 'playersDown';

  // Everything in a player's row that the gradient itself does not rank:
  // the accuracy row beneath, and the name cell.
  blocks.forEach(block => {
    const cols = Object.keys(block.cols).map(Number);

    eachPlayerRow(grid, block, opts, ctx, r => {
      if (cs.nameCellColor) {
        cells.push({ r: r, c: opts.nameLine - 1, value: cs.nameCellColor });
        fonts.push({ r: r, c: opts.nameLine - 1, value: CONFIG.defaultInk });
      }
      if (cs.percentRowColor && down) {
        if (cs.nameCellColor) {
          cells.push({ r: r + 1, c: opts.nameLine - 1, value: cs.percentRowColor });
          fonts.push({ r: r + 1, c: opts.nameLine - 1, value: CONFIG.defaultInk });
        }
        cols.forEach(c => {
          cells.push({ r: r + 1, c: c, value: cs.percentRowColor });
          fonts.push({ r: r + 1, c: c, value: CONFIG.defaultInk });
        });
      }
    });
  });

  // Score cells, ranked within their group.
  const groups = {};
  blocks.forEach((block, bi) => {
    eachScoreCell(grid, block, opts, ctx, (r, c) => {
      const key = (cs.scope === 'sheet' ? '' : bi + '|') + block.cols[c];
      (groups[key] = groups[key] || []).push({ r: r, c: c, value: grid[r][c] });
    });
  });

  Object.keys(groups).forEach(key => {
    const entries = groups[key];
    const scored = entries.filter(e => isNum(e.value));

    entries.forEach(e => {
      fonts.push({ r: e.r, c: e.c, value: CONFIG.defaultInk });   // pastels always take black

      if (!isNum(e.value)) {
        if (cs.blankColor !== 'keep') {
          cells.push({ r: e.r, c: e.c, value: cs.blankColor === 'reset' ? null : cs.blankColor });
        }
        return;
      }
      if (scored.length < 2) {
        if (cs.singleValue === 'mid') cells.push({ r: e.r, c: e.c, value: cs.mid });
        return;
      }

      const nums = scored.map(x => Number(x.value));
      const min = Math.min.apply(null, nums);
      const max = Math.max.apply(null, nums);

      let t = max === min ? 0.5 : (Number(e.value) - min) / (max - min);
      if (dir < 0) t = 1 - t;
      cells.push({ r: e.r, c: e.c, value: scaleColor(t, cs) });
    });
  });

  applyCells(sheet, cells, opts, 'background');
  applyCells(sheet, fonts, opts, 'fontColor');
}

function scaleColor(t, cs) {
  t = Math.max(0, Math.min(1, t));
  return t <= 0.5
    ? lerpHex(cs.low, cs.mid, t * 2)
    : lerpHex(cs.mid, cs.high, (t - 0.5) * 2);
}

function lerpHex(a, b, t) {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  const mix = i => Math.round(ca[i] + (cb[i] - ca[i]) * t);
  return '#' + [mix(0), mix(1), mix(2)]
    .map(v => ('0' + v.toString(16)).slice(-2)).join('').toUpperCase();
}

function readableInk(hex) {
  const c = hexToRgb(hex);
  const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return lum < 140 ? '#FFFFFF' : '#000000';
}

/** Accepts "#RGB", "#RRGGBB", or bare hex with no hash. */
function normHex(raw) {
  let v = String(raw || '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(v)) v = v[0] + v[0] + v[1] + v[1] + v[2] + v[2];
  return /^[0-9a-fA-F]{6}$/.test(v) ? '#' + v.toUpperCase() : null;
}

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)];
}

function isNum(v) {
  return v !== '' && v !== null && v !== undefined && !isNaN(Number(v));
}

// ===========================================================================
//  Writing back
// ===========================================================================

/** kind: 'value' | 'note' | 'background' | 'fontColor' | 'fontLine' */
function applyCells(sheet, cells, opts, kind) {
  if (!cells.length) return;
  const flip = opts.orientation === 'mapsDown';

  const byRow = {};
  cells.forEach(cell => {
    const row = (flip ? cell.c : cell.r) + 1;
    const col = (flip ? cell.r : cell.c) + 1;
    if (row < 1 || col < 1) return;
    (byRow[row] = byRow[row] || []).push({ col: col, value: cell.value });
  });

  Object.keys(byRow).forEach(row => {
    const items = byRow[row].sort((a, b) => a.col - b.col);
    let run = [items[0]];
    for (let i = 1; i <= items.length; i++) {
      if (i < items.length && items[i].col === run[run.length - 1].col + 1) {
        run.push(items[i]);
      } else {
        writeRun(sheet, Number(row), run, kind);
        if (i < items.length) run = [items[i]];
      }
    }
  });
}

/**
 * Writes one contiguous run. A protected range throws; skip that run rather
 * than aborting the refresh.
 *
 * Every kind is matched explicitly and an unknown kind writes NOTHING. An
 * earlier version fell through to setValues() for unrecognised kinds, which
 * meant a formatting instruction like 'none' could be written into cells as
 * content. Formatting must never be able to become data.
 */
function writeRun(sheet, row, run, kind) {
  const vals = [run.map(x => x.value)];
  try {
    const range = sheet.getRange(row, run[0].col, 1, run.length);
    switch (kind) {
      case 'value':      range.setValues(vals); break;
      case 'note':       range.setNotes(vals); break;
      case 'background': range.setBackgrounds(vals); break;
      case 'fontColor':  range.setFontColors(vals); break;
      case 'fontLine':   range.setFontLines(vals); break;
      default:
        console.error('Unknown write kind "' + kind + '" - nothing written.');
        return;
    }
  } catch (err) {
    SKIPPED++;
    console.warn('Skipped ' + kind + ' on ' + sheet.getName() + ' row ' + row + ': ' + err.message);
  }
}

function transpose(m) {
  const width = m.reduce((w, r) => Math.max(w, r.length), 0);
  const out = [];
  for (let c = 0; c < width; c++) out.push(m.map(r => (c < r.length ? r[c] : '')));
  return out;
}

// ===========================================================================
//  Named cells
// ===========================================================================

function writeStatus(ss, text) {
  const range = ss.getRangeByName(CONFIG.statusRangeName);
  if (!range) return;
  try { range.setValue(text); } catch (err) { /* protected */ }
}

function formatNow(ss) {
  return Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'MMM d, h:mm a');
}

// ===========================================================================
//  Percentage formulas
// ===========================================================================

/**
 * Rebuilds every percentage formula from the block structure:
 *
 *   =IF(C33="","",FIXED(100*(C33/(SONGINFO!B$4)), 2)&"%")
 *
 * The score reference is the cell directly above, and the SONGINFO row is
 * pinned with $ so duplicating a block cannot shift it. Copying a block down
 * N rows otherwise drags a relative SONGINFO!B4 to SONGINFO!B(4+N), which
 * divides by an empty cell and yields #DIV/0!.
 *
 * Safe to re-run; it only writes where the formula differs from the target.
 */
function repairPercentFormulas() {
  const ss = SpreadsheetApp.getActive();
  const ctx = buildContext(ss, true);
  let changed = 0, checked = 0;

  resolveSheets(ss).forEach(spec => {
    if (spec.opts.orientation !== 'playersDown') return;

    const sheet = spec.sheet;
    const grid = readGrid(sheet, spec.opts);
    const blocks = findBlocks(grid, ctx.mapIds, spec.opts);
    if (!blocks.length) return;

    const formulas = sheet.getDataRange().getFormulas();

    blocks.forEach(block => {
      const cols = Object.keys(block.cols).map(Number);

      eachPlayerRow(grid, block, spec.opts, ctx, r => {
        const pctRow = r + 1;
        if (pctRow >= formulas.length) return;

        cols.forEach(c => {
          const existing = formulas[pctRow][c];
          if (!existing || existing.charAt(0) !== '=') return;   // not a formula cell
          checked++;

          const scoreRef = sheet.getRange(r + 1, c + 1).getA1Notation();
          const infoCol = columnLetter(c + 1 + CONFIG.songInfoColOffset);
          if (!infoCol) return;

          const target = '=IF(' + scoreRef + '="","",FIXED(100*(' + scoreRef + '/(' +
                         CONFIG.songInfoSheet + '!' + infoCol + '$' + CONFIG.songInfoRow +
                         ')), 2)&"%")';

          if (normFormula(existing) === normFormula(target)) return;

          try {
            sheet.getRange(pctRow + 1, c + 1).setFormula(target);
            changed++;
          } catch (err) {
            console.warn('Could not rewrite ' + sheet.getName() + ' row ' + (pctRow + 1) + ': ' + err.message);
          }
        });
      });
    });
  });

  ss.toast('Checked ' + checked + ' percentage cells, rewrote ' + changed + '.', 'BeatLeader', 8);
}

function normFormula(f) { return String(f).replace(/\s+/g, '').toUpperCase(); }

function columnLetter(n) {
  if (n < 1) return null;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = (n - m - 1) / 26;
  }
  return s;
}

/**
 * Lists score cells holding a value that the API has no score for.
 *
 * With preserveManual: 'auto' these are almost always legitimate hand-entered
 * scores, since the script now clears its own leftovers. Anything here that
 * you did not type yourself predates linkReplays and is worth checking.
 */
function findUnverifiedScores() {
  const ss = SpreadsheetApp.getActive();
  const ctx = buildContext(ss);
  const boards = fetchLeaderboards(dedupe(values(ctx.mapIds)));
  const found = [];

  resolveSheets(ss).forEach(spec => {
    const sheet = spec.sheet;
    const grid = readGrid(sheet, spec.opts);
    const blocks = findBlocks(grid, ctx.mapIds, spec.opts);

    blocks.forEach(block => {
      eachScoreCell(grid, block, spec.opts, ctx, (r, c, key) => {
        const value = grid[r][c];
        if (!isNum(value)) return;

        const board = boards[ctx.mapIds[block.cols[c]]];
        if (board && board.byPlayer[ctx.playerIds[key]]) return;   // API confirms it

        const flip = spec.opts.orientation === 'mapsDown';
        const a1 = sheet.getRange((flip ? c : r) + 1, (flip ? r : c) + 1).getA1Notation();
        found.push(sheet.getName() + '!' + a1 + '  ' +
                   grid[r][spec.opts.nameLine - 1] + ' / ' + block.cols[c] + '  = ' + value);
      });
    });
  });

  const ui = SpreadsheetApp.getUi();
  ui.alert('Unverified scores',
    found.length
      ? found.length + ' cell(s) hold a score BeatLeader has no record of.\n' +
        'Hand-entered scores are expected here. Anything else is likely left over\n' +
        'from copying a block, or predates replay links.\n\n' + found.join('\n')
      : 'Every score in the sheet matches a BeatLeader score.',
    ui.ButtonSet.OK);
}

/**
 * Clears score cells holding text that cannot be a score - for example the
 * word "none" left behind by a bad write. Numeric values and empty cells are
 * never touched, so hand-entered scores are safe.
 */
function clearJunkScores() {
  const ss = SpreadsheetApp.getActive();
  const ctx = buildContext(ss, true);
  const found = [];

  resolveSheets(ss).forEach(spec => {
    const sheet = spec.sheet;
    const grid = readGrid(sheet, spec.opts);
    const blocks = findBlocks(grid, ctx.mapIds, spec.opts);
    const cells = [];

    blocks.forEach(block => {
      eachScoreCell(grid, block, spec.opts, ctx, (r, c) => {
        const v = grid[r][c];
        if (v === '' || v === null || v === undefined) return;
        if (isNum(v)) return;                       // a real score
        if (v instanceof Date) return;

        cells.push({ r: r, c: c, value: '' });
        const flip = spec.opts.orientation === 'mapsDown';
        found.push(sheet.getName() + '!' +
                   sheet.getRange((flip ? c : r) + 1, (flip ? r : c) + 1).getA1Notation() +
                   ' = ' + v);
      });
    });

    if (cells.length) applyCells(sheet, cells, spec.opts, 'value');
  });

  const ui = SpreadsheetApp.getUi();
  ui.alert('Clear junk scores',
    found.length ? 'Cleared ' + found.length + ' cell(s):\n\n' + found.join('\n')
                 : 'No non-numeric values found in any score cell.',
    ui.ButtonSet.OK);
}

// ===========================================================================
//  Max scores
// ===========================================================================

function syncSongInfo(ss, ctx, boards) {
  const info = ss.getSheetByName(CONFIG.songInfoSheet);
  const source = ss.getSheetByName(CONFIG.songInfoSourceSheet);
  if (!info || !source) return 0;

  const opts = CONFIG.defaults;
  const blocks = findBlocks(readGrid(source, opts), ctx.mapIds, opts);

  const byCol = {};
  blocks.forEach(block => {
    Object.keys(block.cols).forEach(c => {
      const board = boards[ctx.mapIds[block.cols[c]]];
      if (!board || board.maxScore == null) return;
      const target = Number(c) + 1 + CONFIG.songInfoColOffset;
      if (target >= 1) byCol[target] = board.maxScore;
    });
  });

  const cols = Object.keys(byCol).map(Number).sort((a, b) => a - b);
  if (!cols.length) return 0;

  let run = [cols[0]];
  for (let i = 1; i <= cols.length; i++) {
    if (i < cols.length && cols[i] === run[run.length - 1] + 1) {
      run.push(cols[i]);
    } else {
      try {
        info.getRange(CONFIG.songInfoRow, run[0], 1, run.length)
            .setValues([run.map(c => byCol[c])]);
      } catch (err) {
        console.warn('SONGINFO write skipped: ' + err.message);
      }
      if (i < cols.length) run = [cols[i]];
    }
  }
  return cols.length;
}

function updateSongInfo() {
  const ss = SpreadsheetApp.getActive();
  const ctx = buildContext(ss, true);
  const boards = fetchLeaderboards(dedupe(values(ctx.mapIds)));
  ss.toast('Updated ' + syncSongInfo(ss, ctx, boards) + ' max scores.', 'BeatLeader', 5);
}

// ===========================================================================
//  API
// ===========================================================================

function fetchLeaderboards(ids) {
  const out = {};
  let pending = ids.filter(Boolean).map(id => ({ id: id, page: 1 }));

  while (pending.length) {
    const requests = pending.map(p => ({
      url: API + '/leaderboard/' + encodeURIComponent(p.id) + '?count=' + PAGE_SIZE + '&page=' + p.page,
      muteHttpExceptions: true,
    }));
    const responses = UrlFetchApp.fetchAll(requests);
    const next = [];

    responses.forEach((res, i) => {
      const p = pending[i];
      const code = res.getResponseCode();
      if (code === 429) { next.push(p); return; }
      if (code !== 200) return;

      const data = JSON.parse(res.getContentText());
      const scores = data.scores || [];

      let entry = out[p.id];
      if (!entry) {
        entry = out[p.id] = {
          label: labelFor(data),
          maxScore: (data.difficulty || {}).maxScore,
          byPlayer: {},
        };
      }
      scores.forEach(s => { entry.byPlayer[String(s.playerId)] = s; });
      if (scores.length === PAGE_SIZE) next.push({ id: p.id, page: p.page + 1 });
    });

    pending = next;
    if (pending.length) Utilities.sleep(300);
  }
  return out;
}

function labelFor(data) {
  const song = data.song || {};
  const diff = data.difficulty || {};
  return [song.name, song.subName].filter(Boolean).join(' ') +
         ' [' + diff.difficultyName + '/' + diff.modeName + ']' +
         (song.mapper ? ' - ' + song.mapper : '');
}

function extractMetric(s, metric) {
  switch (metric) {
    case 'modifiedScore': return s.modifiedScore;
    case 'acc':           return Math.round(s.accuracy * 10000) / 100;
    case 'pp':            return s.pp;
    case 'rank':          return s.rank;
    case 'scoreId':       return s.id;
    case 'modifiers':     return s.modifiers || '';
    case 'date':          return new Date(Number(s.timeset) * 1000);
    default:              return s.baseScore;
  }
}

function parseLeaderboardId(raw) {
  const v = String(raw || '').trim();
  const m = v.match(/leaderboard\/(?:global\/)?([A-Za-z0-9]+)/);
  return m ? m[1] : v;
}

function resolvePlayerId(raw) {
  let v = String(raw || '').trim();
  if (CONFIG.skipIds.indexOf(v.toUpperCase()) !== -1) return null;

  const m = v.match(/\/u\/([^/?#]+)/);
  if (m) v = m[1];
  if (/^\d{5,}$/.test(v)) return v;

  const cache = CacheService.getScriptCache();
  const cached = cache.get('blp_' + v);
  if (cached) return cached;

  const res = UrlFetchApp.fetch(API + '/player/' + encodeURIComponent(v), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;

  const id = String(JSON.parse(res.getContentText()).id);
  cache.put('blp_' + v, id, 21600);
  return id;
}

// ===========================================================================
//  Config reading
// ===========================================================================

/**
 * Reads the Config sheet once and returns a lookup builder. Columns are found
 * by header text, so inserting or moving columns needs no code change.
 *
 *   const table = readConfigSheet(ss, notes);
 *   const players = table('Players', 'PlayerID');   // { name: id }
 */
function readConfigSheet(ss, notes) {
  const sheet = ss.getSheetByName(CONFIG.configSheet);
  if (!sheet) throw new Error('No sheet named "' + CONFIG.configSheet + '".');

  const all = sheet.getDataRange().getValues();
  const headerRow = all[CONFIG.configHeaderRow - 1] || [];

  const index = {};
  headerRow.forEach((h, i) => {
    const key = norm(h);
    if (key && index[key] === undefined) index[key] = i;
  });

  return function (keyHeader, valueHeader) {
    const kc = index[norm(keyHeader)];
    const vc = index[norm(valueHeader)];
    if (kc === undefined) { notes.push('Config has no "' + keyHeader + '" column'); return {}; }
    if (vc === undefined) { notes.push('Config has no "' + valueHeader + '" column'); return {}; }

    const out = {};
    for (let r = CONFIG.configHeaderRow; r < all.length; r++) {
      const name = String(all[r][kc] == null ? '' : all[r][kc]).trim();
      const val = String(all[r][vc] == null ? '' : all[r][vc]).trim();
      if (name && val) out[name.toLowerCase()] = val;
    }
    return out;
  };
}

// ===========================================================================
//  Helpers
// ===========================================================================

function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function values(obj) { return Object.keys(obj).map(k => obj[k]); }
function dedupe(arr) {
  const seen = {}, out = [];
  arr.forEach(v => { if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
  return out;
}

// ===========================================================================
//  Delegated refresh
//
//  An installable onEdit trigger runs under the authority of whoever installed
//  it, not whoever did the editing. Install it once and teammates can trigger
//  a refresh without ever authorizing anything.
//
//    Apps Script editor -> Triggers -> Add trigger
//      function: onCheckboxRefresh   event source: From spreadsheet
//      event type: On edit
//
//  Then name a checkbox cell BL_Refresh via Data -> Named ranges.
// ===========================================================================

function onCheckboxRefresh(e) {
  if (!e || !e.range) return;

  const target = SpreadsheetApp.getActive().getRangeByName(CONFIG.refreshRangeName);
  if (!target) return;
  if (e.range.getSheet().getName() !== target.getSheet().getName()) return;
  if (e.range.getA1Notation() !== target.getA1Notation()) return;
  if (e.range.getValue() !== true) return;              // only on tick, not untick

  try {
    refreshScores();
  } finally {
    e.range.setValue(false);
  }
}

// ===========================================================================
//  Web app refresh
//
//  Deploy this so people with VIEW-ONLY access can refresh, without
//  authorizing anything and without being given edit rights.
//
//    Apps Script editor -> Deploy -> New deployment -> Web app
//      Execute as:      Me
//      Who has access:  Anyone with a Google account
//
//  Copy the /exec URL. Put it in the sheet as a link:
//      =HYPERLINK("https://script.google.com/.../exec", "UPDATE SCORES")
//  or attach it to a drawing via Insert -> Drawing -> Link.
//
//  "Execute as: Me" is what makes this work - the refresh runs under your
//  authorization no matter who opens the link.
// ===========================================================================

function doGet(e) {
  let message, ok = true;
  try {
    const written = refreshScores();
    message = 'Updated ' + written + ' scores.';
  } catch (err) {
    ok = false;
    message = 'Refresh failed: ' + err.message;
  }
  SpreadsheetApp.flush();

  const colour = ok ? '#1E7B3C' : '#A32D2D';
  const html =
    '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;' +
    'justify-content:center;height:90vh;margin:0;text-align:center}' +
    'div{max-width:22rem}h1{font-size:1.25rem;color:' + colour + ';margin:0 0 .5rem}' +
    'p{color:#555;font-size:.9rem;margin:0}</style></head><body><div>' +
    '<h1>' + (ok ? 'Scores refreshed' : 'Something went wrong') + '</h1>' +
    '<p>' + message + '</p><p style="margin-top:1rem">You can close this tab and reload the sheet.</p>' +
    '</div></body></html>';

  return HtmlService.createHtmlOutput(html).setTitle('BeatLeader refresh');
}

// ===========================================================================
//  Trigger setup
//
//  These need one extra OAuth scope in appsscript.json:
//    "https://www.googleapis.com/auth/script.scriptapp"
//
//  If you would rather not grant it, create the triggers by hand instead
//  (Apps Script editor -> Triggers -> Add trigger) and delete this section:
//    refreshScores       Time-driven        Hour timer, every hour
//    onCheckboxRefresh   From spreadsheet   On edit
// ===========================================================================

/** Creates both triggers, replacing any this script already owns. */
function installTriggers() {
  const ss = SpreadsheetApp.getActive();

  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'refreshScores' || fn === 'onCheckboxRefresh') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('refreshScores').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('onCheckboxRefresh').forSpreadsheet(ss).onEdit().create();

  SpreadsheetApp.getUi().alert('Triggers installed',
    'Hourly refresh and checkbox refresh are now active.\n\n' +
    'They run as the account you are signed in with right now, so their\n' +
    'permissions are yours - protected ranges will not block them.',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

/** Reports what is installed and who owns it. */
function checkTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  const lines = triggers.length
    ? triggers.map(t => {
        const src = String(t.getEventType());
        return t.getHandlerFunction() + '  -  ' + src +
               (src === 'CLOCK' ? ' (time-driven)' : '');
      })
    : ['No triggers installed. Nothing will run on its own.'];

  lines.push('');
  lines.push('This lists only triggers owned by the account you are signed in');
  lines.push('with. A trigger installed by another editor will not appear here,');
  lines.push('and runs with their permissions, not yours.');

  SpreadsheetApp.getUi().alert('Trigger status', lines.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
}