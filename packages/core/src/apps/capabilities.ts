import { z } from 'zod';
import type { LocalCompleter } from '../llm/types';

/**
 * What an application can do for the person, as a local model reads it from the application's visible controls. The model
 * proposes; this module checks what it proposed and decides what needs a person's approval. Nothing here runs a step.
 *
 * The model sees the application's name and the names of its controls, never their values, so a message body or a mail
 * subject is not in the request. Everything stays on the device, and nothing is stored here.
 */

/** How much a capability can change outside the device. A draft is never sent by itself. */
export const RISKS = ['read_only', 'draft', 'outbound', 'destructive'] as const;
export type CapabilityRisk = (typeof RISKS)[number];

export interface AppCapability {
  name: string;
  description: string;
  risk: CapabilityRisk;
  /** True for everything but a read. The model cannot turn this off. */
  needsApproval: boolean;
}

/** The controls of one application, by role and name, with no values. */
export interface AppSurface {
  app: string;
  controls: string[];
}

/** The most controls the model is shown. The rest are cut, so a large window cannot flood the request. */
export const MAX_CONTROLS = 80;
const MAX_CAPABILITIES = 12;

/** How risky each kind of word is. The model's own label is only kept when it is at least this risky. */
const RISK_ORDER: readonly CapabilityRisk[] = ['read_only', 'draft', 'outbound', 'destructive'];
const RISK_WORDS: readonly { risk: CapabilityRisk; pattern: RegExp }[] = [
  { risk: 'destructive', pattern: /\b(delete|remove|erase|trash|empty|overwrite|quit|uninstall|reset|wipe|stop all)\b/i },
  { risk: 'outbound', pattern: /\b(send|post|publish|reply|submit|share|forward|invite|pay|buy|order|sign)\b/i },
  { risk: 'draft', pattern: /\b(pause|stop|start|change|turn|enable|disable|set|draft|compose|write|add|create|save|toggle|switch)\b/i },
];

/**
 * The risk of a capability, never lower than the words in it call for. A small model can label a pause or a send as a
 * read, so the words decide the floor and the model's label cannot lower it.
 */
export function riskOf(text: string, modelRisk: CapabilityRisk): CapabilityRisk {
  let risk = modelRisk;
  for (const { risk: wordRisk, pattern } of RISK_WORDS) {
    if (pattern.test(text) && RISK_ORDER.indexOf(wordRisk) > RISK_ORDER.indexOf(risk)) risk = wordRisk;
  }
  return risk;
}

const CONTROL_ROLES = new Set(['button', 'menuitem', 'menubutton', 'link', 'checkbox', 'radiobutton', 'tab', 'textfield', 'combobox', 'popupbutton']);

const CAPABILITY_SCHEMA = {
  type: 'object',
  properties: {
    capabilities: {
      type: 'array',
      maxItems: MAX_CAPABILITIES,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          risk: { type: 'string', enum: [...RISKS] },
        },
        required: ['name', 'description', 'risk'],
      },
    },
  },
  required: ['capabilities'],
} as const;

const Reply = z.object({
  capabilities: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().min(1).max(240),
        risk: z.enum(RISKS),
      }),
    )
    .max(MAX_CAPABILITIES),
});

/**
 * The controls of an application from an accessibility snapshot (agent-desktop's `snapshot` JSON). Each control is listed
 * as `role "name"`. Values, which can hold a message or a number, are never read. Duplicates are dropped, and the list is
 * cut to MAX_CONTROLS.
 */
export function surfaceOf(app: string, snapshot: unknown): AppSurface {
  const controls: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || controls.length >= MAX_CONTROLS) return;
    const element = node as { role?: unknown; name?: unknown; children?: unknown };
    if (typeof element.role === 'string' && CONTROL_ROLES.has(element.role) && typeof element.name === 'string' && element.name.trim()) {
      const label = `${element.role} "${element.name.trim().slice(0, 80)}"`;
      if (!seen.has(label)) {
        seen.add(label);
        controls.push(label);
      }
    }
    if (Array.isArray(element.children)) for (const child of element.children) walk(child);
  };
  walk((snapshot as { data?: { tree?: unknown } } | null)?.data?.tree);
  return { app, controls };
}

