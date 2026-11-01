import json, re, sys
# Each app's name tokens. A name is grounded when it contains one of the tokens of an app in the routine.
TOKENS = {
 'microsoft excel':['excel'], 'libreoffice calc':['calc','libreoffice'], 'microsoft word':['word'], 'pages':['pages'],
 'numbers':['numbers'], 'visual studio code':['code','visual'], 'pycharm':['pycharm'], 'xcode':['xcode'],
 'safari':['safari'], 'firefox':['firefox'], 'google chrome':['chrome'], 'telegram':['telegram'], 'whatsapp':['whatsapp'],
 'discord':['discord'], 'slack':['slack'], 'zoom':['zoom'], 'notion':['notion'], 'figma':['figma'],
 'obsidian':['obsidian'], 'thunderbird':['thunderbird'], 'microsoft teams':['teams'], 'microsoft outlook':['outlook'],
}
GENERIC = re.compile(r'\b(work|workflow|productivity|tools?|routine|daily|tasks?|meetings?|communication|collaboration)\b', re.I)
def routine_apps(steps):
    return [s.strip() for s in steps.split('>')]
def grounded(name, steps):
    low = name.lower()
    for app in routine_apps(steps):
        for tok in TOKENS.get(app, [app]):
            if re.search(r'(^|[^a-z])' + re.escape(tok) + r'([^a-z]|$)', low):
                return True
    return False
def score(path):
    d = json.load(open(path))['wideSample']['names']
    n = len(d)
    passes = [x for x in d if x['outcome'] == 'passes']
    names = [x['raw']['name'] for x in passes]
    clean = [x for x in passes if '_' not in x['raw']['name'] and not x['raw']['name'].isupper() and len(x['raw']['name']) > 2]
    gr = [x for x in clean if grounded(x['raw']['name'], x['steps'])]
    generic = [x for x in clean if GENERIC.search(x['raw']['name']) and not grounded(x['raw']['name'], x['steps'])]
    one = [x for x in passes if len(x['raw']['name'].split()) == 1]
    return dict(model=path, routines=n, passes=len(passes), pass_rate=round(len(passes)/n, 2), one_word=len(one),
                clean=len(clean), grounded_clean=len(gr), generic_only=len(generic),
                usable=len(gr) + len(generic), share_usable_of_all=round((len(gr) + len(generic)) / n, 2))
for p in sys.argv[1:]:
    print(json.dumps(score(p)))
