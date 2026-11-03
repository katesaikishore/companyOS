import { describe, expect, it } from 'vitest';
import { documentType, extractFacts, factCard, factWords, typesAskedFor } from '../src/file-knowledge';

describe('reading a file’s facts', () => {
  it('reads an ICICI statement whose name says nothing, as one bank under all its spellings, keeping four digits of the account', () => {
    const text = [
      'ICICI BANK LIMITED',
      'Statement of Transactions in Savings Account Number: 000401234321 in INR for the period October 01, 2026 - October 26, 2026',
      'Customer Name: KATE SAI KISHORE',
      'S No. Value Date Transaction Date Cheque Number Transaction Remarks Withdrawal Amount Deposit Amount Balance',
      '1 01/10/2026 01/10/2026 UPI/ICICI Bank/payment 450.00 11,550.00',
      'Opening Balance 12,000.00  Thank you for banking with ICICI Bank.',
    ].join('\n');
    const facts = extractFacts({ name: 'OpTransactionHistory26-10-2026.pdf', folder: 'Desktop/documents', text });
    expect(facts).toEqual(['type:bank statement', 'org:icici bank', 'person:kate sai kishore', 'account:4321', 'period:2026-10', 'project:documents']);
    expect(facts.join(' ')).not.toContain('000401234321');
  });

  it('reads a payslip with its employer as one organisation, and a person named after a label', () => {
    const text = 'Dimensions Infotech Pvt Ltd\nPayslip for the month of June 2025\nEmployee Name: Priya Shah\nEarnings Basic HRA Deductions Professional Tax Net Pay 52,000';
    expect(extractFacts({ name: 'Jun_2025.pdf', folder: 'Downloads', text })).toEqual(['type:salary slip', 'org:dimensions infotech', 'person:priya shah', 'period:2025-06']);
  });

  it('keeps headings and labels out of people, and keeps a document without cues untyped', () => {
    const facts = extractFacts({ name: 'notes.pdf', folder: 'Downloads', text: 'Account Statement Opening Balance\nMeeting With Priya Shah About The Launch' });
    expect(facts.filter(fact => fact.startsWith('person:'))).toEqual(['person:priya shah']);
    expect(documentType('Notes from the launch meeting')).toBeUndefined();
  });

  it('keeps banks whose names contain another bank’s name apart', () => {
    const orgs = (text: string) => extractFacts({ name: 'a.pdf', folder: 'Downloads', text }).filter(fact => fact.startsWith('org:'));
    expect(orgs('State Bank of India, Main Branch')).toEqual(['org:state bank of india']);
    expect(orgs('Union Bank of India')).toEqual(['org:union bank of india']);
    expect(orgs('Bank of India')).toEqual(['org:bank of india']);
  });

  it('takes the bank named at the top as the one a statement is from, and banks in its transactions as mentions', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `${i + 1} 0${(i % 9) + 1}/06/2026 UPI/HDFC BANK/payment to a friend 450.00`).join('\n');
    const facts = extractFacts({ name: 'OpTransactionHistory.pdf', folder: 'Desktop', text: `ICICI Bank Limited\nDetailed Statement\n${rows}` });
    expect(facts.filter(fact => /^(org|mention):/.test(fact))).toEqual(['org:icici bank', 'mention:hdfc bank']);
  });

  it('reads day-first dates, and a month-first one only when the day is over twelve', () => {
    expect(extractFacts({ name: 'a.pdf', folder: 'Downloads', text: 'Paid 05/03/2026 and 06/03/2026' })).toContain('period:2026-03');
    expect(extractFacts({ name: 'a.pdf', folder: 'Downloads', text: 'Paid 03/25/2026' })).toContain('period:2026-03');
  });
});

