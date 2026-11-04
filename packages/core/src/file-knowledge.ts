/**
 * What a file is, compressed into a few typed facts read from its text by rules: the kind of document, the organisations
 * and people it names, the account it is about, the months it covers and the project folder it sits in. The facts are
 * the nodes of the file search's knowledge graph, and a short card of them leads the text the file's embedding is made
 * from, so a statement saved as OpTransactionHistory.pdf is found as an ICICI bank statement. No model reads the files:
 * the rules go through thousands of files in seconds, where the local language model would take hours.
 *
 * A fact is "kind:value", such as "type:bank statement", "org:icici bank", "person:priya shah", "email:priya@acme.com",
 * "account:1234" (the last four digits only), "period:2026-10" or "project:vendor deals". Values are lower case. The
 * first organisation named, where a document says who it is from, is its "org"; the others, such as the other banks in a
 * statement's transactions, are "mention"s, which tie a file to a question less.
 */

/** Raised whenever the rules change what they read, so the next pass reads every file's facts again. */
export const FACTS_VERSION = 1;

export type FactKind = 'type' | 'org' | 'mention' | 'person' | 'email' | 'account' | 'period' | 'project';

interface DocumentType {
  type: string;
  /** Other words people search with for this kind of document. */
  aliases: string[];
  /** Phrases that show a document is of this kind, and their weight. Each counts once, however often it appears. */
  cues: Array<[RegExp, number]>;
}

/** A document is of the kind whose cues weigh most, when they weigh at least this. */
const TYPE_THRESHOLD = 3;

