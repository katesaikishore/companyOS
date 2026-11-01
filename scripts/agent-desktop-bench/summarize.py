#!/usr/bin/env python3
"""Prints every figure used in docs/research/agent-desktop-performance.md, computed from the raw data files.
It stops with an assertion if a statement made in the record stops being true of the data (for example that every program
press reported ok, or that the production stage lost no window).
Usage: summarize.py DATA_DIR      (DATA_DIR is docs/research/agent-desktop-bench-data)"""
import json, math, statistics, sys

data_dir = sys.argv[1]
template_path = '-'
load = lambda name: json.load(open(f'{data_dir}/{name}.json'))
FINAL = [load('run-1'), load('run-2')]
EARLIER = {k: load(k) for k in ('earlier-run-1', 'earlier-run-2', 'earlier-run-3', 'earlier-run-4')}
NAMES = load('names-with-error-codes')
PRESS = ['production', 'agent-desktop-press', 'press-headless', 'press-headed']
PROGRAM_PRESS = PRESS[1:]
V = {}


def rank(xs, q):
    s = sorted(xs)
    return s[max(0, math.ceil(q * len(s)) - 1)]


def r1(x):
    return f'{x:.1f}'


def n(x):
    return f'{x:,}'


def trials_of(runs, stage):
    return [t for d in runs for t in d['stages'][stage]['perTrial']]


def tally(runs, stage):
    ts = trials_of(runs, stage)
    lost = [t for t in ts if t['diedAtCall'] is not None]
    last_nokey = sum(1 for t in lost if t['calls'][-1]['pressOk'] and t['calls'][-1]['keys'] == 0)
    last_key = sum(1 for t in lost if t['calls'][-1]['pressOk'] and t['calls'][-1]['keys'] >= 1)
    at = sorted(t['diedAtCall'] for t in lost)
    return {
        'trials': len(ts), 'lost': len(lost), 'calls': sum(t['callsMade'] for t in ts),
        'ok': sum(t['pressOk'] for t in ts), 'keys': sum(t['keysDelivered'] for t in ts),
        'at': at, 'median_at': statistics.median(at) if at else None,
        'sigsegv': sum(1 for t in lost if (t['exit'] or {}).get('signal') == 'SIGSEGV'),
        'fault_reported': sum(1 for t in lost if t['faulthandlerReportedFatalError']),
        'nokey': last_nokey, 'withkey': last_key,
        'one_key_every_call': all(c['keys'] == 1 for t in ts for c in t['calls']) if not lost else None,
    }


def pooled(runs, stage, field):
    xs = [c[field] for t in trials_of(runs, stage) for c in t['calls'] if c['i'] > 1 and field in c]
    return {'n': len(xs), 'p50': rank(xs, .5), 'p90': rank(xs, .9), 'min': min(xs), 'max': max(xs)}


def fmt_median(x):
    return str(int(x)) if x == int(x) else str(x)


# ---- final pair
T = {s: tally(FINAL, s) for s in PRESS}
for s in PRESS:
    key = s.upper().replace('-', '_')
    t = T[s]
    for k in ('trials', 'lost', 'calls', 'ok', 'keys', 'sigsegv', 'fault_reported', 'nokey', 'withkey'):
        V[f'{key}_{k.upper()}'] = n(t[k])
    V[f'{key}_RANGE'] = f"{t['at'][0]} to {t['at'][-1]}" if t['at'] else 'not lost'
    V[f'{key}_MEDIAN'] = fmt_median(t['median_at']) if t['at'] else 'not lost'
    V[f'{key}_AT_SORTED'] = ', '.join(map(str, t['at']))
prog = {k: sum(T[s][k] for s in PROGRAM_PRESS) for k in ('trials', 'lost', 'calls', 'ok', 'nokey', 'withkey')}
V['PROGRAM_TRIALS'] = str(prog['trials']); V['PROGRAM_LOST'] = str(prog['lost'])
V['PROGRAM_CALLS'] = n(prog['calls']); V['PROGRAM_OK'] = n(prog['ok'])
V['PROGRAM_NOKEY'] = str(prog['nokey']); V['PROGRAM_WITHKEY'] = str(prog['withkey'])
V['PROGRAM_SIGSEGV'] = str(sum(T[s]['sigsegv'] for s in PROGRAM_PRESS))
V['PROGRAM_FAULT_REPORTED'] = str(sum(T[s]['fault_reported'] for s in PROGRAM_PRESS))
all_at = sorted(a for s in PROGRAM_PRESS for a in T[s]['at'])
V['PROGRAM_EARLIEST'] = str(all_at[0])
meds = [T[s]['median_at'] for s in PROGRAM_PRESS if T[s]['at']]
V['PROGRAM_MEDIAN_LOW'] = fmt_median(min(meds)); V['PROGRAM_MEDIAN_HIGH'] = fmt_median(max(meds))
assert prog['ok'] == prog['calls'], 'a program press did not report ok: the template says every one did'
assert T['production']['ok'] == T['production']['calls'], 'a production press did not report ok'
assert T['production']['lost'] == 0, 'the production stage lost a window: the template wording must change'
assert T['production']['one_key_every_call'] is True, 'a production press did not log exactly one key'