describe('reaching facts from a question', () => {
  it('reaches a fact by the other names people use, and a month by its name but never by "may"', () => {
    expect(factWords('type:salary slip')).toEqual(expect.arrayContaining(['salary', 'slip', 'payslip']));
    expect(factWords('org:state bank of india')).toContain('sbi');
    expect(factWords('period:2026-10')).toEqual(['2026', 'october']);
    expect(factWords('period:2026-05')).toEqual(['2026']);
  });

  it('reads the document types a question asks for', () => {
    expect(typesAskedFor('icici bank statement')).toEqual(['bank statement']);
    expect(typesAskedFor('payslip march')).toEqual(['salary slip']);
    expect(typesAskedFor('passport photo')).toEqual([]);
  });

  it('shows the facts as a card of plain words', () => {
    expect(factCard(['type:bank statement', 'org:icici bank', 'mention:hdfc bank', 'account:4321', 'period:2026-10', 'project:documents'])).toBe(
      'bank statement, icici bank, mentions hdfc bank, account ending 4321, october 2026, in documents',
    );
  });
});

describe('what the review found', () => {
  const orgs = (text: string, name = 'a.pdf') => extractFacts({ name, folder: 'Downloads', text }).filter(fact => /^(org|mention):/.test(fact));
  const people = (text: string, name = 'a.pdf') => extractFacts({ name, folder: 'Downloads', text }).filter(fact => fact.startsWith('person:'));

  it('keeps banks and insurers that share a name apart', () => {
    expect(orgs('South Indian Bank Ltd\nStatement of Account')).toEqual(['org:south indian bank']);
    expect(orgs('HDFC Life Insurance Company Limited\nPremium receipt')).toEqual(['org:hdfc life']);
    expect(orgs('Small Industries Development Bank of India')).toEqual(['org:sidbi']);
  });

  it('never takes the issuer from a transaction line, or from a regulator', () => {
    expect(orgs('Statement of accounts\n01/06/2026 UPI-ICICI BANK-PAYTM 450.00\nHDFC BANK LIMITED, Koramangala')).toEqual(['org:hdfc bank', 'mention:icici bank']);
    expect(orgs('Deposits are insured by DICGC, a subsidiary of the Reserve Bank of India\nAxis Bank Ltd')).toEqual(['org:axis bank', 'mention:reserve bank of india', 'mention:dicgc']);
  });

  it('finds no people in file names and headings', () => {
    expect(people('', 'WhatsApp Image 2024-05-12 at 10.15.32.jpeg')).toEqual([]);
    expect(people('', 'Screen Shot 2021-04-01 at 9.10.png')).toEqual([]);
    expect(people('', 'PriyaShahResume.pdf')).toEqual([]);
    expect(people('Offer Letter\nUnique Identification Authority\nTamil Nadu\nReverse Charge\nPurchase Order\nBranch Name : KORAMANGALA BANGALORE')).toEqual([]);
  });

  it('reads months only from month words, and reads two-digit years', () => {
    const periods = (text: string) => extractFacts({ name: 'a.pdf', folder: 'Downloads', text }).filter(fact => fact.startsWith('period:'));
    expect(periods('Investment Declaration 2024-25. Marks 2023. Marketing 2025. Junior 2019.')).toEqual([]);
    expect(periods('01/10/26 UPI payment 450.00')).toEqual(['period:2026-10']);
    expect(periods('Statement for 5 Oct 26')).toEqual(['period:2026-10']);
  });

  it('keeps the last four digits of a card, not a year after it, and takes no account from an Aadhaar number', () => {
    const accounts = (text: string) => extractFacts({ name: 'a.pdf', folder: 'Downloads', text }).filter(fact => fact.startsWith('account:'));
    expect(accounts('Card No: XXXX XXXX XXXX 1234 2026')).toEqual(['account:1234']);
    expect(accounts('Aadhaar card 1234 5678 9012')).toEqual([]);
  });

  it('reads long runs of masks or letters in a few milliseconds', () => {
    for (const text of ['x*'.repeat(10_000), 'x'.repeat(20_000), 'a'.repeat(20_000), `${'a'.repeat(19_990)}@b.com`]) {
      const started = performance.now();
      extractFacts({ name: 'a.pdf', folder: 'Downloads', text });
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
});