const DOCUMENT_TYPES: DocumentType[] = [
  {
    type: 'bank statement',
    aliases: ['account statement', 'passbook', 'transaction history', 'transactions'],
    cues: [
      [/statement of accounts?|statement of transactions|account statement|transaction history|transaction details|passbook/, 3],
      [/opening balance|closing balance|available balance/, 2],
      // A statement's columns. Each counts once, so a receipt with a date and an account number is not a statement.
      [/\bwithdrawals?\b/, 1],
      [/\bdeposits?\b/, 1],
      [/\bnarration\b|\bvalue date\b|\btxn date\b|\btransaction (?:date|remarks)\b|\bcheque no|\bchq\b/, 1],
      [/\bifsc\b|\baccount no\b|\ba\/c no\b|\baccount number\b/, 1],
    ],
  },
  {
    type: 'credit card statement',
    aliases: ['card statement', 'credit card bill', 'card bill'],
    cues: [
      [/credit card statement|card statement/, 3],
      [/total amount due|minimum amount due|total dues/, 2],
      [/payment due date|credit limit/, 1],
      [/credit card/, 1],
    ],
  },
  {
    type: 'salary slip',
    aliases: ['payslip', 'pay slip', 'salary', 'slip', 'pay stub'],
    cues: [
      [/pay ?slip|salary slip|pay stub|salary statement/, 3],
      [/net pay|net salary|take home|gross earnings|total earnings|total deductions/, 2],
      [/\bbasic\b|\bhra\b|provident fund|professional tax|\bearnings\b|\bdeductions\b|pay period/, 1],
    ],
  },
  {
    type: 'invoice',
    aliases: ['bill', 'tax invoice'],
    cues: [
      [/tax invoice|invoice no|invoice number|invoice date|invoice #/, 3],
      [/\binvoice\b/, 1],
      [/\bgstin\b|\bbill to\b|\bhsn\b|\bsubtotal\b|\bamount due\b/, 1],
    ],
  },
  {
    type: 'receipt',
    aliases: ['payment receipt', 'acknowledgement'],
    cues: [
      [/payment receipt|e-receipt|\breceipt\b/, 2],
      [/transaction (?:successful|id|reference)|amount paid|payment successful|paid on|reference no/, 1],
    ],
  },
  {
    type: 'tax form',
    aliases: ['form 16', 'form16', 'itr', 'tax return', '26as', 'income tax'],
    cues: [
      [/form ?(?:no\.? ?)?16\b|form ?26as|income tax return|\bitr-?\d\b|assessment year/, 3],
      [/\btds\b|income tax|acknowledgement number/, 1],
    ],
  },
  {
    type: 'offer letter',
    aliases: ['offer', 'appointment letter', 'joining letter'],
    cues: [
      [/offer letter|letter of offer|pleased to offer|appointment letter|letter of appointment/, 3],
      [/date of joining|joining date|\bctc\b|cost to company/, 1],
    ],
  },
  {
    type: 'resume',
    aliases: ['cv', 'curriculum vitae', 'biodata'],
    cues: [
      [/curriculum vitae|\bresume\b|\brésumé\b/, 2],
      [/work experience|professional experience|employment history|professional summary/, 2],
      [/\beducation\b|\bskills\b|\bcertifications\b|linkedin\.com/, 1],
    ],
  },
  {
    type: 'rental agreement',
    aliases: ['rent agreement', 'lease', 'lease agreement', 'rental', 'rent', 'tenancy', 'leave and licence'],
    cues: [
      [/rent(?:al)? agreement|lease agreement|leave and licen[cs]e|tenancy agreement/, 3],
      [/\blessor\b|\blessee\b|\blicensor\b|\blicensee\b|\btenant\b|\blandlord\b|monthly rent|security deposit/, 2],
    ],
  },
  {
    type: 'agreement',
    aliases: ['contract', 'nda', 'non-disclosure agreement'],
    cues: [
      [/this agreement|agreement is made|non-disclosure agreement|deed of/, 3],
      [/hereinafter|witnesseth|in witness whereof/, 1],
    ],
  },
  {
    type: 'insurance policy',
    aliases: ['insurance', 'policy'],
    cues: [
      [/policy (?:number|no|schedule|document)|certificate of insurance/, 2],
      [/sum insured|sum assured|\bpremium\b|policyholder|\binsured\b/, 1],
    ],
  },
  {
    type: 'certificate',
    aliases: ['certification'],
    cues: [
      [/this is to certify|certificate of|certify that/, 3],
      [/\bcertificate\b|successfully completed|\bawarded\b/, 1],
    ],
  },
  // A form that asks for an Aadhaar or PAN number names it too, so the card itself needs the words printed on it.
  {
    type: 'aadhaar card',
    aliases: ['aadhaar', 'aadhar', 'adhar', 'uid'],
    cues: [
      [/\baadhaa?r\b/, 2],
      [/unique identification authority|\buidai\b/, 2],
      [/government of india|govt\.? of india/, 1],
      [/\bvid\b|enrol?ment no|mera aadhaar|आधार/, 1],
    ],
  },
  {
    type: 'pan card',
    aliases: ['pan'],
    cues: [
      [/permanent account number card|income tax department/, 2],
      [/government of india|govt\.? of india/, 1],
      [/permanent account number|\bpan\b/, 1],
    ],
  },
  {
    type: 'credit report',
    aliases: ['cibil', 'cibil report', 'credit score', 'credit information report'],
    cues: [[/\bcibil\b|credit information report|credit score|transunion|experian|equifax|\bcrif\b/, 3]],
  },
  { type: 'driving licence', aliases: ['driving license', 'licence', 'license', 'dl'], cues: [[/driving licen[cs]e|transport department/, 3]] },
  {
    type: 'ticket',
    aliases: ['boarding pass', 'flight', 'train', 'travel', 'itinerary', 'e-ticket'],
    cues: [
      [/boarding pass|e-ticket|electronic reservation slip|\bpnr\b|\bitinerary\b/, 3],
      [/\bdeparture\b|\barrival\b|\bseat\b|\bflight\b|\bcoach\b/, 1],
    ],
  },
  {
    type: 'utility bill',
    aliases: ['bill', 'electricity', 'electricity bill', 'phone bill', 'broadband'],
    cues: [
      [/electricity bill|water bill|gas bill|broadband bill|mobile bill|postpaid bill|bill of supply/, 3],
      [/consumer (?:no|number)|units consumed|bill amount|billing period/, 1],
    ],
  },
];

interface Institution {
  name: string;
  pattern: RegExp;
  /** Short names people search with, such as "sbi". */
  aliases: string[];
  /** Named in documents it did not issue, as a regulator or an insurer of deposits is, so it is only ever a mention. */
  neverIssuer?: boolean;
}

/**
 * Institutions that documents name in many spellings, kept as one node: "ICICI", "ICICI BANK LIMITED" and "icici bank"
 * are all "org:icici bank". Organisations not in the list are still found by the patterns below.
 */
const INSTITUTIONS: Institution[] = [
  // The insurers and brokers that share a bank's name are their own companies.
  { name: 'icici prudential', pattern: /\bicici prudential\b/, aliases: [] },
  { name: 'icici lombard', pattern: /\bicici lombard\b/, aliases: [] },
  { name: 'icici bank', pattern: /\bicici\b(?! (?:prudential|lombard|securities|direct))/, aliases: ['icici'] },
  { name: 'hdfc life', pattern: /\bhdfc life\b/, aliases: [] },
  { name: 'hdfc ergo', pattern: /\bhdfc ergo\b/, aliases: [] },
  { name: 'hdfc bank', pattern: /\bhdfc\b(?! (?:life|ergo|securities|mutual|amc|credila))/, aliases: ['hdfc'] },
  { name: 'state bank of india', pattern: /state bank of india|\bsbi\b/, aliases: ['sbi'] },
  { name: 'axis bank', pattern: /\baxis bank\b/, aliases: ['axis'] },
  { name: 'kotak mahindra bank', pattern: /\bkotak\b/, aliases: ['kotak'] },
  { name: 'south indian bank', pattern: /\bsouth indian bank\b/, aliases: [] },
  { name: 'indian bank', pattern: /(?<!south )\bindian bank\b/, aliases: [] },
  { name: 'canara bank', pattern: /\bcanara bank\b/, aliases: ['canara'] },
  { name: 'punjab national bank', pattern: /punjab national bank|\bpnb\b/, aliases: ['pnb'] },
  { name: 'bank of baroda', pattern: /bank of baroda/, aliases: ['baroda', 'bob'] },
  { name: 'union bank of india', pattern: /union bank of india/, aliases: ['union bank'] },
  { name: 'bank of india', pattern: /(?<!union )(?<!central )(?<!state )(?<!reserve )(?<!development )bank of india\b/, aliases: ['boi'] },
  { name: 'reserve bank of india', pattern: /reserve bank of india|\brbi\b/, aliases: ['rbi'], neverIssuer: true },
  { name: 'dicgc', pattern: /\bdicgc\b|deposit insurance and credit guarantee/, aliases: [], neverIssuer: true },
  { name: 'sidbi', pattern: /\bsidbi\b|small industries development bank/, aliases: [] },
  { name: 'central bank of india', pattern: /central bank of india/, aliases: [] },
  { name: 'indian overseas bank', pattern: /indian overseas bank/, aliases: ['iob'] },
  { name: 'yes bank', pattern: /\byes bank\b/, aliases: [] },
  { name: 'idfc first bank', pattern: /\bidfc\b/, aliases: ['idfc'] },
  { name: 'indusind bank', pattern: /\bindusind\b/, aliases: ['indusind'] },
  { name: 'federal bank', pattern: /\bfederal bank\b/, aliases: [] },
  { name: 'idbi bank', pattern: /\bidbi\b/, aliases: ['idbi'] },
  { name: 'rbl bank', pattern: /\brbl bank\b/, aliases: ['rbl'] },
  { name: 'au small finance bank', pattern: /au small finance bank/, aliases: ['au bank'] },
  { name: 'bandhan bank', pattern: /\bbandhan bank\b/, aliases: ['bandhan'] },
  { name: 'hsbc', pattern: /\bhsbc\b/, aliases: [] },
  { name: 'citibank', pattern: /\bciti ?bank\b/, aliases: ['citi'] },
  { name: 'standard chartered', pattern: /standard chartered/, aliases: [] },
  { name: 'american express', pattern: /american express|\bamex\b/, aliases: ['amex'] },
  { name: 'income tax department', pattern: /income tax department/, aliases: ['income tax'] },
  { name: 'uidai', pattern: /\buidai\b|unique identification authority/, aliases: [] },
  { name: 'epfo', pattern: /\bepfo\b|employees'? provident fund organi[sz]ation/, aliases: ['pf'] },
  { name: 'life insurance corporation of india', pattern: /life insurance corporation/, aliases: ['lic'] },
  { name: 'irctc', pattern: /\birctc\b/, aliases: [] },
];

/** The ending of a company's name, which is dropped from the node so "Acme Pvt Ltd" and "ACME LIMITED" are one. */
const COMPANY_END = /(?:\s+(?:private|pvt\.?|limited|ltd\.?|inc\.?|llp|llc|corp\.?|corporation|co\.?))+\.?$/;
const COMPANY = /\b((?:[A-Z][A-Za-z&.'-]+[ \t]+){1,4}(?:Bank|Limited|Ltd\.?|Pvt\.? Ltd\.?|Private Limited|Inc\.?|LLP|LLC|Corporation|Technologies|Solutions|Infotech|Systems|Services|Software|Consultancy))\b/g;
const COMPANY_CAPS = /\b((?:[A-Z][A-Z&.'-]+[ \t]+){1,4}(?:BANK|LIMITED|LTD\.?|PVT\.? LTD\.?|PRIVATE LIMITED|INC\.?|LLP|TECHNOLOGIES|SOLUTIONS|INFOTECH|SYSTEMS|SERVICES|SOFTWARE))(?![A-Za-z])/g;
/** Words that start a run of capitals without being part of a name, dropped from its front. */
const LEADING = new Set([
  'welcome', 'to', 'the', 'of', 'from', 'dear', 'your', 'by', 'at', 'in', 'for', 'and', 'with', 'statement', 'account', 'm/s', 'ms', 'mr', 'mrs',
  'thank', 'you', 'all', 'our', 'this', 'online', 'net', 'internet', 'mobile', 'beneficiary', 'remitter', 'payer', 'payee', 'issuing', 'partner',
  'other', 'any', 'nodal', 'sponsor', 'name', 'via', 'through', 'sender', 'receiver', 'customer', 'savings', 'current',
  'debit', 'credit', 'card', 'cards', 'care', 'support', 'help', 'banking', 'phone', 'toll', 'free',
]);
/** Capitalised words in a row, such as "Meeting With Priya Shah", which are split into names at the words below. */
const PROPER = /\b([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)+)\b/g;
/** A name after the words that introduce one, such as "Name: KATE SAI KISHORE" or "Dear Priya Shah". */
const NAMED = /(?:(?<!(?:branch|bank|company|employer|product|plan|scheme|file|user|account|father'?s?|mother'?s?|spouse)[ \t])\b[Nn]ame|\b[Dd]ear|\bM(?:r|s|rs)\.?|\bShri|\bSmt\.?)[ \t]*[:\-]?[ \t]*([A-Z][A-Za-z]+(?:[ \t]+[A-Z][A-Za-z]+){1,3})/g;
/**
 * Words that are never part of a person's name: small words, and the labels and headings documents are full of. A run of
 * capitalised words is split at them, and what is left of two to four words is a name.
 */
const NOT_A_NAME = new Set(
  (
    'a an the of and or for to from in on at by with about as is are be this that your our my his her their its into via per ' +
    'account accounts statement statements bank banking branch balance opening closing transaction transactions details date page total ' +
    'amount amounts tax taxes invoice income department government india indian limited ltd pvt private inc llp company corporation ' +
    'technologies technology solutions systems services service software infotech consultancy customer customers number no mobile email ' +
    'phone period summary report description address credit debit card cards payment payments receipt reference ref office dear sir ' +
    'madam regards thanks thank team terms conditions policy insurance salary pay net gross basic allowance form year month assessment ' +
    'certificate university college school institute hospital city state district road street nagar floor building block sector phase ' +
    'plot house name employee employer holder nominee signature authorised authorized signatory remarks withdrawal withdrawals deposit ' +
    'deposits value cheque narration particulars mode status type id serial quantity rate price item items unit units net due paid ' +
    'payable received upi neft imps rtgs atm interest charges fee fees welcome meeting new old north south east west earnings ' +
    'deductions deduction professional provident fund conveyance medical special bonus arrears leave hra lop gratuity ctc ' +
    'image images photo photos picture screen shot screenshot scan scanned whatsapp document documents file files copy final draft ' +
    'resume cv letter offer order purchase charge reverse unique identification authority application declaration nominee ' +
    'nadu pradesh bengal delhi mumbai bangalore bengaluru chennai hyderabad kolkata pune noida gurgaon gurugram koramangala'
  ).split(' '),
);
/** A line of a statement's transactions, which names a payment rail. Banks named there are the other side of a payment. */
const TRANSACTION_LINE = /\b(?:upi|neft|imps|rtgs|nach|ecs|atm|pos)\b/;
// The patterns below are bounded and start only at the start of a run, so a long run of letters or masks cannot make
// them try every position again: the rules read 20,000 characters in the app's main process.
const EMAIL = /(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,4}/g;
/** An account or card number, masked or not, after the words that introduce one. Only its last four digits are kept. */
const ACCOUNT = /\b(?:a\/c|acct|account|card)[ \t]*(?:no\.?|number|#)?[ \t]*[:.\-]?[ \t]*((?:[x*\d]{4}[ -]){3}\d{4}|[x*\d]{2,16}\d{4})\b/gi;
const MASKED = /(?<![\w*])[x*]{2,16}(\d{4})\b/gi;
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAY_FIRST = /\b(\d{1,2})[/.-](\d{1,2})[/.-]((?:19|20)?\d{2})\b/g;
const YEAR_FIRST = /\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/g;
const MONTH_WORD = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const NAMED_MONTH = new RegExp(`\\b${MONTH_WORD}\\b\\.?[ ,'-]{1,3}(?:\\d{1,2}(?:st|nd|rd|th)?[ ,'-]{1,3})?((?:19|20)\\d{2})\\b`, 'gi');
const DAY_NAMED_MONTH = new RegExp(`\\b\\d{1,2}[ -]${MONTH_WORD}\\b[ ,'-]{1,3}((?:19|20)?\\d{2})\\b`, 'gi');
const MONTH_ABBREVIATIONS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** How much of a file's text the rules read. Who issued a document and what it is are near its start. */
const READ_CHARS = 20_000;
const LIMITS: Record<FactKind, number> = { type: 1, org: 1, mention: 6, person: 6, email: 4, account: 2, period: 2, project: 3 };

function normaliseOrg(raw: string): string {
  const words = raw.toLowerCase().replace(/[^a-z0-9&.'\s-]/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
  while (words.length > 1 && LEADING.has(words[0])) words.shift();
  return words.join(' ').replace(COMPANY_END, '').replace(/[.'-]+$/, '').trim();
}

/** The kind of document the text shows, or undefined when no kind's cues weigh enough. */
export function documentType(text: string): string | undefined {
  const lower = text.toLowerCase();
  let best: { type: string; weight: number } | undefined;
  for (const kind of DOCUMENT_TYPES) {
    const weight = kind.cues.reduce((sum, [cue, value]) => sum + (cue.test(lower) ? value : 0), 0);
    if (weight >= TYPE_THRESHOLD && (!best || weight > best.weight)) best = { type: kind.type, weight };
  }
  return best?.type;
}

/** The months a text's dates fall in, most mentioned first, as "yyyy-mm". */
function periodsOf(text: string): string[] {
  const counts = new Map<string, number>();
  const add = (written: number, month: number) => {
    // A two-digit year, as in 01/10/26, is this century's.
    const year = written < 100 ? 2000 + written : written;
    if (month < 1 || month > 12 || year < 1990 || year > 2100) return;
    const key = `${year}-${String(month).padStart(2, '0')}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const [, day, month, year] of text.matchAll(DAY_FIRST)) {
    // Dates here are written day first; a first number over 12 cannot be a month, so a second over 12 means month first.
    if (Number(month) > 12 && Number(day) <= 12) add(Number(year), Number(day));
    else add(Number(year), Number(month));
  }
  for (const [, year, month] of text.matchAll(YEAR_FIRST)) add(Number(year), Number(month));
  for (const pattern of [NAMED_MONTH, DAY_NAMED_MONTH]) {
    for (const [, month, year] of text.matchAll(pattern)) add(Number(year), MONTH_ABBREVIATIONS.indexOf(month.toLowerCase().slice(0, 3)) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0])).map(([key]) => key);
}

/**
 * The facts of one file, read from its name, folder and text. At most one document type, six organisations, six people,
 * four emails, two accounts, two months and three project folders, each once.
 */
export function extractFacts(record: { name: string; folder: string; text: string }): string[] {
  const title = record.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ');
  const text = `${title}\n${record.text.slice(0, READ_CHARS)}`;
  const lower = text.toLowerCase();
  // The kind of document also reads the name's joined words apart, so OpTransactionHistory.pdf is "Op Transaction
  // History". People are read from the name as written, so WhatsAppImage is nobody.
  const words = title.replace(/([a-z])([A-Z])/g, '$1 $2');
  const facts = new Map<FactKind, string[]>();
  const add = (kind: FactKind, value: string) => {
    const list = facts.get(kind) ?? [];
    if (value.length < 2 || value.length > 60 || list.includes(value) || list.length >= LIMITS[kind]) return;
    list.push(value);
    facts.set(kind, list);
  };

  const type = documentType(`${words}\n${text}`);
  if (type) add('type', type);

  // Organisations with where each is first named outside a transaction line, if it is: the known institutions under their
  // one name, then any other company.
  const lines = lower.split('\n');
  const starts: number[] = [];
  lines.reduce((at, line) => (starts.push(at), at + line.length + 1), 0);
  const firstOutsideTransactions = (pattern: RegExp): number => {
    const index = lines.findIndex(line => !TRANSACTION_LINE.test(line) && pattern.test(line));
    return index < 0 ? Number.POSITIVE_INFINITY : starts[index];
  };
  const named: Array<{ org: string; at: number; issuer: boolean }> = [];
  const institutions = INSTITUTIONS.filter(institution => institution.pattern.test(lower));
  for (const institution of institutions) named.push({ org: institution.name, at: firstOutsideTransactions(institution.pattern), issuer: !institution.neverIssuer });
  for (const pattern of [COMPANY, COMPANY_CAPS]) {
    for (const match of text.matchAll(pattern)) {
      const org = normaliseOrg(match[1]);
      // A bare ending such as "Bank" names nobody.
      if ((org.split(' ').length < 2 && !/bank$/.test(org)) || org === 'bank') continue;
      // A known institution, or one already found under a longer name, as "State Bank" is in "State Bank of India", is
      // the same one.
      if (institutions.some(institution => institution.pattern.test(org))) continue;
      if (named.some(known => known.org.includes(org) || org.includes(known.org))) continue;
      const at = match.index ?? 0;
      const end = lower.indexOf('\n', at);
      const line = lower.slice(lower.lastIndexOf('\n', at) + 1, end < 0 ? undefined : end);
      named.push({ org, at: TRANSACTION_LINE.test(line) ? Number.POSITIVE_INFINITY : at, issuer: true });
    }
  }
  // A document says who it is from at its top, so the first organisation named there is the one, and the rest are
  // mentions. A bank named only in transactions, or a regulator, is never the one.
  named.sort((a, b) => a.at - b.at);
  const issuer = named.find(entry => entry.issuer && Number.isFinite(entry.at));
  for (const entry of named) add(entry === issuer ? 'org' : 'mention', entry.org);

  for (const [email] of text.matchAll(EMAIL)) add('email', email.toLowerCase());
  const orgs = [...(facts.get('org') ?? []), ...(facts.get('mention') ?? [])];
  const person = (raw: string) => {
    let run: string[] = [];
    const keep = () => {
      const name = run.join(' ');
      if (run.length >= 2 && run.length <= 4 && !orgs.some(org => org.includes(name) || name.includes(org))) add('person', name);
      run = [];
    };
    for (const word of raw.toLowerCase().split(/\s+/)) {
      if (NOT_A_NAME.has(word)) keep();
      else run.push(word);
    }
    keep();
  };
  for (const [, raw] of text.matchAll(NAMED)) person(raw);
  for (const [, raw] of text.matchAll(PROPER)) person(raw);

  for (const pattern of [ACCOUNT, MASKED]) {
    for (const [, digits] of text.matchAll(pattern)) add('account', digits.replace(/\D/g, '').slice(-4));
  }
  for (const period of periodsOf(text)) add('period', period);
  for (const part of record.folder.split('/').slice(1)) add('project', part.toLowerCase());

  return (['type', 'org', 'mention', 'person', 'email', 'account', 'period', 'project'] as const).flatMap(kind => (facts.get(kind) ?? []).map(value => `${kind}:${value}`));
}

export function factKind(fact: string): FactKind {
  return fact.slice(0, fact.indexOf(':')) as FactKind;
}

export function factValue(fact: string): string {
  return fact.slice(fact.indexOf(':') + 1);
}

/**
 * The words a search can reach a fact by: the words of its value, and of the other names people use for it, so "payslip"
 * reaches "type:salary slip" and "sbi" reaches "org:state bank of india". A month is reached by its full name and its
 * year, but not "may", which is more often a word than a month in a question.
 */
export function factWords(fact: string): string[] {
  const kind = factKind(fact);
  const value = factValue(fact);
  if (kind === 'period') {
    const [year, month] = value.split('-');
    const name = MONTH_NAMES[Number(month) - 1];
    return name && name !== 'may' ? [year, name] : [year];
  }
  const names = [value];
  if (kind === 'type') names.push(...(DOCUMENT_TYPES.find(entry => entry.type === value)?.aliases ?? []));
  if (kind === 'org' || kind === 'mention') names.push(...(INSTITUTIONS.find(entry => entry.name === value)?.aliases ?? []));
  const words = names.flatMap(name => name.split(/[^a-z0-9@.]+/)).filter(word => word.length >= 2);
  return [...new Set(words)];
}

/**
 * The phrases of a document type found in a query, such as "bank statement" in "my icici bank statement", or its other
 * names, such as "payslip". A file of one of these types fits the question's kind of document.
 */
export function typesAskedFor(query: string): string[] {
  const text = ` ${query.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return DOCUMENT_TYPES.filter(entry => [entry.type, ...entry.aliases].some(name => name.length > 2 && text.includes(` ${name} `))).map(entry => entry.type);
}

/** The facts as a short card of plain words, for the embedding and for a person to read, such as "bank statement, icici bank, october 2026". */
export function factCard(facts: readonly string[]): string {
  return facts
    .map(fact => {
      const kind = factKind(fact);
      const value = factValue(fact);
      if (kind === 'account') return `account ending ${value}`;
      if (kind === 'project') return `in ${value}`;
      if (kind === 'mention') return `mentions ${value}`;
      if (kind === 'period') {
        const [year, month] = value.split('-');
        return `${MONTH_NAMES[Number(month) - 1] ?? ''} ${year}`.trim();
      }
      return value;
    })
    .join(', ');
}

/** The first and last moment of a "period:yyyy-mm" fact's month, local time. */
export function periodRange(fact: string): { after: number; before: number } | undefined {
  const [year, month] = factValue(fact).split('-').map(Number);
  if (!year || !month) return undefined;
  return { after: new Date(year, month - 1, 1).getTime(), before: new Date(year, month, 1).getTime() - 1 };
}

/**
 * Who uses this computer, for questions that say "my": their names written without spaces or punctuation, so "Kate Sai
 * Kishore" in a statement and the account "Kate Saikishore" are the same person, and the name to show.
 */
export interface Identity {
  names: string[];
  shown?: string;
}

/** Account names that say nothing about who the person is. */
const GENERIC_ACCOUNTS = new Set(['admin', 'administrator', 'owner', 'macbook', 'student', 'office', 'default', 'ubuntu']);
/** A name this short would match too many other people. */
const MIN_NAME_CHARS = 6;
/** Kinds of document that only their owner keeps, which say whose files these are when the account's names do not. */
const OWN_TYPES = new Set(['salary slip', 'bank statement', 'credit card statement', 'offer letter', 'resume', 'tax form', 'aadhaar card', 'pan card', 'driving licence', 'credit report']);
/** "my", "mine" or "me", but not the "me" of "find me" or "show me", which asks for something without making it theirs. */
const SELF = /\b(?:my|mine|myself|our|ours)\b|(?<!\b(?:find|show|get|give|send|tell|help) )\bme\b/;

const joined = (text: string): string => text.toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');

/** The identity in an account's full name and user name, such as "Kate Saikishore" and "katesaikishore". */
export function identityOf(account: { fullName?: string; username?: string }): Identity {
  const names = [account.fullName, account.username].map(name => joined(name ?? '')).filter(name => name.length >= MIN_NAME_CHARS && !GENERIC_ACCOUNTS.has(name));
  const shown = account.fullName?.trim();
  return { names: [...new Set(names)], ...(shown ? { shown } : {}) };
}

/**
 * True for a person or email fact that is the person's own: their name in full or shortened, "Sai Kishore" for Kate Sai
 * Kishore, or an email that starts with it.
 */
export function isOwnFact(fact: string, identity: Identity): boolean {
  const kind = factKind(fact);
  if (kind !== 'person' && kind !== 'email') return false;
  const value = factValue(fact);
  const name = joined(kind === 'email' ? value.slice(0, value.indexOf('@')) : value);
  if (name.length < MIN_NAME_CHARS) return false;
  return identity.names.some(own => own === name || name.includes(own) || (own.includes(name) && (kind === 'email' || value.includes(' '))));
}

/**
 * The identity, with the files' help when the account's names say nothing: then the person named in the most documents
 * that only their owner keeps, such as payslips and a resume, when they are named in three or more.
 */
export function identityWithFiles(identity: Identity, files: readonly (readonly string[])[]): Identity {
  if (identity.names.length > 0) return identity;
  const counts = new Map<string, number>();
  for (const facts of files) {
    const type = facts.find(fact => factKind(fact) === 'type');
    if (!type || !OWN_TYPES.has(factValue(type))) continue;
    for (const fact of facts) if (factKind(fact) === 'person') counts.set(factValue(fact), (counts.get(factValue(fact)) ?? 0) + 1);
  }
  const [best] = [...counts].sort((a, b) => b[1] - a[1]);
  if (!best || best[1] < 3 || joined(best[0]).length < MIN_NAME_CHARS) return identity;
  return { names: [joined(best[0])], shown: best[0].replace(/\b\w/g, letter => letter.toUpperCase()) };
}

/** True when a question asks for the person's own files, with "my", "mine" or "me". */
export function asksForOwn(query: string): boolean {
  return SELF.test(query.toLowerCase());
}