pf = pooled(FINAL, 'production', 'focusMs'); pp = pooled(FINAL, 'production', 'pressMs')
together = [c['focusMs'] + c['pressMs'] for t in trials_of(FINAL, 'production') for c in t['calls'] if c['i'] > 1]
V['PROD_FOCUS'] = f"{r1(pf['p50'])} / {r1(pf['p90'])}"; V['PROD_PRESS'] = f"{r1(pp['p50'])} / {r1(pp['p90'])}"
V['PROD_TOGETHER'] = f"{r1(rank(together, .5))} / {r1(rank(together, .9))}"
V['PROD_TOGETHER_P50'] = f"{rank(together, .5):.0f}"
slow_p = max(c['pressMs'] for t in trials_of(FINAL, 'production') for c in t['calls'])
slow_f = max(c['focusMs'] for t in trials_of(FINAL, 'production') for c in t['calls'])
V['PROD_SLOWEST_PRESS'] = r1(slow_p); V['PROD_SLOWEST_FOCUS'] = r1(slow_f)
V['PROD_FOCUS_CALLS'] = n(T['production']['calls'])
fails = []
for ri, d in enumerate(FINAL, 1):
    for t in d['stages']['production']['perTrial']:
        for c in t['calls']:
            if not c['focusOk']:
                fails.append((ri, t['trial'], c['i'], c['focusMs'], c['pressOk'], c['keys']))
V['PROD_FOCUS_FAILS'] = str(len(fails))
V['PROD_FOCUS_FAIL_TEXT'] = '; '.join(f'run {r}, trial {tr}, call {i}: {r1(ms)} ms, press then {"ok" if po else "not ok"}, {k} key logged' for r, tr, i, ms, po, k in fails) or 'none'
V['PROD_PRESS_OK_NOTE'] = n(T['production']['ok']) + (f" (focus failed {len(fails)} time{'s' if len(fails) != 1 else ''})" if fails else '')

ap = pooled(FINAL, 'agent-desktop-press', 'pressMs'); hl = pooled(FINAL, 'press-headless', 'pressMs'); hd = pooled(FINAL, 'press-headed', 'pressMs')
V['AD_TIME'] = f"{r1(ap['p50'])} / {r1(ap['p90'])}"; V['HL_TIME'] = f"{r1(hl['p50'])} / {r1(hl['p90'])}"; V['HD_TIME'] = f"{r1(hd['p50'])} / {r1(hd['p90'])}"

# by-run lists for each press path (final pair)
def by_run(stage):
    parts = []
    for ri, d in enumerate(FINAL, 1):
        ts = d['stages'][stage]['perTrial']
        lost = [(t['trial'], t['diedAtCall']) for t in ts if t['diedAtCall'] is not None]
        surv = [t['trial'] for t in ts if t['diedAtCall'] is None]
        txt = f"run {ri}: {len(lost)} of {len(ts)} lost the window"
        if lost:
            txt += ' (trial ' + ', '.join(str(a) for a, _ in lost) + ' at call ' + ', '.join(str(b) for _, b in lost) + ')'
        if surv:
            txt += '; trial ' + ', '.join(map(str, surv)) + ' made all 60 presses'
        parts.append(txt)
    return '; '.join(parts)
V['AD_BY_RUN'] = by_run('agent-desktop-press'); V['HL_BY_RUN'] = by_run('press-headless'); V['HD_BY_RUN'] = by_run('press-headed')

# ---- CLI table (final pair)
rows = []
for i, row in enumerate(FINAL[0]['stages']['cli']['rows']):
    r2 = FINAL[1]['stages']['cli']['rows'][i]
    name = row['command'].replace(' python3.12', '')
    rows.append(f"| `{name}` | {r1(row['p50'])} / {r1(row['p90'])} | {r1(r2['p50'])} / {r1(r2['p90'])} |")
V['CLI_TABLE'] = '\n'.join(rows)
assert all(r['ok'] == r['of'] for d in FINAL for r in d['stages']['cli']['rows']), 'a cli call was not ok'
V['CLI_CALLS_PER_RUN'] = str(5 * (1 + 30))
V['CLI_SURVIVED_FINAL'] = 'in both runs' if all(d['stages']['cli']['windowSurvived'] for d in FINAL) else 'NOT IN ALL RUNS'
assert all(d['stages']['cli']['windowSurvived'] for d in list(EARLIER.values()) + FINAL), 'a window died in a cli stage'

