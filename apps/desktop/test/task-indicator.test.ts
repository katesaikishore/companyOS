import { describe, expect, it } from 'vitest';
import { taskIndicator } from '../src/main/task-indicator';

const step = { n: 1, text: 'Click "1"', outcome: 'landed' as const };

describe('taskIndicator', () => {
  it('shows nothing beside the icon when no task runs', () => {
    expect(taskIndicator({ state: 'idle', goal: 'Calculate 12 times 7', steps: [step] }, 3)).toEqual({ title: '', tooltip: 'companyOS Twin' });
  });

  it('pulses a dot while a task runs, and names the task and its steps in the tooltip', () => {
    const running = { state: 'running' as const, goal: 'Calculate  12 times\n7 in Calculator', steps: [step, step] };
    expect(taskIndicator(running, 0).title).toBe('●');
    expect(taskIndicator(running, 1).title).toBe('○');
    expect(taskIndicator(running, 2).title).toBe('●');
    expect(taskIndicator(running, 0).tooltip).toBe('companyOS Twin is working on: Calculate 12 times 7 in Calculator (2 steps so far)');
    expect(taskIndicator({ ...running, steps: [step] }, 0).tooltip).toContain('(1 step so far)');
  });

  it('pulses the dot while the bar plans a task, before any step', () => {
    const planning = { state: 'planning' as const, goal: 'Calculate 12 times 7 in Calculator', steps: [] };
    expect([taskIndicator(planning, 0).title, taskIndicator(planning, 1).title]).toEqual(['●', '○']);
    expect(taskIndicator(planning, 0).tooltip).toBe('companyOS Twin is planning: Calculate 12 times 7 in Calculator');
  });

  it('keeps the dot filled while a step waits for the person, and shortens a long goal', () => {
    const waiting = taskIndicator({ state: 'waiting', goal: 'x'.repeat(200), steps: [] }, 1);
    expect(waiting.title).toBe('●');
    expect(waiting.tooltip.startsWith('companyOS Twin is waiting for you: ')).toBe(true);
    expect(waiting.tooltip).toHaveLength('companyOS Twin is waiting for you: '.length + 60);
  });
});
