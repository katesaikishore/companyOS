import { basename, isAbsolute } from 'node:path';
import type { OpenDialogOptions } from 'electron';

/**
 * Checks for the local connectors' IPC values and the pieces of a source the desktop app builds itself. This module
 * imports nothing from Electron at runtime, so the tests can load it. A page never sends a path: the person picks one in
 * the system dialog, and the path is checked here before it is saved.
 */

/** The kinds of source that read a file or folder on this device. The cloud kinds are added by another module. */
export const LOCAL_CONNECTOR_KINDS = ['folder', 'git', 'calendar', 'mail'] as const;
export type LocalConnectorKind = (typeof LOCAL_CONNECTOR_KINDS)[number];

/** Limits the engine's config schema enforces. The renderer keeps a copy, and its test checks the copy. */
export const CONNECTOR_SOURCE_MAX = 20;
export const CONNECTOR_LABEL_MAX = 60;
export const CONNECTOR_PATH_MAX = 1000;
const CONNECTOR_ID = /^[A-Za-z0-9_-]{16,64}$/;

const FALLBACK_LABEL: Record<LocalConnectorKind, string> = {
  folder: 'Folder',
  git: 'Git repository',
  calendar: 'Calendar file',
  mail: 'Mail archive',
};

export function connectorKindArg(value: unknown): LocalConnectorKind {
  if (typeof value === 'string' && (LOCAL_CONNECTOR_KINDS as readonly string[]).includes(value)) {
    return value as LocalConnectorKind;
  }
  throw new Error('Invalid source kind.');
}

export function connectorIdArg(value: unknown): string {
  if (typeof value !== 'string' || !CONNECTOR_ID.test(value)) throw new Error('Invalid source id.');
  return value;
}

/** An absolute path from the system dialog, no longer than the engine allows, with no control characters. */
export function connectorPathArg(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > CONNECTOR_PATH_MAX) throw new Error('Invalid path.');
  if (/\p{Cc}/u.test(value) || !isAbsolute(value)) throw new Error('Invalid path.');
  return value;
}

/**
 * The label a source shows in Settings: the name of the chosen folder or file, one line, at most 60 characters. A name
 * that is empty after cleaning gets the kind's own name.
 */
export function connectorLabel(kind: LocalConnectorKind, path: string): string {
  const cleaned = basename(path).replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  let label = cleaned.slice(0, CONNECTOR_LABEL_MAX);
  // A cut that leaves half of a surrogate pair is removed, so the label stays valid text.
  const last = label.charCodeAt(label.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) label = label.slice(0, -1);
  label = label.trim();
  return label === '' ? FALLBACK_LABEL[kind] : label;
}

/** The system dialog for one kind of source: a folder for folder and Git, a file for calendar and mail. */
export function connectorPickerOptions(kind: LocalConnectorKind): OpenDialogOptions {
  switch (kind) {
    case 'folder':
      return { title: 'Choose a folder to read', properties: ['openDirectory'] };
    case 'git':
      return { title: 'Choose a Git repository to read', properties: ['openDirectory'] };
    case 'calendar':
      return {
        title: 'Choose a calendar file to read',
        properties: ['openFile'],
        filters: [
          { name: 'Calendar files', extensions: ['ics', 'ical'] },
          { name: 'All files', extensions: ['*'] },
        ],
      };
    case 'mail':
      return {
        title: 'Choose a mail archive to read',
        properties: ['openFile'],
        filters: [
          { name: 'Mail archives', extensions: ['mbox'] },
          { name: 'All files', extensions: ['*'] },
        ],
      };
  }
}
