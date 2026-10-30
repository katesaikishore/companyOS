import { z } from 'zod';
import { classifyApp } from './classify';
import type { Routine } from './mine';
import type { EffectClass } from './types';

const PARAM_REF = /^\$(p\d+)$/;

export const ParamSchema = z
  .object({
    name: z.string().regex(/^p\d+$/),
    options: z.array(z.string().min(1).max(200)).min(2).max(5),
    default: z.string().min(1).max(200),
  })
  .strict();

/**
 * Steps are deliberately few. Focusing an app and checking that it is focused is the whole
 * vocabulary of this version. Typing, clicking and sending are not automated yet.
 */
export const StepSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('focus_app'), app: z.string().min(1).max(200) }).strict(),
  z.object({ op: z.literal('check_focus'), app: z.string().min(1).max(200) }).strict(),
]);

export const AutomationSchema = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(80),
    version: z.number().int().positive(),
    routineId: z.string().min(1),
    params: z.array(ParamSchema).max(6),
    steps: z.array(StepSchema).min(1).max(12),
  })
  .strict();

export type Param = z.infer<typeof ParamSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Automation = z.infer<typeof AutomationSchema>;

/** Effect of a step, from the operation and the application it touches. */
export function effectOfOp(op: Step['op'], app: string): EffectClass {
  if (op === 'check_focus') return 'read_only';
  // Messages are composed and sent by the person in these apps, and the twin cannot see what is sent.
  const windowClass = classifyApp(app);
  return windowClass === 'mail' || windowClass === 'chat' ? 'external_effect' : 'read_only';
}

/**
 * Compiles a mined routine into an automation. Each routine position becomes a focus step and a
 * postcondition check. A position where the observed app varies becomes a parameter whose options
 * are the apps actually seen there.
 */
export function compileRoutine(routine: Routine, name: string = defaultName(routine)): Automation {
  const params: Param[] = [];
  const steps: Step[] = [];
  routine.steps.forEach((step, index) => {
    let app = step.app;
    if (step.options.length > 1) {
      const paramName = `p${index}`;
      params.push({ name: paramName, options: step.options, default: step.app });
      app = `$${paramName}`;
    }
    steps.push({ op: 'focus_app', app }, { op: 'check_focus', app });
  });
  return AutomationSchema.parse({
    id: `auto_${routine.id}`,
    name,
    version: 1,
    routineId: routine.id,
    params,
    steps,
  });
}

function defaultName(routine: Routine): string {
  return `Routine: ${routine.steps.map(step => step.windowClass).join(' → ')}`;
}

/** Resolves a "$pN" reference against the bound values, which must be observed options. */
export function resolveApp(app: string, params: readonly Param[], values: Readonly<Record<string, string>>): string {
  const match = PARAM_REF.exec(app);
  if (!match) return app;
  const param = params.find(p => p.name === match[1]);
  if (!param) throw new Error(`Unknown parameter ${match[1]}.`);
  const value = values[param.name] ?? param.default;
  if (!param.options.includes(value)) throw new Error(`Value for ${param.name} is not an observed option.`);
  return value;
}

export function resolveStep(step: Step, params: readonly Param[], values: Readonly<Record<string, string>>): Step {
  const app = resolveApp(step.app, params, values);
  return step.op === 'focus_app' ? { op: 'focus_app', app } : { op: 'check_focus', app };
}

/** Every effect the automation can produce across all parameter options. */
export function effectsOf(automation: Automation): EffectClass[] {
  const effects = new Set<EffectClass>();
  for (const step of automation.steps) {
    const param = automation.params.find(p => `$${p.name}` === step.app);
    const apps = param ? param.options : [step.app];
    for (const app of apps) effects.add(effectOfOp(step.op, app));
  }
  return [...effects];
}
