import { describe, expect, it } from 'vitest';
import { AUTOMATION_NAME_LIMIT, renamedAutomationName } from '../src/shared/rename';

describe('renamedAutomationName', () => {
  it('keeps the text, without the spaces around it', () => {
    expect(renamedAutomationName('  Month-end sheet  ')).toBe('Month-end sheet');
  });

  it('refuses a value that is not text, and a name that is blank', () => {
    expect(renamedAutomationName(undefined)).toBeUndefined();
    expect(renamedAutomationName(42)).toBeUndefined();
    expect(renamedAutomationName({ name: 'Month-end sheet' })).toBeUndefined();
    expect(renamedAutomationName('   ')).toBeUndefined();
  });

  it('cuts a longer name to the limit an accepted routine gets', () => {
    const name = renamedAutomationName('x'.repeat(120));
    expect(name).toHaveLength(AUTOMATION_NAME_LIMIT);
    expect(AUTOMATION_NAME_LIMIT).toBe(80);
  });
});