# ---- names (final pair and the codes run)
def names_rows(d):
    return [(r['name'], r['agentDesktopFocusOk'], r['builtInPressOk'], r['keysDelivered']) for r in d['stages']['names']['rows']]
base = names_rows(NAMES)
V['NAMES_SAME_IN_ALL'] = 'yes' if all(names_rows(d) == base for d in FINAL + list(EARLIER.values())) else 'NO'
assert V['NAMES_SAME_IN_ALL'] == 'yes'
codes = {r['name']: r['agentDesktopFocusError'] for r in NAMES['stages']['names']['rows']}
assert all(r['agentDesktopFocusError'] in (None, 'APP_NOT_FOUND') for r in NAMES['stages']['names']['rows'])
V['NAMES_FINAL_HAVE_CODES'] = 'yes' if all('agentDesktopFocusError' in r for d in FINAL for r in d['stages']['names']['rows']) else 'no'
final_codes = {r['name']: r['agentDesktopFocusError'] for d in FINAL for r in d['stages']['names']['rows']}
assert V['NAMES_FINAL_HAVE_CODES'] == 'yes' and final_codes == codes

# ---- earlier runs
E = list(EARLIER.values())
ET = {s: tally([d for d in E if s in d['stages']], s) for s in PRESS}
for s in PRESS:
    key = 'E_' + s.upper().replace('-', '_')
    for k in ('trials', 'lost', 'calls', 'ok', 'keys'):
        V[f'{key}_{k.upper()}'] = n(ET[s][k])
    V[f'{key}_RANGE'] = f"{ET[s]['at'][0]} to {ET[s]['at'][-1]}" if ET[s]['at'] else 'not lost'
    V[f'{key}_MEDIAN'] = fmt_median(ET[s]['median_at']) if ET[s]['at'] else 'not lost'
V['E_PROGRAM_TRIALS'] = str(sum(ET[s]['trials'] for s in PROGRAM_PRESS)); V['E_PROGRAM_LOST'] = str(sum(ET[s]['lost'] for s in PROGRAM_PRESS))
V['E_PROGRAM_CALLS'] = n(sum(ET[s]['calls'] for s in PROGRAM_PRESS)); V['E_PROGRAM_OK'] = n(sum(ET[s]['ok'] for s in PROGRAM_PRESS))
E_by = []
for name, d in EARLIER.items():
    if 'agent-desktop-press' in d['stages']:
        ts = d['stages']['agent-desktop-press']['perTrial']
        E_by.append(f"{name.replace('earlier-run-', 'earlier run ')}: " + ('all ' + str(len(ts)) if all(t['diedAtCall'] is not None for t in ts) else str(sum(t['diedAtCall'] is not None for t in ts)) + ' of ' + str(len(ts))) + ' lost, at calls ' + ', '.join(str(t['diedAtCall']) if t['diedAtCall'] is not None else 'none (60 presses made)' for t in ts))
V['E_AD_BY_RUN'] = '; '.join(E_by)
V['E_PRODUCTION_FOCUS_FAILS'] = str(sum(1 for d in E for t in d['stages']['production']['perTrial'] for c in t['calls'] if not c['focusOk']))

# ---- environment and loads
env = FINAL[0]['environment']
V['ENV_OS'] = env['os']; V['ENV_KERNEL'] = env['kernel']; V['ENV_CPU'] = env['cpu'].replace('Intel(R) Xeon(R) Processor @ ', 'an Intel Xeon at ')
V['ENV_LOGICAL_CPUS'] = str(env['logicalCpus']); V['ENV_MEM_GIB'] = f"{env['memoryMiB'] / 1024:.1f}"; V['ENV_MEM_MIB'] = n(env['memoryMiB'])
for k in ('node', 'agentDesktop', 'atSpi2Core', 'openbox', 'xdotool', 'xvfb', 'gtk', 'python'):
    V['ENV_' + k.upper()] = env[k]