/**
 * Asks the model what the application can do. A reply that does not match the schema, or a failed model, gives an empty
 * list and a reason, so a bad answer never becomes a capability. Every capability that is not a read needs approval.
 */
export async function discoverCapabilities(
  completer: LocalCompleter,
  surface: AppSurface,
  options: { learned?: string; signal?: AbortSignal } = {},
): Promise<{ capabilities: AppCapability[]; reason?: 'no_controls' | 'model_failed' | 'invalid_reply' }> {
  if (surface.controls.length === 0) return { capabilities: [], reason: 'no_controls' };
  const system =
    'You list the jobs a person could hand to an assistant in one application, from the names of its visible controls. ' +
    'A job is something done for the person, such as replying to unread messages, drafting a status update or sending a message. ' +
    'Do not list navigation tabs, settings or switches; those are not jobs. If the controls show no job, return an empty list. ' +
    'Answer only with the JSON the schema asks for, with at most twelve jobs. ' +
    'Use risk "read_only" for reading, "draft" for composing without sending, "outbound" for anything that sends or posts, ' +
    'and "destructive" for anything that deletes or cannot be undone.';
  const prompt = [
    `Application: ${surface.app}`,
    `Visible controls:\n${surface.controls.map(control => `- ${control}`).join('\n')}`,
    options.learned ? `What this user has done before in this application:\n${options.learned}` : '',
    // Qwen3 reads this switch in the user turn, so it goes here and not in the system text.
    '/no_think',
  ]
    .filter(Boolean)
    .join('\n\n');

  let reply: unknown;
  try {
    reply = await completer.complete({ system, prompt, schema: CAPABILITY_SCHEMA, maxTokens: 800, signal: options.signal });
  } catch {
    return { capabilities: [], reason: 'model_failed' };
  }
  const parsed = Reply.safeParse(reply);
  if (!parsed.success) return { capabilities: [], reason: 'invalid_reply' };

  const names = new Set<string>();
  const capabilities: AppCapability[] = [];
  for (const item of parsed.data.capabilities) {
    const key = item.name.toLowerCase();
    if (names.has(key)) continue;
    names.add(key);
    const risk = riskOf(`${item.name} ${item.description}`, item.risk);
    capabilities.push({ name: item.name, description: item.description, risk, needsApproval: risk !== 'read_only' });
  }
  return { capabilities };
}

/** One thing the person did with a proposed capability, kept on this device to shape later proposals. */
export interface RunOutcome {
  app: string;
  capability: string;
  decision: 'approved' | 'rejected' | 'edited';
  /** The text the person wrote instead, for an edited draft. Kept only on this device. */
  edited?: string;
  at: number;
}

/**
 * Notes for the next discovery in one application, from what the person did before: how often each capability was
 * approved or rejected, and the wording they edited into a draft. The most recent edits come first, and each is cut short.
 */
export function learningNotes(outcomes: readonly RunOutcome[], app: string, limit = 5): string {
  const own = outcomes.filter(outcome => outcome.app === app);
  if (own.length === 0) return '';
  const tally = new Map<string, { approved: number; rejected: number; edited: number }>();
  for (const outcome of own) {
    const entry = tally.get(outcome.capability) ?? { approved: 0, rejected: 0, edited: 0 };
    entry[outcome.decision === 'approved' ? 'approved' : outcome.decision === 'rejected' ? 'rejected' : 'edited'] += 1;
    tally.set(outcome.capability, entry);
  }
  const lines = [...tally].map(([name, count]) => `- ${name}: approved ${count.approved}, rejected ${count.rejected}, edited ${count.edited}`);
  const edits = own
    .filter(outcome => outcome.decision === 'edited' && outcome.edited)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map(outcome => `- ${outcome.capability} wording the user chose: "${outcome.edited!.slice(0, 200)}"`);
  return [...lines, ...edits].join('\n');
}
