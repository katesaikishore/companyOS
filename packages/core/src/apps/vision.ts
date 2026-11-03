import { z } from 'zod';
import { RISKS, riskOf, type AppCapability, type AppSurface } from './capabilities';

/**
 * Discovery from a screenshot and the names of the screen's controls, for a local vision model. The model gets the picture
 * and only the controls that can do work. Tabs, links and the window's own buttons are removed first, because a small model
 * copies whatever list it is given. Every proposal must then name a control that is on the screen, so an invented job is
 * dropped before a person sees it. Nothing here runs a step, and nothing is stored.
 */

export interface VisionRequest {
  system: string;
  prompt: string;
  /** The picture of the whole primary display as PNG. It stays on this device. */
  imagePng: Uint8Array;
  schema: Readonly<Record<string, unknown>>;
  maxTokens: number;
  signal?: AbortSignal;
}

/**
 * A vision model that runs on this Mac. The desktop app supplies it, and it may only call the loopback address. The
 * engine's LocalCompleter seam is unchanged: it still makes no network call.
 */
export interface VisionCompleter {
  describe(request: VisionRequest): Promise<unknown>;
}

/** The same budget the app's text discovery uses. */
export const VISION_MAX_TOKENS = 800;
const MAX_CAPABILITIES = 12;
const CONTROL = /^(\w+) "(.*)"$/;
const WINDOW_BUTTONS = new Set(['close', 'zoom', 'minimize']);

/** The controls the model may see: no tabs, no links, and none of the window's own buttons. */
export function filterForModel(surface: AppSurface): AppSurface {
  const controls = surface.controls.filter(control => {
    const match = CONTROL.exec(control);
    if (!match) return false;
    const [, role, name] = match;
    if (role === 'link' || role === 'tab') return false;
    return !(role === 'button' && WINDOW_BUTTONS.has(name.trim().toLowerCase()));
  });
  return { app: surface.app, controls };
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * True when the claimed control matches one on the screen: its first word is in that control, and at least half its words are.
 * The check is on words, not exact text, because the model shortens a control's name.
 */
export function grounded(claim: string, controls: readonly string[]): boolean {
  const claimed = words(claim);
  if (claimed.length === 0) return false;
  return controls.some(control => {
    const onScreen = new Set(words(control));
    const hits = claimed.filter(word => onScreen.has(word)).length;
    return onScreen.has(claimed[0]) && hits / claimed.length >= 0.5;
  });
}

const SYSTEM =
  'You list the jobs a person could hand to an assistant in the application shown in the screenshot. ' +
  'A job is something done for the person, such as exporting data, searching, replying, drafting, merging or stopping something that runs. ' +
  'Use only the controls listed and what the screenshot shows. Name every job after the control that does it, and put that control in "control". ' +
  'Do not list navigation, settings or switches. If no control does a job, return an empty list. ' +
  'Answer only with the JSON the schema asks for. ' +
  'Use risk "read_only" for reading, "draft" for composing without sending, "outbound" for anything that sends, and "destructive" for anything that deletes or cannot be undone.';

const SCHEMA = {
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
          control: { type: 'string' },
        },
        required: ['name', 'description', 'risk', 'control'],
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
        control: z.string().trim().min(1).max(160),
      }),
    )
    .max(MAX_CAPABILITIES),
});

export interface ScreenDiscovery {
  capabilities: AppCapability[];
  /** How many controls the model was shown, after the filter. */
  controls: number;
  /** How many proposals named a control that is not on the screen, and were dropped. */
  dropped: number;
  reason?: 'no_controls' | 'model_failed' | 'invalid_reply';
}

/** Asks the vision model what the screen can do, and keeps only the proposals that name a control on the screen. */
export async function discoverFromScreen(
  vision: VisionCompleter,
  surface: AppSurface,
  imagePng: Uint8Array,
  options: { signal?: AbortSignal } = {},
): Promise<ScreenDiscovery> {
  const filtered = filterForModel(surface);
  if (filtered.controls.length === 0) return { capabilities: [], controls: 0, dropped: 0, reason: 'no_controls' };

  const prompt = [
    `Application: ${surface.app}`,
    `Controls on this screen (role and name):\n${filtered.controls.map(control => `- ${control}`).join('\n')}`,
    'What jobs can be handed to an assistant on this screen? Answer in the schema.',
  ].join('\n\n');

  let reply: unknown;
  try {
    reply = await vision.describe({ system: SYSTEM, prompt, imagePng, schema: SCHEMA, maxTokens: VISION_MAX_TOKENS, signal: options.signal });
  } catch {
    return { capabilities: [], controls: filtered.controls.length, dropped: 0, reason: 'model_failed' };
  }
  const parsed = Reply.safeParse(reply);
  if (!parsed.success) return { capabilities: [], controls: filtered.controls.length, dropped: 0, reason: 'invalid_reply' };

  const names = new Set<string>();
  const capabilities: AppCapability[] = [];
  let dropped = 0;
  for (const item of parsed.data.capabilities) {
    const key = item.name.toLowerCase();
    if (names.has(key)) continue;
    if (!grounded(item.control, filtered.controls)) {
      dropped += 1;
      continue;
    }
    names.add(key);
    const risk = riskOf(`${item.name} ${item.description} ${item.control}`, item.risk);
    capabilities.push({ name: item.name, description: item.description, risk, needsApproval: risk !== 'read_only' });
  }
  return { capabilities, controls: filtered.controls.length, dropped };
}