assert all(FINAL[1]['environment'][k] == env[k] for k in ('os', 'kernel', 'node', 'gtk', 'python', 'xvfb', 'atSpi2Core', 'xdotool', 'openbox', 'agentDesktop'))
loads = [d['environment']['loadAverageAtStart'][0] for d in FINAL + E]
V['LOAD_RUNS'] = f"{min(loads):.1f} to {max(loads):.1f}"
stage_loads = [s['loadAverageAtStart'][0] for d in FINAL for k, s in d['stages'].items() if k in PRESS] + [d['stages']['cli']['loadAverage'][0] for d in FINAL]
V['LOAD_STAGES'] = f"{min(stage_loads):.1f} to {max(stage_loads):.1f}"
V['LOAD_NAMES_ONLY'] = f"{NAMES['environment']['loadAverageAtStart'][0]:.1f}"
starts = sorted(d['environment']['recordedAt'] for d in FINAL + E)
V['FIRST_START'] = starts[0][11:16]; V['LAST_START'] = starts[-1][11:16]
V['FINAL_RECORDED'] = ' and '.join(d['environment']['recordedAt'][11:16] for d in FINAL)
V['N_RUNS'] = str(len(FINAL + E))
cfg = FINAL[0]['config']
assert (cfg['trials'], cfg['calls'], cfg['cliCalls'], cfg['settleMs'], cfg['chord']) == (5, 60, 30, 150, 'ctrl+a')
assert all(d['config'] == cfg or {k: d['config'][k] for k in ('trials', 'calls', 'cliCalls', 'settleMs', 'chord')} == {k: cfg[k] for k in ('trials', 'calls', 'cliCalls', 'settleMs', 'chord')} for d in E)
V['MS_BETWEEN_PRESSES'] = f"{statistics.median(c['focusMs'] + c['pressMs'] + 150 for t in trials_of(FINAL, 'production') for c in t['calls'] if c['i'] > 1):.0f}"

# ---- extra figures used by the wording
V['LISTWIN_MS'] = f"{statistics.mean(d['stages']['cli']['rows'][2]['p50'] for d in FINAL):.0f}"
assert FINAL[0]['stages']['cli']['rows'][2]['command'].startswith('list-windows')
V['TOGETHER_SUM_OF_MEDIANS'] = r1(pf['p50'] + pp['p50'])
V['AD_P50'] = r1(ap['p50'])
V['PROD_FIRST_CALLS'] = str(T['production']['trials'])
V['PROD_FOCUS_AFTER_KEY'] = n(T['production']['calls'] - T['production']['trials'])
V['N_NAMES_RUNS'] = str(len(FINAL) + len(E) + 1)
fin_stage_loads = [d['stages'][k]['loadAverageAtStart'][0] for d in FINAL for k in PRESS] + [d['stages']['cli']['loadAverage'][0] for d in FINAL]
ear_stage_loads = [d['stages'][k]['loadAverageAtStart'][0] for d in E for k in PRESS if k in d['stages']] + [d['stages']['cli']['loadAverage'][0] for d in E]
V['LOAD_STAGES_FINAL'] = f"{min(fin_stage_loads):.1f} to {max(fin_stage_loads):.1f}"
V['LOAD_STAGES_EARLIER'] = f"{min(ear_stage_loads):.1f} to {max(ear_stage_loads):.1f}"
efails = []
for name, d in EARLIER.items():
    for t in d['stages']['production']['perTrial']:
        for c in t['calls']:
            if not c['focusOk']:
                efails.append(f"{name.replace('earlier-run-', 'earlier run ')}, trial {t['trial']}, call {c['i']}: {r1(c['focusMs'])} ms, and the press after it {'was ok and logged a key' if c['pressOk'] and c['keys'] == 1 else 'did not log exactly one key'}")
V['E_FOCUS_FAIL_TEXT'] = '; '.join(efails) if efails else 'none'
V['PROD_FOCUS_FAIL_FINAL'] = V['PROD_FOCUS_FAIL_TEXT'] if fails else 'none in the final pair'

def byrun_rows():
    out = []
    for label, stage in (('Program press with its own focus', 'agent-desktop-press'), ('`press`, headless', 'press-headless'), ('`press --headed`', 'press-headed')):
        for ri, d in enumerate(FINAL, 1):
            ts = d['stages'][stage]['perTrial']
            lost = [f"trial {t['trial']} at call {t['diedAtCall']}" for t in ts if t['diedAtCall'] is not None]
            kept = [f"trial {t['trial']}" for t in ts if t['diedAtCall'] is None]
            out.append(f"| {label} | {ri} | {len([t for t in ts if t['diedAtCall'] is not None])} of {len(ts)} | {', '.join(lost) or 'none'} | {', '.join(kept) or 'none'} |")
    return '\n'.join(out)
V['BYRUN_TABLE'] = byrun_rows()
for s, key in (('agent-desktop-press', 'AD'), ('press-headless', 'HL'), ('press-headed', 'HD')):
    t = T[s]
    V[f'{key}_NOKEY_OF'] = f"{t['nokey']} of {t['lost']}"
    V[f'{key}_LOST_OF'] = f"{t['lost']} of {t['trials']}"

if template_path == '-':
    for k in sorted(V):
        print(f'{k}: {V[k]}')
    sys.exit(0)
